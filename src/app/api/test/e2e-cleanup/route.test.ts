import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "test-support-token-with-at-least-32-chars";
const CLEANUP_BODY = {
  run_id: "123e4567-e89b-42d3-a456-426614174000",
  email:
    "casey.assessment.123e4567-e89b-42d3-a456-426614174000@e2e.example.com",
};

function makeRequest(token?: string, withBody = false): NextRequest {
  const init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
  } = {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  if (withBody) init.body = JSON.stringify(CLEANUP_BODY);
  return new NextRequest(
    "https://patient-web.example.com/api/test/e2e-cleanup",
    init,
  );
}

describe("patient web test cleanup route", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "single-bucket");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "memory");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://127.0.0.1:8000");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "cleanup-test-csrf-secret-at-least-32-bytes",
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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          status: "cleanup_stack_owned",
          secret: "must-not-leak",
        }),
      ),
    );
  });

  afterEach(() => {
    vi.doUnmock("@/lib/server/rate-limit");
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is hidden in every recognized environment unless test support is explicitly enabled", async () => {
    const { POST } = await import("./route");
    const response = await POST(makeRequest(TEST_TOKEN));

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("requires the configured bearer token in local test support", async () => {
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

    const { POST } = await import("./route");

    expect((await POST(makeRequest("wrong-token"))).status).toBe(404);
    expect((await POST(makeRequest())).status).toBe(404);
    expect((await POST(makeRequest(TEST_TOKEN, true))).status).toBe(200);
  });

  it("uses ENVIRONMENT rather than NODE_ENV for authorization", async () => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

    const { POST } = await import("./route");

    expect((await POST(makeRequest())).status).toBe(404);
    expect((await POST(makeRequest(TEST_TOKEN, true))).status).toBe(200);
  });

  it.each([undefined, "", "preview", "unknown"])(
    "denies an unrecognized explicit environment even with enabled test support: %s",
    async (environment) => {
      if (environment === undefined) {
        delete process.env.ENVIRONMENT;
      } else {
        vi.stubEnv("ENVIRONMENT", environment);
      }
      vi.stubEnv("NODE_ENV", "development");
      vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
      vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

      const { POST } = await import("./route");

      expect((await POST(makeRequest(TEST_TOKEN))).status).toBe(404);
    },
  );

  it.each(["short", "wrong-token-with-a-different-length"])(
    "denies invalid configured or supplied bearer tokens: %s",
    async (token) => {
      vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
      vi.stubEnv(
        "PATIENT_WEB_TEST_SUPPORT_TOKEN",
        token === "short" ? token : TEST_TOKEN,
      );

      const { POST } = await import("./route");

      expect((await POST(makeRequest(token))).status).toBe(404);
    },
  );

  it("accepts an exact synthetic run identity and reports stack-owned disposal", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

    const { POST } = await import("./route");

    const response = await POST(makeRequest(TEST_TOKEN, true));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ status: "cleanup_stack_owned" });
  });

  it("rejects missing or mismatched run identity", async () => {
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

    const { POST } = await import("./route");

    const response = await POST(makeRequest(TEST_TOKEN));

    expect(response.status).toBe(404);
  });

  it("rejects extra cleanup fields instead of forwarding arbitrary JSON", async () => {
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

    const { POST } = await import("./route");
    const request = new NextRequest(
      "https://patient-web.example.com/api/test/e2e-cleanup",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ...CLEANUP_BODY, patient_id: "forbidden" }),
      },
    );

    expect((await POST(request)).status).toBe(404);
  });

  it("forwards exact cleanup to the backend with the server token and hides extra response fields", async () => {
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

    const fetchMock = vi.mocked(fetch);
    const { POST } = await import("./route");
    const response = await POST(makeRequest(TEST_TOKEN, true));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "cleanup_stack_owned" });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/test/e2e-cleanup", "http://127.0.0.1:8000"),
      expect.objectContaining({
        body: JSON.stringify(CLEANUP_BODY),
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
        },
      }),
    );
  });
});
