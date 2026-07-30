import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_TOKEN = "test-support-token-with-at-least-32-chars";

function makeRequest(token?: string): NextRequest {
  return new NextRequest("https://patient-web.example.com/api/test/health", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("patient web test-support health route", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
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
    expect(await response.json()).toEqual({ detail: "Not found" });
  });

  it("requires the configured bearer token", async () => {
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

    const { POST } = await import("./route");

    expect((await POST(makeRequest())).status).toBe(404);
    expect((await POST(makeRequest("wrong-token"))).status).toBe(404);

    const response = await POST(makeRequest(TEST_TOKEN));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it.each([undefined, "", "preview", "unknown"])(
    "fails closed for an unrecognized explicit environment: %s",
    async (environment) => {
      if (environment === undefined) {
        delete process.env.ENVIRONMENT;
      } else {
        vi.stubEnv("ENVIRONMENT", environment);
      }
      vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
      vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);

      const { POST } = await import("./route");
      expect((await POST(makeRequest(TEST_TOKEN))).status).toBe(404);
    },
  );

  it("fails closed when the configured token is too short", async () => {
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", "short");

    const { POST } = await import("./route");
    expect((await POST(makeRequest("short"))).status).toBe(404);
  });
});
