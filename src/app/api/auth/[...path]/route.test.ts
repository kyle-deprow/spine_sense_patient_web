import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { createCsrfToken, CSRF_HEADER } from '@/lib/auth/csrf'
import { signAuditActorCookie } from '@/lib/auth/cookies'
import { auditLog, sessionCorrelationFromToken } from '@/lib/server/audit'
import { BackendUnavailableError, backendFetch } from '@/lib/server/backend'

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

const CSRF_SECRET = 'test-patient-web-csrf-secret'
const ORIGIN = 'http://localhost'
const ACTOR_ID = '10000000-0000-4000-8000-000000000001'
const ACCESS_TOKEN = 'existing-private-access-token'
const SIGNING_KEY = {
  id: 'test-current',
  secret: 'patient-web-test-actor-signing-key-32-bytes',
}

// Import after mocking so the route module picks up the mocked dependencies.
const { DELETE, GET, POST } = await import('@/app/api/auth/[...path]/route')

function makeAuthRequest(
  pathname: string,
  body: unknown = {},
  options: {
    method?: 'DELETE' | 'GET' | 'POST'
    accessToken?: string
    auditActorId?: string
  } = {},
): NextRequest {
  const method = options.method ?? 'POST'
  const csrf = createCsrfToken(CSRF_SECRET, 'auth-route-test-nonce')
  const cookies = [`spine_patient_csrf=${csrf}`]
  if (options.accessToken) cookies.push(`spine_patient_sess=${options.accessToken}`)
  if (options.auditActorId && options.accessToken) {
    const issuedAt = Math.floor(Date.now() / 1000)
    cookies.push(`spine_patient_sess_iat=${issuedAt}`)
    cookies.push(
      `spine_patient_audit_actor=${signAuditActorCookie(options.auditActorId, options.accessToken, issuedAt, SIGNING_KEY)}`,
    )
  }

  const init = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookies.join('; '),
      [CSRF_HEADER]: csrf,
      Origin: ORIGIN,
    },
  }
  return new NextRequest(
    `http://localhost${pathname}`,
    method === 'GET' ? init : { ...init, body: JSON.stringify(body) },
  )
}

function makeContext(pathSegments: string[]): { params: Promise<{ path: string[] }> } {
  return { params: Promise.resolve({ path: pathSegments }) }
}

describe('auth catch-all route handler', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', CSRF_SECRET)
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', ORIGIN)
    mockedBackendFetch.mockReset()
    mockedAuditLog.mockReset()
  })

  it('audits an allowed registration verification call with a server request ID', async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ success: true }, { status: 202 }))

    const request = makeAuthRequest('/api/auth/verify/registration/send', {
      email: 'patient@example.test',
    })
    const response = await POST(request, makeContext(['verify', 'registration', 'send']))

    expect(response.status).toBe(202)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ success: true })
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.allowed',
        method: 'POST',
        resourceType: 'auth.registration_verification',
        status: 202,
        reason: 'backend_success',
        requestId: expect.any(String),
      }),
    )

    const [, init] = mockedBackendFetch.mock.calls[0] ?? []
    const headers = init?.headers as Headers
    const auditRecord = mockedAuditLog.mock.calls[0]?.[0]
    expect(headers.get('X-Request-Id')).toBe(auditRecord?.requestId)
    expect(headers.get('X-Request-Id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('forwards the existing bearer token and audits only its HMAC correlation', async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ success: true }, { status: 202 }))

    const request = makeAuthRequest(
      '/api/auth/verify/send',
      { channel: 'email' },
      { accessToken: ACCESS_TOKEN, auditActorId: ACTOR_ID },
    )
    const response = await POST(request, makeContext(['verify', 'send']))

    expect(response.status).toBe(202)
    const [, init] = mockedBackendFetch.mock.calls[0] ?? []
    const headers = init?.headers as Headers
    expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.allowed',
        resourceType: 'auth.email_verification',
        actorId: ACTOR_ID,
        sessionCorrelation: sessionCorrelationFromToken(ACCESS_TOKEN),
      }),
    )
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(ACCESS_TOKEN)
  })

  it('audits registration confirmation token issuance and sets boundary cookies', async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        success: true,
        access_token: 'issued-private-access-token',
        refresh_token: 'issued-private-refresh-token',
      }),
    )
    mockedBackendFetch.mockResolvedValueOnce(Response.json({ user_id: ACTOR_ID }))

    const request = makeAuthRequest('/api/auth/verify/registration/confirm', {
      email: 'patient@example.test',
      code: 'private-registration-code',
    })
    const response = await POST(request, makeContext(['verify', 'registration', 'confirm']))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })

    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('spine_patient_sess=issued-private-access-token')
    expect(setCookie).toContain('spine_patient_refresh=issued-private-refresh-token')
    expect(setCookie).toContain('spine_patient_csrf=')
    expect(setCookie).toContain('spine_patient_sess_iat=')
    expect(setCookie).toContain('spine_patient_audit_actor=v2.test-current.')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=lax')
    expect(setCookie).toContain('SameSite=strict')

    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.token.issued',
        method: 'POST',
        resourceType: 'auth.registration_verification',
        actorId: ACTOR_ID,
        status: 200,
        reason: 'backend_token_pair',
        sessionCorrelation: sessionCorrelationFromToken('issued-private-access-token'),
      }),
    )

    const records = mockedAuditLog.mock.calls.map(([record]) => record)
    expect(records).toHaveLength(2)
    expect(records[0]?.requestId).toBe(records[1]?.requestId)
  })

  it('audits generic verification token issuance without exposing tokens or PHI', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        success: true,
        access_token: 'generic-private-access-token',
        refresh_token: 'generic-private-refresh-token',
        user_id: ACTOR_ID,
      }),
    )

    const request = makeAuthRequest(
      '/api/auth/verify/confirm?return_to=patient@example.test',
      { email: 'patient@example.test', code: 'private-verification-code' },
    )
    const response = await POST(request, makeContext(['verify', 'confirm']))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ success: true })
    expect(response.headers.getSetCookie().join('\n')).not.toContain('spine_patient_sess=')
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.token.issued',
        resourceType: 'auth.email_verification',
        actorId: ACTOR_ID,
        status: 200,
        reason: 'backend_token_pair',
        sessionCorrelation: sessionCorrelationFromToken('generic-private-access-token'),
      }),
    )

    const auditOutput = JSON.stringify(mockedAuditLog.mock.calls)
    expect(auditOutput).not.toContain('patient@example.test')
    expect(auditOutput).not.toContain('private-verification-code')
    expect(auditOutput).not.toContain('generic-private-access-token')
    expect(auditOutput).not.toContain('generic-private-refresh-token')
    expect(auditOutput).not.toContain('/api/auth/verify/confirm')
    expect(auditOutput).not.toContain('return_to')
  })

  it.each([
    ['password-reset', ['password-reset']],
    ['password-reset/confirm', ['password-reset', 'confirm']],
  ])('audits the allowed %s path under the password reset category', async (path, segments) => {
    mockedBackendFetch.mockResolvedValue(Response.json({ accepted: true }, { status: 202 }))

    const response = await POST(
      makeAuthRequest(`/api/auth/${path}`, { secret: 'private-reset-value' }),
      makeContext(segments),
    )

    expect(response.status).toBe(202)
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.allowed',
        resourceType: 'auth.password_reset',
        status: 202,
        reason: 'backend_success',
      }),
    )
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('private-reset-value')
  })

  it.each([
    ['setup', POST, 'POST'],
    ['disable', DELETE, 'DELETE'],
    ['methods', GET, 'GET'],
  ] as const)('audits the allowed MFA %s path', async (path, routeHandler, method) => {
    mockedBackendFetch.mockResolvedValue(Response.json({ success: true }))

    const response = await routeHandler(
      makeAuthRequest(
        `/api/auth/mfa/${path}`,
        { mfa_secret: 'private-mfa-value' },
        { method, accessToken: ACCESS_TOKEN },
      ),
      makeContext(['mfa', path]),
    )

    expect(response.status).toBe(200)
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.allowed',
        method,
        resourceType: 'auth.mfa',
        status: 200,
        reason: 'backend_success',
        sessionCorrelation: sessionCorrelationFromToken(ACCESS_TOKEN),
      }),
    )
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('private-mfa-value')
  })

  it('audits CSRF denial without forwarding the call', async () => {
    const request = new NextRequest('http://localhost/api/auth/verify/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
      },
      body: JSON.stringify({ email: 'patient@example.test' }),
    })

    const response = await POST(request, makeContext(['verify', 'send']))

    expect(response.status).toBe(403)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'csrf_missing' })
    expect(mockedBackendFetch).not.toHaveBeenCalled()
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.denied',
        resourceType: 'auth.email_verification',
        status: 403,
        reason: 'request_policy_denied',
        requestId: expect.any(String),
      }),
    )
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('patient@example.test')
  })

  it('audits an unallowlisted path using only a fixed category', async () => {
    const request = makeAuthRequest(
      '/api/auth/register/private-patient?email=patient@example.test',
      { diagnosis: 'private clinical value' },
      { accessToken: ACCESS_TOKEN },
    )
    const response = await POST(request, makeContext(['register', 'private-patient']))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: 'not_found' })
    expect(mockedBackendFetch).not.toHaveBeenCalled()
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.denied',
        resourceType: 'auth.unknown',
        status: 404,
        reason: 'path_not_allowed',
        sessionCorrelation: sessionCorrelationFromToken(ACCESS_TOKEN),
      }),
    )

    const auditOutput = JSON.stringify(mockedAuditLog.mock.calls)
    expect(auditOutput).not.toContain('private-patient')
    expect(auditOutput).not.toContain('patient@example.test')
    expect(auditOutput).not.toContain('private clinical value')
    expect(auditOutput).not.toContain(ACCESS_TOKEN)
  })

  it('audits an invalid path without retaining traversal content', async () => {
    const request = makeAuthRequest('/api/auth/verify/private-patient')
    const response = await POST(request, makeContext(['verify', '..', 'private-patient']))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_path' })
    expect(mockedBackendFetch).not.toHaveBeenCalled()
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.denied',
        resourceType: 'auth.invalid',
        status: 400,
        reason: 'invalid_path',
      }),
    )
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('private-patient')
  })

  it('does not attribute a non-UUID backend identifier as an actor', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ success: true, user_id: 'patient@example.test' }),
    )

    const response = await POST(
      makeAuthRequest('/api/auth/verify/confirm'),
      makeContext(['verify', 'confirm']),
    )

    expect(response.status).toBe(200)
    const record = mockedAuditLog.mock.calls[0]?.[0]
    expect(record).not.toHaveProperty('actorId')
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('patient@example.test')
  })

  it('audits a rejected backend response with sanitized status and reason', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ error: 'private backend detail' }, { status: 422 }),
    )

    const response = await POST(
      makeAuthRequest('/api/auth/password-reset'),
      makeContext(['password-reset']),
    )

    expect(response.status).toBe(422)
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.allowed',
        resourceType: 'auth.password_reset',
        status: 422,
        reason: 'backend_rejected',
      }),
    )
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('private backend detail')
  })

  it('audits backend unavailability for an allowed route', async () => {
    mockedBackendFetch.mockRejectedValue(new BackendUnavailableError())

    const request = makeAuthRequest('/api/auth/verify/registration/send')
    const response = await POST(request, makeContext(['verify', 'registration', 'send']))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'service_unavailable' })
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'auth.generic.allowed',
        resourceType: 'auth.registration_verification',
        status: 503,
        reason: 'backend_unavailable',
      }),
    )
  })
})
