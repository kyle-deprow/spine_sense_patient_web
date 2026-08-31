import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { signAuditActorCookie } from "@/lib/auth/cookies";
import {
  clearAccountTransitionState,
  forwardCredentialAuth,
  logoutWithCookie,
  refreshWithCookie,
  sessionFromCookie,
} from "@/lib/server/auth";
import { BackendUnavailableError, backendFetch } from "@/lib/server/backend";
import { jsonNoStore } from "@/lib/server/responses";

vi.mock("@/lib/server/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/backend")>();
  return {
    ...actual,
    backendFetch: vi.fn(),
  };
});

const mockedBackendFetch = vi.mocked(backendFetch);
const SIGNING_KEY = {
  id: "test-current",
  secret: "patient-web-test-actor-signing-key-32-bytes",
};

function makeRequest(cookies: Record<string, string> = {}): NextRequest {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest("http://localhost/api/auth/refresh", {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
}

function makeRequestWithCookieHeader(cookieHeader: string): NextRequest {
  return new NextRequest("http://localhost/api/auth/refresh", {
    headers: { Cookie: cookieHeader },
  });
}

function boundSessionCookies(
  actorId: string,
  accessToken: string,
): Record<string, string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  return {
    spine_patient_sess: accessToken,
    spine_patient_sess_iat: String(issuedAt),
    spine_patient_audit_actor:
      signAuditActorCookie(actorId, accessToken, issuedAt, SIGNING_KEY) ?? "",
  };
}

/**
 * Names of cookies this response actively deletes. A deletion is a Set-Cookie
 * with an empty value and an immediate expiry; cookies merely absent from the
 * response are left alone in the browser.
 */
function clearedCookieNames(response: { headers: Headers }): Set<string> {
  return new Set(
    response.headers
      .getSetCookie()
      .filter((cookie) => /^[^=]+=;/.test(cookie) && /Max-Age=0/i.test(cookie))
      .map((cookie) => cookie.slice(0, cookie.indexOf("="))),
  );
}

describe("BFF auth boundary", () => {
  const actorId = "10000000-0000-4000-8000-000000000001";

  beforeEach(() => {
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "test-patient-web-csrf-secret-at-least-32-bytes",
    );
    mockedBackendFetch.mockReset();
  });

  it("sets HttpOnly auth cookies without returning backend tokens to browser JavaScript", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        access_token: "backend-access-token",
        refresh_token: "backend-refresh-token",
        user_id: actorId,
        token_expires_at: "2026-05-04T12:00:00Z",
      }),
    );

    const response = await forwardCredentialAuth("/api/v1/auth/login", {
      email: "patient@example.test",
      password: "redacted",
    });

    // user_id is stripped server-side (HIPAA §164.502(b) minimum necessary)
    await expect(response.json()).resolves.toEqual({
      token_expires_at: "2026-05-04T12:00:00Z",
    });

    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("spine_patient_sess=backend-access-token");
    expect(setCookie).toContain("spine_patient_refresh=backend-refresh-token");
    expect(setCookie).toContain("spine_patient_audit_actor=v2.test-current.");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("SameSite=strict");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("reissues CSRF after successful no-token registration transitions", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        id: actorId,
        user_id: actorId,
        email: "patient@example.test",
        verification_token: "registration-verification-token",
      }),
    );

    const response = await forwardCredentialAuth(
      "/api/v1/auth/register/patient",
      {
        email: "patient@example.test",
        password: "redacted",
      },
      undefined,
      { errorMode: "registration" },
    );

    await expect(response.json()).resolves.toEqual({
      id: actorId,
      email: "patient@example.test",
      verification_token: "registration-verification-token",
    });
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain("spine_patient_sess=;");
    expect(setCookie).toContain("spine_patient_refresh=;");
    expect(setCookie).toContain("spine_patient_audit_actor=;");
    expect(setCookie).toContain("spine_patient_csrf=");
    expect(setCookie).toContain("SameSite=strict");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("does not set auth cookies when backend authentication fails", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ error: "invalid_credentials" }, { status: 401 }),
    );

    const response = await forwardCredentialAuth("/api/v1/auth/login", {});

    expect(response.status).toBe(401);
    // Backend error body is normalized to prevent account enumeration
    await expect(response.json()).resolves.toEqual({ error: "auth_failed" });
    expect(response.headers.getSetCookie().join("\n")).toContain(
      "spine_patient_audit_actor=;",
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps an MFA challenge in HttpOnly cookies and never exposes the transaction", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        mfa_required: true,
        mfa_token: "short-lived-auth-transaction",
        mfa_method_id: "20000000-0000-4000-8000-000000000001",
        user_id: actorId,
      }),
    );

    const response = await forwardCredentialAuth("/api/v1/auth/login", {
      email: "patient@example.test",
      password: "redacted",
    });

    await expect(response.json()).resolves.toEqual({ mfa_required: true });
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain(
      "spine_patient_mfa_transaction=short-lived-auth-transaction",
    );
    expect(setCookie).toContain(
      "spine_patient_mfa_method=20000000-0000-4000-8000-000000000001",
    );
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=strict");
    expect(setCookie).not.toContain("mfa_token");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("fails closed when a challenge response omits its transaction", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ mfa_required: true, user_id: actorId }),
    );

    const response = await forwardCredentialAuth("/api/v1/auth/login", {});

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_auth_transaction",
    });
    expect(response.headers.getSetCookie().join("\n")).toContain(
      "spine_patient_mfa_transaction=;",
    );
  });

  it("fails closed when a backend response combines a session token pair with a challenge", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        access_token: "must-not-be-issued",
        refresh_token: "must-not-be-issued",
        user_id: actorId,
        mfa_required: true,
        mfa_method_id: "20000000-0000-4000-8000-000000000001",
      }),
    );

    const response = await forwardCredentialAuth("/api/v1/auth/login", {});

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_auth_transaction",
    });
    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).not.toContain("spine_patient_sess=must-not-be-issued");
    expect(setCookie).toContain("spine_patient_mfa_transaction=;");
  });

  // ── refreshWithCookie ──────────────────────────────────────────────────────

  describe("refreshWithCookie", () => {
    it("propagates BackendUnavailableError so the route handler can return 503", async () => {
      mockedBackendFetch.mockRejectedValue(new BackendUnavailableError());

      const request = makeRequest({
        spine_patient_refresh: "valid-refresh-token",
        spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
      });
      await expect(refreshWithCookie(request)).rejects.toThrow(
        BackendUnavailableError,
      );
    });

    it("returns 401 refresh_failed when backend returns non-OK", async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ error: "token_invalid" }, { status: 401 }),
      );

      const request = makeRequest({
        spine_patient_refresh: "stale-refresh-token",
        spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
      });
      const response = await refreshWithCookie(request);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "refresh_failed",
      });
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_sess=;");
      expect(setCookie).toContain("spine_patient_audit_actor=;");
    });

    it("returns 200 and sets auth cookies when backend returns a valid token pair", async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          token_type: "bearer",
          user_id: actorId,
        }),
      );

      const request = makeRequest({
        spine_patient_refresh: "valid-refresh-token",
        spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
      });
      const response = await refreshWithCookie(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_sess=new-access-token");
      expect(setCookie).toContain("spine_patient_refresh=new-refresh-token");
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("spine_patient_audit_actor=v2.test-current.");
      const cookies = response.headers.getSetCookie();
      const legacyExpiry = cookies.findIndex(
        (cookie) =>
          cookie.startsWith("spine_patient_refresh=;") &&
          cookie.includes("Path=/api/auth/refresh;"),
      );
      const currentIssue = cookies.findIndex(
        (cookie) =>
          cookie.startsWith("spine_patient_refresh=new-refresh-token;") &&
          cookie.includes("Path=/api/auth;"),
      );
      expect(legacyExpiry).toBeGreaterThanOrEqual(0);
      expect(currentIssue).toBeGreaterThan(legacyExpiry);
      expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
      expect(mockedBackendFetch.mock.calls[0]?.[0]).toBe(
        "/api/v1/auth/refresh",
      );
    });

    it("migrates duplicate same-name refresh cookies without forwarding cookies to backend", async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({
          access_token: "migrated-access-token",
          refresh_token: "migrated-refresh-token",
          token_type: "bearer",
          user_id: actorId,
        }),
      );

      const request = makeRequestWithCookieHeader(
        [
          "spine_patient_refresh=legacy-refresh-token",
          "spine_patient_refresh=current-refresh-token",
          `spine_patient_sess_iat=${Math.floor(Date.now() / 1000)}`,
        ].join("; "),
      );
      const response = await refreshWithCookie(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      await expect(
        new Response(mockedBackendFetch.mock.calls[0]?.[1]?.body).json(),
      ).resolves.toEqual({ refresh_token: "current-refresh-token" });
      expect(
        new Headers(mockedBackendFetch.mock.calls[0]?.[1]?.headers).get(
          "Cookie",
        ),
      ).toBeNull();
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_refresh=;");
      expect(setCookie).toContain("Path=/api/auth/refresh");
      expect(setCookie).toContain(
        "spine_patient_refresh=migrated-refresh-token",
      );
      expect(setCookie).not.toContain("legacy-refresh-token");
    });

    it.each([
      ["missing user_id", undefined],
      ["malformed user_id", "not-a-uuid"],
    ] as const)(
      "rejects a refresh response with %s without a session lookup or refresh reuse",
      async (_case, userId) => {
        mockedBackendFetch.mockResolvedValue(
          Response.json({
            access_token: "rotated-access-token-must-not-be-used",
            refresh_token: "rotated-refresh-token-must-not-be-used",
            token_type: "bearer",
            ...(userId === undefined ? {} : { user_id: userId }),
          }),
        );

        const request = makeRequest({
          spine_patient_refresh: "single-use-refresh-token",
          spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
        });
        const response = await refreshWithCookie(request);

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toEqual({
          error: "authenticated_actor_unavailable",
        });
        expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
        expect(mockedBackendFetch.mock.calls[0]?.[0]).toBe(
          "/api/v1/auth/refresh",
        );
        expect(response.headers.getSetCookie().join("\n")).toContain(
          "spine_patient_refresh=;",
        );
        expect(response.headers.getSetCookie().join("\n")).not.toContain(
          "rotated-access-token-must-not-be-used",
        );
        expect(response.headers.getSetCookie().join("\n")).not.toContain(
          "rotated-refresh-token-must-not-be-used",
        );
      },
    );

    it.each([
      [
        "a partial token pair",
        Response.json({ access_token: "partial-access-token" }),
      ],
      ["a 204 response", new Response(null, { status: 204 })],
    ] as const)(
      "normalizes %s without preserving a consumed refresh cookie",
      async (_case, backendResponse) => {
        mockedBackendFetch.mockResolvedValue(backendResponse);

        const request = makeRequest({
          spine_patient_refresh: "single-use-refresh-token",
          spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
        });
        const response = await refreshWithCookie(request);

        expect(response.status).toBe(502);
        await expect(response.json()).resolves.toEqual({
          error: "refresh_failed",
        });
        expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
        expect(clearedCookieNames(response)).toContain("spine_patient_refresh");
        expect(response.headers.getSetCookie().join("\n")).not.toContain(
          "partial-access-token",
        );
      },
    );

    it("returns 401 session_expired and clears cookies when IAT indicates >12h elapsed", async () => {
      const stalePast = Math.floor(Date.now() / 1000) - 13 * 60 * 60;
      const request = makeRequest({
        spine_patient_refresh: "valid-refresh-token",
        spine_patient_sess_iat: String(stalePast),
      });
      const response = await refreshWithCookie(request);

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "session_expired",
      });
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_sess=;");
      expect(setCookie).toContain("spine_patient_audit_actor=;");
    });

    // Regression: a failed refresh used to clear the CSRF cookie along with the
    // auth cookies (via clearAuthCookies) and never reissue it. That left an
    // unauthenticated browser with NO CSRF cookie at all, so the very next
    // login/register attempt — the only way out of this state — failed
    // validateAuthMutation's csrf_missing check before it ever reached the
    // backend. The CSRF cookie is not an authentication credential; it is
    // exactly what an unauthenticated client needs to log in or register, so
    // every failure path below must reissue it.
    describe("CSRF reissue on failure (regression)", () => {
      it("reissues a real CSRF cookie when the refresh cookie is missing", async () => {
        const request = makeRequest({});
        const response = await refreshWithCookie(request);

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: "refresh_token_missing",
        });
        expect(mockedBackendFetch).not.toHaveBeenCalled();
        expect(clearedCookieNames(response)).not.toContain(
          "spine_patient_csrf",
        );
        const csrfCookie = response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("spine_patient_csrf="));
        expect(csrfCookie).toBeDefined();
        expect(csrfCookie).not.toMatch(/^spine_patient_csrf=;/);
      });

      it("reissues a real CSRF cookie when the absolute session lifetime is exceeded", async () => {
        const stalePast = Math.floor(Date.now() / 1000) - 13 * 60 * 60;
        const request = makeRequest({
          spine_patient_refresh: "valid-refresh-token",
          spine_patient_sess_iat: String(stalePast),
        });
        const response = await refreshWithCookie(request);

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: "session_expired",
        });
        expect(clearedCookieNames(response)).not.toContain(
          "spine_patient_csrf",
        );
        const csrfCookie = response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("spine_patient_csrf="));
        expect(csrfCookie).toBeDefined();
        expect(csrfCookie).not.toMatch(/^spine_patient_csrf=;/);
      });

      it("reissues a real CSRF cookie when the backend refuses the refresh", async () => {
        mockedBackendFetch.mockResolvedValue(
          Response.json({ error: "token_invalid" }, { status: 401 }),
        );

        const request = makeRequest({
          spine_patient_refresh: "stale-refresh-token",
          spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
        });
        const response = await refreshWithCookie(request);

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: "refresh_failed",
        });
        expect(clearedCookieNames(response)).not.toContain(
          "spine_patient_csrf",
        );
        const csrfCookie = response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("spine_patient_csrf="));
        expect(csrfCookie).toBeDefined();
        expect(csrfCookie).not.toMatch(/^spine_patient_csrf=;/);
      });

      // A rejected credential is exactly when the client is about to try again,
      // so this path must leave it able to. Clearing the token here turned one
      // mistyped password — or one failed registration — into a form that could
      // no longer submit at all.
      it("reissues a real CSRF cookie when the backend rejects the credential", async () => {
        mockedBackendFetch.mockResolvedValue(
          Response.json({ error: "invalid_credentials" }, { status: 401 }),
        );

        const response = await forwardCredentialAuth("/api/v1/auth/login", {
          email: "patient@example.test",
          password: "wrong",
        });

        expect(response.status).toBe(401);
        expect(clearedCookieNames(response)).not.toContain(
          "spine_patient_csrf",
        );
        const csrfCookie = response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("spine_patient_csrf="));
        expect(csrfCookie).toBeDefined();
        expect(csrfCookie).not.toMatch(/^spine_patient_csrf=;/);
      });

      it("reissues a real CSRF cookie when a registration attempt is refused", async () => {
        mockedBackendFetch.mockResolvedValue(
          Response.json({ detail: "conflict" }, { status: 409 }),
        );

        const response = await forwardCredentialAuth(
          "/api/v1/auth/register/patient",
          { email: "patient@example.test", password: "redacted" },
          undefined,
          { errorMode: "registration" },
        );

        expect(response.status).toBe(409);
        expect(clearedCookieNames(response)).not.toContain(
          "spine_patient_csrf",
        );
        const csrfCookie = response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("spine_patient_csrf="));
        expect(csrfCookie).toBeDefined();
        expect(csrfCookie).not.toMatch(/^spine_patient_csrf=;/);
      });
    });
  });

  // ── logoutWithCookie ───────────────────────────────────────────────────────

  describe("logoutWithCookie", () => {
    it("returns 200 success and clears cookies on successful backend logout", async () => {
      mockedBackendFetch.mockResolvedValue(new Response(null, { status: 200 }));

      const request = makeRequest({ spine_patient_sess: "access-token" });
      const response = await logoutWithCookie(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_sess=;");
      expect(setCookie).toContain("spine_patient_refresh=;");
      expect(setCookie).toContain("spine_patient_audit_actor=;");
    });

    it("returns 502 logout_backend_failed and clears cookies when backend returns non-OK", async () => {
      mockedBackendFetch.mockResolvedValue(new Response(null, { status: 503 }));

      const request = makeRequest({ spine_patient_sess: "access-token" });
      const response = await logoutWithCookie(request);

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: "logout_backend_failed",
      });
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_sess=;");
    });

    it("returns 502 and clears cookies when BackendUnavailableError is thrown", async () => {
      mockedBackendFetch.mockRejectedValue(new BackendUnavailableError());

      const request = makeRequest({ spine_patient_sess: "access-token" });
      const response = await logoutWithCookie(request);

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: "logout_backend_failed",
      });
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_sess=;");
    });

    it("returns 200 success and clears cookies when no access token cookie is present", async () => {
      const request = makeRequest({});
      const response = await logoutWithCookie(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ success: true });
      expect(mockedBackendFetch).not.toHaveBeenCalled();
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_sess=;");
    });

    // Regression: logoutWithCookie clears the CSRF cookie (via clearAuthCookies)
    // on every path — already-logged-out, backend-failure, and success — but
    // never reissued it. A patient who logs out and logs back in without a hard
    // navigation was stuck behind csrf_missing on the very next login/register
    // submission. clearedCookieNames() only proves the cookie was *cleared*; a
    // deletion (`spine_patient_csrf=;` with Max-Age=0) also matches the
    // substring `spine_patient_csrf=`, so these assertions must find a
    // Set-Cookie for that name that is NOT a deletion.
    describe("CSRF reissue on logout (regression)", () => {
      it("reissues a real CSRF cookie on successful logout", async () => {
        mockedBackendFetch.mockResolvedValue(
          new Response(null, { status: 200 }),
        );

        const request = makeRequest({ spine_patient_sess: "access-token" });
        const response = await logoutWithCookie(request);

        expect(response.status).toBe(200);
        expect(clearedCookieNames(response)).not.toContain(
          "spine_patient_csrf",
        );
        const csrfCookie = response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("spine_patient_csrf="));
        expect(csrfCookie).toBeDefined();
        expect(csrfCookie).not.toMatch(/^spine_patient_csrf=;/);
      });

      it("reissues a real CSRF cookie when the backend logout call fails (502)", async () => {
        mockedBackendFetch.mockResolvedValue(
          new Response(null, { status: 503 }),
        );

        const request = makeRequest({ spine_patient_sess: "access-token" });
        const response = await logoutWithCookie(request);

        expect(response.status).toBe(502);
        expect(clearedCookieNames(response)).not.toContain(
          "spine_patient_csrf",
        );
        const csrfCookie = response.headers
          .getSetCookie()
          .find((cookie) => cookie.startsWith("spine_patient_csrf="));
        expect(csrfCookie).toBeDefined();
        expect(csrfCookie).not.toMatch(/^spine_patient_csrf=;/);
      });
    });
  });

  // ── clearAccountTransitionState ────────────────────────────────────────────

  describe("clearAccountTransitionState", () => {
    // clearAccountTransitionState is invoked on every validateAuthMutation
    // failure and on the rate-limit / malformed-JSON / backend-unavailable
    // paths of login, register, and MFA verify. All of those are failure
    // responses the caller builds locally (not a wrapped success response from
    // forwardCredentialAuth), so reissuing the CSRF cookie here is correct for
    // every current caller: the client's only next move is to retry the
    // mutation, and it needs a live CSRF token to do that.
    it("reissues a real CSRF cookie alongside the auth/MFA cookie wipe", () => {
      const response = clearAccountTransitionState(
        jsonNoStore({ error: "too_many_requests" }, { status: 429 }),
      );

      expect(response.status).toBe(429);
      const cleared = clearedCookieNames(response);
      expect(cleared).toContain("spine_patient_sess");
      expect(cleared).not.toContain("spine_patient_csrf");
      const csrfCookie = response.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("spine_patient_csrf="));
      expect(csrfCookie).toBeDefined();
      expect(csrfCookie).not.toMatch(/^spine_patient_csrf=;/);
    });
  });

  // ── sessionFromCookie ──────────────────────────────────────────────────────

  describe("sessionFromCookie", () => {
    it("propagates BackendUnavailableError so the route handler can return 503", async () => {
      mockedBackendFetch.mockRejectedValue(new BackendUnavailableError());

      // Must include the access token so the code reaches the backendFetch call.
      const request = makeRequest({ spine_patient_sess: "valid-access-token" });
      await expect(sessionFromCookie(request)).rejects.toThrow(
        BackendUnavailableError,
      );
    });

    it("returns 401 and issues a new CSRF cookie when backend returns non-OK", async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ error: "token_expired" }, { status: 401 }),
      );

      const request = makeRequest({
        spine_patient_sess: "expired-access-token",
      });
      const response = await sessionFromCookie(request);

      expect(response.status).toBe(401);
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_csrf=");
    });

    it("returns 200 with session data when backend returns OK", async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ user_id: actorId, email: "patient@example.test" }),
      );

      const request = makeRequest(
        boundSessionCookies(actorId, "valid-access-token"),
      );
      const response = await sessionFromCookie(request);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        user_id: actorId,
        email: "patient@example.test",
      });
      const setCookie = response.headers.getSetCookie().join("\n");
      expect(setCookie).toContain("spine_patient_csrf=");
    });

    // A probe that finds the access credential gone or rejected has learned
    // nothing about the refresh token. Destroying the renewal pair here is what
    // forced a full re-login after any background gap longer than the 15-minute
    // access cookie, so both expiry branches must leave it standing.
    it("keeps the refresh credential when the access cookie has lapsed", async () => {
      const request = makeRequest({
        spine_patient_refresh: "still-valid-refresh-token",
        spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
      });
      const response = await sessionFromCookie(request);

      expect(response.status).toBe(401);
      expect(mockedBackendFetch).not.toHaveBeenCalled();
      expect(clearedCookieNames(response)).toEqual(
        new Set(["spine_patient_sess", "spine_patient_audit_actor"]),
      );
    });

    it("keeps the refresh credential when the backend rejects the access token", async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ error: "token_expired" }, { status: 401 }),
      );

      const request = makeRequest({
        ...boundSessionCookies(actorId, "expired-access-token"),
        spine_patient_refresh: "still-valid-refresh-token",
      });
      const response = await sessionFromCookie(request);

      expect(response.status).toBe(401);
      expect(clearedCookieNames(response)).toEqual(
        new Set(["spine_patient_sess", "spine_patient_audit_actor"]),
      );
    });

    // An actor mismatch is a session integrity failure, not an expiry — the
    // full wipe must survive the narrowing above.
    it("clears the whole cookie set when the bound actor does not match the backend", async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ user_id: "20000000-0000-4000-8000-000000000002" }),
      );

      const request = makeRequest({
        ...boundSessionCookies(actorId, "valid-access-token"),
        spine_patient_refresh: "refresh-token",
      });
      const response = await sessionFromCookie(request);

      expect(response.status).toBe(401);
      expect(clearedCookieNames(response)).toContain("spine_patient_refresh");
      expect(clearedCookieNames(response)).toContain("spine_patient_sess_iat");
    });
  });
});

describe("browser user-agent forwarding on credential auth", () => {
  beforeEach(() => {
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "test-patient-web-csrf-secret-at-least-32-bytes",
    );
    mockedBackendFetch.mockReset();
  });

  it("forwards the browser User-Agent to the backend login call", async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({}, { status: 401 }));
    const browserUa =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36";
    const request = new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "user-agent": browserUa },
    });

    await forwardCredentialAuth(
      "/api/v1/auth/login",
      { email: "patient@example.test", password: "redacted" },
      request,
    );

    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("user-agent")).toBe(browserUa);
  });

  it("sends no User-Agent header when no browser request is available", async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({}, { status: 401 }));

    await forwardCredentialAuth("/api/v1/auth/login", {
      email: "patient@example.test",
      password: "redacted",
    });

    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("user-agent")).toBeNull();
  });
});
