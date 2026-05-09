import { beforeEach, describe, expect, it, vi } from 'vitest'

import { forwardCredentialAuth } from '@/lib/server/auth'
import { backendFetch } from '@/lib/server/backend'

vi.mock('@/lib/server/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/backend')>()
  return {
    ...actual,
    backendFetch: vi.fn(),
  }
})

const mockedBackendFetch = vi.mocked(backendFetch)

describe('BFF auth boundary', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'test-patient-web-csrf-secret')
    mockedBackendFetch.mockReset()
  })

  it('sets HttpOnly auth cookies without returning backend tokens to browser JavaScript', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({
        access_token: 'backend-access-token',
        refresh_token: 'backend-refresh-token',
        user_id: 'user-123',
        token_expires_at: '2026-05-04T12:00:00Z',
      }),
    )

    const response = await forwardCredentialAuth('/api/v1/auth/login', {
      email: 'patient@example.test',
      password: 'redacted',
    })

    await expect(response.json()).resolves.toEqual({
      user_id: 'user-123',
      token_expires_at: '2026-05-04T12:00:00Z',
    })

    const setCookie = response.headers.getSetCookie().join('\n')
    expect(setCookie).toContain('spine_patient_sess=backend-access-token')
    expect(setCookie).toContain('spine_patient_refresh=backend-refresh-token')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=lax')
    expect(setCookie).toContain('SameSite=strict')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('does not set auth cookies when backend authentication fails', async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ error: 'invalid_credentials' }, { status: 401 }),
    )

    const response = await forwardCredentialAuth('/api/v1/auth/login', {})

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toEqual({ error: 'invalid_credentials' })
    expect(response.headers.getSetCookie()).toEqual([])
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
