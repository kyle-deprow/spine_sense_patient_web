import { NextRequest } from 'next/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

const TEST_TOKEN = 'test-support-token-with-at-least-32-chars'

function makeRequest(token?: string): NextRequest {
  return new NextRequest('https://patient-web.example.com/api/test/reset', {
    method: 'POST',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
}

describe('patient web test reset route', () => {
  afterEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('is hidden in production unless E2E support is explicitly enabled', async () => {
    vi.stubEnv('NODE_ENV', 'production')

    const { POST } = await import('./route')
    const response = await POST(makeRequest(TEST_TOKEN))

    expect(response.status).toBe(404)
  })

  it('requires the configured bearer token in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PATIENT_WEB_E2E_TEST_SUPPORT_ENABLED', 'true')
    vi.stubEnv('PATIENT_WEB_E2E_TEST_SUPPORT_TOKEN', TEST_TOKEN)

    const { POST } = await import('./route')

    expect((await POST(makeRequest('wrong-token'))).status).toBe(404)
    expect((await POST(makeRequest())).status).toBe(404)
    expect((await POST(makeRequest(TEST_TOKEN))).status).toBe(200)
  })

  it('clears BFF rate-limit state after token authorization', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PATIENT_WEB_E2E_TEST_SUPPORT_ENABLED', 'true')
    vi.stubEnv('PATIENT_WEB_E2E_TEST_SUPPORT_TOKEN', TEST_TOKEN)

    const { POST } = await import('./route')
    const { rateLimit } = await import('@/lib/server/rate-limit')
    expect(rateLimit('route-reset-test', { limit: 1, windowMs: 60_000 })).toBe(true)
    expect(rateLimit('route-reset-test', { limit: 1, windowMs: 60_000 })).toBe(false)

    const response = await POST(makeRequest(TEST_TOKEN))

    expect(response.status).toBe(200)
    expect(rateLimit('route-reset-test', { limit: 1, windowMs: 60_000 })).toBe(true)
  })
})
