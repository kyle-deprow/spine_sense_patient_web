import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "test-support-token-with-at-least-32-chars";
const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const EMAIL =
  "casey.assessment.123e4567-e89b-42d3-a456-426614174000@e2e.example.com";
const BODY = { document_id: DOCUMENT_ID, email: EMAIL, verdict: "clean" };

function makeRequest(body: unknown, token = TEST_TOKEN): NextRequest {
  return new NextRequest(
    "https://patient-web.example.com/api/test/document-scan-result",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("patient web document-scan support route", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "document-scan-test-csrf-secret-at-least-32-bytes",
    );
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "single-bucket");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "memory");
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("forwards the strict body and returns only allowlisted scan fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ...BODY,
        processing_status: "complete",
        scan_status: "clean",
        secret: "must-not-leak",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      document_id: DOCUMENT_ID,
      processing_status: "complete",
      scan_status: "clean",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/test/document-scan-result", "http://backend.internal"),
      expect.objectContaining({ body: JSON.stringify(BODY) }),
    );
  });

  it.each([
    { ...BODY, unexpected: true },
    { ...BODY, document_id: "not-a-uuid" },
    { ...BODY, verdict: "unknown" },
  ])("rejects malformed or extra support data: %j", async (body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    expect((await POST(makeRequest(body))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps an upstream conflict without exposing its response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ detail: "backend secret" }, { status: 409 }),
        ),
    );
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "support_conflict" });
  });
});
