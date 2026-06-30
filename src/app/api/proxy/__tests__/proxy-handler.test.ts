import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { CSRF_HEADER, createCsrfToken } from '@/lib/auth/csrf'
import { BackendUnavailableError, LONG_BACKEND_TIMEOUT_MS, backendFetch } from '@/lib/server/backend'
import { isLongAssessmentBackendCall } from '@/lib/server/assessment-timeouts'

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
const CSRF_SECRET = 'test-patient-web-csrf-secret'
const ORIGIN = 'http://localhost'

describe('proxy route handler', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', CSRF_SECRET)
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', ORIGIN)
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

  it('keeps the default backend timeout for normal proxy calls', async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ data: 'test' }))

    const request = makeProxyRequest(
      VALID_PATHNAME,
      'GET',
      { spine_patient_sess: 'access-token' },
    )
    const response = await GET(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(200)
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      '/api/v1/patients/me/assessments/',
      expect.any(Object),
      {},
    )
  })

  it('uses the long backend timeout for LLM-backed assessment proxy calls', async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ questions: [] }))
    const csrf = createCsrfToken(CSRF_SECRET, 'proxy-route-test-nonce')

    const request = makeProxyRequest(
      '/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/adaptive/prepare',
      'POST',
      {
        spine_patient_sess: 'access-token',
        spine_patient_csrf: csrf,
      },
      {
        'Content-Type': 'application/json',
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    )
    const response = await POST(
      request,
      makeContext([
        'api',
        'v1',
        'patients',
        'me',
        'assessments',
        '10000000-0000-4000-8000-000000000001',
        'adaptive',
        'prepare',
      ]),
    )

    expect(response.status).toBe(200)
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      '/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/adaptive/prepare',
      expect.any(Object),
      { timeoutMs: LONG_BACKEND_TIMEOUT_MS },
    )
  })

  it('rejects retired assessment phase routes before backend forwarding', async () => {
    const csrf = createCsrfToken(CSRF_SECRET, 'proxy-route-test-nonce')
    const request = makeProxyRequest(
      '/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/refinement/run',
      'POST',
      {
        spine_patient_sess: 'access-token',
        spine_patient_csrf: csrf,
      },
      {
        'Content-Type': 'application/json',
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    )

    const response = await POST(
      request,
      makeContext([
        'api',
        'v1',
        'patients',
        'me',
        'assessments',
        '10000000-0000-4000-8000-000000000001',
        'refinement',
        'run',
      ]),
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'proxy_path_not_allowed' })
    expect(mockedBackendFetch).not.toHaveBeenCalled()
  })

  it('forwards bodyless intake completion POSTs without an empty JSON body', async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ id: 'intake-1', isComplete: true }))
    const csrf = createCsrfToken(CSRF_SECRET, 'proxy-route-test-nonce')

    const request = makeProxyRequest(
      '/api/proxy/api/v1/patients/me/intake/progress/complete',
      'POST',
      {
        spine_patient_sess: 'access-token',
        spine_patient_csrf: csrf,
      },
      {
        'Content-Type': 'application/json',
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    )
    const response = await POST(
      request,
      makeContext(['api', 'v1', 'patients', 'me', 'intake', 'progress', 'complete']),
    )

    expect(response.status).toBe(200)
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      '/api/v1/patients/me/intake/progress/complete',
      expect.objectContaining({
        method: 'POST',
      }),
      {},
    )
    const requestInit = mockedBackendFetch.mock.calls[0]?.[1]
    expect(requestInit).not.toHaveProperty('body')
    expect(new Headers(requestInit?.headers).has('content-type')).toBe(false)
  })

  it('classifies only adaptive and analysis run assessment calls as long-running', () => {
    expect(
      isLongAssessmentBackendCall('/api/v1/patients/me/assessments/assessment-123/adaptive/prepare'),
    ).toBe(true)
    expect(
      isLongAssessmentBackendCall('/api/v1/patients/me/assessments/assessment-123/prefill'),
    ).toBe(false)
    expect(
      isLongAssessmentBackendCall('/api/v1/patients/me/assessments/assessment-123/analysis/run'),
    ).toBe(true)
    expect(
      isLongAssessmentBackendCall('/api/v1/patients/me/assessments/assessment-123/analysis'),
    ).toBe(false)
    expect(isLongAssessmentBackendCall('/api/v1/patients/me/assessments')).toBe(false)
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
