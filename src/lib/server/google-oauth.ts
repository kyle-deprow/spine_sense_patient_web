import "server-only";

import { createHash, randomBytes } from "node:crypto";

import Redis from "ioredis";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import {
  COOKIE_NAMES,
  clearMfaTransactionCookies,
  issueAuthenticatedSessionCookies,
  setMfaTransactionCookies,
  shouldUseSecureCookies,
} from "@/lib/auth/cookies";
import { frontDoorOriginRejectionReason } from "@/lib/front-door-origin-guard";
import {
  auditLog,
  createAuditContext,
  isRoutineAuditEnabled,
} from "@/lib/server/audit";
import {
  issueCsrfCookie,
  resolveBackendAuthenticatedActorId,
} from "@/lib/server/auth";
import { backendFetch, hasTokenPair, readJsonBody } from "@/lib/server/backend";
import { getGoogleOAuthConfig, getPatientWebConfig } from "@/lib/server/config";
import { getClientRateLimitKey, rateLimit } from "@/lib/server/rate-limit";
import {
  configurationUnavailableResponse,
  jsonNoStore,
} from "@/lib/server/responses";
import type { BackendLoginResponse, BackendTokenPair } from "@/types/auth";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALLBACK_PATH = "/api/auth/google/callback";
const LINK_BACKEND_PATH = "/api/v1/auth/social-identities/link";
const COOKIE_MAX_AGE_SECONDS = 10 * 60;
const MAX_PENDING_STATES = 2048;
const OAUTH_INIT_LIMIT = 10;
const OAUTH_INIT_WINDOW_MS = 15 * 60 * 1000;
const STATE_KEY_PREFIX = "spinesense:patient-web:google-oauth-state:v1:";
const STATE_CONSUME_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if value then redis.call('DEL', KEYS[1]) end
return value
`;
const OAUTH_STATE_COOKIE = "spine_google_oauth_state";
const SAFE_RETURN_PATHS = new Set([
  "/",
  "/login",
  "/register",
  "/profile/linked-accounts",
]);

type GoogleAuthMode = "login" | "register" | "link";
type GoogleTokenResponse = { id_token?: unknown };
type BackendErrorResponse = { detail?: unknown };
type GoogleFailureReason =
  | "account_exists"
  | "already_linked"
  | "callback_failed"
  | "cancelled"
  | "google"
  | "missing_id_token"
  | "not_linked"
  | "session_required"
  | "state_mismatch";

interface OAuthStateRecord {
  linkSessionDigest: string | null;
  mode: GoogleAuthMode;
  nonce: string;
  returnTo: string;
  verifier: string;
}

const pendingStates = new Map<
  string,
  { expiresAt: number; record: OAuthStateRecord }
>();
let redisClient: Redis | null = null;
let redisConnectPromise: Promise<void> | null = null;

function randomUrlToken(byteLength = 32): string {
  return randomBytes(byteLength).toString("base64url");
}

function stateKey(state: string): string {
  return `${STATE_KEY_PREFIX}${createHash("sha256").update(state).digest("base64url")}`;
}

function sessionDigest(accessToken: string): string {
  return createHash("sha256")
    .update(`spinesense.patient-web.google-link-session.v1\0${accessToken}`)
    .digest("base64url");
}

async function issueState(record: OAuthStateRecord): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const state = randomUrlToken();
    if (await storeStateIfAbsent(stateKey(state), record)) return state;
  }
  throw new Error("Unable to allocate OAuth state");
}

async function consumeState(state: string): Promise<OAuthStateRecord | null> {
  const serialized = await consumeStoredState(stateKey(state));
  return serialized === null ? null : parseStateRecord(serialized);
}

async function storeStateIfAbsent(
  key: string,
  record: OAuthStateRecord,
): Promise<boolean> {
  const config = getPatientWebConfig();
  if (config.credentialRateLimitStore === "memory") {
    prunePendingStates();
    if (pendingStates.has(key)) return false;
    pendingStates.set(key, {
      expiresAt: Date.now() + COOKIE_MAX_AGE_SECONDS * 1000,
      record,
    });
    while (pendingStates.size > MAX_PENDING_STATES) {
      const oldest = pendingStates.keys().next().value;
      if (typeof oldest !== "string") break;
      pendingStates.delete(oldest);
    }
    return true;
  }
  const client = await getReadyRedisClient(config.redisUrl);
  return (
    (await client.set(
      key,
      JSON.stringify(record),
      "PX",
      COOKIE_MAX_AGE_SECONDS * 1000,
      "NX",
    )) === "OK"
  );
}

async function consumeStoredState(key: string): Promise<string | null> {
  const config = getPatientWebConfig();
  if (config.credentialRateLimitStore === "memory") {
    prunePendingStates();
    const entry = pendingStates.get(key);
    if (entry === undefined) return null;
    pendingStates.delete(key);
    return JSON.stringify(entry.record);
  }
  const client = await getReadyRedisClient(config.redisUrl);
  const value = await client.eval(STATE_CONSUME_SCRIPT, 1, key);
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Invalid OAuth state result");
  return value;
}

function prunePendingStates(): void {
  const now = Date.now();
  for (const [key, entry] of pendingStates) {
    if (entry.expiresAt <= now) pendingStates.delete(key);
  }
}

function parseStateRecord(value: string): OAuthStateRecord | null {
  try {
    const parsed = JSON.parse(value) as Partial<OAuthStateRecord>;
    if (
      !isGoogleAuthMode(parsed.mode) ||
      typeof parsed.nonce !== "string" ||
      parsed.nonce.length !== 43 ||
      typeof parsed.verifier !== "string" ||
      parsed.verifier.length < 43 ||
      typeof parsed.returnTo !== "string" ||
      (parsed.linkSessionDigest !== null &&
        (typeof parsed.linkSessionDigest !== "string" ||
          parsed.linkSessionDigest.length !== 43)) ||
      (parsed.mode === "link") !== (parsed.linkSessionDigest !== null) ||
      safeReturnTo(
        parsed.returnTo,
        parsed.mode === "link" ? "/profile/linked-accounts" : "/",
      ) !== parsed.returnTo
    ) {
      return null;
    }
    return {
      mode: parsed.mode,
      linkSessionDigest: parsed.linkSessionDigest,
      nonce: parsed.nonce,
      returnTo: parsed.returnTo,
      verifier: parsed.verifier,
    };
  } catch {
    return null;
  }
}

function createRedisClient(redisUrl: string): Redis {
  redisClient = new Redis(redisUrl, {
    connectTimeout: 1_500,
    commandTimeout: 2_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redisClient.on("error", () => undefined);
  return redisClient;
}

async function getReadyRedisClient(redisUrl: string | null): Promise<Redis> {
  if (redisUrl === null) throw new Error("OAuth state store is unavailable");
  if (redisClient === null || redisClient.status === "end") {
    createRedisClient(redisUrl);
  }
  const client = redisClient;
  if (client === null) throw new Error("OAuth state store is unavailable");
  if (client.status === "ready") return client;
  if (redisConnectPromise === null) {
    redisConnectPromise = client.connect().finally(() => {
      redisConnectPromise = null;
    });
  }
  try {
    await redisConnectPromise;
  } catch {
    client.disconnect(false);
    if (redisClient === client) redisClient = null;
    throw new Error("OAuth state store is unavailable");
  }
  if (String(client.status) !== "ready") {
    throw new Error("OAuth state store is unavailable");
  }
  return client;
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function oauthCookieOptions() {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: "lax" as const,
    path: "/api/auth/google",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  };
}

function clearOauthCookies(response: NextResponse): void {
  response.cookies.set(OAUTH_STATE_COOKIE, "", {
    ...oauthCookieOptions(),
    maxAge: 0,
  });
}

function oauthPublicOrigin(request: NextRequest): string {
  const oauthConfig = getGoogleOAuthConfig();
  const config = getPatientWebConfig();
  const publicUrl = new URL(oauthConfig.publicUrl);
  if (
    config.frontDoorOriginGuardMode === "enforce" &&
    (config.azureFrontDoorId === null ||
      frontDoorOriginRejectionReason(
        request.headers,
        config.azureFrontDoorId,
      ) !== null)
  ) {
    throw new Error("OAuth request source is not trusted");
  }
  const forwardedHost = strictSingleHeader(request, "x-forwarded-host");
  const observedHost =
    forwardedHost ?? request.headers.get("host") ?? request.nextUrl.host;
  if (observedHost.toLowerCase() !== publicUrl.host.toLowerCase()) {
    throw new Error("OAuth request host is not allowed");
  }
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== publicUrl.origin) {
    throw new Error("OAuth request origin is not allowed");
  }
  return publicUrl.origin;
}

function strictSingleHeader(request: NextRequest, name: string): string | null {
  const value = request.headers.get(name);
  if (value === null) return null;
  if (value !== value.trim() || value === "" || value.includes(",")) {
    throw new Error("OAuth forwarding metadata is invalid");
  }
  return value;
}

function parseMode(value: string | null): GoogleAuthMode | null {
  if (value === null || value === "login") return "login";
  return isGoogleAuthMode(value) ? value : null;
}

function isGoogleAuthMode(value: unknown): value is GoogleAuthMode {
  return value === "login" || value === "register" || value === "link";
}

function safeReturnTo(value: string | null, fallback = "/"): string {
  return value !== null && SAFE_RETURN_PATHS.has(value) ? value : fallback;
}

function redirectWithinApp(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, oauthPublicOrigin(request)));
}

async function oauthInitiationFailure(
  request: NextRequest,
): Promise<NextResponse | null> {
  const baseKey = getClientRateLimitKey(request, "auth.login");
  if (baseKey === null) return configurationUnavailableResponse();
  const digest = createHash("sha256")
    .update(`spinesense.patient-web.google-oauth-init.v1\0${baseKey}`)
    .digest("base64url");
  try {
    const allowed = await rateLimit(`google-oauth-init:v1:${digest}`, {
      limit: OAUTH_INIT_LIMIT,
      windowMs: OAUTH_INIT_WINDOW_MS,
    });
    return allowed
      ? null
      : jsonNoStore(
          { error: "too_many_requests" },
          {
            status: 429,
            headers: { "Retry-After": String(OAUTH_INIT_WINDOW_MS / 1000) },
          },
        );
  } catch {
    return configurationUnavailableResponse();
  }
}

export async function startGoogleOAuth(
  request: NextRequest,
): Promise<NextResponse> {
  const mode = parseMode(request.nextUrl.searchParams.get("mode"));
  if (mode === null) {
    return jsonNoStore({ error: "invalid_mode" }, { status: 400 });
  }
  const auditContext = createAuditContext();
  const oauthConfig = getGoogleOAuthConfig();
  const origin = oauthPublicOrigin(request);
  const existingAccessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
  if (mode === "link" && !existingAccessToken) {
    return jsonNoStore({ error: "unauthorized" }, { status: 401 });
  }
  const rateLimitFailure = await oauthInitiationFailure(request);
  if (rateLimitFailure !== null) return rateLimitFailure;

  const returnTo = safeReturnTo(
    request.nextUrl.searchParams.get("returnTo"),
    mode === "link" ? "/profile/linked-accounts" : "/",
  );
  const verifier = randomUrlToken(48);
  const nonce = randomUrlToken();
  const state = await issueState({
    mode,
    nonce,
    returnTo,
    verifier,
    linkSessionDigest:
      mode === "link" ? sessionDigest(existingAccessToken as string) : null,
  });
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", oauthConfig.clientId);
  authUrl.searchParams.set("redirect_uri", `${origin}${CALLBACK_PATH}`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", pkceChallenge(verifier));
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("prompt", "select_account");

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(OAUTH_STATE_COOKIE, state, oauthCookieOptions());
  if (isRoutineAuditEnabled()) {
    auditLog({
      ts: new Date().toISOString(),
      event: "auth.google.start",
      method: "GET",
      ...auditContext,
    });
  }
  return response;
}

export async function completeGoogleOAuth(
  request: NextRequest,
): Promise<NextResponse> {
  oauthPublicOrigin(request);
  const auditContext = createAuditContext();
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  const state = request.nextUrl.searchParams.get("state");
  if (!expectedState || !state || state !== expectedState) {
    return googleFailureRedirect(request, "login", "state_mismatch");
  }
  const transaction = await consumeState(state);
  if (transaction === null) {
    return googleFailureRedirect(request, "login", "state_mismatch");
  }
  const code = request.nextUrl.searchParams.get("code");
  const providerError = request.nextUrl.searchParams.get("error");
  if (providerError || !code) {
    return googleFailureRedirect(request, transaction.mode, "cancelled");
  }
  const existingAccessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
  if (transaction.mode === "link" && !existingAccessToken) {
    return googleFailureRedirect(request, "link", "session_required");
  }
  if (
    transaction.mode === "link" &&
    transaction.linkSessionDigest !==
      sessionDigest(existingAccessToken as string)
  ) {
    return googleFailureRedirect(request, "link", "session_required");
  }

  try {
    const token = await exchangeGoogleCode(request, code, transaction.verifier);
    if (!token.id_token || typeof token.id_token !== "string") {
      return googleFailureRedirect(
        request,
        transaction.mode,
        "missing_id_token",
      );
    }
    if (readGoogleNonce(token.id_token) !== transaction.nonce) {
      return googleFailureRedirect(
        request,
        transaction.mode,
        "callback_failed",
      );
    }
    if (transaction.mode === "link") {
      return await completeGoogleLink(
        request,
        token.id_token,
        existingAccessToken as string,
        transaction.returnTo,
        auditContext,
      );
    }
    return await completeGoogleLoginOrRegistration(
      request,
      token.id_token,
      transaction.mode,
      transaction.returnTo,
      auditContext,
    );
  } catch {
    return googleFailureRedirect(request, transaction.mode, "callback_failed");
  }
}

async function completeGoogleLink(
  request: NextRequest,
  idToken: string,
  accessToken: string,
  returnTo: string,
  auditContext: ReturnType<typeof createAuditContext>,
): Promise<NextResponse> {
  const browserUserAgent = request.headers.get("user-agent");
  const backendResponse = await backendFetch(LINK_BACKEND_PATH, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(browserUserAgent ? { "User-Agent": browserUserAgent } : {}),
    },
    body: JSON.stringify({ provider: "google", id_token: idToken }),
    signal: request.signal,
  });
  const data = await readJsonBody<BackendErrorResponse>(backendResponse);
  if (!backendResponse.ok) {
    return googleFailureRedirect(
      request,
      "link",
      googleFailureReason("link", backendResponse.status, data),
    );
  }
  const response = redirectWithinApp(request, returnTo);
  clearOauthCookies(response);
  if (isRoutineAuditEnabled()) {
    auditLog({
      ts: new Date().toISOString(),
      event: "auth.google.link.success",
      method: "GET",
      status: backendResponse.status,
      ...auditContext,
    });
  }
  return response;
}

async function completeGoogleLoginOrRegistration(
  request: NextRequest,
  idToken: string,
  mode: "login" | "register",
  returnTo: string,
  auditContext: ReturnType<typeof createAuditContext>,
): Promise<NextResponse> {
  const backendPath =
    mode === "register"
      ? "/api/v1/auth/register/google"
      : "/api/v1/auth/login/google";
  const browserUserAgent = request.headers.get("user-agent");
  const backendResponse = await backendFetch(backendPath, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(browserUserAgent ? { "User-Agent": browserUserAgent } : {}),
    },
    body: JSON.stringify({ id_token: idToken }),
    signal: request.signal,
  });
  const data = await readJsonBody<BackendLoginResponse & BackendErrorResponse>(
    backendResponse,
  );
  const authData = data as BackendLoginResponse & BackendErrorResponse;
  const backendActorId = authData.user_id;
  if (!backendResponse.ok) {
    return googleFailureRedirect(
      request,
      mode,
      googleFailureReason(mode, backendResponse.status, authData),
    );
  }
  const tokenPairIssued = hasTokenPair(data);
  const hasChallenge =
    authData.mfa_required === true || authData.mfa_enrollment_required === true;
  const malformedChallenge =
    (authData.mfa_required !== undefined &&
      typeof authData.mfa_required !== "boolean") ||
    (authData.mfa_enrollment_required !== undefined &&
      typeof authData.mfa_enrollment_required !== "boolean") ||
    (authData.mfa_required === true &&
      authData.mfa_enrollment_required === true) ||
    (hasChallenge && tokenPairIssued) ||
    (hasChallenge &&
      (typeof authData.mfa_token !== "string" ||
        authData.mfa_token.length === 0)) ||
    (authData.mfa_required === true &&
      (typeof authData.mfa_method_id !== "string" ||
        authData.mfa_method_id.length === 0));
  if (malformedChallenge || (!tokenPairIssued && !hasChallenge)) {
    return googleFailureRedirect(request, mode, "callback_failed");
  }
  if (hasChallenge) {
    const challengePath = authData.mfa_enrollment_required
      ? "/mfa-enrollment"
      : "/verify";
    const response = redirectWithinApp(request, challengePath);
    clearMfaTransactionCookies(response);
    setMfaTransactionCookies(
      response,
      authData.mfa_token as string,
      authData.mfa_method_id,
    );
    issueCsrfCookie(response);
    clearOauthCookies(response);
    auditLog({
      ts: new Date().toISOString(),
      event: "auth.mfa.interim",
      method: "GET",
      status: backendResponse.status,
      ...auditContext,
    });
    return response;
  }

  const tokenPair = data as BackendTokenPair;
  const actorId = await resolveBackendAuthenticatedActorId(
    backendActorId,
    tokenPair,
  );
  if (actorId === undefined) {
    return googleFailureRedirect(request, mode, "callback_failed");
  }
  const response = redirectWithinApp(request, returnTo);
  clearMfaTransactionCookies(response);
  const issued = issueAuthenticatedSessionCookies(response, {
    accessToken: tokenPair.access_token,
    refreshToken: tokenPair.refresh_token,
    actorId,
  });
  issueCsrfCookie(response);
  clearOauthCookies(response);
  if (isRoutineAuditEnabled()) {
    auditLog({
      ts: new Date().toISOString(),
      event:
        mode === "register"
          ? "auth.google.register.success"
          : "auth.google.login.success",
      method: "GET",
      status: backendResponse.status,
      ...auditContext,
      actorId,
      sessionCorrelation: issued.sessionCorrelation,
    });
  }
  auditLog({
    ts: new Date().toISOString(),
    event: "auth.token.issued",
    method: "GET",
    status: backendResponse.status,
    ...auditContext,
    actorId,
    sessionCorrelation: issued.sessionCorrelation,
    reason: "google_token_pair",
  });
  return response;
}

async function exchangeGoogleCode(
  request: NextRequest,
  code: string,
  verifier: string,
): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret, publicUrl } = getGoogleOAuthConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `${publicUrl}${CALLBACK_PATH}`,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    cache: "no-store",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw new Error("Google OAuth token exchange failed");
  return (await response.json()) as GoogleTokenResponse;
}

function readGoogleNonce(idToken: string): string | undefined {
  const segments = idToken.split(".");
  if (segments.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(segments[1] ?? "", "base64url").toString("utf8"),
    ) as { nonce?: unknown };
    return typeof payload.nonce === "string" ? payload.nonce : undefined;
  } catch {
    return undefined;
  }
}

function googleFailureRedirect(
  request: NextRequest,
  mode: GoogleAuthMode,
  reason: GoogleFailureReason,
): NextResponse {
  const auditContext = createAuditContext();
  const targetPath =
    mode === "link"
      ? "/profile/linked-accounts"
      : mode === "register" &&
          (reason === "account_exists" || reason === "already_linked")
        ? "/login"
        : mode === "register"
          ? "/register"
          : "/login";
  const response = redirectWithinApp(
    request,
    `${targetPath}?socialAuthError=${encodeURIComponent(reason)}`,
  );
  clearOauthCookies(response);
  auditLog({
    ts: new Date().toISOString(),
    event:
      mode === "register"
        ? "auth.google.register.failure"
        : mode === "link"
          ? "auth.google.link.failure"
          : "auth.google.login.failure",
    method: "GET",
    reason,
    ...auditContext,
  });
  return response;
}

function googleFailureReason(
  mode: GoogleAuthMode,
  status: number,
  data: BackendErrorResponse,
): GoogleFailureReason {
  const detail = typeof data.detail === "string" ? data.detail : "";
  if (
    mode === "register" &&
    status === 409 &&
    detail === "ACCOUNT_EXISTS_REQUIRES_LOGIN"
  ) {
    return "account_exists";
  }
  if (
    status === 409 &&
    detail === "Social identity already linked to another account"
  ) {
    return "already_linked";
  }
  if (
    mode === "login" &&
    status === 401 &&
    detail === "SOCIAL_ACCOUNT_NOT_LINKED"
  ) {
    return "not_linked";
  }
  return "google";
}

export function googleOAuthConfigurationFailure(): NextResponse {
  return configurationUnavailableResponse();
}
