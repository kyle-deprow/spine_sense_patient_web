import { describe, expect, it } from 'vitest'
import { validateProxyTarget } from '@/lib/proxy/allowlist'

describe('proxy allowlist', () => {
  it('allows canonical patient routes under /api/proxy/api/v1', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'assessments'],
        'POST',
        '/api/proxy/api/v1/patients/me/assessments',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/assessments/' })
  })

  it('allows patient symptom trend reads used by the home dashboard', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'symptom-trends'],
        'GET',
        '/api/proxy/api/v1/patients/me/symptom-trends',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/symptom-trends' })
  })

  it('preserves explicit trailing slashes for FastAPI collection routes', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'assessments'],
        'POST',
        '/api/proxy/api/v1/patients/me/assessments/',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/assessments/' })
  })

  it('blocks backend auth routes in the generic proxy', () => {
    expect(
      validateProxyTarget(['api', 'v1', 'auth', 'session'], 'GET', '/api/proxy/api/v1/auth/session'),
    ).toEqual({ ok: false, status: 404, code: 'proxy_auth_blocked' })
  })

  it('rejects encoded traversal and double slash prefix bypasses', () => {
    expect(
      validateProxyTarget(['api', 'v1', 'patients', 'me'], 'GET', '/api/proxy/api/v1/patients/%2e%2e/me'),
    ).toEqual({ ok: false, status: 400, code: 'proxy_path_invalid' })

    expect(
      validateProxyTarget(['api', 'v1', 'patients', 'me'], 'GET', '/api/proxy//api/v1/patients/me'),
    ).toEqual({ ok: false, status: 404, code: 'proxy_prefix_not_allowed' })
  })

  it('blocks method mismatches before forwarding', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'dashboard'],
        'POST',
        '/api/proxy/api/v1/patients/me/dashboard',
      ),
    ).toEqual({ ok: false, status: 405, code: 'proxy_method_not_allowed' })
  })
})
