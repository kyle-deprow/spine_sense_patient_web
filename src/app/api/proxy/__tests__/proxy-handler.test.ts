import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { CSRF_HEADER, createCsrfToken } from '@/lib/auth/csrf'
import { signAuditActorCookie } from '@/lib/auth/cookies'
import { BackendUnavailableError, LONG_BACKEND_TIMEOUT_MS, backendFetch } from '@/lib/server/backend'
import { isLongAssessmentBackendCall } from '@/lib/server/assessment-timeouts'
import { auditLog, sessionCorrelationFromToken } from '@/lib/server/audit'

vi.mock('@/lib/server/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/backend')>()
  return {
    ...actual,
    backendFetch: vi.fn(),
  }
})

vi.mock('@/lib/server/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/audit')>()
  return { ...actual, auditLog: vi.fn() }
})

const mockedBackendFetch = vi.mocked(backendFetch)
const mockedAuditLog = vi.mocked(auditLog)

// Import after mocking so the route module picks up the mocked backendFetch.
const { DELETE, GET, POST } = await import('@/app/api/proxy/[...path]/route')

function makeProxyRequest(
  pathname: string,
  method = 'GET',
  cookies: Record<string, string> = {},
  extraHeaders: Record<string, string> = {},
  body?: BodyInit,
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
    ...(body === undefined ? {} : { body }),
  })
}

function makeContext(pathSegments: readonly string[]): {
  params: Promise<{ path: string[] }>
} {
  return { params: Promise.resolve({ path: [...pathSegments] }) }
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
    mockedAuditLog.mockReset()
  })

  it('returns 401 when no access token cookie is present', async () => {
    const request = makeProxyRequest(VALID_PATHNAME, 'GET', {})
    const response = await GET(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'unauthorized' })
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'phi.proxy.denied',
        reason: 'authentication_required',
        status: 401,
      }),
    )
  })

  it('returns 403 when CSRF validation fails on a mutating request', async () => {
    // POST without CSRF header/cookie should fail CSRF (missing token)
    const request = makeProxyRequest(
      VALID_PATHNAME,
      'POST',
      { spine_patient_sess: 'access-token' },
      { 'Content-Type': 'application/json', Origin: ORIGIN },
    )
    const response = await POST(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(403)
    const body = await response.json()
    expect(body).toHaveProperty('error')
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'phi.proxy.denied',
        reason: 'csrf_missing',
        sessionCorrelation: sessionCorrelationFromToken('access-token'),
        status: 403,
      }),
    )
  })

  it('returns 404 when path is not in the allowlist', async () => {
    const request = makeProxyRequest('/api/proxy/api/v1/admin/users', 'GET', {
      spine_patient_sess: 'access-token',
    })
    const response = await GET(request, makeContext(['api', 'v1', 'admin', 'users']))

    expect(response.status).toBe(404)
    const body = await response.json()
    expect(body).toHaveProperty('error')
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'phi.proxy.denied',
        reason: 'proxy_path_not_allowed',
        status: 404,
      }),
    )
  })

  it('returns 503 when BackendUnavailableError is thrown', async () => {
    mockedBackendFetch.mockRejectedValue(new BackendUnavailableError())

    const request = makeProxyRequest(VALID_PATHNAME, 'GET', {
      spine_patient_sess: 'access-token',
    })
    const response = await GET(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: 'service_unavailable',
    })
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'phi.proxy.denied',
        reason: 'backend_unavailable',
        status: 503,
      }),
    )
  })

  it('returns the backend response body and status for a valid authenticated GET', async () => {
    mockedBackendFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: 'test' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const request = makeProxyRequest(VALID_PATHNAME, 'GET', {
      spine_patient_sess: 'access-token',
    })
    const response = await GET(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ data: 'test' })
  })

  it('keeps the default backend timeout for normal proxy calls', async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ data: 'test' }))

    const request = makeProxyRequest(VALID_PATHNAME, 'GET', {
      spine_patient_sess: 'access-token',
    })
    const response = await GET(request, makeContext(VALID_SEGMENTS))

    expect(response.status).toBe(200)
    expect(mockedBackendFetch).toHaveBeenCalledWith('/api/v1/patients/me/assessments/', expect.any(Object), {})
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

  it('forwards assessment report generation through the authenticated proxy', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json(
        {
          id: 'report-1',
          downloadUrl: 'https://storage.example.test/report.pdf',
        },
        { status: 201 },
      ),
    )
    const csrf = createCsrfToken(CSRF_SECRET, 'proxy-route-test-nonce')
    const assessmentId = '10000000-0000-4000-8000-000000000001'

    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/reports`,
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
      makeContext(['api', 'v1', 'patients', 'me', 'assessments', assessmentId, 'reports']),
    )

    expect(response.status).toBe(201)
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      `/api/v1/patients/me/assessments/${assessmentId}/reports`,
      expect.objectContaining({
        method: 'POST',
      }),
      {},
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
    await expect(response.json()).resolves.toEqual({
      error: 'proxy_path_not_allowed',
    })
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
    const response = await POST(request, makeContext(['api', 'v1', 'patients', 'me', 'intake', 'progress', 'complete']))

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
    expect(isLongAssessmentBackendCall('/api/v1/patients/me/assessments/assessment-123/adaptive/prepare')).toBe(true)
    expect(isLongAssessmentBackendCall('/api/v1/patients/me/assessments/assessment-123/prefill')).toBe(false)
    expect(isLongAssessmentBackendCall('/api/v1/patients/me/assessments/assessment-123/analysis/run')).toBe(true)
    expect(isLongAssessmentBackendCall('/api/v1/patients/me/assessments/assessment-123/analysis')).toBe(false)
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
    const response = await POST(request, makeContext(['api', 'v1', 'patients', 'me', 'dashboard']))

    expect(response.status).toBe(405)
    const body = await response.json()
    expect(body).toHaveProperty('error')
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'phi.proxy.denied',
        reason: 'proxy_method_not_allowed',
        status: 405,
      }),
    )
  })

  describe('MyScribe proxy boundary', () => {
    const recordingId = '10000000-0000-4000-8000-000000000001'
    const prefix = '/api/proxy/api/v1/patients/me/miscribe'
    const segments = ['api', 'v1', 'patients', 'me', 'miscribe']

    it('injects cookie auth server-side, replaces browser request IDs, and forwards query parameters', async () => {
      const issuedAt = Math.floor(Date.now() / 1000)
      mockedBackendFetch.mockResolvedValue(
        Response.json([{ id: recordingId }], {
          headers: {
            Authorization: 'must-not-reach-browser',
            'Set-Cookie': 'backend_session=must-not-reach-browser',
            'X-Internal-Debug': 'private',
          },
        }),
      )

      const request = makeProxyRequest(
        `${prefix}/recordings?status=ready&limit=10`,
        'GET',
        {
          spine_patient_sess: 'cookie-access-token',
          spine_patient_sess_iat: String(issuedAt),
          spine_patient_audit_actor:
            signAuditActorCookie(recordingId, 'cookie-access-token', issuedAt, {
              id: 'test-current',
              secret: 'patient-web-test-actor-signing-key-32-bytes',
            }) ?? '',
        },
        {
          Authorization: 'Bearer browser-controlled-token',
          'X-Request-Id': 'patient@example.test?note=private',
        },
      )
      const response = await GET(request, makeContext([...segments, 'recordings']))

      expect(response.status).toBe(200)
      expect(mockedBackendFetch).toHaveBeenCalledWith(
        '/api/v1/patients/me/miscribe/recordings?status=ready&limit=10',
        expect.any(Object),
        {},
      )
      const forwardedHeaders = new Headers(mockedBackendFetch.mock.calls[0]?.[1]?.headers)
      expect(forwardedHeaders.get('Authorization')).toBe('Bearer cookie-access-token')
      expect(forwardedHeaders.get('X-Request-Id')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      )
      expect(forwardedHeaders.get('X-Request-Id')).not.toContain('patient@example.test')
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Pragma')).toBe('no-cache')
      expect(response.headers.get('Authorization')).toBeNull()
      expect(response.headers.get('Set-Cookie')).toBeNull()
      expect(response.headers.get('X-Internal-Debug')).toBeNull()
      expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('status=ready')
      expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('cookie-access-token')
      expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('patient@example.test')
      expect(mockedAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'phi.proxy.access',
          resourceType: 'patients.miscribe',
          actorId: recordingId,
          sessionCorrelation: sessionCorrelationFromToken('cookie-access-token'),
          status: 200,
        }),
      )
      expect(mockedAuditLog.mock.calls[0]?.[0]).not.toHaveProperty('userId')
      expect(mockedAuditLog.mock.calls[0]?.[0]?.requestId).not.toBe('patient@example.test?note=private')
    })

    it('does not trust a browser-forged audit actor cookie', async () => {
      mockedBackendFetch.mockResolvedValue(Response.json([]))
      const forged = `v1.${recordingId}.${'a'.repeat(43)}`
      const request = makeProxyRequest(
        `${prefix}/recordings`,
        'GET',
        {
          spine_patient_sess: 'cookie-access-token',
          spine_patient_audit_actor: forged,
        },
      )

      const response = await GET(request, makeContext([...segments, 'recordings']))

      expect(response.status).toBe(200)
      expect(mockedAuditLog.mock.calls[0]?.[0]).not.toHaveProperty('actorId')
    })

    it('forwards MyScribe POST query and body without adding content to audit metadata', async () => {
      mockedBackendFetch.mockResolvedValue(Response.json({ id: recordingId }, { status: 201 }))
      const csrf = createCsrfToken(CSRF_SECRET, 'miscribe-setup-test')
      const requestBody = JSON.stringify({
        visit_type: 'follow-up',
        clinical_note: 'private text',
      })

      const request = makeProxyRequest(
        `${prefix}/recordings/setup?source=web`,
        'POST',
        { spine_patient_sess: 'cookie-access-token', spine_patient_csrf: csrf },
        {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        requestBody,
      )
      const response = await POST(request, makeContext([...segments, 'recordings', 'setup']))

      expect(response.status).toBe(201)
      expect(mockedBackendFetch.mock.calls[0]?.[0]).toBe('/api/v1/patients/me/miscribe/recordings/setup?source=web')
      const forwardedBody = mockedBackendFetch.mock.calls[0]?.[1]?.body
      expect(Buffer.from(forwardedBody as ArrayBuffer).toString('utf8')).toBe(requestBody)
      expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('follow-up')
      expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('private text')
    })

    it.each([
      ['POST', `${prefix}/recordings/setup`, [...segments, 'recordings', 'setup']],
      ['DELETE', `${prefix}/recordings/${recordingId}`, [...segments, 'recordings', recordingId]],
    ] as const)('rejects MyScribe %s without CSRF proof', async (method, pathname, path) => {
      const request = makeProxyRequest(
        pathname,
        method,
        { spine_patient_sess: 'cookie-access-token' },
        { 'Content-Type': 'application/json', Origin: ORIGIN },
      )
      const response =
        method === 'POST' ? await POST(request, makeContext(path)) : await DELETE(request, makeContext(path))

      expect(response.status).toBe(403)
      expect(mockedBackendFetch).not.toHaveBeenCalled()
      expect(mockedAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'phi.proxy.denied',
          reason: 'csrf_missing',
          status: 403,
        }),
      )
    })

    it('preserves a MyScribe DELETE 204 while stripping headers and disabling storage', async () => {
      mockedBackendFetch.mockResolvedValue(
        new Response(null, {
          status: 204,
          headers: {
            'Set-Cookie': 'backend_session=private',
            'X-Internal-Debug': 'private',
          },
        }),
      )
      const csrf = createCsrfToken(CSRF_SECRET, 'miscribe-delete-test')
      const request = makeProxyRequest(
        `${prefix}/recordings/${recordingId}`,
        'DELETE',
        { spine_patient_sess: 'cookie-access-token', spine_patient_csrf: csrf },
        {
          'Content-Type': 'application/json',
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
      )

      const response = await DELETE(request, makeContext([...segments, 'recordings', recordingId]))

      expect(response.status).toBe(204)
      await expect(response.text()).resolves.toBe('')
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Pragma')).toBe('no-cache')
      expect(response.headers.get('Set-Cookie')).toBeNull()
      expect(response.headers.get('X-Internal-Debug')).toBeNull()
      const requestInit = mockedBackendFetch.mock.calls[0]?.[1]
      expect(requestInit?.method).toBe('DELETE')
      expect(requestInit).not.toHaveProperty('body')
      expect(new Headers(requestInit?.headers).has('content-type')).toBe(false)
    })
  })
})
