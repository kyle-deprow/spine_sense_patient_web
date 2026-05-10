import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { COOKIE_NAMES, clearAuthCookies, setAuthCookies, setCsrfCookie } from '@/lib/auth/cookies'
import { createCsrfToken } from '@/lib/auth/csrf'
import { BackendUnavailableError, backendFetch, hasTokenPair, readJsonBody, stripTokens } from '@/lib/server/backend'
import { getPatientWebConfig } from '@/lib/server/config'
import { jsonNoStore, withNoStore } from '@/lib/server/responses'
import type { BackendTokenPair } from '@/types/auth'

type JsonRecord = Record<string, unknown>

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
): Promise<NextResponse> {
  const backendResponse = await backendFetch(backendPath, authBackendRequest(requestBody))
  const data = await readJsonBody<JsonRecord>(backendResponse)

  if (!backendResponse.ok) {
    return jsonNoStore(data ?? { error: 'auth_failed' }, { status: backendResponse.status })
  }

  const response = jsonNoStore(safeAuthResponse(data), { status: backendResponse.status })
  if (hasTokenPair(data)) {
    setAuthCookies(response, toTokenPair(data))
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
