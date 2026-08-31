import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  COOKIE_NAMES,
  SESSION_MAX_AGE_SECONDS,
  auditActorIdFromRequest,
  clearAuthCookies,
  clearExpiredAccessCookies,
  clearMfaTransactionCookies,
  issueAuthenticatedSessionCookies,
  setMfaTransactionCookies,
  setCsrfCookie,
} from "@/lib/auth/cookies";
import { createCsrfToken } from "@/lib/auth/csrf";
import {
  BackendUnavailableError,
  backendFetch,
  hasTokenPair,
  readJsonBody,
  stripTokens,
} from "@/lib/server/backend";
import { getPatientWebConfig } from "@/lib/server/config";
import { jsonNoStore, withNoStore } from "@/lib/server/responses";
import {
  auditLog,
  backendAuthenticatedActorId,
  createAuditContext,
  isRoutineAuditEnabled,
  type AuditContext,
} from "@/lib/server/audit";
import type { BackendLoginResponse, BackendTokenPair } from "@/types/auth";

type JsonRecord = Record<string, unknown>;
type CredentialAuthErrorMode = "credential" | "registration";

function normalizeAuthError(
  backendStatus: number,
  mode: CredentialAuthErrorMode = "credential",
  backendBody?: unknown,
): {
  status: number;
  body: { error: string; registration_conflict?: "email" | "phone" };
} {
  if (backendStatus === 429) {
    // Rate limit from the backend — safe to surface
    return { status: 429, body: { error: "too_many_requests" } };
  }
  if (mode === "registration" && backendStatus === 409) {
    const registrationConflict = allowlistedRegistrationConflict(backendBody);
    return {
      status: 409,
      body: {
        error: "conflict",
        ...(registrationConflict === undefined
          ? {}
          : { registration_conflict: registrationConflict }),
      },
    };
  }
  if (backendStatus === 422 || backendStatus === 400) {
    // Validation error (e.g. malformed request body) — safe to surface as 400
    return { status: 400, body: { error: "invalid_request" } };
  }
  if (mode === "registration" && backendStatus >= 500) {
    return { status: 502, body: { error: "server_error" } };
  }
  if (backendStatus === 503 || backendStatus === 502) {
    // Backend unavailable — already handled upstream via BackendUnavailableError,
    // but guard here in case the backend returns a 503 response body
    return { status: 503, body: { error: "service_unavailable" } };
  }
  // 401, 403, 404, 423, 500, and anything else → generic auth_failed at 401
  // This collapses "wrong password", "email not found", "account locked" into one shape
  return { status: 401, body: { error: "auth_failed" } };
}

function allowlistedRegistrationConflict(
  value: unknown,
): "email" | "phone" | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const conflict = (value as JsonRecord)["registration_conflict"];
  return conflict === "email" || conflict === "phone" ? conflict : undefined;
}

export async function readRequestJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function issueCsrfCookie(response: NextResponse): void {
  const { csrfSecret } = getPatientWebConfig();
  setCsrfCookie(response, createCsrfToken(csrfSecret));
}

export function authBackendRequest(
  body: unknown,
  request?: NextRequest,
): RequestInit {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  // Session rows record the User-Agent of the minting request; without this
  // the backend sees the BFF's own fetch client for every web patient.
  const userAgent = request?.headers.get("user-agent");
  if (userAgent) headers["User-Agent"] = userAgent;
  return {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  };
}

export async function forwardCredentialAuth(
  backendPath: string,
  requestBody: unknown,
  request?: NextRequest,
  options: {
    errorMode?: CredentialAuthErrorMode;
    auditContext?: AuditContext;
    onAuthenticatedActor?: (actorId: string) => void;
    responseBody?: (data: JsonRecord) => JsonRecord;
    onSafeResponse?: (response: NextResponse, data: JsonRecord) => void;
  } = {},
): Promise<NextResponse> {
  const backendResponse = await backendFetch(
    backendPath,
    authBackendRequest(requestBody, request),
  );
  const data = await readJsonBody<BackendLoginResponse>(backendResponse);

  if (!backendResponse.ok) {
    const normalized = normalizeAuthError(
      backendResponse.status,
      options.errorMode,
      data,
    );
    const response = clearAndNoStore(normalized.body, normalized.status);
    // Same reasoning as the refresh failure paths below: a REJECTED credential
    // is the case where the client most needs a usable CSRF token, because its
    // next act is to try again. Clearing the token here turned one mistyped
    // password into a login form that could no longer submit at all.
    issueCsrfCookie(response);
    if (!backendPath.includes("/mfa/verify"))
      clearMfaTransactionCookies(response);
    return response;
  }

  // The backend authenticated this UUID; never derive actor attribution from JWT claims.
  const actorId = await resolveBackendAuthenticatedActorId(data?.user_id, data);
  if (actorId !== undefined) options.onAuthenticatedActor?.(actorId);
  const mfaRequired = data?.mfa_required;
  const mfaEnrollmentRequired = data?.mfa_enrollment_required;

  // Derive audit event name from the backend path before stripTokens discards user_id.
  const auditContext = options.auditContext ?? createAuditContext();
  const isMfaVerify = backendPath.includes("/mfa/verify");
  const successEvent = isMfaVerify
    ? "auth.mfa.verify.success"
    : "auth.login.success";

  const tokenPairIssued = hasTokenPair(data);
  const hasChallenge = mfaRequired === true || mfaEnrollmentRequired === true;
  const malformedChallenge =
    (mfaRequired !== undefined && typeof mfaRequired !== "boolean") ||
    (mfaEnrollmentRequired !== undefined &&
      typeof mfaEnrollmentRequired !== "boolean") ||
    (mfaRequired === true && mfaEnrollmentRequired === true) ||
    (hasChallenge && tokenPairIssued) ||
    (hasChallenge &&
      (typeof data.mfa_token !== "string" || data.mfa_token.length === 0)) ||
    (mfaRequired === true &&
      (typeof data.mfa_method_id !== "string" ||
        data.mfa_method_id.length === 0));

  const permitsUnauthenticatedSuccess =
    backendPath.includes("/register/patient");
  if (
    malformedChallenge ||
    (!tokenPairIssued && !hasChallenge && !permitsUnauthenticatedSuccess)
  ) {
    const failure = clearAndNoStore({ error: "invalid_auth_transaction" }, 502);
    issueCsrfCookie(failure);
    clearMfaTransactionCookies(failure);
    return failure;
  }
  if (tokenPairIssued && actorId === undefined) {
    const failure = clearAndNoStore(
      { error: "authenticated_actor_unavailable" },
      502,
    );
    issueCsrfCookie(failure);
    return failure;
  }

  const safeBody =
    options.responseBody?.(data as JsonRecord) ??
    safeAuthResponse(data as JsonRecord);
  const response = jsonNoStore(safeBody, {
    status: backendResponse.status,
  });
  clearAuthCookies(response);
  clearMfaTransactionCookies(response);
  options.onSafeResponse?.(response, data as JsonRecord);

  if (tokenPairIssued && actorId !== undefined) {
    const issued = issueAuthenticatedSessionCookies(response, {
      ...toTokenPair(data),
      actorId,
    });
    issueCsrfCookie(response);
    if (isRoutineAuditEnabled()) {
      auditLog({
        ts: new Date().toISOString(),
        event: successEvent,
        method: "POST",
        status: backendResponse.status,
        ...auditContext,
        actorId,
        sessionCorrelation: issued.sessionCorrelation,
      });
    }
    auditLog({
      ts: new Date().toISOString(),
      event: "auth.token.issued",
      method: "POST",
      status: backendResponse.status,
      ...auditContext,
      actorId,
      sessionCorrelation: issued.sessionCorrelation,
      reason: "backend_token_pair",
    });
  } else if (hasChallenge) {
    const challenge = data as BackendLoginResponse;
    setMfaTransactionCookies(
      response,
      challenge.mfa_token as string,
      challenge.mfa_method_id,
    );
    issueCsrfCookie(response);
    auditLog({
      ts: new Date().toISOString(),
      event: "auth.mfa.interim",
      method: "POST",
      status: backendResponse.status,
      ...auditContext,
      ...(actorId === undefined ? {} : { actorId }),
    });
  } else {
    issueCsrfCookie(response);
  }
  return response;
}

export interface IssuedSessionAudit {
  actorId: string;
  sessionCorrelation: string;
}

export interface IssuedSessionCredentials {
  accessToken: string;
  refreshToken: string;
  actorId: string;
  issuedAt: number;
}

export interface RotatedTokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshWithCookieOptions {
  /** Called immediately after a valid pair is received, before actor checks. */
  onTokenPairReceived?: (pair: RotatedTokenPair, backendStatus: number) => void;
  onTokenPairIssued?: (session: IssuedSessionCredentials) => void;
  /** Called when a successful backend rotation has no complete token pair. */
  onMalformedTokenPair?: (accessToken?: string) => void;
  preserveBackendStatusOnFailure?: boolean;
  preserveCookiesOnFailure?: boolean;
}

export async function refreshWithCookie(
  request: NextRequest,
  onTokenIssued?: (issued: IssuedSessionAudit) => void,
  options: RefreshWithCookieOptions = {},
): Promise<NextResponse> {
  const refreshToken = request.cookies.get(COOKIE_NAMES.refresh)?.value;
  if (!refreshToken) {
    const response = jsonNoStore(
      { error: "refresh_token_missing" },
      { status: 401 },
    );
    if (!options.preserveCookiesOnFailure) clearAuthCookies(response);
    // The CSRF cookie is not an authentication credential — it is precisely what
    // an UNauthenticated client needs in order to log in or register. Tearing it
    // down along with the auth cookies on a failed refresh strands the user: the
    // very next login/register attempt fails CSRF validation before it ever
    // reaches the backend. Reissue it for the browser-facing refresh route;
    // internal callers that must preserve the original retry state opt out.
    if (!options.preserveCookiesOnFailure) issueCsrfCookie(response);
    return response;
  }

  const iatCookie = request.cookies.get(COOKIE_NAMES.sessionIssuedAt)?.value;
  const iat =
    iatCookie && /^[1-9][0-9]{9}$/.test(iatCookie) ? Number(iatCookie) : null;
  const now = Math.floor(Date.now() / 1000);

  if (iat === null || iat > now + 60 || now - iat > SESSION_MAX_AGE_SECONDS) {
    // Session has exceeded absolute lifetime — force re-login
    const response = jsonNoStore({ error: "session_expired" }, { status: 401 });
    if (!options.preserveCookiesOnFailure) {
      clearAuthCookies(response);
      issueCsrfCookie(response);
    }
    return response;
  }

  const backendResponse = await backendFetch(
    "/api/v1/auth/refresh",
    authBackendRequest({ refresh_token: refreshToken }, request),
  );
  const data = await readJsonBody<JsonRecord>(backendResponse);
  const tokenPairIssued = hasTokenPair(data);

  if (!backendResponse.ok || !tokenPairIssued) {
    // A successful response without a complete pair may still have consumed
    // the single-use refresh credential. Treat it as a protocol failure, not
    // as a retryable 2xx, and let internal callers revoke any usable access
    // token without putting the old refresh token back in a browser cookie.
    if (backendResponse.ok) {
      const candidateAccessToken =
        typeof data?.access_token === "string" && data.access_token.length > 0
          ? data.access_token
          : undefined;
      options.onMalformedTokenPair?.(candidateAccessToken);
    }
    const response = jsonNoStore(
      { error: "refresh_failed" },
      {
        status: backendResponse.ok
          ? 502
          : options.preserveBackendStatusOnFailure
            ? backendResponse.status
            : 401,
      },
    );
    if (!options.preserveCookiesOnFailure) {
      clearAuthCookies(response);
      issueCsrfCookie(response);
    }
    return response;
  }

  // Capture the backend pair before resolving metadata. The refresh endpoint
  // has already rotated the old credential at this point; a missing user_id
  // must never cause the old refresh cookie to be reused.
  const rotatedPair = toTokenPair(data);
  options.onTokenPairReceived?.(rotatedPair, backendResponse.status);

  // The refresh contract carries the backend-authenticated actor directly.
  // Do not call /auth/session after rotation: a malformed response must not
  // turn the newly issued access token into a second backend lookup.
  const actorId = backendAuthenticatedActorId(data["user_id"]);
  if (actorId === undefined) {
    if (options.preserveCookiesOnFailure) {
      return jsonNoStore(
        { error: "authenticated_actor_unavailable" },
        { status: 502 },
      );
    }
    // Same defect as the three 401 paths above: this clears auth cookies via
    // clearAndNoStore and must not leave the client without a CSRF cookie either,
    // or the ensuing forced re-login would itself fail CSRF validation.
    const response = clearAndNoStore(
      { error: "authenticated_actor_unavailable" },
      502,
    );
    issueCsrfCookie(response);
    return response;
  }

  const response = jsonNoStore({ success: true });
  clearAuthCookies(response);
  const session: IssuedSessionCredentials = {
    ...rotatedPair,
    actorId,
    issuedAt: iat,
  };
  const issued = issueAuthenticatedSessionCookies(response, session);
  issueCsrfCookie(response);
  options.onTokenPairIssued?.(session);
  onTokenIssued?.({ actorId, sessionCorrelation: issued.sessionCorrelation });
  return response;
}

export async function logoutWithCookie(
  request: NextRequest,
): Promise<NextResponse> {
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;

  if (!accessToken) {
    // Already logged out — cookies are absent, nothing to revoke. This still
    // clears (a no-op for auth cookies, but not for CSRF/MFA state) and must
    // still leave a fresh CSRF cookie behind — see clearAccountTransitionState.
    return clearAccountTransitionState(jsonNoStore({ success: true }));
  }

  let backendOk = false;
  try {
    const backendResponse = await backendFetch("/api/v1/auth/logout", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    backendOk = backendResponse.ok;
  } catch (err) {
    if (!(err instanceof BackendUnavailableError)) throw err;
    // BackendUnavailableError — fall through to clear cookies and return 502.
  }

  // Always clear browser cookies: even on backend failure the local session
  // must be invalidated so the patient is not left in a half-logged-out state.
  // A user who just logged out (or tried to) is about to log back in, so the
  // CSRF cookie this clears must be reissued — see clearAccountTransitionState.
  if (!backendOk) {
    return clearAccountTransitionState(
      jsonNoStore({ error: "logout_backend_failed" }, { status: 502 }),
    );
  }

  return clearAccountTransitionState(jsonNoStore({ success: true }));
}

export async function sessionFromCookie(
  request: NextRequest,
): Promise<NextResponse> {
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
  if (!accessToken) {
    // The 15-minute access cookie lapsed (or was never set). This says nothing
    // about the 7-day refresh cookie, so retire the access credential only and
    // let the client spend its refresh token. Clearing the whole set here is
    // what forced a full re-login after any >15-minute background gap.
    const response = jsonNoStore({ error: "unauthorized" }, { status: 401 });
    clearExpiredAccessCookies(response);
    issueCsrfCookie(response);
    return response;
  }

  const backendResponse = await backendFetch("/api/v1/auth/session", {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await readJsonBody<JsonRecord>(backendResponse);

  if (!backendResponse.ok) {
    const response = jsonNoStore(data ?? { error: "unauthorized" }, {
      status: backendResponse.status,
    });
    if (backendResponse.status === 401) {
      // Same reasoning as the missing-cookie branch: a rejected ACCESS token is
      // not evidence the refresh token is dead. If the whole session really was
      // revoked, the backend rejects the refresh too and `refreshWithCookie`
      // performs the full wipe one step later.
      clearExpiredAccessCookies(response);
      issueCsrfCookie(response);
    }
    return response;
  }

  const backendActorId = backendAuthenticatedActorId(data?.["user_id"]);
  const sessionActorId = auditActorIdFromRequest(request);
  if (backendActorId === undefined || sessionActorId !== backendActorId) {
    const response = jsonNoStore({ error: "unauthorized" }, { status: 401 });
    clearAuthCookies(response);
    issueCsrfCookie(response);
    return response;
  }

  const response = jsonNoStore(data);
  issueCsrfCookie(response);
  return response;
}

function safeAuthResponse(data: JsonRecord): JsonRecord {
  return stripTokens(data);
}

function toTokenPair(data: BackendTokenPair): {
  accessToken: string;
  refreshToken: string;
} {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  };
}

export function clearAndNoStore(body: unknown, status = 200): NextResponse {
  const response = jsonNoStore(body, { status });
  clearAuthCookies(response);
  return withNoStore(response);
}

export function clearAccountTransitionState(
  response: NextResponse,
): NextResponse {
  clearAuthCookies(response);
  clearMfaTransactionCookies(response);
  // clearAuthCookies tears down the CSRF cookie along with the session/refresh
  // cookies. Every current caller of this helper is a failure path — request
  // policy rejection, rate limiting, malformed JSON, backend unavailability —
  // where the client's very next move is to retry the mutation (login,
  // register, or MFA verify). The CSRF cookie is not an authentication
  // credential; it is exactly what an UNauthenticated client needs to make
  // that next attempt, so it must always be reissued here. If a future caller
  // ever wraps an already-authenticated success response in this helper,
  // reassess: that would double-issue (harmless) but signals the caller
  // probably wants `clearAuthCookies` directly instead.
  try {
    issueCsrfCookie(response);
  } catch {
    // getPatientWebConfig() throws when deployment configuration itself is
    // invalid (e.g. PATIENT_WEB_ALLOWED_ORIGINS unset). validateAuthMutation
    // already caught that same failure and normalized the response we were
    // handed into a sanitized "service_unavailable" — there is no valid CSRF
    // secret to mint a token with in that state, and the whole BFF fails
    // closed regardless, so swallow this rather than crash the response.
  }
  return response;
}

export async function resolveBackendAuthenticatedActorId(
  candidate: unknown,
  tokenPair?: Partial<BackendTokenPair>,
): Promise<string | undefined> {
  const actorId = backendAuthenticatedActorId(candidate);
  if (actorId !== undefined) return actorId;
  if (typeof tokenPair?.access_token !== "string") return undefined;

  try {
    const response = await backendFetch("/api/v1/auth/session", {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${tokenPair.access_token}`,
      },
    });
    if (!response.ok) return undefined;
    const session = await readJsonBody<JsonRecord>(response);
    return backendAuthenticatedActorId(session?.["user_id"]);
  } catch (error) {
    if (error instanceof BackendUnavailableError) return undefined;
    throw error;
  }
}
