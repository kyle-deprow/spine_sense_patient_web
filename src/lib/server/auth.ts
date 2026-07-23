import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  COOKIE_NAMES,
  SESSION_MAX_AGE_SECONDS,
  auditActorIdFromRequest,
  clearAuthCookies,
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

export function authBackendRequest(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body ?? {}),
  };
}

export async function forwardCredentialAuth(
  backendPath: string,
  requestBody: unknown,
  _request?: NextRequest,
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
    authBackendRequest(requestBody),
  );
  const data = await readJsonBody<BackendLoginResponse>(backendResponse);

  if (!backendResponse.ok) {
    const normalized = normalizeAuthError(
      backendResponse.status,
      options.errorMode,
      data,
    );
    const response = clearAndNoStore(normalized.body, normalized.status);
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
    clearMfaTransactionCookies(failure);
    return failure;
  }
  if (tokenPairIssued && actorId === undefined) {
    return clearAndNoStore({ error: "authenticated_actor_unavailable" }, 502);
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

export async function refreshWithCookie(
  request: NextRequest,
  onTokenIssued?: (issued: IssuedSessionAudit) => void,
): Promise<NextResponse> {
  const refreshToken = request.cookies.get(COOKIE_NAMES.refresh)?.value;
  if (!refreshToken) {
    const response = jsonNoStore(
      { error: "refresh_token_missing" },
      { status: 401 },
    );
    clearAuthCookies(response);
    return response;
  }

  const iatCookie = request.cookies.get(COOKIE_NAMES.sessionIssuedAt)?.value;
  const iat =
    iatCookie && /^[1-9][0-9]{9}$/.test(iatCookie) ? Number(iatCookie) : null;
  const now = Math.floor(Date.now() / 1000);

  if (iat === null || iat > now + 60 || now - iat > SESSION_MAX_AGE_SECONDS) {
    // Session has exceeded absolute lifetime — force re-login
    const response = jsonNoStore({ error: "session_expired" }, { status: 401 });
    clearAuthCookies(response);
    return response;
  }

  const backendResponse = await backendFetch(
    "/api/v1/auth/refresh",
    authBackendRequest({ refresh_token: refreshToken }),
  );
  const data = await readJsonBody<JsonRecord>(backendResponse);

  if (!backendResponse.ok || !hasTokenPair(data)) {
    const response = jsonNoStore({ error: "refresh_failed" }, { status: 401 });
    clearAuthCookies(response);
    return response;
  }

  const actorId = await resolveBackendAuthenticatedActorId(
    data["user_id"],
    data,
  );
  if (actorId === undefined) {
    return clearAndNoStore({ error: "authenticated_actor_unavailable" }, 502);
  }

  const response = jsonNoStore({ success: true });
  clearAuthCookies(response);
  const issued = issueAuthenticatedSessionCookies(response, {
    ...toTokenPair(data),
    actorId,
    issuedAt: iat,
  });
  issueCsrfCookie(response);
  onTokenIssued?.({ actorId, sessionCorrelation: issued.sessionCorrelation });
  return response;
}

export async function logoutWithCookie(
  request: NextRequest,
): Promise<NextResponse> {
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;

  if (!accessToken) {
    // Already logged out — cookies are absent, nothing to revoke.
    const response = jsonNoStore({ success: true });
    clearAuthCookies(response);
    clearMfaTransactionCookies(response);
    return response;
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
  if (!backendOk) {
    const response = jsonNoStore(
      { error: "logout_backend_failed" },
      { status: 502 },
    );
    clearAuthCookies(response);
    clearMfaTransactionCookies(response);
    return response;
  }

  const response = jsonNoStore({ success: true });
  clearAuthCookies(response);
  clearMfaTransactionCookies(response);
  return response;
}

export async function sessionFromCookie(
  request: NextRequest,
): Promise<NextResponse> {
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
  if (!accessToken) {
    const response = jsonNoStore({ error: "unauthorized" }, { status: 401 });
    clearAuthCookies(response);
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
      clearAuthCookies(response);
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
