import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { createCsrfToken, CSRF_HEADER } from '@/lib/auth/csrf'
import { BackendUnavailableError, backendFetch } from '@/lib/server/backend'

vi.mock('@/lib/server/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/backend')>()
  return {
    ...actual,
    backendFetch: vi.fn(),
  }
})

const mockedBackendFetch = vi.mocked(backendFetch)

const CSRF_SECRET = 'test-patient-web-csrf-secret'
const ORIGIN = 'http://localhost'

// Import after mocking so the route module picks up the mocked backendFetch.
const { POST } = await import('@/app/api/auth/[...path]/route')

function makeAuthRequest(pathname: string, body: unknown = {}): NextRequest {
  const csrf = createCsrfToken(CSRF_SECRET, 'auth-route-test-nonce')
  return new NextRequest(`http://localhost${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `spine_patient_csrf=${csrf}`,
      [CSRF_HEADER]: csrf,
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
  })
}

function makeContext(pathSegments: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: pathSegments }) }
}

describe('auth catch-all route handler', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', CSRF_SECRET)
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', ORIGIN)
    mockedBackendFetch.mockReset()
  })

  it('allows registration verification send through the auth catch-all', async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ success: true }, { status: 202 }))

    const request = makeAuthRequest('/api/auth/verify/registration/send', {
      email: 'patient@example.test',
    })
    const response = await POST(request, makeContext(['verify', 'registration', 'send']))

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toEqual({ success: true })
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      '/api/v1/auth/verify/registration/send',
      expect.objectContaining({
        method: 'POST',
        headers: expect.any(Headers),
      }),
    )
  })

  it('strips registration confirm token pairs and sets BFF auth boundary cookies', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        success: true,
        access_token: 'backend-access-token',
        refresh_token: 'backend-refresh-token',
        user_id: 'user-123',
      }),
    )

    const request = makeAuthRequest('/api/auth/verify/registration/confirm', {
      email: 'patient@example.test',
      code: '123456',
    })
    const response = await POST(request, makeContext(['verify', 'registration', 'confirm']))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })

    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('spine_patient_sess=backend-access-token')
    expect(setCookie).toContain('spine_patient_refresh=backend-refresh-token')
    expect(setCookie).toContain('spine_patient_csrf=')
    expect(setCookie).toContain('spine_patient_sess_iat=')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=lax')
    expect(setCookie).toContain('SameSite=strict')
  })

  it('returns 404 for auth paths not explicitly allowed', async () => {
    const request = makeAuthRequest('/api/auth/register/patient', {
      email: 'patient@example.test',
    })
    const response = await POST(request, makeContext(['register', 'patient']))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'not_found' })
    expect(mockedBackendFetch).not.toHaveBeenCalled()
  })

  it('returns 503 when the backend is unavailable', async () => {
    mockedBackendFetch.mockRejectedValue(new BackendUnavailableError())

    const request = makeAuthRequest('/api/auth/verify/registration/send')
    const response = await POST(request, makeContext(['verify', 'registration', 'send']))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'service_unavailable' })
  })
})
