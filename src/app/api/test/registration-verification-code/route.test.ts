import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "test-support-token-with-at-least-32-chars";
const BACKEND_TEST_TOKEN = "backend-support-token-with-at-least-32-chars";
const EMAIL =
  "casey.assessment.123e4567-e89b-42d3-a456-426614174000@e2e.example.com";

function makeRequest(body: unknown, token = TEST_TOKEN): NextRequest {
  return new NextRequest(
    "https://patient-web.example.com/api/test/registration-verification-code",
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

describe("patient web registration-code support route", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);
    vi.stubEnv("PATIENT_WEB_BACKEND_TEST_SUPPORT_TOKEN", BACKEND_TEST_TOKEN);
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "registration-code-test-csrf-secret-at-least-32-bytes",
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

  it("forwards the exact synthetic request with the server token and allowlists the code", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        Response.json({ code: "123456", secret: "must-not-leak" }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ email: EMAIL }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ code: "123456" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "/test/registration-verification-code",
        "http://backend.internal",
      ),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: EMAIL }),
        headers: {
          authorization: `Bearer ${BACKEND_TEST_TOKEN}`,
          "content-type": "application/json",
        },
      }),
    );
  });

  it.each([
    { email: "patient@example.com" },
    { email: EMAIL, run_id: "unexpected" },
  ])("rejects non-exact support bodies: %j", async (body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    expect((await POST(makeRequest(body))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not expose an upstream error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ detail: "backend secret" }, { status: 404 }),
        ),
    );
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ email: EMAIL }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ detail: "Not found" });
  });

  it("fails closed when the separate backend support token is unavailable", async () => {
    vi.stubEnv("PATIENT_WEB_BACKEND_TEST_SUPPORT_TOKEN", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    const response = await POST(makeRequest({ email: EMAIL }));

    expect(response.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
