import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { BackendUnavailableError, backendFetch } from '@/lib/server/backend'

vi.mock('@/lib/server/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/backend')>()
  return {
    ...actual,
    backendFetch: vi.fn(),
  }
})

const mockedBackendFetch = vi.mocked(backendFetch)

// Import after mocking so the route module picks up the mocked backendFetch.
const { GET, POST } = await import('@/app/api/proxy/[...path]/route')

function makeProxyRequest(
  pathname: string,
  method = 'GET',
  cookies: Record<string, string> = {},
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...extraHeaders,
    },
  })
}

function makeContext(pathSegments: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: pathSegments }) }
}

const VALID_PATHNAME = '/api/proxy/api/v1/patients/me/assessments'
const VALID_SEGMENTS = ['api', 'v1', 'patients', 'me', 'assessments']

describe('proxy route handler', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'test-patient-web-csrf-secret')
    mockedBackendFetch.mockReset()
  })

  it('returns 401 when no access token cookie is present', async () => {
    const request = makeProxyRequest(VALID_PATHNAME, 'GET', {})
    const response = await GET(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' })
  })

  it('returns 403 when CSRF validation fails on a mutating request', async () => {
    // POST without CSRF header/cookie should fail CSRF (missing token)
    const request = makeProxyRequest(
      VALID_PATHNAME,
      'POST',
      { spine_patient_sess: 'access-token' },
      { 'Content-Type': 'application/json' },
    )
    const response = await POST(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body).toHaveProperty('error')
  })

  it('returns 404 when path is not in the allowlist', async () => {
    const request = makeProxyRequest(
      '/api/proxy/api/v1/admin/users',
      'GET',
      { spine_patient_sess: 'access-token' },
    )
    const response = await GET(
      request,
      makeContext(['api', 'v1', 'admin', 'users']),
    )

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toHaveProperty('error')
  })

  it('returns 503 when BackendUnavailableError is thrown', async () => {
    mockedBackendFetch.mockRejectedValue(new BackendUnavailableError())

    const request = makeProxyRequest(
      VALID_PATHNAME,
      'GET',
      { spine_patient_sess: 'access-token' },
    )
    const response = await GET(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'service_unavailable' })
  })

  it('returns the backend response body and status for a valid authenticated GET', async () => {
    mockedBackendFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const request = makeProxyRequest(
      VALID_PATHNAME,
      'GET',
      { spine_patient_sess: 'access-token' },
    )
    const response = await GET(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ data: 'test' })
  })

  it('returns 405 when HTTP method is not allowed for the matched route', async () => {
    // /api/v1/patients/me/dashboard only allows GET
    const request = makeProxyRequest(
      '/api/proxy/api/v1/patients/me/dashboard',
      'POST',
      { spine_patient_sess: 'access-token' },
      { 'Content-Type': 'application/json' },
    )
    const response = await POST(
      request,
      makeContext(['api', 'v1', 'patients', 'me', 'dashboard']),
    )

    expect(response.status).toBe(405)
    const body = await response.json()
    expect(body).toHaveProperty('error')
  })
})
