import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { backendFetch } from "@/lib/server/backend";
import { clearRateLimitStore } from "@/lib/server/rate-limit";

vi.mock("server-only", () => ({}));
vi.mock("ioredis", () => ({
  default: class UnavailableRedis {
    status = "wait";
    on() {
      return this;
    }
    async connect() {
      throw new Error("unavailable");
    }
    disconnect() {
      this.status = "end";
    }
  },
}));
vi.mock("@/lib/server/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/backend")>();
  return { ...actual, backendFetch: vi.fn() };
});

const mockedBackendFetch = vi.mocked(backendFetch);
const googleFetch = vi.fn();
const { GET: startGoogle } = await import("@/app/api/auth/google/start/route");
const { GET: completeGoogle } =
  await import("@/app/api/auth/google/callback/route");

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ");
}

function idTokenWithNonce(nonce: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ nonce })).toString("base64url");
  return `${header}.${payload}.provider-signature`;
}

async function startFlow(
  mode: "login" | "register" | "link" = "login",
  sessionCookie?: string,
) {
  const returnTo = mode === "link" ? "/profile/linked-accounts" : "/";
  const response = await startGoogle(
    new NextRequest(
      `http://localhost/api/auth/google/start?mode=${mode}&returnTo=${returnTo}`,
      sessionCookie ? { headers: { Cookie: sessionCookie } } : undefined,
    ),
  );
  const location = new URL(response.headers.get("location") ?? "");
  return {
    response,
    state: location.searchParams.get("state") ?? "",
    nonce: location.searchParams.get("nonce") ?? "",
    cookies: cookieHeaderFrom(response),
  };
}

function authCookieMutations(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((cookie) =>
      [
        "spine_patient_sess=",
        "spine_patient_refresh=",
        "spine_patient_sess_iat=",
        "spine_patient_audit_actor=",
      ].some((prefix) => cookie.startsWith(prefix)),
    );
}

describe("Google OAuth BFF routes", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "single-bucket");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "memory");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("PATIENT_WEB_E2E_BYPASS_RATE_LIMITS", "true");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "test-patient-web-csrf-secret-at-least-32-bytes",
    );
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "http://localhost");
    vi.stubEnv("PATIENT_WEB_PUBLIC_URL", "http://localhost");
    vi.stubEnv("GOOGLE_OAUTH_ENABLED", "true");
    vi.stubEnv("GOOGLE_CLIENT_ID", "google-web-client-id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-web-client-secret");
    mockedBackendFetch.mockReset();
    googleFetch.mockReset();
    vi.stubGlobal("fetch", googleFetch);
  });

  afterEach(async () => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "single-bucket");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "memory");
    vi.stubEnv("REDIS_URL", "");
    vi.stubEnv("PATIENT_WEB_E2E_BYPASS_RATE_LIMITS", "");
    await clearRateLimitStore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("stores OAuth transaction data server-side and sets only an opaque state cookie", async () => {
    const { response, state, nonce } = await startFlow();
    const location = new URL(response.headers.get("location") ?? "");
    const setCookie = response.headers.getSetCookie().join("\n");

    expect(response.status).toBe(307);
    expect(location.origin).toBe("https://accounts.google.com");
    expect(location.searchParams.get("client_id")).toBe("google-web-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://localhost/api/auth/google/callback",
    );
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state).toHaveLength(43);
    expect(nonce).toHaveLength(43);
    expect(setCookie).toContain("spine_google_oauth_state=");
    expect(setCookie).not.toContain("spine_google_oauth_verifier=");
    expect(setCookie).not.toContain("spine_google_oauth_nonce=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).not.toContain("google-web-client-secret");
  });

  it("uses the validated public origin behind a trusted reverse proxy", async () => {
    const frontDoorId = "12345678-1234-1234-1234-123456789abc";
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
    vi.stubEnv("PATIENT_WEB_PUBLIC_URL", "https://patient.example.test");
    vi.stubEnv("FRONT_DOOR_ORIGIN_GUARD_MODE", "enforce");
    vi.stubEnv("AZURE_FRONT_DOOR_ID", frontDoorId);

    const response = await startGoogle(
      new NextRequest("http://0.0.0.0:3000/api/auth/google/start", {
        headers: {
          "x-forwarded-host": "patient.example.test",
          "x-azure-fdid": frontDoorId,
        },
      }),
    );
    const location = new URL(response.headers.get("location") ?? "");

    expect(response.status).toBe(307);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://patient.example.test/api/auth/google/callback",
    );
    expect(response.headers.get("location")).not.toContain("0.0.0.0");
  });

  it("rejects mismatched forwarded host metadata without using the internal origin", async () => {
    const frontDoorId = "12345678-1234-1234-1234-123456789abc";
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
    vi.stubEnv("PATIENT_WEB_PUBLIC_URL", "https://patient.example.test");
    vi.stubEnv("FRONT_DOOR_ORIGIN_GUARD_MODE", "enforce");
    vi.stubEnv("AZURE_FRONT_DOOR_ID", frontDoorId);

    const response = await startGoogle(
      new NextRequest("http://0.0.0.0:3000/api/auth/google/start", {
        headers: {
          "x-forwarded-host": "evil.example.test",
          "x-azure-fdid": frontDoorId,
        },
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("completes login through the backend and issues HttpOnly app session cookies", async () => {
    const { state, nonce, cookies } = await startFlow();
    googleFetch.mockResolvedValueOnce(
      Response.json({ id_token: idTokenWithNonce(nonce) }),
    );
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({
          access_token: "backend-access-token",
          refresh_token: "backend-refresh-token",
          token_type: "bearer",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ user_id: "10000000-0000-4000-8000-000000000001" }),
      );

    const response = await completeGoogle(
      new NextRequest(
        `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
        { headers: { Cookie: cookies } },
      ),
    );

    expect(response.headers.get("location")).toBe("http://localhost/");
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      "/api/v1/auth/login/google",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id_token: idTokenWithNonce(nonce) }),
      }),
    );
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("spine_patient_sess=backend-access-token");
    expect(setCookie).toContain("spine_patient_refresh=backend-refresh-token");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).not.toContain("provider-signature");
  });

  it("does not clear an existing session on start or provider cancellation", async () => {
    const existing =
      "spine_patient_sess=existing-access; spine_patient_refresh=existing-refresh";
    const {
      response: startResponse,
      state,
      cookies,
    } = await startFlow("register", existing);
    expect(authCookieMutations(startResponse)).toEqual([]);

    const callbackResponse = await completeGoogle(
      new NextRequest(
        `http://localhost/api/auth/google/callback?state=${state}&error=access_denied&error_description=private-detail`,
        { headers: { Cookie: `${existing}; ${cookies}` } },
      ),
    );

    expect(callbackResponse.headers.get("location")).toBe(
      "http://localhost/register?socialAuthError=cancelled",
    );
    expect(authCookieMutations(callbackResponse)).toEqual([]);
    expect(callbackResponse.headers.get("location")).not.toContain(
      "access_denied",
    );
  });

  it("does not force logout when provider or backend verification fails", async () => {
    const existing = "spine_patient_sess=existing-access";
    const { state, nonce, cookies } = await startFlow("login", existing);
    googleFetch.mockResolvedValueOnce(
      Response.json({ id_token: idTokenWithNonce(`${nonce}-wrong`) }),
    );

    const response = await completeGoogle(
      new NextRequest(
        `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
        { headers: { Cookie: `${existing}; ${cookies}` } },
      ),
    );

    expect(response.headers.get("location")).toContain(
      "socialAuthError=callback_failed",
    );
    expect(authCookieMutations(response)).toEqual([]);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("atomically consumes callback state before provider exchange", async () => {
    const { state, cookies } = await startFlow();
    googleFetch.mockResolvedValueOnce(Response.json({}));
    const callbackUrl = `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`;
    const first = await completeGoogle(
      new NextRequest(callbackUrl, { headers: { Cookie: cookies } }),
    );
    const second = await completeGoogle(
      new NextRequest(callbackUrl, { headers: { Cookie: cookies } }),
    );

    expect(first.headers.get("location")).toContain(
      "socialAuthError=missing_id_token",
    );
    expect(second.headers.get("location")).toContain(
      "socialAuthError=state_mismatch",
    );
    expect(googleFetch).toHaveBeenCalledTimes(1);
  });

  it("requires an existing session for link mode", async () => {
    const response = await startGoogle(
      new NextRequest("http://localhost/api/auth/google/start?mode=link"),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails an orphaned link callback before provider or backend calls", async () => {
    const existing = "spine_patient_sess=existing-access";
    const { state, cookies } = await startFlow("link", existing);
    const response = await completeGoogle(
      new NextRequest(
        `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
        { headers: { Cookie: cookies } },
      ),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost/profile/linked-accounts?socialAuthError=session_required",
    );
    expect(googleFetch).not.toHaveBeenCalled();
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(authCookieMutations(response)).toEqual([]);
  });

  it("links through the authenticated API contract without replacing session cookies", async () => {
    const existing = "spine_patient_sess=existing-access";
    const { state, nonce, cookies } = await startFlow("link", existing);
    googleFetch.mockResolvedValueOnce(
      Response.json({ id_token: idTokenWithNonce(nonce) }),
    );
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(
        {
          id: "10000000-0000-4000-8000-000000000001",
          provider: "google",
          linked_at: "2026-09-01T12:00:00Z",
        },
        { status: 201 },
      ),
    );

    const response = await completeGoogle(
      new NextRequest(
        `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
        { headers: { Cookie: `${existing}; ${cookies}` } },
      ),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost/profile/linked-accounts",
    );
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      "/api/v1/auth/social-identities/link",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          provider: "google",
          id_token: idTokenWithNonce(nonce),
        }),
      }),
    );
    const headers = new Headers(mockedBackendFetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer existing-access");
    expect(authCookieMutations(response)).toEqual([]);
  });

  it("rejects unknown modes before initiating OAuth", async () => {
    const response = await startGoogle(
      new NextRequest("http://localhost/api/auth/google/start?mode=replace"),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_mode" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rate-limits OAuth initiation in a separate opaque bucket", async () => {
    vi.stubEnv("PATIENT_WEB_E2E_BYPASS_RATE_LIMITS", "");
    await clearRateLimitStore();
    const responses = [];
    for (let index = 0; index < 11; index += 1) {
      responses.push(
        await startGoogle(
          new NextRequest("http://localhost/api/auth/google/start"),
        ),
      );
    }

    expect(
      responses.slice(0, 10).every((response) => response.status === 307),
    ).toBe(true);
    expect(responses[10]?.status).toBe(429);
    await expect(responses[10]?.json()).resolves.toEqual({
      error: "too_many_requests",
    });
  });

  it("fails closed when the hosted shared store is unavailable", async () => {
    const frontDoorId = "12345678-1234-1234-1234-123456789abc";
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "azure-front-door");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "redis");
    vi.stubEnv("REDIS_URL", "rediss://redis.example.test:6380/0");
    vi.stubEnv("PATIENT_WEB_E2E_BYPASS_RATE_LIMITS", "");
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
    vi.stubEnv("PATIENT_WEB_PUBLIC_URL", "https://patient.example.test");
    vi.stubEnv("FRONT_DOOR_ORIGIN_GUARD_MODE", "enforce");
    vi.stubEnv("AZURE_FRONT_DOOR_ID", frontDoorId);

    const response = await startGoogle(
      new NextRequest("http://0.0.0.0:3000/api/auth/google/start", {
        headers: {
          "x-forwarded-host": "patient.example.test",
          "x-azure-fdid": frontDoorId,
          "x-azure-socketip": "203.0.113.10",
        },
      }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails only Google routes when the feature is disabled", async () => {
    vi.stubEnv("GOOGLE_OAUTH_ENABLED", "false");
    const startResponse = await startGoogle(
      new NextRequest("http://localhost/api/auth/google/start"),
    );
    const callbackResponse = await completeGoogle(
      new NextRequest(
        "http://localhost/api/auth/google/callback?code=unused&state=unused",
      ),
    );

    for (const response of [startResponse, callbackResponse]) {
      expect(response.status).toBe(503);
      await expect(response.clone().json()).resolves.toEqual({
        error: "service_unavailable",
      });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(googleFetch).not.toHaveBeenCalled();
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });
});
