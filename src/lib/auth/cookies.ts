import type { NextResponse } from 'next/server'

export const COOKIE_NAMES = {
  access: 'spine_patient_sess',
  refresh: 'spine_patient_refresh',
  csrf: 'spine_patient_csrf',
  sessionIssuedAt: 'spine_patient_sess_iat',
} as const

export const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60
export const REFRESH_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
export const CSRF_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60 // 12 hours absolute limit

export interface CookieOptions {
  httpOnly: boolean
  secure: boolean
  sameSite: 'lax' | 'strict'
  path: string
  maxAge: number
}

export function shouldUseSecureCookies(
  nodeEnv = process.env.NODE_ENV,
  override = process.env.PATIENT_WEB_COOKIE_SECURE,
  allowInsecureE2e = process.env.PATIENT_WEB_E2E_ALLOW_INSECURE_COOKIES,
  allowedOrigins = process.env.PATIENT_WEB_ALLOWED_ORIGINS,
): boolean {
  if (allowInsecureE2e === 'true' && nodeEnv === 'production') {
    throw new Error('PATIENT_WEB_E2E_ALLOW_INSECURE_COOKIES must not be set in production')
  }
  if (override === 'true') return true
  if (override === 'false') {
    return !(nodeEnv === 'development' || (allowInsecureE2e === 'true' && hasOnlyLocalOrigins(allowedOrigins)))
  }
  return nodeEnv !== 'development'
}

function hasOnlyLocalOrigins(value: string | undefined): boolean {
  if (!value) return false
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
    .every((origin) => {
      try {
        const url = new URL(origin)
        return (
          url.protocol === 'http:' &&
          (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')
        )
      } catch {
        return false
      }
    })
}

export function accessCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'lax',
    path: '/',
    maxAge: ACCESS_TOKEN_MAX_AGE_SECONDS,
  }
}

export function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'strict',
    path: '/api/auth/refresh',
    maxAge: REFRESH_TOKEN_MAX_AGE_SECONDS,
  }
}

export function csrfCookieOptions(): CookieOptions {
  return {
    httpOnly: false,
    secure: shouldUseSecureCookies(),
    sameSite: 'strict',
    path: '/',
    maxAge: CSRF_TOKEN_MAX_AGE_SECONDS,
  }
}

export function setAuthCookies(
  response: NextResponse,
  tokens: { accessToken: string; refreshToken?: string },
): void {
  response.cookies.set(COOKIE_NAMES.access, tokens.accessToken, accessCookieOptions())
  if (tokens.refreshToken) {
    response.cookies.set(COOKIE_NAMES.refresh, tokens.refreshToken, refreshCookieOptions())
  }
}

export function setCsrfCookie(response: NextResponse, token: string): void {
  response.cookies.set(COOKIE_NAMES.csrf, token, csrfCookieOptions())
}

export function clearAuthCookies(response: NextResponse): void {
  response.cookies.set(COOKIE_NAMES.access, '', {
    ...accessCookieOptions(),
    maxAge: 0,
  })
  response.cookies.set(COOKIE_NAMES.refresh, '', {
    ...refreshCookieOptions(),
    maxAge: 0,
  })
  response.cookies.set(COOKIE_NAMES.csrf, '', {
    ...csrfCookieOptions(),
    maxAge: 0,
  })
  response.cookies.set(COOKIE_NAMES.sessionIssuedAt, '', {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'strict',
    path: '/api/auth/refresh',
    maxAge: 0,
  })
}

export function issueSessionIssuedAt(response: NextResponse, nodeEnv?: 'development' | 'production' | 'test'): void {
  const isSecure = shouldUseSecureCookies(nodeEnv)
  const now = Math.floor(Date.now() / 1000) // Unix seconds
  response.cookies.set(COOKIE_NAMES.sessionIssuedAt, String(now), {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'strict',
    path: '/api/auth/refresh', // only sent to the refresh endpoint
    maxAge: SESSION_MAX_AGE_SECONDS,
  })
}
