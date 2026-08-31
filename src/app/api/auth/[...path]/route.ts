import type { NextRequest, NextResponse } from "next/server";

import {
  COOKIE_NAMES,
  clearAuthCookies,
  clearAuthenticatedSessionCookies,
  clearMfaTransactionCookies,
  clearRegistrationVerificationCookie,
  issueAuthenticatedSessionCookies,
} from "@/lib/auth/cookies";
import {
  validateAuthMutation,
  validatePatientWebConfiguration,
} from "@/lib/auth/route-guards";
import {
  BackendUnavailableError,
  backendFetch,
  hasTokenPair,
  readJsonBody,
  stripTokens,
} from "@/lib/server/backend";
import {
  issueCsrfCookie,
  refreshWithCookie,
  resolveBackendAuthenticatedActorId,
  type IssuedSessionCredentials,
  type RotatedTokenPair,
} from "@/lib/server/auth";
import {
  auditLog,
  createRequestAuditContext,
  isRoutineAuditEnabled,
  sessionCorrelationFromToken,
  type AuditContext,
} from "@/lib/server/audit";
import { jsonNoStore } from "@/lib/server/responses";
import type { BackendTokenPair } from "@/types/auth";

type AuthProxyContext = {
  params: Promise<{ path: string[] }>;
};

type JsonRecord = Record<string, unknown>;

const AUTH_ROUTE_CATEGORIES = new Map<string, string>([
  ["password/reset", "auth.password_reset"],
  ["password/reset/confirm", "auth.password_reset"],
  ["verify-email", "auth.email_verification"],
  ["resend-verification", "auth.email_verification"],
  ["verify/send", "auth.email_verification"],
  ["verify/confirm", "auth.email_verification"],
  ["verify/registration/send", "auth.registration_verification"],
  ["verify/registration/confirm", "auth.registration_verification"],
  ["mfa/setup", "auth.mfa"],
  ["mfa/disable", "auth.mfa"],
  ["mfa/methods", "auth.mfa"],
  ["logout-all", "auth.logout_all"],
]);

const TOKEN_COOKIE_AUTH_PATHS = new Set(["verify/registration/confirm"]);
const AUTH_ROUTE_METHODS = new Map<string, ReadonlySet<string>>([
  ["logout-all", new Set(["POST"])],
]);

function sanitizeAuthPath(authPath: string): string | null {
  if (authPath.includes("\0")) return null;
  const lower = authPath.toLowerCase();
  if (
    lower.includes("//") ||
    lower.includes("\\") ||
    lower.includes("..") ||
    lower.includes("%2f") ||
    lower.includes("%5c") ||
    lower.includes("%2e")
  ) {
    return null;
  }
  return authPath;
}

async function handler(request: NextRequest, context: AuthProxyContext) {
  const configurationFailure = validatePatientWebConfiguration();
  if (configurationFailure) return configurationFailure;
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
  const auditContext = createRequestAuditContext(request, accessToken);
  const { path } = await context.params;
  const authPath = path.join("/");
  const isAccountTransition = TOKEN_COOKIE_AUTH_PATHS.has(authPath);

  if (sanitizeAuthPath(authPath) === null) {
    auditGenericCall(
      request.method,
      "denied",
      "auth.invalid",
      400,
      "invalid_path",
      auditContext,
    );
    return transitionResponse(
      jsonNoStore({ error: "invalid_path" }, { status: 400 }),
      isAccountTransition,
    );
  }

  const routeCategory = AUTH_ROUTE_CATEGORIES.get(authPath);
  if (!routeCategory) {
    auditGenericCall(
      request.method,
      "denied",
      "auth.unknown",
      404,
      "path_not_allowed",
      auditContext,
    );
    return transitionResponse(
      jsonNoStore({ error: "not_found" }, { status: 404 }),
      isAccountTransition,
    );
  }

  const allowedMethods = AUTH_ROUTE_METHODS.get(authPath);
  if (allowedMethods && !allowedMethods.has(request.method.toUpperCase())) {
    auditGenericCall(
      request.method,
      "denied",
      routeCategory,
      405,
      "method_not_allowed",
      auditContext,
    );
    return jsonNoStore(
      { error: "method_not_allowed" },
      { status: 405, headers: { Allow: [...allowedMethods].join(", ") } },
    );
  }

  if (shouldForwardBody(request.method)) {
    const failure = validateAuthMutation(request);
    if (failure) {
      auditGenericCall(
        request.method,
        "denied",
        routeCategory,
        failure.status,
        "request_policy_denied",
        auditContext,
      );
      return transitionResponse(failure, isAccountTransition);
    }
  }

  if (authPath === "logout-all") {
    return handleLogoutAll(request, routeCategory, auditContext, accessToken);
  }

  const backendRequest: RequestInit = {
    method: request.method,
    headers: buildAuthHeaders(request, auditContext.requestId),
  };

  if (shouldForwardBody(request.method)) {
    backendRequest.body = await authRequestBody(request, authPath);
  }

  let backendResponse: Response;
  try {
    backendResponse = await backendFetch(
      `/api/v1/auth/${authPath}${request.nextUrl.search}`,
      backendRequest,
    );
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      auditGenericCall(
        request.method,
        "allowed",
        routeCategory,
        503,
        "backend_unavailable",
        auditContext,
      );
      return transitionResponse(
        jsonNoStore({ error: "service_unavailable" }, { status: 503 }),
        isAccountTransition,
      );
    }
    throw err;
  }
  const data = await readJsonBody<JsonRecord>(backendResponse);

  const actorId = backendResponse.ok
    ? await resolveBackendAuthenticatedActorId(data?.["user_id"], data)
    : undefined;

  auditGenericCall(
    request.method,
    "allowed",
    routeCategory,
    backendResponse.status,
    backendResponse.ok ? "backend_success" : "backend_rejected",
    auditContext,
    actorId,
  );

  const tokenPairIssued = backendResponse.ok && hasTokenPair(data);
  if (tokenPairIssued && actorId !== undefined) {
    auditLog({
      ts: new Date().toISOString(),
      event: "auth.token.issued",
      method: request.method,
      resourceType: routeCategory,
      status: backendResponse.status,
      ...auditContext,
      actorId,
      sessionCorrelation: sessionCorrelationFromToken(data.access_token),
      reason: "backend_token_pair",
    });
  }

  if (tokenPairIssued && actorId === undefined) {
    return transitionResponse(
      jsonNoStore(
        { error: "authenticated_actor_unavailable" },
        { status: 502 },
      ),
      true,
    );
  }

  const response = transitionResponse(
    jsonNoStore(safeAuthBody(data), { status: backendResponse.status }),
    isAccountTransition,
    !(tokenPairIssued && actorId !== undefined),
  );
  if (tokenPairIssued && isAccountTransition && actorId !== undefined) {
    issueAuthenticatedSessionCookies(response, {
      ...toTokenPair(data),
      actorId,
    });
    issueCsrfCookie(response);
    clearRegistrationVerificationCookie(response);
  }
  return response;
}

async function handleLogoutAll(
  request: NextRequest,
  routeCategory: string,
  auditContext: AuditContext,
  accessToken: string | undefined,
): Promise<NextResponse> {
  let refreshedSession: IssuedSessionCredentials | undefined;
  let logoutAccessToken = accessToken;
  let refreshAttempted = false;
  let rotatedPair: RotatedTokenPair | undefined;
  let malformedSuccessfulRotation = false;
  let candidateAccessToken: string | undefined;

  if (!logoutAccessToken) {
    if (!hasRefreshCredential(request)) {
      return logoutFailureResponse(
        request,
        routeCategory,
        auditContext,
        401,
        { error: "refresh_required" },
        "missing_authentication",
      );
    }

    refreshAttempted = true;
    const refreshResult = await refreshLogoutSession(
      request,
      routeCategory,
      auditContext,
    );
    rotatedPair = refreshResult.rotatedPair;
    malformedSuccessfulRotation = refreshResult.malformedSuccessfulRotation;
    candidateAccessToken = refreshResult.candidateAccessToken;
    if (refreshResult.response && refreshResult.accessToken === undefined) {
      if (malformedSuccessfulRotation) {
        return hardLogoutRecovery(
          request,
          routeCategory,
          auditContext,
          candidateAccessToken,
        );
      }
      return refreshResult.response;
    }
    refreshedSession = refreshResult.session;
    if (refreshResult.accessToken === undefined) {
      return hardLogoutRecovery(
        request,
        routeCategory,
        auditContext,
        candidateAccessToken,
      );
    }
    logoutAccessToken = refreshResult.accessToken;
  }

  if (logoutAccessToken === undefined) {
    return logoutFailureResponse(
      request,
      routeCategory,
      auditContext,
      401,
      { error: "refresh_required" },
      "missing_authentication",
    );
  }

  const body = await request.arrayBuffer();
  let backendResponse: Response;
  try {
    backendResponse = await forwardLogoutAll(
      request,
      auditContext.requestId,
      logoutAccessToken,
      body,
    );
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      if (rotatedPair && !refreshedSession) {
        return hardLogoutRecovery(
          request,
          routeCategory,
          auditContext,
          rotatedPair.accessToken,
          503,
          "retryable_backend_failure",
        );
      }
      return logoutFailureResponse(
        request,
        routeCategory,
        auditContext,
        503,
        { error: "service_unavailable" },
        "retryable_backend_failure",
        refreshedSession,
      );
    }
    throw err;
  }

  if (backendResponse.status === 401 && !refreshAttempted) {
    if (!hasRefreshCredential(request)) {
      return logoutFailureResponse(
        request,
        routeCategory,
        auditContext,
        401,
        { error: "refresh_required" },
        "unauthorized_global_revocation_unproven",
      );
    }

    refreshAttempted = true;
    const refreshResult = await refreshLogoutSession(
      request,
      routeCategory,
      auditContext,
    );
    rotatedPair = refreshResult.rotatedPair;
    malformedSuccessfulRotation = refreshResult.malformedSuccessfulRotation;
    candidateAccessToken = refreshResult.candidateAccessToken;
    if (refreshResult.response && refreshResult.accessToken === undefined) {
      if (malformedSuccessfulRotation) {
        return hardLogoutRecovery(
          request,
          routeCategory,
          auditContext,
          candidateAccessToken,
        );
      }
      return refreshResult.response;
    }
    refreshedSession = refreshResult.session;
    if (refreshResult.accessToken === undefined) {
      return hardLogoutRecovery(
        request,
        routeCategory,
        auditContext,
        candidateAccessToken,
      );
    }

    try {
      backendResponse = await forwardLogoutAll(
        request,
        auditContext.requestId,
        refreshResult.accessToken,
        body,
      );
    } catch (err) {
      if (err instanceof BackendUnavailableError) {
        if (rotatedPair && !refreshedSession) {
          return hardLogoutRecovery(
            request,
            routeCategory,
            auditContext,
            rotatedPair.accessToken,
            503,
            "retryable_backend_failure",
          );
        }
        return logoutFailureResponse(
          request,
          routeCategory,
          auditContext,
          503,
          { error: "service_unavailable" },
          "retryable_backend_failure",
          refreshedSession,
        );
      }
      throw err;
    }
  }

  const data = await readJsonBody<JsonRecord>(backendResponse);
  // A 204 is not a valid response for this JSON proxy contract. In particular,
  // never ask NextResponse.json to construct a body with status 204.
  if (backendResponse.ok && backendResponse.status !== 204) {
    auditGenericCall(
      request.method,
      "allowed",
      routeCategory,
      backendResponse.status,
      "confirmed_success",
      auditContext,
    );
    return clearLogoutResponse(
      jsonNoStore(safeAuthBody(data), { status: backendResponse.status }),
    );
  }

  if (backendResponse.status === 204) {
    if (rotatedPair && !refreshedSession) {
      return hardLogoutRecovery(
        request,
        routeCategory,
        auditContext,
        rotatedPair.accessToken,
        503,
        "retryable_backend_failure",
      );
    }
    return logoutFailureResponse(
      request,
      routeCategory,
      auditContext,
      503,
      { error: "service_unavailable" },
      "retryable_backend_failure",
      refreshedSession,
    );
  }

  if (backendResponse.status === 401 || backendResponse.status < 500) {
    if (rotatedPair && !refreshedSession) {
      return hardLogoutRecovery(
        request,
        routeCategory,
        auditContext,
        rotatedPair.accessToken,
        401,
        "unauthorized_global_revocation_unproven",
      );
    }
    return logoutFailureResponse(
      request,
      routeCategory,
      auditContext,
      401,
      { error: "logout_authorization_unproven" },
      "unauthorized_global_revocation_unproven",
      refreshedSession,
    );
  }

  if (rotatedPair && !refreshedSession) {
    return hardLogoutRecovery(
      request,
      routeCategory,
      auditContext,
      rotatedPair.accessToken,
      503,
      "retryable_backend_failure",
    );
  }

  return logoutFailureResponse(
    request,
    routeCategory,
    auditContext,
    503,
    { error: "service_unavailable" },
    "retryable_backend_failure",
    refreshedSession,
  );
}

async function refreshLogoutSession(
  request: NextRequest,
  routeCategory: string,
  auditContext: AuditContext,
): Promise<{
  accessToken?: string;
  session?: IssuedSessionCredentials;
  response?: NextResponse;
  rotatedPair?: RotatedTokenPair;
  malformedSuccessfulRotation: boolean;
  candidateAccessToken?: string;
}> {
  let refreshedSession: IssuedSessionCredentials | undefined;
  let rotatedPair: RotatedTokenPair | undefined;
  let rotatedStatus: number | undefined;
  let malformedSuccessfulRotation = false;
  let candidateAccessToken: string | undefined;
  let refreshResponse: NextResponse;
  try {
    refreshResponse = await refreshWithCookie(request, undefined, {
      onTokenPairReceived: (pair, status) => {
        rotatedPair = pair;
        rotatedStatus = status;
      },
      onTokenPairIssued: (session) => {
        refreshedSession = session;
      },
      onMalformedTokenPair: (accessToken) => {
        malformedSuccessfulRotation = true;
        candidateAccessToken = accessToken;
      },
      preserveBackendStatusOnFailure: true,
      preserveCookiesOnFailure: true,
    });
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      return {
        response: logoutFailureResponse(
          request,
          routeCategory,
          auditContext,
          503,
          { error: "service_unavailable" },
          "retryable_backend_failure",
        ),
        malformedSuccessfulRotation: false,
      };
    }
    throw err;
  }

  if (rotatedPair && !refreshedSession) {
    refreshedSession = trustedRotatedSession(
      request,
      auditContext,
      rotatedPair,
    );
  }

  if (rotatedPair) {
    if (refreshedSession) {
      auditLog({
        ts: new Date().toISOString(),
        event: "auth.token.issued",
        method: request.method,
        resourceType: routeCategory,
        status: rotatedStatus ?? refreshResponse.status,
        ...auditContext,
        actorId: refreshedSession.actorId,
        sessionCorrelation: sessionCorrelationFromToken(
          refreshedSession.accessToken,
        ),
        reason: "refresh_token_pair",
      });
    }
    return {
      accessToken: rotatedPair.accessToken,
      ...(refreshedSession ? { session: refreshedSession } : {}),
      ...(!refreshResponse.ok
        ? {
            response: refreshFailureResponse(
              request,
              routeCategory,
              auditContext,
              refreshResponse,
              false,
            ),
          }
        : {}),
      rotatedPair,
      malformedSuccessfulRotation,
      ...(candidateAccessToken ? { candidateAccessToken } : {}),
    };
  }

  if (malformedSuccessfulRotation) {
    return {
      response: refreshFailureResponse(
        request,
        routeCategory,
        auditContext,
        refreshResponse,
        false,
      ),
      malformedSuccessfulRotation: true,
      ...(candidateAccessToken ? { candidateAccessToken } : {}),
    };
  }

  return {
    response: refreshFailureResponse(
      request,
      routeCategory,
      auditContext,
      refreshResponse,
      true,
    ),
    malformedSuccessfulRotation: false,
  };
}

function refreshFailureResponse(
  request: NextRequest,
  routeCategory: string,
  auditContext: AuditContext,
  refreshResponse: NextResponse,
  emitAudit: boolean,
): NextResponse {
  const status = refreshResponse.status >= 500 ? 503 : 401;
  const reason =
    status >= 500
      ? "retryable_backend_failure"
      : "unauthorized_global_revocation_unproven";
  const response = jsonNoStore(
    { error: status >= 500 ? "service_unavailable" : "refresh_required" },
    { status },
  );
  if (emitAudit) {
    auditGenericCall(
      request.method,
      "allowed",
      routeCategory,
      status,
      reason,
      auditContext,
    );
  }
  return response;
}

function trustedRotatedSession(
  request: NextRequest,
  auditContext: AuditContext,
  pair: RotatedTokenPair,
): IssuedSessionCredentials | undefined {
  // This is only a fallback for the backend-first rollout where the refresh
  // response may omit user_id. The old signed actor cookie is bound to the
  // pre-rotation access token and issued-at, so it is trusted only when the
  // normal request audit context already verified it.
  const actorId = auditContext.actorId;
  const issuedAtValue = request.cookies.get(
    COOKIE_NAMES.sessionIssuedAt,
  )?.value;
  if (
    actorId === undefined ||
    issuedAtValue === undefined ||
    !/^[1-9][0-9]{9}$/.test(issuedAtValue)
  ) {
    return undefined;
  }
  return {
    ...pair,
    actorId,
    issuedAt: Number(issuedAtValue),
  };
}

async function hardLogoutRecovery(
  request: NextRequest,
  routeCategory: string,
  auditContext: AuditContext,
  rotatedAccessToken?: string,
  failureStatus?: 401 | 503,
  failureReason?: string,
): Promise<NextResponse> {
  if (failureStatus !== undefined && failureReason !== undefined) {
    auditGenericCall(
      request.method,
      "allowed",
      routeCategory,
      failureStatus,
      failureReason,
      auditContext,
    );
  }

  // A successful refresh has consumed the old credential. If the new pair
  // cannot be safely reissued, revoke the newly issued access credential once
  // and wipe both cookie-path variants so neither family member is reused.
  if (rotatedAccessToken !== undefined) {
    try {
      await backendFetch("/api/v1/auth/logout", {
        method: "POST",
        headers: buildAuthHeaders(
          request,
          auditContext.requestId,
          rotatedAccessToken,
        ),
        body: "{}",
      });
    } catch {
      // Recovery is best effort and must not disclose backend transport detail.
    }
  }

  const response = clearLogoutResponse(
    jsonNoStore({ error: "logout_recovery_required" }, { status: 503 }),
  );
  auditGenericCall(
    request.method,
    "allowed",
    routeCategory,
    503,
    "logout_recovery_required",
    auditContext,
  );
  return response;
}

async function forwardLogoutAll(
  request: NextRequest,
  requestId: string,
  accessToken: string,
  body: ArrayBuffer,
): Promise<Response> {
  return backendFetch(`/api/v1/auth/logout-all${request.nextUrl.search}`, {
    method: "POST",
    headers: buildAuthHeaders(request, requestId, accessToken),
    body: body.slice(0),
  });
}

function hasRefreshCredential(request: NextRequest): boolean {
  const refreshToken = request.cookies.get(COOKIE_NAMES.refresh)?.value;
  return typeof refreshToken === "string" && refreshToken.length > 0;
}

function logoutFailureResponse(
  request: NextRequest,
  routeCategory: string,
  auditContext: AuditContext,
  status: 401 | 503,
  body: { error: string },
  reason: string,
  refreshedSession?: IssuedSessionCredentials,
): NextResponse {
  const response = jsonNoStore(body, { status });
  if (refreshedSession) {
    issueAuthenticatedSessionCookies(response, refreshedSession);
    issueCsrfCookie(response);
  }
  auditGenericCall(
    request.method,
    "allowed",
    routeCategory,
    status,
    reason,
    auditContext,
  );
  return response;
}

async function authRequestBody(
  request: NextRequest,
  authPath: string,
): Promise<BodyInit> {
  const body = await request.arrayBuffer();
  if (!isRegistrationVerificationPath(authPath)) return body;

  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) return body;

  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      return body;

    const record = parsed as Record<string, unknown>;
    return JSON.stringify(
      normalizeRegistrationVerificationBody(record, request),
    );
  } catch {
    return body;
  }
}

function normalizeRegistrationVerificationBody(
  record: Record<string, unknown>,
  request: NextRequest,
): Record<string, unknown> {
  const {
    verification_token: snakeToken,
    verificationToken: camelToken,
    ...safeRecord
  } = record;
  const cookieToken = request.cookies.get(
    COOKIE_NAMES.registrationVerification,
  )?.value;
  const token =
    firstNonEmptyString(cookieToken) ??
    firstNonEmptyString(snakeToken) ??
    firstNonEmptyString(camelToken);

  return token === undefined
    ? safeRecord
    : { ...safeRecord, verification_token: token };
}

function firstNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

function isRegistrationVerificationPath(authPath: string): boolean {
  return (
    authPath === "verify/registration/send" ||
    authPath === "verify/registration/confirm"
  );
}

function buildAuthHeaders(
  request: NextRequest,
  requestId: string,
  accessTokenOverride?: string,
): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "X-Request-Id": requestId,
  });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  const userAgent = request.headers.get("user-agent");
  if (userAgent) headers.set("User-Agent", userAgent);

  const accessToken =
    accessTokenOverride ?? request.cookies.get(COOKIE_NAMES.access)?.value;
  if (accessToken) {
    headers.set("Authorization", `Bearer ${accessToken}`);
  }

  return headers;
}

function auditGenericCall(
  method: string,
  disposition: "allowed" | "denied",
  routeCategory: string,
  status: number,
  reason: string,
  auditContext: AuditContext,
  actorId?: string,
): void {
  if (
    disposition === "allowed" &&
    reason === "backend_success" &&
    !isRoutineAuditEnabled()
  ) {
    return;
  }
  auditLog({
    ts: new Date().toISOString(),
    event: `auth.generic.${disposition}`,
    method,
    resourceType: routeCategory,
    status,
    ...auditContext,
    ...(actorId === undefined ? {} : { actorId }),
    reason,
  });
}

function safeAuthBody(data: JsonRecord | undefined): JsonRecord {
  return data ? stripTokens(data) : {};
}

function shouldForwardBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

function clearLogoutResponse(response: NextResponse): NextResponse {
  clearAuthCookies(response);
  clearMfaTransactionCookies(response);
  issueCsrfCookie(response);
  return response;
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

function transitionResponse(
  response: NextResponse,
  isAccountTransition: boolean,
  preserveRegistrationVerification = true,
): NextResponse {
  if (!isAccountTransition) return response;
  if (!preserveRegistrationVerification) {
    clearAuthCookies(response);
    return response;
  }

  clearAuthenticatedSessionCookies(response);
  issueCsrfCookie(response);
  return response;
}

export {
  handler as DELETE,
  handler as GET,
  handler as PATCH,
  handler as POST,
  handler as PUT,
};
