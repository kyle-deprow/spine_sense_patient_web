import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_TOKEN = 'test-support-token-with-at-least-32-chars'

function makeRequest(token?: string): NextRequest {
  return new NextRequest('https://patient-web.example.com/api/test/e2e-cleanup', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('patient web test cleanup route', () => {
  beforeEach(() => {
    vi.stubEnv('ENVIRONMENT', 'test')
    vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'single-bucket')
    vi.stubEnv('PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE', 'memory')
    vi.stubEnv('REDIS_URL', '')
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'cleanup-test-csrf-secret-at-least-32-bytes')
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', 'https://patient.example.test')
    vi.stubEnv('PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY_ID', 'test-current')
    vi.stubEnv(
      'PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY',
      'patient-web-test-actor-signing-key-32-bytes',
    )
  })

  afterEach(() => {
    vi.doUnmock('@/lib/server/rate-limit')
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('is hidden in every recognized environment unless test support is explicitly enabled', async () => {
    const { POST } = await import('./route')
    const response = await POST(makeRequest(TEST_TOKEN))

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('requires the configured bearer token in local test support', async () => {
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_ENABLED', 'true')
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_TOKEN', TEST_TOKEN)

    const { POST } = await import('./route')

    expect((await POST(makeRequest('wrong-token'))).status).toBe(404)
    expect((await POST(makeRequest())).status).toBe(404)
    expect((await POST(makeRequest(TEST_TOKEN))).status).toBe(200)
  })

  it('uses ENVIRONMENT rather than NODE_ENV for authorization', async () => {
    vi.stubEnv('ENVIRONMENT', 'test')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_ENABLED', 'true')
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_TOKEN', TEST_TOKEN)

    const { POST } = await import('./route')

    expect((await POST(makeRequest())).status).toBe(404)
    expect((await POST(makeRequest(TEST_TOKEN))).status).toBe(200)
  })

  it.each([undefined, '', 'preview', 'unknown'])(
    'denies an unrecognized explicit environment even with enabled test support: %s',
    async (environment) => {
      if (environment === undefined) {
        delete process.env.ENVIRONMENT
      } else {
        vi.stubEnv('ENVIRONMENT', environment)
      }
      vi.stubEnv('NODE_ENV', 'development')
      vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_ENABLED', 'true')
      vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_TOKEN', TEST_TOKEN)

      const { POST } = await import('./route')

      expect((await POST(makeRequest(TEST_TOKEN))).status).toBe(404)
    },
  )

  it.each(['short', 'wrong-token-with-a-different-length'])(
    'denies invalid configured or supplied bearer tokens: %s',
    async (token) => {
      vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_ENABLED', 'true')
      vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_TOKEN', token === 'short' ? token : TEST_TOKEN)

      const { POST } = await import('./route')

      expect((await POST(makeRequest(token))).status).toBe(404)
    },
  )

  it('clears BFF rate-limit state after token authorization', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_ENABLED', 'true')
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_TOKEN', TEST_TOKEN)

    const { POST } = await import('./route')
    const { rateLimit } = await import('@/lib/server/rate-limit')
    await expect(rateLimit('route-cleanup-test', { limit: 1, windowMs: 60_000 })).resolves.toBe(
      true,
    )
    await expect(rateLimit('route-cleanup-test', { limit: 1, windowMs: 60_000 })).resolves.toBe(
      false,
    )

    const response = await POST(makeRequest(TEST_TOKEN))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({ status: 'cleanup_complete' })
    await expect(rateLimit('route-cleanup-test', { limit: 1, windowMs: 60_000 })).resolves.toBe(
      true,
    )
  })

  it('does not clear rate-limit state when authorization is denied', async () => {
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_ENABLED', 'true')
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_TOKEN', TEST_TOKEN)

    const { POST } = await import('./route')
    const { rateLimit } = await import('@/lib/server/rate-limit')
    const options = { limit: 1, windowMs: 60_000 }
    await expect(rateLimit('unauthorized-cleanup-test', options)).resolves.toBe(true)
    await expect(rateLimit('unauthorized-cleanup-test', options)).resolves.toBe(false)

    const response = await POST(makeRequest('wrong-token'))

    expect(response.status).toBe(404)
    await expect(rateLimit('unauthorized-cleanup-test', options)).resolves.toBe(false)
  })

  it('awaits cleanup failure and returns a no-store service unavailable response', async () => {
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_ENABLED', 'true')
    vi.stubEnv('PATIENT_WEB_TEST_SUPPORT_TOKEN', TEST_TOKEN)
    vi.doMock('@/lib/server/rate-limit', () => ({
      clearRateLimitStore: vi.fn().mockRejectedValue(new Error('redis unavailable')),
    }))

    const { POST } = await import('./route')
    const response = await POST(makeRequest(TEST_TOKEN))

    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(await response.json()).toEqual({ error: 'service_unavailable' })
  })
})
