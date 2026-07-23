import type { NextRequest, NextResponse } from "next/server";

import {
  COOKIE_NAMES,
  clearAuthCookies,
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
  resolveBackendAuthenticatedActorId,
} from "@/lib/server/auth";
import {
  auditLog,
  createRequestAuditContext,
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
]);

const TOKEN_COOKIE_AUTH_PATHS = new Set(["verify/registration/confirm"]);

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

async function authRequestBody(
  request: NextRequest,
  authPath: string,
): Promise<BodyInit> {
  const body = await request.arrayBuffer();
  if (!isRegistrationVerificationPath(authPath)) return body;

  const cookieToken = request.cookies.get(
    COOKIE_NAMES.registrationVerification,
  )?.value;
  if (typeof cookieToken !== "string" || cookieToken.trim().length === 0)
    return body;

  const contentType = request.headers.get("content-type");
  if (!contentType?.includes("application/json")) return body;

  try {
    const parsed = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed))
      return body;

    const record = parsed as Record<string, unknown>;
    const submittedToken =
      record.verification_token ?? record.verificationToken;
    if (typeof submittedToken === "string" && submittedToken.trim().length > 0)
      return body;

    return JSON.stringify({ ...record, verification_token: cookieToken });
  } catch {
    return body;
  }
}

function isRegistrationVerificationPath(authPath: string): boolean {
  return (
    authPath === "verify/registration/send" ||
    authPath === "verify/registration/confirm"
  );
}

function buildAuthHeaders(request: NextRequest, requestId: string): Headers {
  const headers = new Headers({
    Accept: "application/json",
    "X-Request-Id": requestId,
  });
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
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
): NextResponse {
  if (isAccountTransition) clearAuthCookies(response);
  return response;
}

export {
  handler as DELETE,
  handler as GET,
  handler as PATCH,
  handler as POST,
  handler as PUT,
};
