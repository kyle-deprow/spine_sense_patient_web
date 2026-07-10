import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { CSRF_HEADER, createCsrfToken } from '@/lib/auth/csrf'
import { BackendUnavailableError, backendFetch } from '@/lib/server/backend'
import { auditLog } from '@/lib/server/audit'

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

// Import after mocking so the route module picks up the mocked backendFetch.
const { POST } = await import('@/app/api/auth/register/route')

function makeRegisterRequest(body: unknown, ip = '203.0.113.10'): NextRequest {
  const csrf = createCsrfToken(CSRF_SECRET, `register-route-test-${ip.replaceAll('.', '-')}`)
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `spine_patient_csrf=${csrf}`,
      [CSRF_HEADER]: csrf,
      Origin: ORIGIN,
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body),
  })
}

function makeInvalidJsonRequest(ip = '203.0.113.11'): NextRequest {
  const csrf = createCsrfToken(CSRF_SECRET, `register-route-test-${ip.replaceAll('.', '-')}`)
  return new NextRequest('http://localhost/api/auth/register', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `spine_patient_csrf=${csrf}`,
      [CSRF_HEADER]: csrf,
      Origin: ORIGIN,
      'x-forwarded-for': ip,
    },
    body: '{',
  })
}

describe('register route handler', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', CSRF_SECRET)
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', ORIGIN)
    mockedBackendFetch.mockReset()
    mockedAuditLog.mockReset()
  })

  it('normalizes current app registration fields before forwarding to the backend', async () => {
    const actorId = '10000000-0000-4000-8000-000000000001'
    mockedBackendFetch.mockResolvedValue(
      Response.json({ id: actorId, user_id: actorId, email: 'patient@example.test' }),
    )

    const response = await POST(makeRegisterRequest({
      email: 'patient@example.test',
      password: 'Password123!!',
      firstName: 'Synthetic',
      lastName: 'Patient',
      dateOfBirth: '1990-01-15',
      phone: '5551234567',
      role: 'admin',
      access_token: 'must-not-forward',
    }))

    expect(response.status).toBe(200)
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      '/api/v1/auth/register/patient',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          email: 'patient@example.test',
          password: 'Password123!!',
          first_name: 'Synthetic',
          last_name: 'Patient',
          date_of_birth: '1990-01-15',
          phone: '5551234567',
        }),
      }),
    )
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('Synthetic')
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain('Password123!!')
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'auth.register.success', actorId }),
    )
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_patient_audit_actor=;')
  })

  it('prefers backend-native snake_case fields when both shapes are present', async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ id: 'patient-2' }))

    const response = await POST(makeRegisterRequest({
      email: 'patient@example.test',
      password: 'Password123!!',
      firstName: 'Camel',
      first_name: 'Snake',
      lastName: 'Case',
      last_name: 'Contract',
      dateOfBirth: '1980-01-01',
      date_of_birth: '1981-02-03',
      phoneNumber: '5550001111',
      phone: '',
    }, '203.0.113.12'))

    expect(response.status).toBe(200)
    const requestBody = mockedBackendFetch.mock.calls[0]?.[1]?.body
    expect(requestBody).toBe(JSON.stringify({
      email: 'patient@example.test',
      password: 'Password123!!',
      first_name: 'Snake',
      last_name: 'Contract',
      date_of_birth: '1981-02-03',
    }))
  })

  it('rejects invalid JSON before backend forwarding', async () => {
    const response = await POST(makeInvalidJsonRequest())

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_json' })
    expect(mockedBackendFetch).not.toHaveBeenCalled()
  })

  it('returns 503 when the backend is unavailable', async () => {
    mockedBackendFetch.mockRejectedValue(new BackendUnavailableError())

    const response = await POST(makeRegisterRequest({
      email: 'patient@example.test',
      password: 'Password123!!',
      firstName: 'Synthetic',
      lastName: 'Patient',
      dateOfBirth: '1990-01-15',
    }, '203.0.113.13'))

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: 'service_unavailable' })
  })

  it('preserves duplicate registration as a conflict instead of a login failure', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ detail: 'Email already registered' }, { status: 409 }),
    )

    const response = await POST(makeRegisterRequest({
      email: 'patient@example.test',
      password: 'Password123!!',
      firstName: 'Synthetic',
      lastName: 'Patient',
      dateOfBirth: '1990-01-15',
    }, '203.0.113.14'))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({ error: 'conflict' })
  })

  it('maps backend registration server failures to a server error, not auth_failed', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ detail: 'internal error' }, { status: 500 }),
    )

    const response = await POST(makeRegisterRequest({
      email: 'patient@example.test',
      password: 'Password123!!',
      firstName: 'Synthetic',
      lastName: 'Patient',
      dateOfBirth: '1990-01-15',
    }, '203.0.113.15'))

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: 'server_error' })
  })
})
