import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { backendFetch } from "@/lib/server/backend";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/server/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/backend")>();
  return {
    ...actual,
    backendFetch: vi.fn(),
  };
});

const mockedBackendFetch = vi.mocked(backendFetch);

const { GET: startFhir } = await import("@/app/api/fhir/start/route");
const { GET: completeFhir } = await import("@/app/api/fhir/callback/route");

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

function makeRequest(
  path: string,
  cookies: Record<string, string> = {},
  extraHeaders: Record<string, string> = {},
) {
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  return new NextRequest(`http://localhost${path}`, {
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...extraHeaders,
    },
  });
}

describe("FHIR OAuth BFF routes", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "test-patient-web-csrf-secret-at-least-32-bytes",
    );
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "http://localhost");
    vi.stubEnv("PATIENT_WEB_PUBLIC_URL", "http://localhost");
    vi.stubEnv("PATIENT_WEB_FHIR_OAUTH_ENABLED", "true");
    vi.stubEnv(
      "PATIENT_WEB_FHIR_RELEASE_PROFILE",
      "confidential_private_key_jwt",
    );
    vi.stubEnv(
      "PATIENT_WEB_FHIR_REDIRECT_URI",
      "http://localhost/api/fhir/callback",
    );
    vi.stubEnv(
      "PATIENT_WEB_FHIR_AUTHORIZATION_ENDPOINTS",
      "https://epic.example.test/oauth2/authorize",
    );
    mockedBackendFetch.mockReset();
  });

  it("starts browser FHIR OAuth through the backend using the exact web redirect URI", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(
        {
          connection_id: "10000000-0000-4000-8000-000000000001",
          auth_url:
            "https://epic.example.test/oauth2/authorize?state=opaque-state",
          oauth_state: "opaque-state",
        },
        { status: 201 },
      ),
    );

    const response = await startFhir(
      makeRequest(
        "/api/fhir/start?endpointId=endpoint-1&permissionPolicyVersion=phase_1c_documents_labs.v1&categories=Demographics&categories=Diagnostic%20reports&categories=Laboratory%20results&purposeCode=patient_directed_record_import&retentionNoticeVersion=fhir_retention.v1",
        { spine_patient_sess: "access-token" },
        { Referer: "http://localhost/profile/fhir" },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://epic.example.test/oauth2/authorize?state=opaque-state",
    );
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      "/api/v1/fhir/connections",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
          Accept: "application/json",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          endpoint_id: "endpoint-1",
          redirect_uri: "http://localhost/api/fhir/callback",
          permission_policy_version: "phase_1c_documents_labs.v1",
          categories: [
            "Demographics",
            "Diagnostic reports",
            "Laboratory results",
          ],
          purpose_code: "patient_directed_record_import",
          retention_notice_version: "fhir_retention.v1",
          provider_visibility: false,
          background_sync: false,
          consequences_acknowledged: true,
        }),
      }),
    );
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("spine_fhir_oauth_state=opaque-state");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).not.toContain("access-token");
  });

  it("rejects browser FHIR OAuth start when the patient session cookie is absent", async () => {
    const response = await startFhir(
      makeRequest(
        "/api/fhir/start?endpointId=endpoint-1&permissionPolicyVersion=phase_1b_core.v1&categories=Demographics&purposeCode=patient_directed_record_import&retentionNoticeVersion=fhir_retention.v1",
      ),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("rejects browser FHIR OAuth start from cross-site navigation before mutating backend state", async () => {
    const response = await startFhir(
      makeRequest(
        "/api/fhir/start?endpointId=endpoint-1&permissionPolicyVersion=phase_1b_core.v1&categories=Demographics&purposeCode=patient_directed_record_import&retentionNoticeVersion=fhir_retention.v1",
        { spine_patient_sess: "access-token" },
        { Referer: "https://evil.example.test/launch" },
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "origin_forbidden",
    });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("rejects malformed backend OAuth state before writing the HttpOnly state cookie", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(
        {
          connection_id: "10000000-0000-4000-8000-000000000001",
          auth_url:
            "https://epic.example.test/oauth2/authorize?state=opaque-state",
          oauth_state: "bad;state",
        },
        { status: 201 },
      ),
    );

    const response = await startFhir(
      makeRequest(
        "/api/fhir/start?endpointId=endpoint-1&permissionPolicyVersion=phase_1b_core.v1&categories=Demographics&purposeCode=patient_directed_record_import&retentionNoticeVersion=fhir_retention.v1",
        { spine_patient_sess: "access-token" },
        { Referer: "http://localhost/profile/fhir" },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/fhir/callback?fhirStatus=failed",
    );
    expect(response.headers.getSetCookie().join("\n")).not.toContain(
      "bad;state",
    );
  });

  it("rejects backend authorization redirects that are not bound to the HttpOnly state", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(
        {
          connection_id: "10000000-0000-4000-8000-000000000001",
          auth_url:
            "https://epic.example.test/oauth2/authorize?state=different-state",
          oauth_state: "opaque-state",
        },
        { status: 201 },
      ),
    );

    const response = await startFhir(
      makeRequest(
        "/api/fhir/start?endpointId=endpoint-1&permissionPolicyVersion=phase_1b_core.v1&categories=Demographics&purposeCode=patient_directed_record_import&retentionNoticeVersion=fhir_retention.v1",
        { spine_patient_sess: "access-token" },
        { Referer: "http://localhost/profile/fhir" },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/fhir/callback?fhirStatus=failed",
    );
    expect(response.headers.getSetCookie().join("\n")).not.toContain(
      "spine_fhir_oauth_state",
    );
  });

  it("completes browser FHIR OAuth server-side and clears code/state from the app redirect", async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json(
          {
            connection_id: "10000000-0000-4000-8000-000000000001",
            auth_url:
              "https://epic.example.test/oauth2/authorize?state=opaque-state",
            oauth_state: "opaque-state",
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "10000000-0000-4000-8000-000000000001" }),
      );
    const startResponse = await startFhir(
      makeRequest(
        "/api/fhir/start?endpointId=endpoint-1&permissionPolicyVersion=phase_1b_core.v1&categories=Demographics&purposeCode=patient_directed_record_import&retentionNoticeVersion=fhir_retention.v1",
        { spine_patient_sess: "access-token" },
        { Referer: "http://localhost/profile/fhir" },
      ),
    );

    const callbackResponse = await completeFhir(
      makeRequest(
        "/api/fhir/callback?code=provider-code&state=opaque-state&iss=https%3A%2F%2Ffhir.example.test%2FR4",
        {
          spine_patient_sess: "access-token",
          ...Object.fromEntries(
            cookieHeaderFrom(startResponse)
              .split("; ")
              .filter(Boolean)
              .map((entry) => entry.split("=", 2) as [string, string]),
          ),
        },
      ),
    );

    expect(callbackResponse.status).toBe(307);
    const location = callbackResponse.headers.get("location") ?? "";
    expect(location).toBe(
      "http://localhost/fhir/callback?fhirStatus=connected",
    );
    expect(location).not.toContain("provider-code");
    expect(location).not.toContain("opaque-state");
    expect(mockedBackendFetch).toHaveBeenLastCalledWith(
      "/api/v1/fhir/connections/callback",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
        }),
        body: JSON.stringify({
          code: "provider-code",
          state: "opaque-state",
          iss: "https://fhir.example.test/R4",
        }),
      }),
    );
    expect(callbackResponse.headers.getSetCookie().join("\n")).toContain(
      "spine_fhir_oauth_state=;",
    );
  });

  it("fails closed on callback state mismatch before calling the backend", async () => {
    const response = await completeFhir(
      makeRequest(
        "/api/fhir/callback?code=provider-code&state=attacker-state",
        {
          spine_patient_sess: "access-token",
          spine_fhir_oauth_state: "expected-state",
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/fhir/callback?fhirStatus=failed",
    );
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("scrubs callback code and state when the patient session has expired", async () => {
    const response = await completeFhir(
      makeRequest("/api/fhir/callback?code=provider-code&state=opaque-state", {
        spine_fhir_oauth_state: "opaque-state",
      }),
    );

    expect(response.status).toBe(307);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe("http://localhost/fhir/callback?fhirStatus=failed");
    expect(location).not.toContain("provider-code");
    expect(location).not.toContain("opaque-state");
    expect(response.headers.getSetCookie().join("\n")).toContain(
      "spine_fhir_oauth_state=;",
    );
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("fails closed on callback values containing control characters", async () => {
    const response = await completeFhir(
      makeRequest(
        "/api/fhir/callback?code=provider-code%0A&state=opaque-state",
        {
          spine_patient_sess: "access-token",
          spine_fhir_oauth_state: "opaque-state",
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/fhir/callback?fhirStatus=failed",
    );
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("consumes provider denial without reflecting provider error text to the app", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    const response = await completeFhir(
      makeRequest(
        "/api/fhir/callback?error=access_denied&error_description=patient%20name%20must%20not%20leak&state=opaque-state",
        {
          spine_patient_sess: "access-token",
          spine_fhir_oauth_state: "opaque-state",
        },
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost/fhir/callback?fhirStatus=denied",
    );
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      "/api/v1/fhir/connections/callback/denial",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ state: "opaque-state" }),
      }),
    );
    expect(response.headers.get("location")).not.toContain("patient");
  });
});
