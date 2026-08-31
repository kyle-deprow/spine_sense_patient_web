import { describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import {
  COOKIE_NAMES,
  accessCookieOptions,
  auditActorCookieOptions,
  clearAuthCookies,
  csrfCookieOptions,
  issueAuthenticatedSessionCookies,
  legacyRefreshCookieOptions,
  refreshCookieOptions,
  signAuditActorCookie,
  shouldUseSecureCookies,
  verifyAuditActorCookie,
} from "@/lib/auth/cookies";

const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const ACCESS_TOKEN = "opaque-access-token";
const ISSUED_AT = Math.floor(Date.now() / 1000);
const CURRENT_KEY = {
  id: "current-key",
  secret: "current-test-signing-secret-at-least-32-bytes",
};
const PREVIOUS_KEY = {
  id: "previous-key",
  secret: "previous-test-signing-secret-at-least-32-bytes",
};
const KEY_RING = { current: CURRENT_KEY, previous: PREVIOUS_KEY };

type BrowserCookie = { name: string; value: string; path: string };

function applyRefreshSetCookies(
  jar: BrowserCookie[],
  response: Response,
): void {
  for (const setCookie of response.headers.getSetCookie()) {
    const [pair, ...attributes] = setCookie.split(";");
    if (!pair) continue;
    const separator = pair?.indexOf("=") ?? -1;
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const path =
      attributes
        .find((attribute) => attribute.trim().toLowerCase().startsWith("path="))
        ?.trim()
        .slice("Path=".length) ?? "/";
    const maxAge = attributes
      .find((attribute) =>
        attribute.trim().toLowerCase().startsWith("max-age="),
      )
      ?.trim()
      .slice("Max-Age=".length);
    const sameCookie = (cookie: BrowserCookie) =>
      cookie.name === name && cookie.path === path;
    if (maxAge === "0") {
      for (let index = jar.length - 1; index >= 0; index -= 1) {
        const cookie = jar[index];
        if (cookie && sameCookie(cookie)) jar.splice(index, 1);
      }
    } else {
      for (let index = jar.length - 1; index >= 0; index -= 1) {
        const cookie = jar[index];
        if (cookie && sameCookie(cookie)) jar.splice(index, 1);
      }
      jar.push({ name, value, path });
    }
  }
}

describe("patient web cookie helpers", () => {
  it("uses HttpOnly same-site access cookies", () => {
    const options = accessCookieOptions();

    expect(COOKIE_NAMES.access).toBe("spine_patient_sess");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("lax");
    expect(options.path).toBe("/api");
    expect(options.maxAge).toBeLessThanOrEqual(15 * 60);
  });

  it("does not scope backend credential cookies to direct websocket paths", () => {
    expect(accessCookieOptions().path).toBe("/api");
    expect(auditActorCookieOptions().path).toBe("/api");
    expect(refreshCookieOptions().path).toBe("/api/auth");
    expect(accessCookieOptions().path).not.toBe("/");
    expect(auditActorCookieOptions().path).not.toBe("/");
  });

  it("path-scopes refresh cookies to the common auth prefix", () => {
    const options = refreshCookieOptions();

    expect(COOKIE_NAMES.refresh).toBe("spine_patient_refresh");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("strict");
    expect(options.path).toBe("/api/auth");
    expect(options.maxAge).toBeLessThanOrEqual(7 * 24 * 60 * 60);

    // RFC 6265 path matching: the browser sends this cookie to both BFF auth
    // endpoints, but not to an adjacent prefix or a non-auth API route.
    const browserSendsToPath = (requestPath: string) =>
      requestPath === options.path ||
      requestPath.startsWith(`${options.path}/`);
    expect(browserSendsToPath("/api/auth/refresh")).toBe(true);
    expect(browserSendsToPath("/api/auth/logout-all")).toBe(true);
    expect(browserSendsToPath("/api/authz/logout-all")).toBe(false);
    expect(browserSendsToPath("/api/patients/me")).toBe(false);
  });

  it("keeps the legacy refresh path explicit for the staged browser migration", () => {
    const options = legacyRefreshCookieOptions();

    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("strict");
    expect(options.path).toBe("/api/auth/refresh");
    expect(options.maxAge).toBeLessThanOrEqual(7 * 24 * 60 * 60);

    // Deployment/order contract: ship the BFF that expires this path before
    // relying on the new /api/auth cookie at logout-all.
    expect("/api/auth/logout-all".startsWith(`${options.path}/`)).toBe(false);
  });

  it("uses the common auth path when clearing the refresh cookie", () => {
    const response = NextResponse.json({ success: true });

    clearAuthCookies(response);

    const refreshDeletion = response.headers
      .getSetCookie()
      .find((cookie) => cookie.startsWith(`${COOKIE_NAMES.refresh}=;`));
    expect(refreshDeletion).toContain("Path=/api/auth");

    const refreshDeletions = response.headers
      .getSetCookie()
      .filter((cookie) => cookie.startsWith(`${COOKIE_NAMES.refresh}=;`));
    expect(refreshDeletions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Path=/api/auth;"),
        expect.stringContaining("Path=/api/auth/refresh;"),
      ]),
    );
  });

  it("migrates and then clears duplicate browser refresh cookies by exact path", () => {
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "test-patient-web-csrf-secret-at-least-32-bytes",
    );
    const jar: BrowserCookie[] = [
      {
        name: COOKIE_NAMES.refresh,
        value: "legacy-token",
        path: "/api/auth/refresh",
      },
      {
        name: COOKIE_NAMES.refresh,
        value: "old-current-token",
        path: "/api/auth",
      },
    ];
    const issued = NextResponse.json({ success: true });
    issueAuthenticatedSessionCookies(issued, {
      accessToken: "new-access-token",
      refreshToken: "new-current-token",
      actorId: ACTOR_ID,
      issuedAt: ISSUED_AT,
    });

    applyRefreshSetCookies(jar, issued);
    expect(
      jar.filter((cookie) => cookie.name === COOKIE_NAMES.refresh),
    ).toEqual([
      {
        name: COOKIE_NAMES.refresh,
        value: "new-current-token",
        path: "/api/auth",
      },
    ]);

    const cleared = NextResponse.json({ success: true });
    clearAuthCookies(cleared);
    applyRefreshSetCookies(jar, cleared);
    expect(
      jar.filter((cookie) => cookie.name === COOKIE_NAMES.refresh),
    ).toEqual([]);
  });

  it("keeps only the csrf cookie readable by browser JavaScript", () => {
    expect(csrfCookieOptions().httpOnly).toBe(false);
    expect(accessCookieOptions().httpOnly).toBe(true);
    expect(refreshCookieOptions().httpOnly).toBe(true);
    expect(auditActorCookieOptions().httpOnly).toBe(true);
  });

  it("uses a strict same-site session-scoped audit actor cookie", () => {
    const options = auditActorCookieOptions();

    expect(COOKIE_NAMES.auditActor).toBe("spine_patient_audit_actor");
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe("strict");
    expect(options.path).toBe("/api");
    expect(options.maxAge).toBe(12 * 60 * 60);
  });

  it("signs and verifies only UUID audit actors", () => {
    const signed = signAuditActorCookie(
      ACTOR_ID.toUpperCase(),
      ACCESS_TOKEN,
      ISSUED_AT,
      CURRENT_KEY,
    );

    expect(signed).toMatch(
      /^v2\.current-key\.[0-9a-f-]+\.[0-9]{10}\.sess_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/,
    );
    expect(
      verifyAuditActorCookie(signed, ACCESS_TOKEN, String(ISSUED_AT), KEY_RING),
    ).toBe(ACTOR_ID);
    expect(
      signAuditActorCookie(
        "patient@example.test",
        ACCESS_TOKEN,
        ISSUED_AT,
        CURRENT_KEY,
      ),
    ).toBeUndefined();
  });

  it("binds the actor to the access token and session issued-at", () => {
    const signed = signAuditActorCookie(
      ACTOR_ID,
      ACCESS_TOKEN,
      ISSUED_AT,
      CURRENT_KEY,
    );
    expect(signed).toBeDefined();

    expect(
      verifyAuditActorCookie(
        `${signed}x`,
        ACCESS_TOKEN,
        String(ISSUED_AT),
        KEY_RING,
      ),
    ).toBeUndefined();
    expect(
      verifyAuditActorCookie(
        signed,
        "different-access-token",
        String(ISSUED_AT),
        KEY_RING,
      ),
    ).toBeUndefined();
    expect(
      verifyAuditActorCookie(
        signed,
        ACCESS_TOKEN,
        String(ISSUED_AT - 1),
        KEY_RING,
      ),
    ).toBeUndefined();
  });

  it("accepts an explicitly configured previous key by ID during rotation", () => {
    const signed = signAuditActorCookie(
      ACTOR_ID,
      ACCESS_TOKEN,
      ISSUED_AT,
      PREVIOUS_KEY,
    );

    expect(
      verifyAuditActorCookie(signed, ACCESS_TOKEN, String(ISSUED_AT), KEY_RING),
    ).toBe(ACTOR_ID);
    expect(
      verifyAuditActorCookie(signed, ACCESS_TOKEN, String(ISSUED_AT), {
        current: CURRENT_KEY,
      }),
    ).toBeUndefined();
  });

  it("uses secure cookies outside development; allows insecure only for local E2E", () => {
    expect(shouldUseSecureCookies("production")).toBe(true);
    expect(shouldUseSecureCookies("test")).toBe(true);

    // The Make-managed standalone BFF runs with NODE_ENV=production, but only
    // allows insecure cookies when explicitly scoped to local HTTP origins.
    expect(
      shouldUseSecureCookies(
        "production",
        "false",
        "true",
        "http://127.0.0.1:43101",
      ),
    ).toBe(false);
    expect(
      shouldUseSecureCookies(
        "development",
        "false",
        "true",
        "http://127.0.0.1:43101",
      ),
    ).toBe(false);
    expect(shouldUseSecureCookies("development", "false")).toBe(false);
  });

  it("ignores the insecure cookie override in production without the E2E guard", () => {
    expect(
      shouldUseSecureCookies(
        "production",
        "false",
        "",
        "http://127.0.0.1:43101",
      ),
    ).toBe(true);
  });

  it("throws when PATIENT_WEB_E2E_ALLOW_INSECURE_COOKIES is set in production for non-local origins", () => {
    expect(() =>
      shouldUseSecureCookies(
        "production",
        "false",
        "true",
        "https://patient.example.com",
      ),
    ).toThrow(
      "PATIENT_WEB_E2E_ALLOW_INSECURE_COOKIES must not be set in production",
    );
  });
});
