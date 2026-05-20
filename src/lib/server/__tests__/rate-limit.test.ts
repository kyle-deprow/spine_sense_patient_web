import { afterEach, describe, expect, it, vi } from 'vitest'

import { rateLimit, shouldBypassRateLimit } from '@/lib/server/rate-limit'

describe('rate limiting', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('enforces the in-memory sliding window by default', () => {
    expect(rateLimit('default-rate-limit-test', { limit: 1, windowMs: 60_000 })).toBe(true)
    expect(rateLimit('default-rate-limit-test', { limit: 1, windowMs: 60_000 })).toBe(false)
  })

  it('supports an opt-in non-production E2E bypass', () => {
    vi.stubEnv('PATIENT_WEB_E2E_BYPASS_RATE_LIMITS', 'true')

    expect(rateLimit('e2e-rate-limit-test', { limit: 0, windowMs: 60_000 })).toBe(true)
  })

  it('rejects the E2E bypass in production', () => {
    expect(() => shouldBypassRateLimit('production', 'true')).toThrow(
      'PATIENT_WEB_E2E_BYPASS_RATE_LIMITS must not be set in production',
    )
  })
})
