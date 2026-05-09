import { describe, expect, it } from 'vitest'
import {
  COOKIE_NAMES,
  accessCookieOptions,
  csrfCookieOptions,
  refreshCookieOptions,
  shouldUseSecureCookies,
} from '@/lib/auth/cookies'

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
  })

  it('uses secure cookies outside development unless explicitly running local E2E on localhost', () => {
    expect(shouldUseSecureCookies('production')).toBe(true)
    expect(shouldUseSecureCookies('test')).toBe(true)

    expect(shouldUseSecureCookies('production', 'false', 'true', 'http://127.0.0.1:43101')).toBe(false)
    expect(shouldUseSecureCookies('development', 'false')).toBe(false)
  })

  it('ignores the insecure cookie override in production without the E2E guard', () => {
    expect(shouldUseSecureCookies('production', 'false', '', 'http://127.0.0.1:43101')).toBe(true)
  })

  it('ignores the insecure cookie override in production when origins are not local', () => {
    expect(shouldUseSecureCookies('production', 'false', 'true', 'https://patient.example.com')).toBe(true)
  })
})
