import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "test-support-token-with-at-least-32-chars";

function makeRequest(token?: string): NextRequest {
  return new NextRequest("https://patient-web.example.com/api/test/health", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("patient web test support health route", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "single-bucket");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "memory");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "health-test-csrf-secret-at-least-32-bytes",
    );
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
    vi.stubEnv(
      "PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY_ID",
      "test-current",
    );
    vi.stubEnv(
      "PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY",
      "patient-web-test-actor-signing-key-32-bytes",
    );
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("is hidden unless test support is explicitly enabled", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest(TEST_TOKEN));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("requires the configured bearer token", async () => {
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

    const { POST } = await import("./route");

    expect((await POST(makeRequest())).status).toBe(404);
    expect((await POST(makeRequest("wrong-token"))).status).toBe(404);
    expect((await POST(makeRequest(TEST_TOKEN))).status).toBe(200);
  });

  it("does not clear rate-limit state", async () => {
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);
    vi.doMock("@/lib/server/rate-limit", () => ({
      clearRateLimitStore: vi.fn(),
    }));

    const { POST } = await import("./route");
    const { clearRateLimitStore } = await import("@/lib/server/rate-limit");
    const response = await POST(makeRequest(TEST_TOKEN));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(clearRateLimitStore).not.toHaveBeenCalled();
  });
});
