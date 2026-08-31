import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createCsrfToken, CSRF_HEADER } from "@/lib/auth/csrf";
import { COOKIE_NAMES, signAuditActorCookie } from "@/lib/auth/cookies";
import { auditLog, sessionCorrelationFromToken } from "@/lib/server/audit";
import { BackendUnavailableError, backendFetch } from "@/lib/server/backend";

vi.mock("@/lib/server/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/backend")>();
  return {
    ...actual,
    backendFetch: vi.fn(),
  };
});

vi.mock("@/lib/server/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/audit")>();
  return { ...actual, auditLog: vi.fn() };
});

const mockedBackendFetch = vi.mocked(backendFetch);
const mockedAuditLog = vi.mocked(auditLog);

const CSRF_SECRET = "test-patient-web-csrf-secret-at-least-32-bytes";
const ORIGIN = "http://localhost";
const ACTOR_ID = "10000000-0000-4000-8000-000000000001";
const ACCESS_TOKEN = "existing-private-access-token";
const SIGNING_KEY = {
  id: "test-current",
  secret: "patient-web-test-actor-signing-key-32-bytes",
};

// Import after mocking so the route module picks up the mocked dependencies.
const { DELETE, GET, PATCH, POST, PUT } =
  await import("@/app/api/auth/[...path]/route");

function makeAuthRequest(
  pathname: string,
  body: unknown = {},
  options: {
    method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
    accessToken?: string;
    refreshToken?: string;
    sessionIssuedAt?: number;
    auditActorId?: string;
    registrationVerificationToken?: string;
    extraCookies?: readonly string[];
    origin?: string;
    userAgent?: string;
  } = {},
): NextRequest {
  const method = options.method ?? "POST";
  const origin = options.origin ?? ORIGIN;
  const csrf = createCsrfToken(CSRF_SECRET, "auth-route-test-nonce");
  const cookies = [`spine_patient_csrf=${csrf}`];
  if (options.accessToken)
    cookies.push(`spine_patient_sess=${options.accessToken}`);
  if (options.refreshToken)
    cookies.push(`spine_patient_refresh=${options.refreshToken}`);
  if (options.registrationVerificationToken) {
    cookies.push(
      `${COOKIE_NAMES.registrationVerification}=${options.registrationVerificationToken}`,
    );
  }
  if (options.extraCookies) cookies.push(...options.extraCookies);
  if (options.sessionIssuedAt !== undefined) {
    cookies.push(`spine_patient_sess_iat=${options.sessionIssuedAt}`);
  }
  if (options.auditActorId && options.accessToken) {
    const issuedAt = options.sessionIssuedAt ?? Math.floor(Date.now() / 1000);
    if (options.sessionIssuedAt === undefined)
      cookies.push(`spine_patient_sess_iat=${issuedAt}`);
    cookies.push(
      `spine_patient_audit_actor=${signAuditActorCookie(options.auditActorId, options.accessToken, issuedAt, SIGNING_KEY)}`,
    );
  }

  const init = {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: cookies.join("; "),
      [CSRF_HEADER]: csrf,
      Origin: origin,
      ...(options.userAgent ? { "user-agent": options.userAgent } : {}),
    },
  };
  return new NextRequest(
    `${origin}${pathname}`,
    method === "GET" ? init : { ...init, body: JSON.stringify(body) },
  );
}

type BrowserCookie = { value: string; path: string };

function makeBrowserCookieJar(
  accessToken: string,
  refreshToken: string,
  csrfToken: string,
): Map<string, BrowserCookie> {
  return new Map([
    [COOKIE_NAMES.access, { value: accessToken, path: "/api" }],
    [COOKIE_NAMES.refresh, { value: refreshToken, path: "/api/auth" }],
    [
      COOKIE_NAMES.sessionIssuedAt,
      { value: String(Math.floor(Date.now() / 1000)), path: "/api" },
    ],
    [COOKIE_NAMES.csrf, { value: csrfToken, path: "/" }],
  ]);
}

function browserPathMatches(cookiePath: string, requestPath: string): boolean {
  if (cookiePath === requestPath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

function browserCookieHeader(
  jar: Map<string, BrowserCookie>,
  requestPath: string,
): string {
  return [...jar.entries()]
    .filter(([, cookie]) => browserPathMatches(cookie.path, requestPath))
    .map(([name, cookie]) => `${name}=${cookie.value}`)
    .join("; ");
}

function applySetCookies(
  jar: Map<string, BrowserCookie>,
  response: Response,
): void {
  for (const setCookie of response.headers.getSetCookie()) {
    const [pair, ...attributes] = setCookie.split(";");
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator < 1) continue;
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const pathAttribute = attributes.find((attribute) =>
      attribute.trim().toLowerCase().startsWith("path="),
    );
    const path = pathAttribute?.trim().slice("Path=".length) ?? "/";
    const maxAge = attributes
      .find((attribute) =>
        attribute.trim().toLowerCase().startsWith("max-age="),
      )
      ?.trim()
      .slice("Max-Age=".length);

    if (maxAge === "0") {
      const current = jar.get(name);
      if (current?.path === path) jar.delete(name);
      continue;
    }
    jar.set(name, { value, path });
  }
}

function makeBrowserAuthRequest(
  pathname: string,
  jar: Map<string, BrowserCookie>,
): NextRequest {
  const url = new URL(`http://localhost${pathname}`);
  const csrfToken = jar.get(COOKIE_NAMES.csrf)?.value;
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: browserCookieHeader(jar, url.pathname),
      [CSRF_HEADER]: csrfToken ?? "",
      Origin: ORIGIN,
    },
    body: JSON.stringify({}),
  });
}

function makeContext(pathSegments: string[]): {
  params: Promise<{ path: string[] }>;
} {
  return { params: Promise.resolve({ path: pathSegments }) };
}

function expectAuthCookiesCleared(response: Response): void {
  const setCookies = response.headers.getSetCookie();
  for (const name of [
    COOKIE_NAMES.access,
    COOKIE_NAMES.refresh,
    COOKIE_NAMES.sessionIssuedAt,
    COOKIE_NAMES.auditActor,
    COOKIE_NAMES.mfaTransaction,
    COOKIE_NAMES.mfaMethod,
    COOKIE_NAMES.mfaPending,
    COOKIE_NAMES.registrationVerification,
  ]) {
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${name}=;`) && cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);
  }

  expect(
    setCookies.some(
      (cookie) =>
        cookie.startsWith(`${COOKIE_NAMES.refresh}=;`) &&
        cookie.includes("Path=/api/auth;") &&
        cookie.includes("Max-Age=0"),
    ),
  ).toBe(true);
  expect(
    setCookies.some(
      (cookie) =>
        cookie.startsWith(`${COOKIE_NAMES.refresh}=;`) &&
        cookie.includes("Path=/api/auth/refresh") &&
        cookie.includes("Max-Age=0"),
    ),
  ).toBe(true);

  const csrfCookie = setCookies.find((cookie) =>
    cookie.startsWith(`${COOKIE_NAMES.csrf}=`),
  );
  expect(csrfCookie).toBeDefined();
  expect(csrfCookie).not.toContain("Max-Age=0");
}

describe("auth catch-all route handler", () => {
  beforeEach(() => {
    vi.stubEnv("PATIENT_WEB_CSRF_SECRET", CSRF_SECRET);
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", ORIGIN);
    mockedBackendFetch.mockReset();
    mockedAuditLog.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("audits an allowed registration verification call with a server request ID", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ success: true }, { status: 202 }),
    );

    const request = makeAuthRequest("/api/auth/verify/registration/send", {
      email: "patient@example.test",
    });
    const response = await POST(
      request,
      makeContext(["verify", "registration", "send"]),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        method: "POST",
        resourceType: "auth.registration_verification",
        status: 202,
        reason: "backend_success",
        requestId: expect.any(String),
      }),
    );

    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    const auditRecord = mockedAuditLog.mock.calls[0]?.[0];
    expect(headers.get("X-Request-Id")).toBe(auditRecord?.requestId);
    expect(headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("forwards the existing bearer token and audits only its HMAC correlation", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ success: true }, { status: 202 }),
    );

    const request = makeAuthRequest(
      "/api/auth/verify/send",
      { channel: "email" },
      { accessToken: ACCESS_TOKEN, auditActorId: ACTOR_ID },
    );
    const response = await POST(request, makeContext(["verify", "send"]));

    expect(response.status).toBe(202);
    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.email_verification",
        actorId: ACTOR_ID,
        sessionCorrelation: sessionCorrelationFromToken(ACCESS_TOKEN),
      }),
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      ACCESS_TOKEN,
    );
  });

  it("audits registration confirmation token issuance and sets boundary cookies", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        success: true,
        access_token: "issued-private-access-token",
        refresh_token: "issued-private-refresh-token",
      }),
    );
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({ user_id: ACTOR_ID }),
    );

    const request = makeAuthRequest("/api/auth/verify/registration/confirm", {
      email: "patient@example.test",
      code: "private-registration-code",
    });
    const response = await POST(
      request,
      makeContext(["verify", "registration", "confirm"]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });

    const setCookie = response.headers.getSetCookie().join("\n");
    expect(setCookie).toContain(
      "spine_patient_sess=issued-private-access-token",
    );
    expect(setCookie).toContain(
      "spine_patient_refresh=issued-private-refresh-token",
    );
    expect(setCookie).toContain("spine_patient_csrf=");
    expect(setCookie).toContain("spine_patient_sess_iat=");
    expect(setCookie).toContain("spine_patient_audit_actor=v2.test-current.");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("SameSite=strict");

    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.token.issued",
        method: "POST",
        resourceType: "auth.registration_verification",
        actorId: ACTOR_ID,
        status: 200,
        reason: "backend_token_pair",
        sessionCorrelation: sessionCorrelationFromToken(
          "issued-private-access-token",
        ),
      }),
    );

    const records = mockedAuditLog.mock.calls.map(([record]) => record);
    expect(records).toHaveLength(2);
    expect(records[0]?.requestId).toBe(records[1]?.requestId);
  });

  it("keeps token issuance audit records in production without routine success logs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "unavailable");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "redis");
    vi.stubEnv(
      "REDIS_URL",
      "rediss://:test-password@redis.example.test:6380/0",
    );
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        success: true,
        access_token: "issued-private-access-token",
        refresh_token: "issued-private-refresh-token",
      }),
    );
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({ user_id: ACTOR_ID }),
    );

    const request = makeAuthRequest(
      "/api/auth/verify/registration/confirm",
      {
        email: "patient@example.test",
        code: "private-registration-code",
      },
      { origin: "https://patient.example.test" },
    );
    const response = await POST(
      request,
      makeContext(["verify", "registration", "confirm"]),
    );

    expect(response.status).toBe(200);
    const records = mockedAuditLog.mock.calls.map(([record]) => record);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        event: "auth.token.issued",
        method: "POST",
        resourceType: "auth.registration_verification",
        actorId: ACTOR_ID,
        status: 200,
        reason: "backend_token_pair",
        sessionCorrelation: sessionCorrelationFromToken(
          "issued-private-access-token",
        ),
      }),
    );
    const auditOutput = JSON.stringify(mockedAuditLog.mock.calls);
    expect(auditOutput).not.toContain("patient@example.test");
    expect(auditOutput).not.toContain("private-registration-code");
    expect(auditOutput).not.toContain("issued-private-access-token");
    expect(auditOutput).not.toContain("issued-private-refresh-token");
  });

  it("audits generic verification token issuance without exposing tokens or PHI", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        success: true,
        access_token: "generic-private-access-token",
        refresh_token: "generic-private-refresh-token",
        user_id: ACTOR_ID,
      }),
    );

    const request = makeAuthRequest(
      "/api/auth/verify/confirm?return_to=patient@example.test",
      {
        email: "patient@example.test",
        code: "private-verification-code",
      },
    );
    const response = await POST(request, makeContext(["verify", "confirm"]));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(response.headers.getSetCookie().join("\n")).not.toContain(
      "spine_patient_sess=",
    );
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.token.issued",
        resourceType: "auth.email_verification",
        actorId: ACTOR_ID,
        status: 200,
        reason: "backend_token_pair",
        sessionCorrelation: sessionCorrelationFromToken(
          "generic-private-access-token",
        ),
      }),
    );

    const auditOutput = JSON.stringify(mockedAuditLog.mock.calls);
    expect(auditOutput).not.toContain("patient@example.test");
    expect(auditOutput).not.toContain("private-verification-code");
    expect(auditOutput).not.toContain("generic-private-access-token");
    expect(auditOutput).not.toContain("generic-private-refresh-token");
    expect(auditOutput).not.toContain("/api/auth/verify/confirm");
    expect(auditOutput).not.toContain("return_to");
  });

  it.each([
    ["password/reset", ["password", "reset"]],
    ["password/reset/confirm", ["password", "reset", "confirm"]],
  ])(
    "audits the allowed %s path under the password reset category",
    async (path, segments) => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ accepted: true }, { status: 202 }),
      );

      const response = await POST(
        makeAuthRequest(`/api/auth/${path}`, { secret: "private-reset-value" }),
        makeContext(segments),
      );

      expect(response.status).toBe(202);
      expect(mockedAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "auth.generic.allowed",
          resourceType: "auth.password_reset",
          status: 202,
          reason: "backend_success",
        }),
      );
      expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
        "private-reset-value",
      );
    },
  );

  it.each([
    ["setup", POST, "POST"],
    ["disable", DELETE, "DELETE"],
    ["methods", GET, "GET"],
  ] as const)(
    "audits the allowed MFA %s path",
    async (path, routeHandler, method) => {
      mockedBackendFetch.mockResolvedValue(Response.json({ success: true }));

      const response = await routeHandler(
        makeAuthRequest(
          `/api/auth/mfa/${path}`,
          { mfa_secret: "private-mfa-value" },
          { method, accessToken: ACCESS_TOKEN },
        ),
        makeContext(["mfa", path]),
      );

      expect(response.status).toBe(200);
      expect(mockedAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "auth.generic.allowed",
          method,
          resourceType: "auth.mfa",
          status: 200,
          reason: "backend_success",
          sessionCorrelation: sessionCorrelationFromToken(ACCESS_TOKEN),
        }),
      );
      expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
        "private-mfa-value",
      );
    },
  );

  it("proxies logout-all to the backend and clears the BFF session cookies", async () => {
    const backendAccessToken = "backend-private-access-token";
    const backendRefreshToken = "backend-private-refresh-token";
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        revoked: 3,
        access_token: backendAccessToken,
        refresh_token: backendRefreshToken,
        user_id: ACTOR_ID,
      }),
    );

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          accessToken: ACCESS_TOKEN,
          refreshToken: "current-refresh-cookie",
          extraCookies: [`${COOKIE_NAMES.refresh}=legacy-refresh-cookie`],
          auditActorId: ACTOR_ID,
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ revoked: 3 });
    expect(JSON.stringify(responseBody)).not.toContain(backendAccessToken);
    expect(JSON.stringify(responseBody)).not.toContain(backendRefreshToken);
    expectAuthCookiesCleared(response);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 200,
        reason: "confirmed_success",
      }),
    );
    expect(mockedAuditLog).toHaveBeenCalledTimes(1);

    const [backendPath, init] = mockedBackendFetch.mock.calls[0] ?? [];
    expect(backendPath).toBe("/api/v1/auth/logout-all");
    expect(init?.method).toBe("POST");
    await expect(new Response(init?.body).text()).resolves.toBe("{}");
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.get("Cookie")).toBeNull();
    expect(response.headers.getSetCookie().join("\n")).not.toContain(
      backendAccessToken,
    );
    expect(response.headers.getSetCookie().join("\n")).not.toContain(
      backendRefreshToken,
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      ACCESS_TOKEN,
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      backendRefreshToken,
    );
  });

  it("does not claim global revocation or clear cookies on backend 401", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json(
        {
          error: "private unauthorized detail",
          access_token: "private-unauthorized-token",
        },
        { status: 401 },
      ),
    );

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        { accessToken: ACCESS_TOKEN, auditActorId: ACTOR_ID },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "refresh_required",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedAuditLog).toHaveBeenCalledTimes(1);
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 401,
        reason: "unauthorized_global_revocation_unproven",
      }),
    );
    const auditOutput = JSON.stringify(mockedAuditLog.mock.calls);
    expect(auditOutput).not.toContain("private unauthorized detail");
    expect(auditOutput).not.toContain("private-unauthorized-token");
  });

  it("returns missing authentication without clearing cookies when access is absent", async () => {
    const response = await POST(
      makeAuthRequest("/api/auth/logout-all"),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "refresh_required",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledTimes(1);
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 401,
        reason: "missing_authentication",
      }),
    );
  });

  it("treats a browser carrying only the legacy refresh path as refresh-required", async () => {
    const csrfToken = createCsrfToken(CSRF_SECRET, "legacy-only-browser");
    const legacyOnlyJar = new Map<string, BrowserCookie>([
      [
        COOKIE_NAMES.refresh,
        { value: "legacy-refresh-token", path: "/api/auth/refresh" },
      ],
      [COOKIE_NAMES.csrf, { value: csrfToken, path: "/" }],
    ]);

    // Browser path matching intentionally omits the legacy cookie from
    // /logout-all. The patient app must perform its bounded /auth/refresh
    // migration request before retrying this route.
    const request = makeBrowserAuthRequest(
      "/api/auth/logout-all",
      legacyOnlyJar,
    );
    expect(request.headers.get("Cookie")).toBe(
      `${COOKIE_NAMES.csrf}=${csrfToken}`,
    );

    const response = await POST(request, makeContext(["logout-all"]));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "refresh_required",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "auth.logout_all",
        status: 401,
        reason: "missing_authentication",
      }),
    );
  });

  it("uses a valid refresh credential when access is missing before logout-all", async () => {
    const refreshedAccessToken = "missing-access-refreshed-token";
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({
          access_token: refreshedAccessToken,
          refresh_token: "missing-access-refreshed-refresh-token",
          token_type: "bearer",
          user_id: ACTOR_ID,
        }),
      )
      .mockResolvedValueOnce(Response.json({ revoked: 1 }));

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          refreshToken: "missing-access-refresh-token",
          sessionIssuedAt: Math.floor(Date.now() / 1000),
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: 1 });
    expectAuthCookiesCleared(response);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(2);
    expect(mockedBackendFetch.mock.calls[0]?.[0]).toBe("/api/v1/auth/refresh");
    expect(mockedBackendFetch.mock.calls[1]?.[0]).toBe(
      "/api/v1/auth/logout-all",
    );
    expect(
      new Headers(mockedBackendFetch.mock.calls[1]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${refreshedAccessToken}`);
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.token.issued",
        resourceType: "auth.logout_all",
        status: 200,
        actorId: ACTOR_ID,
        sessionCorrelation: sessionCorrelationFromToken(refreshedAccessToken),
        reason: "refresh_token_pair",
      }),
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 200,
        reason: "confirmed_success",
      }),
    ]);
    expect(mockedAuditLog).toHaveBeenCalledTimes(2);
  });

  it("preserves local state and returns a sanitized failure when logout-all fails", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json(
        {
          error: "private backend detail",
          access_token: "private-failure-access-token",
        },
        { status: 503 },
      ),
    );

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        { accessToken: ACCESS_TOKEN, auditActorId: ACTOR_ID },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedAuditLog).toHaveBeenCalledTimes(1);
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "private backend detail",
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "private-failure-access-token",
    );
  });

  it("preserves local state when the logout-all backend is unavailable", async () => {
    mockedBackendFetch.mockRejectedValue(new BackendUnavailableError());

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        { accessToken: ACCESS_TOKEN, auditActorId: ACTOR_ID },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedAuditLog).toHaveBeenCalledTimes(1);
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
    );
  });

  it("preserves retry state across backend failure and reaches the backend on retry", async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "private backend detail" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json({ revoked: 2 }));

    const requestOptions = {
      accessToken: ACCESS_TOKEN,
      auditActorId: ACTOR_ID,
      registrationVerificationToken: "registration-challenge",
      extraCookies: [
        `${COOKIE_NAMES.mfaTransaction}=mfa-transaction`,
        `${COOKIE_NAMES.mfaMethod}=mfa-method`,
        `${COOKIE_NAMES.mfaPending}=mfa-pending`,
      ],
    } as const;
    const firstResponse = await POST(
      makeAuthRequest("/api/auth/logout-all", {}, requestOptions),
      makeContext(["logout-all"]),
    );

    expect(firstResponse.status).toBe(503);
    await expect(firstResponse.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(firstResponse.headers.getSetCookie()).toEqual([]);

    const secondResponse = await POST(
      makeAuthRequest("/api/auth/logout-all", {}, requestOptions),
      makeContext(["logout-all"]),
    );

    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toEqual({ revoked: 2 });
    expectAuthCookiesCleared(secondResponse);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(2);
    const [retryPath, retryInit] = mockedBackendFetch.mock.calls[1] ?? [];
    expect(retryPath).toBe("/api/v1/auth/logout-all");
    expect(new Headers(retryInit?.headers).get("Authorization")).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 200,
        reason: "confirmed_success",
      }),
    ]);
  });

  it("preserves local state and sanitizes a bounded refresh backend failure", async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "unauthorized" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "private refresh backend detail",
            access_token: "private-refresh-failure-token",
          },
          { status: 503 },
        ),
      );

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          accessToken: "expired-private-access-token",
          refreshToken: "retryable-private-refresh-token",
          sessionIssuedAt: Math.floor(Date.now() / 1000),
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(2);
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
    ]);
    const auditOutput = JSON.stringify(mockedAuditLog.mock.calls);
    expect(auditOutput).not.toContain("private refresh backend detail");
    expect(auditOutput).not.toContain("private-refresh-failure-token");
  });

  it("returns a retryable sanitized response for a malformed logout-all 204", async () => {
    mockedBackendFetch.mockResolvedValue(new Response(null, { status: 204 }));

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        { accessToken: ACCESS_TOKEN, auditActorId: ACTOR_ID },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
    );
  });

  it("reissues a rotated pair from the trusted pre-rotation actor when logout retry fails", async () => {
    const rotatedAccessToken = "trusted-rotated-access-token";
    const rotatedRefreshToken = "trusted-rotated-refresh-token";
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "expired" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: rotatedAccessToken,
          refresh_token: rotatedRefreshToken,
          token_type: "bearer",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "private transient failure" }, { status: 503 }),
      );

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          accessToken: "expired-access-token",
          refreshToken: "single-use-refresh-token",
          sessionIssuedAt: Math.floor(Date.now() / 1000),
          auditActorId: ACTOR_ID,
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    const setCookies = response.headers.getSetCookie().join("\n");
    expect(setCookies).toContain(`spine_patient_sess=${rotatedAccessToken}`);
    expect(setCookies).toContain(
      `spine_patient_refresh=${rotatedRefreshToken}`,
    );
    expect(setCookies).not.toContain("expired-access-token");
    expect(mockedBackendFetch).toHaveBeenCalledTimes(3);
    expect(mockedBackendFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/logout-all",
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout-all",
    ]);
    expect(
      new Headers(mockedBackendFetch.mock.calls[2]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${rotatedAccessToken}`);
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.token.issued",
        resourceType: "auth.logout_all",
        actorId: ACTOR_ID,
        sessionCorrelation: sessionCorrelationFromToken(rotatedAccessToken),
        reason: "refresh_token_pair",
      }),
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
    ]);
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      rotatedAccessToken,
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      rotatedRefreshToken,
    );
  });

  it("reissues rotated cookies when the final logout-all response remains unauthorized", async () => {
    const rotatedAccessToken = "unauthorized-rotated-access-token";
    const rotatedRefreshToken = "unauthorized-rotated-refresh-token";
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "private initial authorization detail",
            access_token: "private-initial-access-token",
          },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: rotatedAccessToken,
          refresh_token: rotatedRefreshToken,
          token_type: "bearer",
          user_id: ACTOR_ID,
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          {
            error: "private final authorization detail",
            access_token: "private-final-access-token",
          },
          { status: 401 },
        ),
      );

    const request = makeAuthRequest(
      "/api/auth/logout-all",
      {},
      {
        accessToken: "expired-access-token",
        refreshToken: "single-use-refresh-token",
        sessionIssuedAt: Math.floor(Date.now() / 1000),
        auditActorId: ACTOR_ID,
        registrationVerificationToken: "registration-recovery-token",
        extraCookies: [`${COOKIE_NAMES.mfaTransaction}=mfa-recovery-token`],
      },
    );
    const initialCsrfToken = request.headers.get(CSRF_HEADER);
    const response = await POST(request, makeContext(["logout-all"]));

    expect(response.status).toBe(401);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ error: "logout_authorization_unproven" });
    const setCookies = response.headers.getSetCookie();
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.access}=${rotatedAccessToken}`) &&
          cookie.includes("HttpOnly"),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.refresh}=${rotatedRefreshToken}`) &&
          cookie.includes("Path=/api/auth;") &&
          cookie.includes("HttpOnly"),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.refresh}=;`) &&
          cookie.includes("Path=/api/auth/refresh") &&
          cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.refresh}=;`) &&
          cookie.includes("Path=/api/auth;") &&
          cookie.includes("Max-Age=0"),
      ),
    ).toBe(false);
    const csrfCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${COOKIE_NAMES.csrf}=`),
    );
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toContain("Max-Age=0");
    expect(csrfCookie?.split(";", 1)[0]?.split("=", 2)[1]).not.toBe(
      initialCsrfToken,
    );
    for (const name of [
      COOKIE_NAMES.access,
      COOKIE_NAMES.sessionIssuedAt,
      COOKIE_NAMES.auditActor,
      COOKIE_NAMES.mfaTransaction,
      COOKIE_NAMES.registrationVerification,
    ]) {
      expect(
        setCookies.some(
          (cookie) =>
            cookie.startsWith(`${name}=;`) && cookie.includes("Max-Age=0"),
        ),
      ).toBe(false);
    }

    expect(mockedBackendFetch).toHaveBeenCalledTimes(3);
    expect(mockedBackendFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/logout-all",
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout-all",
    ]);
    await expect(
      new Response(mockedBackendFetch.mock.calls[1]?.[1]?.body).json(),
    ).resolves.toEqual({ refresh_token: "single-use-refresh-token" });
    expect(
      new Headers(mockedBackendFetch.mock.calls[0]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe("Bearer expired-access-token");
    expect(
      new Headers(mockedBackendFetch.mock.calls[2]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${rotatedAccessToken}`);
    for (const [, init] of mockedBackendFetch.mock.calls) {
      expect(new Headers(init?.headers).get("Cookie")).toBeNull();
    }
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.token.issued",
        resourceType: "auth.logout_all",
        status: 200,
        actorId: ACTOR_ID,
        sessionCorrelation: sessionCorrelationFromToken(rotatedAccessToken),
        reason: "refresh_token_pair",
      }),
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 401,
        reason: "unauthorized_global_revocation_unproven",
      }),
    ]);
    const output = JSON.stringify({
      body: responseBody,
      audits: mockedAuditLog.mock.calls,
    });
    expect(output).not.toContain(rotatedAccessToken);
    expect(output).not.toContain(rotatedRefreshToken);
    expect(output).not.toContain("private final authorization detail");
  });

  it("reissues rotated cookies when the final logout-all transport fails", async () => {
    const rotatedAccessToken = "transport-rotated-access-token";
    const rotatedRefreshToken = "transport-rotated-refresh-token";
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "private initial failure" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: rotatedAccessToken,
          refresh_token: rotatedRefreshToken,
          token_type: "bearer",
          user_id: ACTOR_ID,
        }),
      )
      .mockRejectedValueOnce(new BackendUnavailableError());

    const request = makeAuthRequest(
      "/api/auth/logout-all",
      {},
      {
        accessToken: "transport-expired-access-token",
        refreshToken: "transport-single-use-refresh-token",
        sessionIssuedAt: Math.floor(Date.now() / 1000),
        auditActorId: ACTOR_ID,
        registrationVerificationToken: "transport-registration-token",
        extraCookies: [`${COOKIE_NAMES.mfaPending}=transport-mfa-token`],
      },
    );
    const initialCsrfToken = request.headers.get(CSRF_HEADER);
    const response = await POST(request, makeContext(["logout-all"]));

    expect(response.status).toBe(503);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ error: "service_unavailable" });
    const setCookies = response.headers.getSetCookie();
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.access}=${rotatedAccessToken}`) &&
          cookie.includes("HttpOnly"),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.refresh}=${rotatedRefreshToken}`) &&
          cookie.includes("Path=/api/auth;") &&
          cookie.includes("HttpOnly"),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.refresh}=;`) &&
          cookie.includes("Path=/api/auth/refresh") &&
          cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.refresh}=;`) &&
          cookie.includes("Path=/api/auth;") &&
          cookie.includes("Max-Age=0"),
      ),
    ).toBe(false);
    const csrfCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${COOKIE_NAMES.csrf}=`),
    );
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toContain("Max-Age=0");
    expect(csrfCookie?.split(";", 1)[0]?.split("=", 2)[1]).not.toBe(
      initialCsrfToken,
    );
    for (const name of [
      COOKIE_NAMES.access,
      COOKIE_NAMES.sessionIssuedAt,
      COOKIE_NAMES.auditActor,
      COOKIE_NAMES.mfaPending,
      COOKIE_NAMES.registrationVerification,
    ]) {
      expect(
        setCookies.some(
          (cookie) =>
            cookie.startsWith(`${name}=;`) && cookie.includes("Max-Age=0"),
        ),
      ).toBe(false);
    }

    expect(mockedBackendFetch).toHaveBeenCalledTimes(3);
    expect(mockedBackendFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/logout-all",
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout-all",
    ]);
    await expect(
      new Response(mockedBackendFetch.mock.calls[1]?.[1]?.body).json(),
    ).resolves.toEqual({
      refresh_token: "transport-single-use-refresh-token",
    });
    expect(
      new Headers(mockedBackendFetch.mock.calls[0]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe("Bearer transport-expired-access-token");
    expect(
      new Headers(mockedBackendFetch.mock.calls[2]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${rotatedAccessToken}`);
    for (const [, init] of mockedBackendFetch.mock.calls) {
      expect(new Headers(init?.headers).get("Cookie")).toBeNull();
    }
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.token.issued",
        resourceType: "auth.logout_all",
        status: 200,
        actorId: ACTOR_ID,
        sessionCorrelation: sessionCorrelationFromToken(rotatedAccessToken),
        reason: "refresh_token_pair",
      }),
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
    ]);
    const output = JSON.stringify({
      body: responseBody,
      audits: mockedAuditLog.mock.calls,
    });
    expect(output).not.toContain(rotatedAccessToken);
    expect(output).not.toContain(rotatedRefreshToken);
    expect(output).not.toContain("private initial failure");
  });

  it("clears all cookies when logout-all confirms revocation with missing refresh user metadata", async () => {
    const rotatedAccessToken = "metadata-missing-access-token";
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "expired" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: rotatedAccessToken,
          refresh_token: "metadata-missing-refresh-token",
          token_type: "bearer",
        }),
      )
      .mockResolvedValueOnce(Response.json({ revoked: 1 }, { status: 200 }));

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          accessToken: "expired-access-token",
          refreshToken: "single-use-refresh-token",
          sessionIssuedAt: Math.floor(Date.now() / 1000),
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ revoked: 1 });
    expectAuthCookiesCleared(response);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(3);
    expect(
      new Headers(mockedBackendFetch.mock.calls[2]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${rotatedAccessToken}`);
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 200,
        reason: "confirmed_success",
      }),
    ]);
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      rotatedAccessToken,
    );
  });

  it("expires consumed state and revokes a partial rotation once when safe reissue is impossible", async () => {
    const partialAccessToken = "partial-rotated-access-token";
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "expired" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({ access_token: partialAccessToken }, { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          accessToken: "expired-access-token",
          refreshToken: "single-use-refresh-token",
          sessionIssuedAt: Math.floor(Date.now() / 1000),
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "logout_recovery_required",
    });
    expectAuthCookiesCleared(response);
    expect(mockedBackendFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/logout-all",
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout",
    ]);
    expect(
      new Headers(mockedBackendFetch.mock.calls[2]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${partialAccessToken}`);
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      partialAccessToken,
    );
  });

  it.each([
    [
      "partial token pair",
      Response.json({ access_token: "browser-partial-access-token" }),
      [
        "/api/v1/auth/logout-all",
        "/api/v1/auth/refresh",
        "/api/v1/auth/logout",
      ],
    ],
    [
      "204 rotation response",
      new Response(null, { status: 204 }),
      ["/api/v1/auth/logout-all", "/api/v1/auth/refresh"],
    ],
  ] as const)(
    "browser retry normalizes a consumed %s with bounded calls and no leaked state",
    async (_case, rotationResponse, expectedPaths) => {
      mockedBackendFetch.mockResolvedValueOnce(
        Response.json({ error: "expired" }, { status: 401 }),
      );
      mockedBackendFetch.mockResolvedValueOnce(rotationResponse);
      if (expectedPaths.length === 3) {
        mockedBackendFetch.mockResolvedValueOnce(
          new Response(null, { status: 200 }),
        );
      }

      const jar = makeBrowserCookieJar(
        "browser-expired-access-token",
        "browser-spent-refresh-token",
        createCsrfToken(CSRF_SECRET, `browser-${_case}`),
      );
      const response = await POST(
        makeBrowserAuthRequest("/api/auth/logout-all", jar),
        makeContext(["logout-all"]),
      );

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "logout_recovery_required",
      });
      expectAuthCookiesCleared(response);
      applySetCookies(jar, response);
      expect(jar.has(COOKIE_NAMES.access)).toBe(false);
      expect(jar.has(COOKIE_NAMES.refresh)).toBe(false);
      expect(mockedBackendFetch.mock.calls.map(([path]) => path)).toEqual(
        expectedPaths,
      );
      for (const [, init] of mockedBackendFetch.mock.calls) {
        expect(new Headers(init?.headers).get("Cookie")).toBeNull();
      }
      const output = JSON.stringify(mockedAuditLog.mock.calls);
      expect(output).not.toContain("browser-partial-access-token");
      expect(output).not.toContain("browser-spent-refresh-token");
    },
  );

  it("does not reuse a rotated refresh token when refresh user_id is missing", async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "unauthorized" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: "rotated-access-token-must-not-be-used",
          refresh_token: "rotated-refresh-token-must-not-be-used",
          token_type: "bearer",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "private logout failure" }, { status: 503 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          accessToken: "expired-private-access-token",
          refreshToken: "single-use-refresh-token",
          sessionIssuedAt: Math.floor(Date.now() / 1000),
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "logout_recovery_required",
    });
    expectAuthCookiesCleared(response);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(4);
    expect(mockedBackendFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/logout-all",
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout-all",
      "/api/v1/auth/logout",
    ]);
    expect(
      new Headers(mockedBackendFetch.mock.calls[2]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe("Bearer rotated-access-token-must-not-be-used");
    expect(
      new Headers(mockedBackendFetch.mock.calls[3]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe("Bearer rotated-access-token-must-not-be-used");
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "logout_recovery_required",
      }),
    ]);
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "rotated-access-token-must-not-be-used",
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "rotated-refresh-token-must-not-be-used",
    );
  });

  it("applies rotated cookies to the next browser retry without reusing the refresh family", async () => {
    const accessTokenAfterFirstRefresh = "rotated-private-access-token";
    const refreshTokenAfterFirstRefresh = "rotated-private-refresh-token";
    const accessTokenAfterSecondRefresh = "second-rotated-private-access-token";
    const refreshTokenAfterSecondRefresh =
      "second-rotated-private-refresh-token";
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "unauthorized" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: accessTokenAfterFirstRefresh,
          refresh_token: refreshTokenAfterFirstRefresh,
          token_type: "bearer",
          user_id: ACTOR_ID,
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: "private transient logout failure" },
          { status: 503 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "unauthorized" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: accessTokenAfterSecondRefresh,
          refresh_token: refreshTokenAfterSecondRefresh,
          token_type: "bearer",
          user_id: ACTOR_ID,
        }),
      )
      .mockResolvedValueOnce(Response.json({ revoked: 2 }));

    const initialCsrfToken = createCsrfToken(
      CSRF_SECRET,
      "browser-retry-initial",
    );
    const jar = makeBrowserCookieJar(
      "expired-private-access-token",
      "first-family-private-refresh-token",
      initialCsrfToken,
    );
    const firstResponse = await POST(
      makeBrowserAuthRequest("/api/auth/logout-all", jar),
      makeContext(["logout-all"]),
    );

    expect(firstResponse.status).toBe(503);
    await expect(firstResponse.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(firstResponse.headers.getSetCookie()).not.toEqual([]);
    expect(
      firstResponse.headers
        .getSetCookie()
        .some((cookie) =>
          cookie.startsWith(
            `${COOKIE_NAMES.access}=${accessTokenAfterFirstRefresh}`,
          ),
        ),
    ).toBe(true);
    for (const cookie of firstResponse.headers
      .getSetCookie()
      .filter(
        (value) =>
          value.startsWith(`${COOKIE_NAMES.access}=`) ||
          value.startsWith(`${COOKIE_NAMES.refresh}=`),
      )) {
      expect(cookie).toContain("HttpOnly");
    }
    applySetCookies(jar, firstResponse);

    const rotatedCsrfToken = jar.get(COOKIE_NAMES.csrf)?.value;
    expect(rotatedCsrfToken).toBeDefined();
    expect(rotatedCsrfToken).not.toBe(initialCsrfToken);
    expect(jar.get(COOKIE_NAMES.access)?.value).toBe(
      accessTokenAfterFirstRefresh,
    );
    expect(jar.get(COOKIE_NAMES.refresh)?.value).toBe(
      refreshTokenAfterFirstRefresh,
    );
    expect(browserCookieHeader(jar, "/api/auth/logout-all")).toContain(
      `${COOKIE_NAMES.refresh}=${refreshTokenAfterFirstRefresh}`,
    );

    const secondRequest = makeBrowserAuthRequest("/api/auth/logout-all", jar);
    expect(secondRequest.headers.get(CSRF_HEADER)).toBe(rotatedCsrfToken);
    const secondResponse = await POST(
      secondRequest,
      makeContext(["logout-all"]),
    );

    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toEqual({ revoked: 2 });
    expectAuthCookiesCleared(secondResponse);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(6);
    expect(mockedBackendFetch.mock.calls.map(([path]) => path)).toEqual([
      "/api/v1/auth/logout-all",
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout-all",
      "/api/v1/auth/logout-all",
      "/api/v1/auth/refresh",
      "/api/v1/auth/logout-all",
    ]);

    await expect(
      new Response(mockedBackendFetch.mock.calls[1]?.[1]?.body).json(),
    ).resolves.toEqual({
      refresh_token: "first-family-private-refresh-token",
    });
    await expect(
      new Response(mockedBackendFetch.mock.calls[4]?.[1]?.body).json(),
    ).resolves.toEqual({
      refresh_token: refreshTokenAfterFirstRefresh,
    });
    expect(
      new Headers(mockedBackendFetch.mock.calls[3]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${accessTokenAfterFirstRefresh}`);
    expect(
      new Headers(mockedBackendFetch.mock.calls[5]?.[1]?.headers).get(
        "Authorization",
      ),
    ).toBe(`Bearer ${accessTokenAfterSecondRefresh}`);
    for (const [, init] of mockedBackendFetch.mock.calls) {
      expect(new Headers(init?.headers).get("Cookie")).toBeNull();
    }

    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.token.issued",
        resourceType: "auth.logout_all",
        status: 200,
        actorId: ACTOR_ID,
        sessionCorrelation: sessionCorrelationFromToken(
          accessTokenAfterFirstRefresh,
        ),
        reason: "refresh_token_pair",
      }),
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 503,
        reason: "retryable_backend_failure",
      }),
      expect.objectContaining({
        event: "auth.token.issued",
        resourceType: "auth.logout_all",
        status: 200,
        actorId: ACTOR_ID,
        sessionCorrelation: sessionCorrelationFromToken(
          accessTokenAfterSecondRefresh,
        ),
        reason: "refresh_token_pair",
      }),
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.logout_all",
        status: 200,
        reason: "confirmed_success",
      }),
    ]);
    const auditOutput = JSON.stringify(mockedAuditLog.mock.calls);
    for (const token of [
      accessTokenAfterFirstRefresh,
      refreshTokenAfterFirstRefresh,
      accessTokenAfterSecondRefresh,
      refreshTokenAfterSecondRefresh,
    ]) {
      expect(auditOutput).not.toContain(token);
    }
  });

  it("refreshes once after an expired access token and retries logout-all server-side", async () => {
    const refreshedAccessToken = "refreshed-private-access-token";
    const refreshedRefreshToken = "refreshed-private-refresh-token";
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "unauthorized" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({
          access_token: refreshedAccessToken,
          refresh_token: refreshedRefreshToken,
          token_type: "bearer",
          user_id: ACTOR_ID,
        }),
      )
      .mockResolvedValueOnce(Response.json({ revoked: 4 }));

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          accessToken: "expired-private-access-token",
          refreshToken: "valid-private-refresh-token",
          sessionIssuedAt: Math.floor(Date.now() / 1000),
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json();
    expect(responseBody).toEqual({ revoked: 4 });
    expect(JSON.stringify(responseBody)).not.toContain(refreshedAccessToken);
    expect(JSON.stringify(responseBody)).not.toContain(refreshedRefreshToken);
    expectAuthCookiesCleared(response);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(3);

    const [refreshPath, refreshInit] = mockedBackendFetch.mock.calls[1] ?? [];
    expect(refreshPath).toBe("/api/v1/auth/refresh");
    await expect(new Response(refreshInit?.body).json()).resolves.toEqual({
      refresh_token: "valid-private-refresh-token",
    });
    const [retryPath, retryInit] = mockedBackendFetch.mock.calls[2] ?? [];
    expect(retryPath).toBe("/api/v1/auth/logout-all");
    expect(new Headers(retryInit?.headers).get("Authorization")).toBe(
      `Bearer ${refreshedAccessToken}`,
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      refreshedAccessToken,
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      refreshedRefreshToken,
    );
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "auth.logout_all",
        status: 200,
        reason: "confirmed_success",
      }),
    );
    expect(mockedAuditLog).toHaveBeenCalledTimes(2);
  });

  it("preserves cookies and does not claim revocation when refresh is terminal", async () => {
    mockedBackendFetch
      .mockResolvedValueOnce(
        Response.json({ error: "unauthorized" }, { status: 401 }),
      )
      .mockResolvedValueOnce(
        Response.json({ error: "refresh token revoked" }, { status: 401 }),
      );

    const response = await POST(
      makeAuthRequest(
        "/api/auth/logout-all",
        {},
        {
          accessToken: "expired-private-access-token",
          refreshToken: "stale-private-refresh-token",
          sessionIssuedAt: Math.floor(Date.now() / 1000),
        },
      ),
      makeContext(["logout-all"]),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "refresh_required",
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedBackendFetch).toHaveBeenCalledTimes(2);
    expect(mockedAuditLog).toHaveBeenCalledTimes(1);
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "auth.logout_all",
        status: 401,
        reason: "unauthorized_global_revocation_unproven",
      }),
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "refresh token revoked",
    );
  });

  it.each([
    ["GET", GET],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ] as const)(
    "rejects non-POST logout-all requests for %s without forwarding or clearing cookies",
    async (method, routeHandler) => {
      const response = await routeHandler(
        makeAuthRequest(
          "/api/auth/logout-all",
          {},
          { method, accessToken: ACCESS_TOKEN },
        ),
        makeContext(["logout-all"]),
      );

      expect(response.status).toBe(405);
      expect(response.headers.get("Allow")).toBe("POST");
      await expect(response.json()).resolves.toEqual({
        error: "method_not_allowed",
      });
      expect(mockedBackendFetch).not.toHaveBeenCalled();
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(mockedAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "auth.generic.denied",
          resourceType: "auth.logout_all",
          status: 405,
          reason: "method_not_allowed",
        }),
      );
      expect(mockedAuditLog).toHaveBeenCalledTimes(1);
    },
  );

  it("denies logout-all without CSRF before forwarding or clearing cookies", async () => {
    const request = new NextRequest("http://localhost/api/auth/logout-all", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${COOKIE_NAMES.access}=${ACCESS_TOKEN}`,
        Origin: ORIGIN,
      },
      body: "{}",
    });

    const response = await POST(request, makeContext(["logout-all"]));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "csrf_missing" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog.mock.calls.map(([record]) => record)).toEqual([
      expect.objectContaining({
        event: "auth.generic.denied",
        resourceType: "auth.logout_all",
        status: 403,
        reason: "request_policy_denied",
      }),
    ]);
  });

  it("audits CSRF denial without forwarding the call", async () => {
    const request = new NextRequest("http://localhost/api/auth/verify/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
      },
      body: JSON.stringify({ email: "patient@example.test" }),
    });

    const response = await POST(request, makeContext(["verify", "send"]));

    expect(response.status).toBe(403);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ error: "csrf_missing" });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.denied",
        resourceType: "auth.email_verification",
        status: 403,
        reason: "request_policy_denied",
        requestId: expect.any(String),
      }),
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "patient@example.test",
    );
  });

  it("preserves the HttpOnly registration challenge and rotates CSRF after confirmation CSRF denial", async () => {
    const request = new NextRequest(
      "http://localhost/api/auth/verify/registration/confirm",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `${COOKIE_NAMES.registrationVerification}=private-registration-challenge-token`,
          Origin: ORIGIN,
        },
        body: JSON.stringify({ code: "private-registration-code" }),
      },
    );

    const response = await POST(
      request,
      makeContext(["verify", "registration", "confirm"]),
    );

    expect(response.status).toBe(403);
    const setCookies = response.headers.getSetCookie();
    expect(
      setCookies.some((cookie) =>
        cookie.startsWith(`${COOKIE_NAMES.registrationVerification}=;`),
      ),
    ).toBe(false);
    const csrfCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${COOKIE_NAMES.csrf}=`),
    );
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toContain("Max-Age=0");
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("preserves the HttpOnly registration challenge after backend confirmation rejection", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ error: "invalid_code" }, { status: 422 }),
    );

    const response = await POST(
      makeAuthRequest(
        "/api/auth/verify/registration/confirm",
        { code: "private-registration-code" },
        {
          accessToken: ACCESS_TOKEN,
          registrationVerificationToken: "private-registration-challenge-token",
        },
      ),
      makeContext(["verify", "registration", "confirm"]),
    );

    expect(response.status).toBe(422);
    const setCookies = response.headers.getSetCookie();
    expect(
      setCookies.some((cookie) =>
        cookie.startsWith(`${COOKIE_NAMES.registrationVerification}=;`),
      ),
    ).toBe(false);
    expect(
      setCookies.some(
        (cookie) =>
          cookie.startsWith(`${COOKIE_NAMES.access}=;`) &&
          cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);
    const csrfCookie = setCookies.find((cookie) =>
      cookie.startsWith(`${COOKIE_NAMES.csrf}=`),
    );
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toContain("Max-Age=0");
  });

  it("audits an unallowlisted path using only a fixed category", async () => {
    const request = makeAuthRequest(
      "/api/auth/register/private-patient?email=patient@example.test",
      { diagnosis: "private clinical value" },
      { accessToken: ACCESS_TOKEN },
    );
    const response = await POST(
      request,
      makeContext(["register", "private-patient"]),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.denied",
        resourceType: "auth.unknown",
        status: 404,
        reason: "path_not_allowed",
        sessionCorrelation: sessionCorrelationFromToken(ACCESS_TOKEN),
      }),
    );

    const auditOutput = JSON.stringify(mockedAuditLog.mock.calls);
    expect(auditOutput).not.toContain("private-patient");
    expect(auditOutput).not.toContain("patient@example.test");
    expect(auditOutput).not.toContain("private clinical value");
    expect(auditOutput).not.toContain(ACCESS_TOKEN);
  });

  it("audits an invalid path without retaining traversal content", async () => {
    const request = makeAuthRequest("/api/auth/verify/private-patient");
    const response = await POST(
      request,
      makeContext(["verify", "..", "private-patient"]),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_path" });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.denied",
        resourceType: "auth.invalid",
        status: 400,
        reason: "invalid_path",
      }),
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "private-patient",
    );
  });

  it("does not attribute a non-UUID backend identifier as an actor", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ success: true, user_id: "patient@example.test" }),
    );

    const response = await POST(
      makeAuthRequest("/api/auth/verify/confirm"),
      makeContext(["verify", "confirm"]),
    );

    expect(response.status).toBe(200);
    const record = mockedAuditLog.mock.calls[0]?.[0];
    expect(record).not.toHaveProperty("actorId");
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "patient@example.test",
    );
  });

  it("audits a rejected backend response with sanitized status and reason", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ error: "private backend detail" }, { status: 422 }),
    );

    const response = await POST(
      makeAuthRequest("/api/auth/password/reset"),
      makeContext(["password", "reset"]),
    );

    expect(response.status).toBe(422);
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.password_reset",
        status: 422,
        reason: "backend_rejected",
      }),
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "private backend detail",
    );
  });

  it("audits backend unavailability for an allowed route", async () => {
    mockedBackendFetch.mockRejectedValue(new BackendUnavailableError());

    const request = makeAuthRequest("/api/auth/verify/registration/send");
    const response = await POST(
      request,
      makeContext(["verify", "registration", "send"]),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "auth.generic.allowed",
        resourceType: "auth.registration_verification",
        status: 503,
        reason: "backend_unavailable",
      }),
    );
  });

  it("injects the HttpOnly registration verification cookie when confirming after a web reload", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        success: true,
        access_token: "issued-private-access-token",
        refresh_token: "issued-private-refresh-token",
      }),
    );
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({ user_id: ACTOR_ID }),
    );

    const request = makeAuthRequest(
      "/api/auth/verify/registration/confirm",
      {
        code: "private-registration-code",
        verification_token: "",
      },
      { registrationVerificationToken: "private-registration-challenge-token" },
    );
    const response = await POST(
      request,
      makeContext(["verify", "registration", "confirm"]),
    );

    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().join("\n")).toContain(
      `${COOKIE_NAMES.registrationVerification}=;`,
    );
    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(
      JSON.stringify({
        code: "private-registration-code",
        verification_token: "private-registration-challenge-token",
      }),
    );
  });

  it("injects the HttpOnly registration verification cookie when resending after a web reload", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        message: "Verification code sent. Check your inbox.",
      }),
    );

    const response = await POST(
      makeAuthRequest(
        "/api/auth/verify/registration/send",
        {
          verificationToken: "",
        },
        {
          registrationVerificationToken: "private-registration-challenge-token",
        },
      ),
      makeContext(["verify", "registration", "send"]),
    );

    expect(response.status).toBe(200);
    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(
      JSON.stringify({
        verification_token: "private-registration-challenge-token",
      }),
    );
  });

  it("normalizes a browser-provided registration verification alias before forwarding", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        message: "Verification code sent. Check your inbox.",
      }),
    );

    const response = await POST(
      makeAuthRequest("/api/auth/verify/registration/send", {
        verificationToken: "private-registration-challenge-token",
      }),
      makeContext(["verify", "registration", "send"]),
    );

    expect(response.status).toBe(200);
    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    expect(init?.body).toBe(
      JSON.stringify({
        verification_token: "private-registration-challenge-token",
      }),
    );
  });
});

describe("browser user-agent forwarding", () => {
  beforeEach(() => {
    vi.stubEnv("PATIENT_WEB_CSRF_SECRET", CSRF_SECRET);
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", ORIGIN);
    mockedBackendFetch.mockReset();
    mockedAuditLog.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards the browser's User-Agent to the backend", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ success: true }, { status: 202 }),
    );
    const browserUa =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1";

    const request = makeAuthRequest(
      "/api/auth/verify/registration/send",
      { email: "patient@example.test" },
      { userAgent: browserUa },
    );
    await POST(request, makeContext(["verify", "registration", "send"]));

    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("user-agent")).toBe(browserUa);
  });

  it("sends no User-Agent header when the browser omitted one", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ success: true }, { status: 202 }),
    );

    const request = makeAuthRequest("/api/auth/verify/registration/send", {
      email: "patient@example.test",
    });
    await POST(request, makeContext(["verify", "registration", "send"]));

    const [, init] = mockedBackendFetch.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get("user-agent")).toBeNull();
  });
});
