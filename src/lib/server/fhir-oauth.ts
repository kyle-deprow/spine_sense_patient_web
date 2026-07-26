import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { COOKIE_NAMES, shouldUseSecureCookies } from "@/lib/auth/cookies";
import { auditLog, createRequestAuditContext } from "@/lib/server/audit";
import {
  BackendUnavailableError,
  backendFetch,
  readJsonBody,
} from "@/lib/server/backend";
import { getPatientWebConfig } from "@/lib/server/config";
import { jsonNoStore, withNoStore } from "@/lib/server/responses";

const APP_CALLBACK_PATH = "/fhir/callback";
const COOKIE_MAX_AGE_SECONDS = 10 * 60;
const FHIR_OAUTH_STATE_COOKIE = "spine_fhir_oauth_state";
const SAFE_QUERY_VALUE_RE = /^[A-Za-z0-9._~:-]{1,256}$/;
const SAFE_CATEGORY_VALUE_RE = /^[A-Za-z][A-Za-z0-9 ._~:/-]{0,127}$/;

type InitiateConnectionResponse = {
  connection_id?: unknown;
  auth_url?: unknown;
  oauth_state?: unknown;
};

type FhirCallbackStatus = "connected" | "denied" | "failed";

function oauthCookieOptions() {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax" as const,
    path: "/api/fhir",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
}

function clearOauthCookies(response: NextResponse): void {
  response.cookies.set(FHIR_OAUTH_STATE_COOKIE, "", {
    ...oauthCookieOptions(),
    maxAge: 0,
  });
}

function appRedirect(
  request: NextRequest,
  status: FhirCallbackStatus,
): NextResponse {
  const { publicUrl } = getPatientWebConfig();
  const origin = publicUrl?.replace(/\/+$/u, "") || request.nextUrl.origin;
  const target = new URL(APP_CALLBACK_PATH, origin);
  target.searchParams.set("fhirStatus", status);
  const response = NextResponse.redirect(target);
  return withNoStore(response);
}

function safeQueryValue(value: string | null): string | null {
  if (!value || !SAFE_QUERY_VALUE_RE.test(value)) return null;
  return value;
}

function isSafeCallbackValue(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function repeatedQueryValues(request: NextRequest, name: string): string[] {
  return request.nextUrl.searchParams
    .getAll(name)
    .map((value) => value.trim())
    .filter((value) => SAFE_CATEGORY_VALUE_RE.test(value));
}

function backendJsonHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function validateAuthorizationRedirect(
  authUrl: string,
  oauthState: string,
): boolean {
  const { fhirAuthorizationEndpoints } = getPatientWebConfig();
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    return false;
  }
  const exactEndpoint = `${parsed.origin}${parsed.pathname}`;
  const states = parsed.searchParams.getAll("state");
  return (
    fhirAuthorizationEndpoints.includes(exactEndpoint) &&
    states.length === 1 &&
    states[0] === oauthState
  );
}

function fhirDisabledResponse(): NextResponse {
  return jsonNoStore({ error: "fhir_oauth_unavailable" }, { status: 404 });
}

function unauthorizedResponse(): NextResponse {
  return jsonNoStore({ error: "unauthorized" }, { status: 401 });
}

function invalidRequestResponse(): NextResponse {
  return jsonNoStore({ error: "invalid_request" }, { status: 400 });
}

function forbiddenResponse(): NextResponse {
  return jsonNoStore({ error: "origin_forbidden" }, { status: 403 });
}

function isSameOriginStartRequest(request: NextRequest): boolean {
  const { allowedOrigins } = getPatientWebConfig();
  const allowed = new Set(allowedOrigins);
  const fetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") return false;

  const origin = request.headers.get("origin");
  if (origin) return allowed.has(origin);

  const referer = request.headers.get("referer");
  if (referer) {
    try {
      return allowed.has(new URL(referer).origin);
    } catch {
      return false;
    }
  }

  return fetchSite === "same-origin";
}

export async function startFhirOAuth(
  request: NextRequest,
): Promise<NextResponse> {
  const config = getPatientWebConfig();
  if (!config.fhirOauthEnabled) return fhirDisabledResponse();

  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
  const auditContext = createRequestAuditContext(request, accessToken);
  if (!accessToken) {
    auditLog({
      ts: new Date().toISOString(),
      event: "fhir.oauth.denied",
      method: "GET",
      resourceType: "fhir.oauth",
      status: 401,
      reason: "authentication_required",
      ...auditContext,
    });
    return unauthorizedResponse();
  }

  if (!isSameOriginStartRequest(request)) {
    auditLog({
      ts: new Date().toISOString(),
      event: "fhir.oauth.denied",
      method: "GET",
      resourceType: "fhir.oauth",
      status: 403,
      reason: "origin_forbidden",
      ...auditContext,
    });
    return forbiddenResponse();
  }

  const endpointId = safeQueryValue(
    request.nextUrl.searchParams.get("endpointId"),
  );
  const permissionPolicyVersion = safeQueryValue(
    request.nextUrl.searchParams.get("permissionPolicyVersion"),
  );
  const purposeCode = safeQueryValue(
    request.nextUrl.searchParams.get("purposeCode"),
  );
  const retentionNoticeVersion = safeQueryValue(
    request.nextUrl.searchParams.get("retentionNoticeVersion"),
  );
  const categories = repeatedQueryValues(request, "categories");
  if (
    !endpointId ||
    !permissionPolicyVersion ||
    !purposeCode ||
    !retentionNoticeVersion ||
    categories.length === 0 ||
    !config.fhirRedirectUri
  ) {
    auditLog({
      ts: new Date().toISOString(),
      event: "fhir.oauth.denied",
      method: "GET",
      resourceType: "fhir.oauth",
      status: 400,
      reason: "invalid_start",
      ...auditContext,
    });
    return invalidRequestResponse();
  }

  let backendResponse: Response;
  try {
    backendResponse = await backendFetch("/api/v1/fhir/connections", {
      method: "POST",
      headers: backendJsonHeaders(accessToken),
      body: JSON.stringify({
        endpoint_id: endpointId,
        redirect_uri: config.fhirRedirectUri,
        permission_policy_version: permissionPolicyVersion,
        categories,
        purpose_code: purposeCode,
        retention_notice_version: retentionNoticeVersion,
        provider_visibility: false,
        background_sync: false,
        consequences_acknowledged: true,
      }),
    });
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      auditLog({
        ts: new Date().toISOString(),
        event: "fhir.oauth.denied",
        method: "GET",
        resourceType: "fhir.oauth",
        status: 503,
        reason: "backend_unavailable",
        ...auditContext,
      });
      return appRedirect(request, "failed");
    }
    throw err;
  }

  const data = await readJsonBody<InitiateConnectionResponse>(backendResponse);
  if (
    !backendResponse.ok ||
    typeof data.auth_url !== "string" ||
    typeof data.oauth_state !== "string" ||
    !SAFE_QUERY_VALUE_RE.test(data.oauth_state) ||
    !validateAuthorizationRedirect(data.auth_url, data.oauth_state)
  ) {
    auditLog({
      ts: new Date().toISOString(),
      event: "fhir.oauth.denied",
      method: "GET",
      resourceType: "fhir.oauth",
      status: backendResponse.status,
      reason: "start_failed",
      ...auditContext,
    });
    return appRedirect(request, "failed");
  }

  const response = NextResponse.redirect(data.auth_url);
  response.cookies.set(
    FHIR_OAUTH_STATE_COOKIE,
    data.oauth_state,
    oauthCookieOptions(),
  );
  auditLog({
    ts: new Date().toISOString(),
    event: "fhir.oauth.start",
    method: "GET",
    resourceType: "fhir.oauth",
    status: backendResponse.status,
    ...auditContext,
  });
  return withNoStore(response);
}

export async function completeFhirOAuth(
  request: NextRequest,
): Promise<NextResponse> {
  const config = getPatientWebConfig();
  if (!config.fhirOauthEnabled) return fhirDisabledResponse();

  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
  const auditContext = createRequestAuditContext(request, accessToken);
  const expectedState = request.cookies.get(FHIR_OAUTH_STATE_COOKIE)?.value;
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const iss = request.nextUrl.searchParams.get("iss");
  const deniedByProvider = request.nextUrl.searchParams.has("error");

  if (!accessToken) {
    const response = appRedirect(request, "failed");
    clearOauthCookies(response);
    auditLog({
      ts: new Date().toISOString(),
      event: "fhir.oauth.denied",
      method: "GET",
      resourceType: "fhir.oauth",
      status: 401,
      reason: "authentication_required",
      ...auditContext,
    });
    return response;
  }

  if (
    !expectedState ||
    !SAFE_QUERY_VALUE_RE.test(expectedState) ||
    !state ||
    !SAFE_QUERY_VALUE_RE.test(state) ||
    state !== expectedState
  ) {
    const response = appRedirect(request, "failed");
    clearOauthCookies(response);
    auditLog({
      ts: new Date().toISOString(),
      event: "fhir.oauth.denied",
      method: "GET",
      resourceType: "fhir.oauth",
      status: 400,
      reason: "state_mismatch",
      ...auditContext,
    });
    return response;
  }

  if (deniedByProvider) {
    const response = await consumeDeniedCallback(
      request,
      accessToken,
      state,
      auditContext,
    );
    clearOauthCookies(response);
    return response;
  }

  if (
    !code ||
    !isSafeCallbackValue(code) ||
    (iss !== null && !isSafeCallbackValue(iss))
  ) {
    const response = appRedirect(request, "failed");
    clearOauthCookies(response);
    auditLog({
      ts: new Date().toISOString(),
      event: "fhir.oauth.denied",
      method: "GET",
      resourceType: "fhir.oauth",
      status: 400,
      reason: "callback_incomplete",
      ...auditContext,
    });
    return response;
  }

  let backendResponse: Response;
  try {
    backendResponse = await backendFetch("/api/v1/fhir/connections/callback", {
      method: "POST",
      headers: backendJsonHeaders(accessToken),
      body: JSON.stringify({
        code,
        state,
        ...(iss ? { iss } : {}),
      }),
    });
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      const response = appRedirect(request, "failed");
      clearOauthCookies(response);
      auditLog({
        ts: new Date().toISOString(),
        event: "fhir.oauth.denied",
        method: "GET",
        resourceType: "fhir.oauth",
        status: 503,
        reason: "backend_unavailable",
        ...auditContext,
      });
      return response;
    }
    throw err;
  }

  const response = appRedirect(
    request,
    backendResponse.ok ? "connected" : "failed",
  );
  clearOauthCookies(response);
  auditLog({
    ts: new Date().toISOString(),
    event: backendResponse.ok ? "fhir.oauth.connected" : "fhir.oauth.denied",
    method: "GET",
    resourceType: "fhir.oauth",
    status: backendResponse.status,
    ...(backendResponse.ok ? {} : { reason: "callback_failed" }),
    ...auditContext,
  });
  return response;
}

async function consumeDeniedCallback(
  request: NextRequest,
  accessToken: string,
  state: string,
  auditContext: ReturnType<typeof createRequestAuditContext>,
): Promise<NextResponse> {
  try {
    const backendResponse = await backendFetch(
      "/api/v1/fhir/connections/callback/denial",
      {
        method: "POST",
        headers: backendJsonHeaders(accessToken),
        body: JSON.stringify({ state }),
      },
    );
    const response = appRedirect(
      request,
      backendResponse.ok ? "denied" : "failed",
    );
    auditLog({
      ts: new Date().toISOString(),
      event: "fhir.oauth.denied",
      method: "GET",
      resourceType: "fhir.oauth",
      status: backendResponse.status,
      reason: backendResponse.ok ? "provider_denied" : "denial_callback_failed",
      ...auditContext,
    });
    return response;
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      const response = appRedirect(request, "failed");
      auditLog({
        ts: new Date().toISOString(),
        event: "fhir.oauth.denied",
        method: "GET",
        resourceType: "fhir.oauth",
        status: 503,
        reason: "backend_unavailable",
        ...auditContext,
      });
      return response;
    }
    throw err;
  }
}
