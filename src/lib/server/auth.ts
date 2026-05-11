import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { COOKIE_NAMES, SESSION_MAX_AGE_SECONDS, clearAuthCookies, issueSessionIssuedAt, setAuthCookies, setCsrfCookie } from '@/lib/auth/cookies'
import { createCsrfToken } from '@/lib/auth/csrf'
import { BackendUnavailableError, backendFetch, hasTokenPair, readJsonBody, stripTokens } from '@/lib/server/backend'
import { getPatientWebConfig } from '@/lib/server/config'
import { jsonNoStore, withNoStore } from '@/lib/server/responses'
import { auditLog, extractUserIdFromToken } from '@/lib/server/audit'
import type { BackendLoginResponse, BackendTokenPair } from '@/types/auth'

type JsonRecord = Record<string, unknown>

function normalizeAuthError(backendStatus: number): { status: number; body: { error: string } } {
  if (backendStatus === 429) {
    // Rate limit from the backend — safe to surface
    return { status: 429, body: { error: 'too_many_requests' } }
  }
  if (backendStatus === 422 || backendStatus === 400) {
    // Validation error (e.g. malformed request body) — safe to surface as 400
    return { status: 400, body: { error: 'invalid_request' } }
  }
  if (backendStatus === 503 || backendStatus === 502) {
    // Backend unavailable — already handled upstream via BackendUnavailableError,
    // but guard here in case the backend returns a 503 response body
    return { status: 503, body: { error: 'service_unavailable' } }
  }
  // 401, 403, 404, 423, 500, and anything else → generic auth_failed at 401
  // This collapses "wrong password", "email not found", "account locked" into one shape
  return { status: 401, body: { error: 'auth_failed' } }
}

export async function readRequestJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export function issueCsrfCookie(response: NextResponse): void {
  const { csrfSecret } = getPatientWebConfig()
  setCsrfCookie(response, createCsrfToken(csrfSecret))
}

export function authBackendRequest(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  }
}

export async function forwardCredentialAuth(
  backendPath: string,
  requestBody: unknown,
  request?: NextRequest,
): Promise<NextResponse> {
  const backendResponse = await backendFetch(backendPath, authBackendRequest(requestBody))
  const data = await readJsonBody<BackendLoginResponse>(backendResponse)

  if (!backendResponse.ok) {
    const normalized = normalizeAuthError(backendResponse.status)
    return jsonNoStore(normalized.body, { status: normalized.status })
  }

  // Capture user_id and mfa_required before hasTokenPair narrows the type.
  const userId = data?.user_id ?? undefined
  const mfaRequired = data?.mfa_required

  // Derive audit event name from the backend path before stripTokens discards user_id.
  const requestId = request?.headers.get('x-request-id') ?? undefined
  const isMfaVerify = backendPath.includes('/mfa/verify')
  const successEvent = isMfaVerify ? 'auth.mfa.verify.success' : 'auth.login.success'

  if (hasTokenPair(data)) {
    // Full authentication succeeded — tokens are present.
    auditLog({
      ts: new Date().toISOString(),
      event: successEvent,
      method: 'POST',
      userId,
      status: backendResponse.status,
      requestId,
    })
  } else if (mfaRequired) {
    // First-factor succeeded but MFA step is still required.
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.mfa.interim',
      method: 'POST',
      userId,
      status: backendResponse.status,
      requestId,
    })
  }

  const response = jsonNoStore(safeAuthResponse(data as JsonRecord), { status: backendResponse.status })
  if (hasTokenPair(data)) {
    setAuthCookies(response, toTokenPair(data))
    issueSessionIssuedAt(response)
    issueCsrfCookie(response)
  }
  return response
}

export async function refreshWithCookie(request: NextRequest): Promise<NextResponse> {
  const refreshToken = request.cookies.get(COOKIE_NAMES.refresh)?.value
  if (!refreshToken) {
    const response = jsonNoStore({ error: 'refresh_token_missing' }, { status: 401 })
    clearAuthCookies(response)
    return response
  }

  const backendResponse = await backendFetch(
    '/api/v1/auth/refresh',
    authBackendRequest({ refresh_token: refreshToken }),
  )
  const data = await readJsonBody<JsonRecord>(backendResponse)

  if (!backendResponse.ok || !hasTokenPair(data)) {
    const response = jsonNoStore({ error: 'refresh_failed' }, { status: 401 })
    clearAuthCookies(response)
    return response
  }

  const response = jsonNoStore({ success: true })
  setAuthCookies(response, toTokenPair(data))
  issueCsrfCookie(response)
  return response
}

export async function logoutWithCookie(request: NextRequest): Promise<NextResponse> {
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value

  if (!accessToken) {
    // Already logged out — cookies are absent, nothing to revoke.
    const response = jsonNoStore({ success: true })
    clearAuthCookies(response)
    return response
  }

  let backendOk = false
  try {
    const backendResponse = await backendFetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    backendOk = backendResponse.ok
  } catch (err) {
    if (!(err instanceof BackendUnavailableError)) throw err
    // BackendUnavailableError — fall through to clear cookies and return 502.
  }

  // Always clear browser cookies: even on backend failure the local session
  // must be invalidated so the patient is not left in a half-logged-out state.
  if (!backendOk) {
    const response = jsonNoStore({ error: 'logout_backend_failed' }, { status: 502 })
    clearAuthCookies(response)
    return response
  }

  const response = jsonNoStore({ success: true })
  clearAuthCookies(response)
  return response
}

export async function sessionFromCookie(request: NextRequest): Promise<NextResponse> {
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value
  if (!accessToken) {
    const response = jsonNoStore({ error: 'unauthorized' }, { status: 401 })
    issueCsrfCookie(response)
    return response
  }

  const backendResponse = await backendFetch('/api/v1/auth/session', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
  })
  const data = await readJsonBody<JsonRecord>(backendResponse)

  if (!backendResponse.ok) {
    const response = jsonNoStore(data ?? { error: 'unauthorized' }, { status: backendResponse.status })
    if (backendResponse.status === 401) {
      clearAuthCookies(response)
      issueCsrfCookie(response)
    }
    return response
  }

  const response = jsonNoStore(data)
  issueCsrfCookie(response)
  return response
}

function safeAuthResponse(data: JsonRecord): JsonRecord {
  return stripTokens(data)
}

function toTokenPair(data: BackendTokenPair): { accessToken: string; refreshToken: string } {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  }
}

export function clearAndNoStore(body: unknown, status = 200): NextResponse {
  const response = jsonNoStore(body, { status })
  clearAuthCookies(response)
  return withNoStore(response)
}
