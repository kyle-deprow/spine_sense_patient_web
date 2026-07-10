import { describe, expect, it } from 'vitest'
import {
  COOKIE_NAMES,
  accessCookieOptions,
  auditActorCookieOptions,
  csrfCookieOptions,
  refreshCookieOptions,
  signAuditActorCookie,
  shouldUseSecureCookies,
  verifyAuditActorCookie,
} from '@/lib/auth/cookies'

const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const ACCESS_TOKEN = 'opaque-access-token'
const ISSUED_AT = Math.floor(Date.now() / 1000)
const CURRENT_KEY = { id: 'current-key', secret: 'current-test-signing-secret-at-least-32-bytes' }
const PREVIOUS_KEY = { id: 'previous-key', secret: 'previous-test-signing-secret-at-least-32-bytes' }
const KEY_RING = { current: CURRENT_KEY, previous: PREVIOUS_KEY }

describe('patient web cookie helpers', () => {
  it('uses HttpOnly same-site access cookies', () => {
    const options = accessCookieOptions()

    expect(COOKIE_NAMES.access).toBe('spine_patient_sess')
    expect(options.httpOnly).toBe(true)
    expect(options.sameSite).toBe('lax')
    expect(options.path).toBe('/')
    expect(options.maxAge).toBeLessThanOrEqual(15 * 60)
  })

  it('path-scopes refresh cookies to the refresh route', () => {
    const options = refreshCookieOptions()

    expect(COOKIE_NAMES.refresh).toBe('spine_patient_refresh')
    expect(options.httpOnly).toBe(true)
    expect(options.sameSite).toBe('strict')
    expect(options.path).toBe('/api/auth/refresh')
    expect(options.maxAge).toBeLessThanOrEqual(7 * 24 * 60 * 60)
  })

  it('keeps only the csrf cookie readable by browser JavaScript', () => {
    expect(csrfCookieOptions().httpOnly).toBe(false)
    expect(accessCookieOptions().httpOnly).toBe(true)
    expect(refreshCookieOptions().httpOnly).toBe(true)
    expect(auditActorCookieOptions().httpOnly).toBe(true)
  })

  it('uses a strict same-site session-scoped audit actor cookie', () => {
    const options = auditActorCookieOptions()

    expect(COOKIE_NAMES.auditActor).toBe('spine_patient_audit_actor')
    expect(options.httpOnly).toBe(true)
    expect(options.sameSite).toBe('strict')
    expect(options.path).toBe('/')
    expect(options.maxAge).toBe(12 * 60 * 60)
  })

  it('signs and verifies only UUID audit actors', () => {
    const signed = signAuditActorCookie(ACTOR_ID.toUpperCase(), ACCESS_TOKEN, ISSUED_AT, CURRENT_KEY)

    expect(signed).toMatch(/^v2\.current-key\.[0-9a-f-]+\.[0-9]{10}\.sess_[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/)
    expect(verifyAuditActorCookie(signed, ACCESS_TOKEN, String(ISSUED_AT), KEY_RING)).toBe(ACTOR_ID)
    expect(signAuditActorCookie('patient@example.test', ACCESS_TOKEN, ISSUED_AT, CURRENT_KEY)).toBeUndefined()
  })

  it('binds the actor to the access token and session issued-at', () => {
    const signed = signAuditActorCookie(ACTOR_ID, ACCESS_TOKEN, ISSUED_AT, CURRENT_KEY)
    expect(signed).toBeDefined()

    expect(verifyAuditActorCookie(`${signed}x`, ACCESS_TOKEN, String(ISSUED_AT), KEY_RING)).toBeUndefined()
    expect(verifyAuditActorCookie(signed, 'different-access-token', String(ISSUED_AT), KEY_RING)).toBeUndefined()
    expect(verifyAuditActorCookie(signed, ACCESS_TOKEN, String(ISSUED_AT - 1), KEY_RING)).toBeUndefined()
  })

  it('accepts an explicitly configured previous key by ID during rotation', () => {
    const signed = signAuditActorCookie(ACTOR_ID, ACCESS_TOKEN, ISSUED_AT, PREVIOUS_KEY)

    expect(verifyAuditActorCookie(signed, ACCESS_TOKEN, String(ISSUED_AT), KEY_RING)).toBe(ACTOR_ID)
    expect(
      verifyAuditActorCookie(signed, ACCESS_TOKEN, String(ISSUED_AT), { current: CURRENT_KEY }),
    ).toBeUndefined()
  })

  it('uses secure cookies outside development; allows insecure only for local E2E', () => {
    expect(shouldUseSecureCookies('production')).toBe(true)
    expect(shouldUseSecureCookies('test')).toBe(true)

    // The Make-managed standalone BFF runs with NODE_ENV=production, but only
    // allows insecure cookies when explicitly scoped to local HTTP origins.
    expect(shouldUseSecureCookies('production', 'false', 'true', 'http://127.0.0.1:43101')).toBe(false)
    expect(shouldUseSecureCookies('development', 'false', 'true', 'http://127.0.0.1:43101')).toBe(false)
    expect(shouldUseSecureCookies('development', 'false')).toBe(false)
  })

  it('ignores the insecure cookie override in production without the E2E guard', () => {
    expect(shouldUseSecureCookies('production', 'false', '', 'http://127.0.0.1:43101')).toBe(true)
  })

  it('throws when PATIENT_WEB_E2E_ALLOW_INSECURE_COOKIES is set in production for non-local origins', () => {
    expect(() =>
      shouldUseSecureCookies('production', 'false', 'true', 'https://patient.example.com'),
    ).toThrow('PATIENT_WEB_E2E_ALLOW_INSECURE_COOKIES must not be set in production')
  })
})
