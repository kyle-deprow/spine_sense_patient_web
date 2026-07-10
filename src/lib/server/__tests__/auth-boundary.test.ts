import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { signAuditActorCookie } from '@/lib/auth/cookies'
import { forwardCredentialAuth, logoutWithCookie, refreshWithCookie, sessionFromCookie } from '@/lib/server/auth'
import { BackendUnavailableError, backendFetch } from '@/lib/server/backend'

vi.mock('@/lib/server/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/backend')>()
  return {
    ...actual,
    backendFetch: vi.fn(),
  }
})

const mockedBackendFetch = vi.mocked(backendFetch)
const SIGNING_KEY = {
  id: 'test-current',
  secret: 'patient-web-test-actor-signing-key-32-bytes',
}

function makeRequest(cookies: Record<string, string> = {}): NextRequest {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ')
  return new NextRequest('http://localhost/api/auth/refresh', {
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  })
}

function boundSessionCookies(actorId: string, accessToken: string): Record<string, string> {
  const issuedAt = Math.floor(Date.now() / 1000)
  return {
    spine_patient_sess: accessToken,
    spine_patient_sess_iat: String(issuedAt),
    spine_patient_audit_actor:
      signAuditActorCookie(actorId, accessToken, issuedAt, SIGNING_KEY) ?? '',
  }
}

describe('BFF auth boundary', () => {
  const actorId = '10000000-0000-4000-8000-000000000001'

  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'test-patient-web-csrf-secret')
    mockedBackendFetch.mockReset()
  })

  it('sets HttpOnly auth cookies without returning backend tokens to browser JavaScript', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        access_token: 'backend-access-token',
        refresh_token: 'backend-refresh-token',
        user_id: actorId,
        token_expires_at: '2026-05-04T12:00:00Z',
      }),
    )

    const response = await forwardCredentialAuth('/api/v1/auth/login', {
      email: 'patient@example.test',
      password: 'redacted',
    })

    // user_id is stripped server-side (HIPAA §164.502(b) minimum necessary)
    await expect(response.json()).resolves.toEqual({
      token_expires_at: '2026-05-04T12:00:00Z',
    })

    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('spine_patient_sess=backend-access-token')
    expect(setCookie).toContain('spine_patient_refresh=backend-refresh-token')
    expect(setCookie).toContain('spine_patient_audit_actor=v2.test-current.')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=lax')
    expect(setCookie).toContain('SameSite=strict')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('reissues CSRF after successful no-token registration transitions', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        id: actorId,
        user_id: actorId,
        email: 'patient@example.test',
        verification_token: 'registration-verification-token',
      }),
    )

    const response = await forwardCredentialAuth(
      '/api/v1/auth/register/patient',
      {
        email: 'patient@example.test',
        password: 'redacted',
      },
      undefined,
      { errorMode: 'registration' },
    )

    await expect(response.json()).resolves.toEqual({
      id: actorId,
      email: 'patient@example.test',
      verification_token: 'registration-verification-token',
    })
    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('spine_patient_sess=;')
    expect(setCookie).toContain('spine_patient_refresh=;')
    expect(setCookie).toContain('spine_patient_audit_actor=;')
    expect(setCookie).toContain('spine_patient_csrf=')
    expect(setCookie).toContain('SameSite=strict')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('does not set auth cookies when backend authentication fails', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ error: 'invalid_credentials' }, { status: 401 }),
    )

    const response = await forwardCredentialAuth('/api/v1/auth/login', {})

    expect(response.status).toBe(401)
    // Backend error body is normalized to prevent account enumeration
    await expect(response.json()).resolves.toEqual({ error: 'auth_failed' })
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_patient_audit_actor=;')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  // ── refreshWithCookie ──────────────────────────────────────────────────────

  describe('refreshWithCookie', () => {
    it('propagates BackendUnavailableError so the route handler can return 503', async () => {
      mockedBackendFetch.mockRejectedValue(new BackendUnavailableError())

      const request = makeRequest({
        spine_patient_refresh: 'valid-refresh-token',
        spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
      })
      await expect(refreshWithCookie(request)).rejects.toThrow(BackendUnavailableError)
    })

    it('returns 401 refresh_failed when backend returns non-OK', async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ error: 'token_invalid' }, { status: 401 }),
      )

      const request = makeRequest({
        spine_patient_refresh: 'stale-refresh-token',
        spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
      })
      const response = await refreshWithCookie(request)

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'refresh_failed' })
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_sess=;')
      expect(setCookie).toContain('spine_patient_audit_actor=;')
    })

    it('returns 200 and sets auth cookies when backend returns a valid token pair', async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          user_id: actorId,
        }),
      )

      const request = makeRequest({
        spine_patient_refresh: 'valid-refresh-token',
        spine_patient_sess_iat: String(Math.floor(Date.now() / 1000)),
      })
      const response = await refreshWithCookie(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ success: true })
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_sess=new-access-token')
      expect(setCookie).toContain('spine_patient_refresh=new-refresh-token')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('spine_patient_audit_actor=v2.test-current.')
    })

    it('returns 401 session_expired and clears cookies when IAT indicates >12h elapsed', async () => {
      const stalePast = Math.floor(Date.now() / 1000) - 13 * 60 * 60
      const request = makeRequest({
        spine_patient_refresh: 'valid-refresh-token',
        spine_patient_sess_iat: String(stalePast),
      })
      const response = await refreshWithCookie(request)

      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual({ error: 'session_expired' })
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_sess=;')
      expect(setCookie).toContain('spine_patient_audit_actor=;')
    })
  })

  // ── logoutWithCookie ───────────────────────────────────────────────────────

  describe('logoutWithCookie', () => {
    it('returns 200 success and clears cookies on successful backend logout', async () => {
      mockedBackendFetch.mockResolvedValue(new Response(null, { status: 200 }))

      const request = makeRequest({ spine_patient_sess: 'access-token' })
      const response = await logoutWithCookie(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ success: true })
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_sess=;')
      expect(setCookie).toContain('spine_patient_refresh=;')
      expect(setCookie).toContain('spine_patient_audit_actor=;')
    })

    it('returns 502 logout_backend_failed and clears cookies when backend returns non-OK', async () => {
      mockedBackendFetch.mockResolvedValue(new Response(null, { status: 503 }))

      const request = makeRequest({ spine_patient_sess: 'access-token' })
      const response = await logoutWithCookie(request)

      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toEqual({ error: 'logout_backend_failed' })
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_sess=;')
    })

    it('returns 502 and clears cookies when BackendUnavailableError is thrown', async () => {
      mockedBackendFetch.mockRejectedValue(new BackendUnavailableError())

      const request = makeRequest({ spine_patient_sess: 'access-token' })
      const response = await logoutWithCookie(request)

      expect(response.status).toBe(502)
      await expect(response.json()).resolves.toEqual({ error: 'logout_backend_failed' })
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_sess=;')
    })

    it('returns 200 success and clears cookies when no access token cookie is present', async () => {
      const request = makeRequest({})
      const response = await logoutWithCookie(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({ success: true })
      expect(mockedBackendFetch).not.toHaveBeenCalled()
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_sess=;')
    })
  })

  // ── sessionFromCookie ──────────────────────────────────────────────────────

  describe('sessionFromCookie', () => {
    it('propagates BackendUnavailableError so the route handler can return 503', async () => {
      mockedBackendFetch.mockRejectedValue(new BackendUnavailableError())

      // Must include the access token so the code reaches the backendFetch call.
      const request = makeRequest({ spine_patient_sess: 'valid-access-token' })
      await expect(sessionFromCookie(request)).rejects.toThrow(BackendUnavailableError)
    })

    it('returns 401 and issues a new CSRF cookie when backend returns non-OK', async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ error: 'token_expired' }, { status: 401 }),
      )

      const request = makeRequest({ spine_patient_sess: 'expired-access-token' })
      const response = await sessionFromCookie(request)

      expect(response.status).toBe(401)
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_csrf=')
    })

    it('returns 200 with session data when backend returns OK', async () => {
      mockedBackendFetch.mockResolvedValue(
        Response.json({ user_id: actorId, email: 'patient@example.test' }),
      )

      const request = makeRequest(boundSessionCookies(actorId, 'valid-access-token'))
      const response = await sessionFromCookie(request)

      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        user_id: actorId,
        email: 'patient@example.test',
      })
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_csrf=')
    })
  })
})
