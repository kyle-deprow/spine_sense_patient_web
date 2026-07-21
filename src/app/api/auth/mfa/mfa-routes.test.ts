import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { CSRF_HEADER, createCsrfToken } from '@/lib/auth/csrf'
import { backendFetch } from '@/lib/server/backend'

vi.mock('@/lib/server/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/backend')>()
  return { ...actual, backendFetch: vi.fn() }
})

const mockedBackendFetch = vi.mocked(backendFetch)
const CSRF_SECRET = 'test-patient-web-csrf-secret'
const ORIGIN = 'http://localhost'
const ACTOR_ID = '10000000-0000-4000-8000-000000000001'

const { POST: setup } = await import('@/app/api/auth/mfa/enrollment/setup/route')
const { POST: confirm } = await import('@/app/api/auth/mfa/enrollment/confirm/route')
const { POST: verify } = await import('@/app/api/auth/mfa/verify/route')
const { POST: stepUp } = await import('@/app/api/auth/mfa/step-up/route')
const { POST: authenticatedSetup } = await import('@/app/api/auth/mfa/setup/route')
const { POST: authenticatedConfirm } = await import('@/app/api/auth/mfa/confirm/route')
const { DELETE: disable } = await import('@/app/api/auth/mfa/disable/route')

function request(path: string, method: 'POST' | 'DELETE', body: unknown, cookies: Record<string, string> = {}) {
  const csrf = createCsrfToken(CSRF_SECRET, `mfa-route-${path.replaceAll('/', '-')}`)
  const cookie = Object.entries({ spine_patient_csrf: csrf, ...cookies })
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
  return new NextRequest(`http://localhost${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie,
      [CSRF_HEADER]: csrf,
      Origin: ORIGIN,
    },
    body: JSON.stringify(body),
  })
}

describe('exact MFA BFF routes', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', CSRF_SECRET)
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', ORIGIN)
    mockedBackendFetch.mockReset()
  })

  it('injects the HttpOnly transaction into login verification', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        user_id: ACTOR_ID,
      }),
    )
    const response = await verify(
      request(
        '/api/auth/mfa/verify',
        'POST',
        { code: '123456', mfa_token: 'attacker' },
        {
          spine_patient_mfa_transaction: 'trusted-transaction',
          spine_patient_mfa_method: '20000000-0000-4000-8000-000000000001',
        },
      ),
    )

    const init = mockedBackendFetch.mock.calls[0]?.[1]
    expect(init?.body).toBe(
      JSON.stringify({
        code: '123456',
        mfa_token: 'trusted-transaction',
        method_id: '20000000-0000-4000-8000-000000000001',
      }),
    )
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_patient_sess=access')
  })

  it('stores pending enrollment identity in HttpOnly state and returns only display material', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        pending_id: 'pending-secret-id',
        secret: 'DISPLAYSECRET',
        otpauth_uri: 'otpauth://totp/test',
      }),
    )
    const response = await setup(
      request(
        '/api/auth/mfa/enrollment/setup',
        'POST',
        {},
        {
          spine_patient_mfa_transaction: 'trusted-transaction',
        },
      ),
    )

    const browserBody = await response.json()
    expect(browserBody).toEqual({
      secret: 'DISPLAYSECRET',
      otpauth_uri: 'otpauth://totp/test',
    })
    expect(mockedBackendFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ mfa_token: 'trusted-transaction' }))
    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('spine_patient_mfa_pending=pending-secret-id')
    expect(setCookie).toContain('HttpOnly')
    expect(JSON.stringify(browserBody)).not.toContain('pending-secret-id')
  })

  it('injects transaction and pending identity when confirming enrollment', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        access_token: 'access',
        refresh_token: 'refresh',
        user_id: ACTOR_ID,
      }),
    )
    const response = await confirm(
      request(
        '/api/auth/mfa/enrollment/confirm',
        'POST',
        { code: '654321' },
        {
          spine_patient_mfa_transaction: 'trusted-transaction',
          spine_patient_mfa_pending: 'trusted-pending',
        },
      ),
    )

    expect(mockedBackendFetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        mfa_token: 'trusted-transaction',
        pending_id: 'trusted-pending',
        code: '654321',
      }),
    )
    await expect(response.json()).resolves.toEqual({ success: true })
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_patient_mfa_transaction=;')
  })

  it('uses the session cookie for step-up and never accepts a browser bearer token', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        mfa_verified: true,
        mfa_verified_until: '2026-07-20T12:15:00Z',
      }),
    )
    const response = await stepUp(
      request(
        '/api/auth/mfa/step-up',
        'POST',
        { code: '123456', access_token: 'attacker' },
        {
          spine_patient_sess: 'trusted-access',
        },
      ),
    )

    const headers = mockedBackendFetch.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer trusted-access')
    expect(mockedBackendFetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ code: '123456' }))
    await expect(response.json()).resolves.toEqual({
      mfa_verified: true,
      mfa_verified_until: '2026-07-20T12:15:00Z',
    })
  })

  it('proxies authenticated replacement setup through the HttpOnly session', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        method_id: '20000000-0000-4000-8000-000000000001',
        secret: 'DISPLAYSECRET',
        otpauth_uri: 'otpauth://totp/replacement',
      }),
    )
    const response = await authenticatedSetup(
      request('/api/auth/mfa/setup', 'POST', {}, { spine_patient_sess: 'trusted-access' }),
    )

    const headers = mockedBackendFetch.mock.calls[0]?.[1]?.headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer trusted-access')
    await expect(response.json()).resolves.toEqual({
      method_id: '20000000-0000-4000-8000-000000000001',
      secret: 'DISPLAYSECRET',
      otpauth_uri: 'otpauth://totp/replacement',
    })
  })

  it('preserves only the typed stale-assurance recovery code from authenticated setup', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json(
        { code: 'mfa_step_up_required', detail: 'sensitive backend message' },
        { status: 403 },
      ),
    )

    const response = await authenticatedSetup(
      request('/api/auth/mfa/setup', 'POST', {}, { spine_patient_sess: 'trusted-access' }),
    )

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'mfa_setup_failed',
      code: 'mfa_step_up_required',
    })
  })

  it('proxies authenticated replacement confirmation and ignores browser bearer material', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        message: 'MFA enrolled successfully',
        method_id: '20000000-0000-4000-8000-000000000001',
        is_primary: true,
      }),
    )
    const response = await authenticatedConfirm(
      request(
        '/api/auth/mfa/confirm',
        'POST',
        {
          code: '123456',
          method_id: '20000000-0000-4000-8000-000000000001',
          access_token: 'attacker',
        },
        { spine_patient_sess: 'trusted-access' },
      ),
    )

    const init = mockedBackendFetch.mock.calls[0]?.[1]
    expect((init?.headers as Headers).get('Authorization')).toBe('Bearer trusted-access')
    expect(init?.body).toBe(
      JSON.stringify({ code: '123456', method_id: '20000000-0000-4000-8000-000000000001' }),
    )
    expect(response.status).toBe(200)
  })

  it('revokes local cookies after the API disables MFA and all sessions', async () => {
    mockedBackendFetch.mockResolvedValue(new Response(null, { status: 204 }))
    const response = await disable(
      request(
        '/api/auth/mfa/disable',
        'DELETE',
        { current_password: 'redacted', code: '123456' },
        {
          spine_patient_sess: 'trusted-access',
        },
      ),
    )

    expect(mockedBackendFetch).toHaveBeenCalledWith('/api/v1/auth/mfa', expect.objectContaining({ method: 'DELETE' }))
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_patient_sess=;')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('fails before backend forwarding when transient state is missing', async () => {
    const response = await confirm(request('/api/auth/mfa/enrollment/confirm', 'POST', { code: '123456' }))

    expect(response.status).toBe(401)
    expect(mockedBackendFetch).not.toHaveBeenCalled()
  })
})
