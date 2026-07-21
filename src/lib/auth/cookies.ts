import { createHmac, timingSafeEqual } from 'node:crypto'

import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'

import { getPatientWebConfig, type AuditActorSigningKey, type AuditActorSigningKeys } from '@/lib/server/config'

export const COOKIE_NAMES = {
  access: 'spine_patient_sess',
  refresh: 'spine_patient_refresh',
  csrf: 'spine_patient_csrf',
  sessionIssuedAt: 'spine_patient_sess_iat',
  auditActor: 'spine_patient_audit_actor',
  mfaTransaction: 'spine_patient_mfa_transaction',
  mfaMethod: 'spine_patient_mfa_method',
  mfaPending: 'spine_patient_mfa_pending',
} as const

export const ACCESS_TOKEN_MAX_AGE_SECONDS = 15 * 60
export const REFRESH_TOKEN_MAX_AGE_SECONDS = 7 * 24 * 60 * 60
export const CSRF_TOKEN_MAX_AGE_SECONDS = 2 * 60 * 60
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60 // 12 hours absolute limit
export const MFA_TRANSACTION_MAX_AGE_SECONDS = 5 * 60

const AUDIT_ACTOR_COOKIE_VERSION = 'v2'
const AUDIT_ACTOR_SIGNING_PURPOSE = 'patient-web-audit-actor\0'
const SESSION_CORRELATION_PURPOSE = 'patient-web-audit-session\0'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BASE64URL_SHA256_RE = /^[A-Za-z0-9_-]{43}$/
const KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const UNIX_SECONDS_RE = /^[1-9][0-9]{9}$/

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
  if (allowInsecureE2e === 'true' && nodeEnv === 'production' && !hasOnlyLocalOrigins(allowedOrigins)) {
    throw new Error('PATIENT_WEB_E2E_ALLOW_INSECURE_COOKIES must not be set in production')
  }
  if (override === 'true') return true
  if (override === 'false') {
    return !(nodeEnv === 'development' || (allowInsecureE2e === 'true' && hasOnlyLocalOrigins(allowedOrigins)))
  }
  return nodeEnv !== 'development'
}

export function hasOnlyLocalOrigins(value: string | undefined): boolean {
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
    path: '/api',
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

export function auditActorCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'strict',
    path: '/api',
    maxAge: SESSION_MAX_AGE_SECONDS,
  }
}

export function mfaTransactionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'strict',
    path: '/api/auth/mfa',
    maxAge: MFA_TRANSACTION_MAX_AGE_SECONDS,
  }
}

export function setMfaTransactionCookies(response: NextResponse, transaction: string, methodId?: string | null): void {
  if (!transaction) throw new Error('Cannot issue an empty MFA transaction')
  response.cookies.set(COOKIE_NAMES.mfaTransaction, transaction, mfaTransactionCookieOptions())
  if (methodId) {
    response.cookies.set(COOKIE_NAMES.mfaMethod, methodId, mfaTransactionCookieOptions())
  } else {
    clearCookie(response, COOKIE_NAMES.mfaMethod, mfaTransactionCookieOptions())
  }
  clearCookie(response, COOKIE_NAMES.mfaPending, mfaTransactionCookieOptions())
}

export function setMfaPendingCookie(response: NextResponse, pendingId: string): void {
  if (!pendingId) throw new Error('Cannot issue an empty MFA pending identifier')
  response.cookies.set(COOKIE_NAMES.mfaPending, pendingId, mfaTransactionCookieOptions())
}

export function clearMfaTransactionCookies(response: NextResponse): void {
  clearCookie(response, COOKIE_NAMES.mfaTransaction, mfaTransactionCookieOptions())
  clearCookie(response, COOKIE_NAMES.mfaMethod, mfaTransactionCookieOptions())
  clearCookie(response, COOKIE_NAMES.mfaPending, mfaTransactionCookieOptions())
}

export function normalizeAuditActorId(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : undefined
}

export function tokenSessionCorrelation(accessToken: string, key: AuditActorSigningKey): string {
  return `sess_${createHmac('sha256', key.secret)
    .update(SESSION_CORRELATION_PURPOSE, 'utf8')
    .update(accessToken, 'utf8')
    .digest('base64url')}`
}

export function signAuditActorCookie(
  actorId: unknown,
  accessToken: string,
  issuedAt: number,
  key: AuditActorSigningKey,
): string | undefined {
  const normalizedActorId = normalizeAuditActorId(actorId)
  if (normalizedActorId === undefined || !accessToken || !validSessionIssuedAt(issuedAt) || !KEY_ID_RE.test(key.id))
    return undefined

  const correlation = tokenSessionCorrelation(accessToken, key)
  const payload = `${AUDIT_ACTOR_COOKIE_VERSION}.${key.id}.${normalizedActorId}.${issuedAt}.${correlation}`
  return `${payload}.${auditActorSignature(payload, key.secret)}`
}

export function verifyAuditActorCookie(
  value: string | undefined,
  accessToken: string | undefined,
  issuedAtValue: string | undefined,
  keys: AuditActorSigningKeys,
): string | undefined {
  if (!value) return undefined
  const parts = value.split('.')
  if (parts.length !== 6 || !accessToken || !issuedAtValue) return undefined

  const [version, keyId, actorId, issuedAt, correlation, signature] = parts
  if (
    version !== AUDIT_ACTOR_COOKIE_VERSION ||
    keyId === undefined ||
    actorId === undefined ||
    issuedAt === undefined ||
    correlation === undefined ||
    signature === undefined ||
    normalizeAuditActorId(actorId) !== actorId ||
    issuedAt !== issuedAtValue ||
    !UNIX_SECONDS_RE.test(issuedAt) ||
    !validSessionIssuedAt(Number(issuedAt)) ||
    !/^sess_[A-Za-z0-9_-]{43}$/.test(correlation) ||
    !BASE64URL_SHA256_RE.test(signature)
  ) {
    return undefined
  }

  const key = signingKeyById(keyId, keys)
  if (!key || correlation !== tokenSessionCorrelation(accessToken, key)) return undefined

  const payload = `${version}.${keyId}.${actorId}.${issuedAt}.${correlation}`
  const expected = Buffer.from(auditActorSignature(payload, key.secret), 'base64url')
  const received = Buffer.from(signature, 'base64url')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined
  return actorId
}

export function auditActorIdFromRequest(request: NextRequest): string | undefined {
  const { auditActorSigningKeys } = getPatientWebConfig()
  return verifyAuditActorCookie(
    request.cookies.get(COOKIE_NAMES.auditActor)?.value,
    request.cookies.get(COOKIE_NAMES.access)?.value,
    request.cookies.get(COOKIE_NAMES.sessionIssuedAt)?.value,
    auditActorSigningKeys,
  )
}

export function issueAuthenticatedSessionCookies(
  response: NextResponse,
  session: {
    accessToken: string
    refreshToken: string
    actorId: unknown
    issuedAt?: number
  },
): { actorId: string; issuedAt: number; sessionCorrelation: string } {
  const { auditActorSigningKeys } = getPatientWebConfig()
  const actorId = normalizeAuditActorId(session.actorId)
  const issuedAt = session.issuedAt ?? Math.floor(Date.now() / 1000)
  const actorCookie = signAuditActorCookie(actorId, session.accessToken, issuedAt, auditActorSigningKeys.current)
  if (!session.accessToken || !session.refreshToken || !actorId || !actorCookie) {
    throw new Error('Cannot issue patient web session without a full token pair and trusted actor')
  }

  response.cookies.set(COOKIE_NAMES.access, session.accessToken, accessCookieOptions())
  response.cookies.set(COOKIE_NAMES.refresh, session.refreshToken, refreshCookieOptions())
  response.cookies.set(COOKIE_NAMES.sessionIssuedAt, String(issuedAt), sessionIssuedAtCookieOptions())
  response.cookies.set(COOKIE_NAMES.auditActor, actorCookie, auditActorCookieOptions())
  return {
    actorId,
    issuedAt,
    sessionCorrelation: tokenSessionCorrelation(session.accessToken, auditActorSigningKeys.current),
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
    ...sessionIssuedAtCookieOptions(),
    maxAge: 0,
  })
  response.cookies.set(COOKIE_NAMES.auditActor, '', {
    ...auditActorCookieOptions(),
    maxAge: 0,
  })
}

function clearCookie(response: NextResponse, name: string, options: CookieOptions): void {
  response.cookies.set(name, '', { ...options, maxAge: 0 })
}

function sessionIssuedAtCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: shouldUseSecureCookies(),
    sameSite: 'strict',
    path: '/api',
    maxAge: SESSION_MAX_AGE_SECONDS,
  }
}

function auditActorSignature(payload: string, secret: string): string {
  return createHmac('sha256', secret)
    .update(AUDIT_ACTOR_SIGNING_PURPOSE, 'utf8')
    .update(payload, 'utf8')
    .digest('base64url')
}

function signingKeyById(id: string, keys: AuditActorSigningKeys): AuditActorSigningKey | undefined {
  if (keys.current.id === id) return keys.current
  return keys.previous?.id === id ? keys.previous : undefined
}

function validSessionIssuedAt(value: number, now = Math.floor(Date.now() / 1000)): boolean {
  return Number.isInteger(value) && value > 0 && value <= now + 60 && now - value <= SESSION_MAX_AGE_SECONDS
}
