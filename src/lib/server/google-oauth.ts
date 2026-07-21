import 'server-only'

import { createHash, randomBytes } from 'crypto'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import {
  clearAuthCookies,
  clearMfaTransactionCookies,
  issueAuthenticatedSessionCookies,
  setMfaTransactionCookies,
} from '@/lib/auth/cookies'
import { auditLog, createAuditContext } from '@/lib/server/audit'
import { issueCsrfCookie, resolveBackendAuthenticatedActorId } from '@/lib/server/auth'
import { backendFetch, hasTokenPair, readJsonBody } from '@/lib/server/backend'
import { getPatientWebConfig } from '@/lib/server/config'
import type { BackendLoginResponse, BackendTokenPair } from '@/types/auth'

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CALLBACK_PATH = '/api/auth/google/callback'
const COOKIE_MAX_AGE_SECONDS = 10 * 60

const OAUTH_COOKIE_NAMES = {
  state: 'spine_google_oauth_state',
  verifier: 'spine_google_oauth_verifier',
  mode: 'spine_google_oauth_mode',
  returnTo: 'spine_google_oauth_return_to',
} as const

type GoogleAuthMode = 'login' | 'register'

type GoogleTokenResponse = {
  id_token?: unknown
}

type BackendErrorResponse = {
  detail?: unknown
}

type GoogleFailureReason =
  | 'account_exists'
  | 'already_linked'
  | 'callback_failed'
  | 'google'
  | 'missing_id_token'
  | 'not_linked'
  | 'state_mismatch'

function randomUrlToken(byteLength = 32): string {
  return randomBytes(byteLength).toString('base64url')
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function oauthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV !== 'development',
    sameSite: 'lax' as const,
    path: '/api/auth/google',
    maxAge: COOKIE_MAX_AGE_SECONDS,
  }
}

function clearOauthCookies(response: NextResponse): void {
  for (const name of Object.values(OAUTH_COOKIE_NAMES)) {
    response.cookies.set(name, '', {
      ...oauthCookieOptions(),
      maxAge: 0,
    })
  }
}

function requestOrigin(request: NextRequest): string {
  const { publicUrl } = getPatientWebConfig()
  if (publicUrl) return publicUrl.replace(/\/+$/, '')
  return request.nextUrl.origin
}

function redirectUri(request: NextRequest): string {
  return `${requestOrigin(request)}${CALLBACK_PATH}`
}

function parseMode(value: string | null): GoogleAuthMode {
  return value === 'register' ? 'register' : 'login'
}

function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  if (value.includes('\\') || value.includes('\0')) return '/'
  return value
}

function redirectWithinApp(request: NextRequest, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, requestOrigin(request)))
}

function googleConfig(): { clientId: string; clientSecret: string } {
  const { googleClientId, googleClientSecret } = getPatientWebConfig()
  if (!googleClientId || !googleClientSecret) {
    throw new Error('Google OAuth is not configured for patient web')
  }
  return { clientId: googleClientId, clientSecret: googleClientSecret }
}

export function startGoogleOAuth(request: NextRequest): NextResponse {
  const auditContext = createAuditContext()
  const { clientId } = googleConfig()
  const mode = parseMode(request.nextUrl.searchParams.get('mode'))
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'))
  const state = randomUrlToken()
  const verifier = randomUrlToken(48)

  const authUrl = new URL(GOOGLE_AUTH_URL)
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', redirectUri(request))
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('scope', 'openid email')
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('nonce', randomUrlToken())
  authUrl.searchParams.set('code_challenge', pkceChallenge(verifier))
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('prompt', 'select_account')

  const response = NextResponse.redirect(authUrl)
  clearAuthCookies(response)
  clearMfaTransactionCookies(response)
  response.cookies.set(OAUTH_COOKIE_NAMES.state, state, oauthCookieOptions())
  response.cookies.set(OAUTH_COOKIE_NAMES.verifier, verifier, oauthCookieOptions())
  response.cookies.set(OAUTH_COOKIE_NAMES.mode, mode, oauthCookieOptions())
  response.cookies.set(OAUTH_COOKIE_NAMES.returnTo, returnTo, oauthCookieOptions())
  auditLog({
    ts: new Date().toISOString(),
    event: 'auth.google.start',
    method: 'GET',
    ...auditContext,
  })
  return response
}

export async function completeGoogleOAuth(request: NextRequest): Promise<NextResponse> {
  const auditContext = createAuditContext()
  const expectedState = request.cookies.get(OAUTH_COOKIE_NAMES.state)?.value
  const verifier = request.cookies.get(OAUTH_COOKIE_NAMES.verifier)?.value
  const mode = parseMode(request.cookies.get(OAUTH_COOKIE_NAMES.mode)?.value ?? null)
  const returnTo = safeReturnTo(request.cookies.get(OAUTH_COOKIE_NAMES.returnTo)?.value ?? null)
  const state = request.nextUrl.searchParams.get('state')
  const code = request.nextUrl.searchParams.get('code')

  if (!expectedState || !verifier || !state || state !== expectedState || !code) {
    return googleFailureRedirect(request, mode, 'state_mismatch')
  }

  try {
    const token = await exchangeGoogleCode(request, code, verifier)
    if (!token.id_token || typeof token.id_token !== 'string') {
      return googleFailureRedirect(request, mode, 'missing_id_token')
    }

    const backendPath = mode === 'register' ? '/api/v1/auth/register/google' : '/api/v1/auth/login/google'
    const backendResponse = await backendFetch(backendPath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ id_token: token.id_token }),
    })
    const data = await readJsonBody<BackendLoginResponse & BackendErrorResponse>(backendResponse)
    const authData = data as BackendLoginResponse & BackendErrorResponse
    const backendActorId = authData.user_id
    if (!backendResponse.ok) {
      return googleFailureRedirect(request, mode, googleFailureReason(mode, backendResponse.status, data))
    }
    const tokenPairIssued = hasTokenPair(data)
    const hasChallenge = authData.mfa_required === true || authData.mfa_enrollment_required === true
    const malformedChallenge =
      (authData.mfa_required !== undefined && typeof authData.mfa_required !== 'boolean') ||
      (authData.mfa_enrollment_required !== undefined && typeof authData.mfa_enrollment_required !== 'boolean') ||
      (authData.mfa_required === true && authData.mfa_enrollment_required === true) ||
      (hasChallenge && tokenPairIssued) ||
      (hasChallenge && (typeof authData.mfa_token !== 'string' || authData.mfa_token.length === 0)) ||
      (authData.mfa_required === true &&
        (typeof authData.mfa_method_id !== 'string' || authData.mfa_method_id.length === 0))
    if (malformedChallenge || (!tokenPairIssued && !hasChallenge)) {
      return googleFailureRedirect(request, mode, 'callback_failed')
    }
    if (hasChallenge) {
      const challengePath = authData.mfa_enrollment_required ? '/mfa-enrollment' : '/verify?mode=mfa'
      const response = redirectWithinApp(request, challengePath)
      clearAuthCookies(response)
      clearMfaTransactionCookies(response)
      setMfaTransactionCookies(response, authData.mfa_token as string, authData.mfa_method_id)
      issueCsrfCookie(response)
      clearOauthCookies(response)
      auditLog({
        ts: new Date().toISOString(),
        event: 'auth.mfa.interim',
        method: 'GET',
        status: backendResponse.status,
        ...auditContext,
      })
      return response
    }
    const tokenPair = data as BackendTokenPair
    const actorId = await resolveBackendAuthenticatedActorId(backendActorId, tokenPair)
    if (actorId === undefined) {
      return googleFailureRedirect(request, mode, 'callback_failed')
    }

    const response = redirectWithinApp(request, returnTo)
    clearAuthCookies(response)
    clearMfaTransactionCookies(response)
    const issued = issueAuthenticatedSessionCookies(response, {
      accessToken: tokenPair.access_token,
      refreshToken: tokenPair.refresh_token,
      actorId,
    })
    issueCsrfCookie(response)
    clearOauthCookies(response)
    auditLog({
      ts: new Date().toISOString(),
      event: mode === 'register' ? 'auth.google.register.success' : 'auth.google.login.success',
      method: 'GET',
      status: backendResponse.status,
      ...auditContext,
      actorId,
      sessionCorrelation: issued.sessionCorrelation,
    })
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.token.issued',
      method: 'GET',
      status: backendResponse.status,
      ...auditContext,
      actorId,
      sessionCorrelation: issued.sessionCorrelation,
      reason: 'google_token_pair',
    })
    return response
  } catch {
    return googleFailureRedirect(request, mode, 'callback_failed')
  }
}

async function exchangeGoogleCode(request: NextRequest, code: string, verifier: string): Promise<GoogleTokenResponse> {
  const { clientId, clientSecret } = googleConfig()
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(request),
    grant_type: 'authorization_code',
    code_verifier: verifier,
  })

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body,
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    throw new Error('Google OAuth token exchange failed')
  }

  return (await response.json()) as GoogleTokenResponse
}

function googleFailureRedirect(request: NextRequest, mode: GoogleAuthMode, reason: GoogleFailureReason): NextResponse {
  const auditContext = createAuditContext()
  const targetPath =
    mode === 'register' && (reason === 'account_exists' || reason === 'already_linked')
      ? '/login'
      : mode === 'register'
        ? '/register'
        : '/login'
  const target = `${targetPath}?socialAuthError=${encodeURIComponent(reason)}`
  const response = redirectWithinApp(request, target)
  clearAuthCookies(response)
  clearMfaTransactionCookies(response)
  clearOauthCookies(response)
  auditLog({
    ts: new Date().toISOString(),
    event: mode === 'register' ? 'auth.google.register.failure' : 'auth.google.login.failure',
    method: 'GET',
    reason,
    ...auditContext,
  })
  return response
}

function googleFailureReason(mode: GoogleAuthMode, status: number, data: BackendErrorResponse): GoogleFailureReason {
  const detail = typeof data.detail === 'string' ? data.detail : ''

  if (mode === 'register' && status === 409 && detail === 'ACCOUNT_EXISTS_REQUIRES_LOGIN') {
    return 'account_exists'
  }

  if (status === 409 && detail === 'Social identity already linked to another account') {
    return 'already_linked'
  }

  if (mode === 'login' && status === 401 && detail === 'SOCIAL_ACCOUNT_NOT_LINKED') {
    return 'not_linked'
  }

  return 'google'
}
