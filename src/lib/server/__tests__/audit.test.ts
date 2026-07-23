import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  auditLog,
  createAuditContext,
  isRoutineAuditEnabled,
  sessionCorrelationFromToken,
} from "@/lib/server/audit";

const UUID = "10000000-0000-4000-8000-000000000001";
const TOKEN = "opaque-access-token-with-private-content";

describe("audit sanitization", () => {
  beforeEach(() => {
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "audit-test-secret-at-least-thirty-two-bytes",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("emits only sanitized metadata and strict UUID identifiers", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    auditLog({
      ts: "2026-07-10T12:00:00.000Z",
      event: "phi.proxy.denied",
      method: "post",
      resourceType: "patients.miscribe",
      actorId: UUID.toUpperCase(),
      status: 403,
      requestId: UUID.toUpperCase(),
      sessionCorrelation: sessionCorrelationFromToken(TOKEN),
      reason: "csrf_missing",
    });

    const entry = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<
      string,
      unknown
    >;
    expect(entry).toEqual({
      ts: "2026-07-10T12:00:00.000Z",
      event: "phi.proxy.denied",
      method: "POST",
      resourceType: "patients.miscribe",
      actorId: UUID,
      status: 403,
      requestId: UUID,
      sessionCorrelation: sessionCorrelationFromToken(TOKEN),
      reason: "csrf_missing",
    });
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
  });

  it("drops raw or malformed values that could contain request or clinical content", () => {
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    auditLog({
      ts: "not-a-date",
      event: "phi.proxy.denied?patient=name",
      method: "POST /clinical-note",
      resourceType: "/api/v1/patients/me/miscribe?note=private",
      actorId: "patient@example.test",
      status: 999,
      requestId: "browser-query-and-token",
      sessionCorrelation: "raw-cookie-or-client-request-id",
      reason: "symptom text here",
    });

    const output = String(write.mock.calls[0]?.[0]);
    const entry = JSON.parse(output) as Record<string, unknown>;
    expect(entry.event).toBe("audit.invalid_event");
    expect(entry).not.toHaveProperty("method");
    expect(entry).not.toHaveProperty("resourceType");
    expect(entry).not.toHaveProperty("actorId");
    expect(entry).not.toHaveProperty("status");
    expect(entry).not.toHaveProperty("requestId");
    expect(entry).not.toHaveProperty("sessionCorrelation");
    expect(entry).not.toHaveProperty("reason");
    expect(output).not.toContain("private");
    expect(output).not.toContain("symptom");
    expect(output).not.toContain("patient@example.test");
  });

  it("creates a stable secret-keyed correlation without retaining the token", () => {
    const first = createAuditContext(TOKEN);
    const second = createAuditContext(TOKEN);
    const other = createAuditContext("different-token");

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.sessionCorrelation).toBe(second.sessionCorrelation);
    expect(first.sessionCorrelation).not.toBe(other.sessionCorrelation);
    expect(first.sessionCorrelation).toMatch(/^sess_[A-Za-z0-9_-]{43}$/);
    expect(first.sessionCorrelation).not.toContain(TOKEN);
  });

  it("enables routine audit logging only in explicit local-style environments", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENVIRONMENT", "production");
    expect(isRoutineAuditEnabled()).toBe(false);

    vi.stubEnv("ENVIRONMENT", "test");
    expect(isRoutineAuditEnabled()).toBe(true);

    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("NODE_ENV", "development");
    expect(isRoutineAuditEnabled()).toBe(true);
  });
});
