import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { backendFetch } from '@/lib/server/backend'

vi.mock('server-only', () => ({}))

vi.mock('@/lib/server/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/backend')>()
  return {
    ...actual,
    backendFetch: vi.fn(),
  }
})

const mockedBackendFetch = vi.mocked(backendFetch)
const googleFetch = vi.fn()

const { GET: startGoogle } = await import('@/app/api/auth/google/start/route')
const { GET: completeGoogle } = await import('@/app/api/auth/google/callback/route')

function cookieHeaderFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';', 1)[0])
    .join('; ')
}

describe('Google OAuth BFF routes', () => {
  const actorId = '10000000-0000-4000-8000-000000000001'

  beforeEach(() => {
    vi.stubEnv('ENVIRONMENT', 'test')
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'test-patient-web-csrf-secret')
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', 'http://localhost')
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-web-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-web-client-secret')
    vi.stubEnv('PATIENT_WEB_PUBLIC_URL', 'http://localhost')
    mockedBackendFetch.mockReset()
    googleFetch.mockReset()
    vi.stubGlobal('fetch', googleFetch)
  })

  it('starts Google OAuth with state and PKCE cookies', () => {
    const request = new NextRequest('http://localhost/api/auth/google/start?mode=login&returnTo=/')

    const response = startGoogle(request)

    expect(response.status).toBe(307)
    const location = response.headers.get('location')
    expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth')
    const authUrl = new URL(location ?? '')
    expect(authUrl.searchParams.get('client_id')).toBe('google-web-client-id')
    expect(authUrl.searchParams.get('redirect_uri')).toBe(
      'http://localhost/api/auth/google/callback',
    )
    expect(authUrl.searchParams.get('scope')).toBe('openid email')
    expect(authUrl.searchParams.get('response_type')).toBe('code')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')

    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('spine_google_oauth_state=')
    expect(setCookie).toContain('spine_google_oauth_verifier=')
    expect(setCookie).toContain('spine_google_oauth_mode=login')
    expect(setCookie).toContain('spine_google_oauth_return_to=%2F')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=lax')
    expect(setCookie).not.toContain('google-web-client-secret')
  })

  it('returns a sanitized no-store 503 before OAuth work when configuration is invalid', async () => {
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', '')

    const startResponse = startGoogle(new NextRequest('http://localhost/api/auth/google/start'))
    const callbackResponse = await completeGoogle(
      new NextRequest('http://localhost/api/auth/google/callback?code=unused&state=unused'),
    )

    for (const response of [startResponse, callbackResponse]) {
      expect(response.status).toBe(503)
      await expect(response.clone().json()).resolves.toEqual({
        error: 'service_unavailable',
      })
      expect(response.headers.get('Cache-Control')).toBe('no-store')
    }
    expect(googleFetch).not.toHaveBeenCalled()
    expect(mockedBackendFetch).not.toHaveBeenCalled()
  })

  it('completes Google OAuth through the backend and sets HttpOnly app session cookies', async () => {
    const startResponse = startGoogle(
      new NextRequest('http://localhost/api/auth/google/start?mode=login&returnTo=/'),
    )
    const state = new URL(startResponse.headers.get('location') ?? '').searchParams.get('state')
    const cookies = cookieHeaderFrom(startResponse)
    googleFetch.mockResolvedValueOnce(Response.json({ id_token: 'google-id-token' }))
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        access_token: 'backend-access-token',
        refresh_token: 'backend-refresh-token',
        token_type: 'bearer',
      }),
    )
    mockedBackendFetch.mockResolvedValueOnce(Response.json({ user_id: actorId }))

    const callbackRequest = new NextRequest(
      `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
      {
        headers: { Cookie: cookies },
      },
    )
    const response = await completeGoogle(callbackRequest)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe('http://localhost/')
    expect(googleFetch).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/token',
      expect.objectContaining({
        method: 'POST',
        cache: 'no-store',
      }),
    )
    const tokenBody = googleFetch.mock.calls[0]?.[1]?.body as URLSearchParams
    expect(tokenBody.get('code')).toBe('auth-code')
    expect(tokenBody.get('client_secret')).toBe('google-web-client-secret')
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      '/api/v1/auth/login/google',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ id_token: 'google-id-token' }),
      }),
    )
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      '/api/v1/auth/session',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer backend-access-token',
        }),
      }),
    )

    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('spine_patient_sess=backend-access-token')
    expect(setCookie).toContain('spine_patient_refresh=backend-refresh-token')
    expect(setCookie).toContain('spine_patient_csrf=')
    expect(setCookie).toContain('spine_patient_sess_iat=')
    expect(setCookie).toContain('spine_patient_audit_actor=v2.test-current.')
    expect(setCookie).toContain('spine_google_oauth_state=;')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).not.toContain('google-id-token')
  })

  it.each([
    [{ mfa_required: true }, '/verify?mode=mfa'],
    [{ mfa_enrollment_required: true }, '/mfa-enrollment'],
  ])(
    'keeps a Google challenge in HttpOnly state and redirects to %s',
    async (challenge, target) => {
      const startResponse = startGoogle(
        new NextRequest('http://localhost/api/auth/google/start?mode=login&returnTo=/'),
      )
      const state = new URL(startResponse.headers.get('location') ?? '').searchParams.get('state')
      const cookies = cookieHeaderFrom(startResponse)
      googleFetch.mockResolvedValueOnce(Response.json({ id_token: 'google-id-token' }))
      mockedBackendFetch.mockResolvedValueOnce(
        Response.json({
          ...challenge,
          mfa_token: 'google-auth-transaction',
          mfa_method_id:
            'mfa_required' in challenge && challenge.mfa_required
              ? '20000000-0000-4000-8000-000000000001'
              : null,
        }),
      )

      const response = await completeGoogle(
        new NextRequest(`http://localhost/api/auth/google/callback?code=auth-code&state=${state}`, {
          headers: { Cookie: cookies },
        }),
      )

      expect(response.headers.get('location')).toBe(`http://localhost${target}`)
      const setCookie = response.headers.getSetCookie().join('\n')
      expect(setCookie).toContain('spine_patient_mfa_transaction=google-auth-transaction')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).not.toContain('spine_patient_sess=google-auth-transaction')
    },
  )

  it('fails closed when Google authentication returns both a token pair and an MFA challenge', async () => {
    const startResponse = startGoogle(
      new NextRequest('http://localhost/api/auth/google/start?mode=login&returnTo=/'),
    )
    const state = new URL(startResponse.headers.get('location') ?? '').searchParams.get('state')
    const cookies = cookieHeaderFrom(startResponse)
    googleFetch.mockResolvedValueOnce(Response.json({ id_token: 'google-id-token' }))
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        access_token: 'must-not-be-issued',
        refresh_token: 'must-not-be-issued',
        mfa_required: true,
        mfa_method_id: '20000000-0000-4000-8000-000000000001',
      }),
    )

    const response = await completeGoogle(
      new NextRequest(`http://localhost/api/auth/google/callback?code=auth-code&state=${state}`, {
        headers: { Cookie: cookies },
      }),
    )

    expect(response.headers.get('location')).toBe(
      'http://localhost/login?socialAuthError=callback_failed',
    )
    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).not.toContain('spine_patient_sess=must-not-be-issued')
    expect(setCookie).toContain('spine_patient_mfa_transaction=;')
  })

  it('redirects existing Google registration emails to login with an actionable reason', async () => {
    const startResponse = startGoogle(
      new NextRequest('http://localhost/api/auth/google/start?mode=register&returnTo=/'),
    )
    const state = new URL(startResponse.headers.get('location') ?? '').searchParams.get('state')
    const cookies = cookieHeaderFrom(startResponse)
    googleFetch.mockResolvedValueOnce(Response.json({ id_token: 'google-id-token' }))
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({ detail: 'ACCOUNT_EXISTS_REQUIRES_LOGIN' }, { status: 409 }),
    )

    const callbackRequest = new NextRequest(
      `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
      {
        headers: { Cookie: cookies },
      },
    )
    const response = await completeGoogle(callbackRequest)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost/login?socialAuthError=account_exists',
    )
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_google_oauth_state=;')
  })

  it('redirects already-linked Google registration attempts to login with an actionable reason', async () => {
    const startResponse = startGoogle(
      new NextRequest('http://localhost/api/auth/google/start?mode=register&returnTo=/'),
    )
    const state = new URL(startResponse.headers.get('location') ?? '').searchParams.get('state')
    const cookies = cookieHeaderFrom(startResponse)
    googleFetch.mockResolvedValueOnce(Response.json({ id_token: 'google-id-token' }))
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(
        { detail: 'Social identity already linked to another account' },
        { status: 409 },
      ),
    )

    const callbackRequest = new NextRequest(
      `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
      {
        headers: { Cookie: cookies },
      },
    )
    const response = await completeGoogle(callbackRequest)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost/login?socialAuthError=already_linked',
    )
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_google_oauth_state=;')
  })

  it('redirects unlinked Google login attempts to login with an actionable reason', async () => {
    const startResponse = startGoogle(
      new NextRequest('http://localhost/api/auth/google/start?mode=login&returnTo=/'),
    )
    const state = new URL(startResponse.headers.get('location') ?? '').searchParams.get('state')
    const cookies = cookieHeaderFrom(startResponse)
    googleFetch.mockResolvedValueOnce(Response.json({ id_token: 'google-id-token' }))
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({ detail: 'SOCIAL_ACCOUNT_NOT_LINKED' }, { status: 401 }),
    )

    const callbackRequest = new NextRequest(
      `http://localhost/api/auth/google/callback?code=auth-code&state=${state}`,
      {
        headers: { Cookie: cookies },
      },
    )
    const response = await completeGoogle(callbackRequest)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost/login?socialAuthError=not_linked',
    )
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_google_oauth_state=;')
  })

  it('fails closed on state mismatch before calling Google or the backend', async () => {
    const startResponse = startGoogle(
      new NextRequest('http://localhost/api/auth/google/start?mode=login'),
    )
    const cookies = cookieHeaderFrom(startResponse)
    const callbackRequest = new NextRequest(
      'http://localhost/api/auth/google/callback?code=auth-code&state=wrong-state',
      { headers: { Cookie: cookies } },
    )

    const response = await completeGoogle(callbackRequest)

    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toBe(
      'http://localhost/login?socialAuthError=state_mismatch',
    )
    expect(googleFetch).not.toHaveBeenCalled()
    expect(mockedBackendFetch).not.toHaveBeenCalled()
    expect(response.headers.getSetCookie().join('\n')).toContain('spine_google_oauth_state=;')
  })
})
