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

  it('blocks retired assessment phase routes at the BFF boundary', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'assessments', '10000000-0000-4000-8000-000000000001', 'refinement', 'run'],
        'POST',
        '/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/refinement/run',
      ),
    ).toEqual({ ok: false, status: 404, code: 'proxy_path_not_allowed' })
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

  it('allows tracked symptom routes explicitly', () => {
    const trackerId = '10000000-0000-4000-8000-000000000001'

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'tracked-symptoms'],
        'GET',
        '/api/proxy/api/v1/patients/me/tracked-symptoms',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/tracked-symptoms/' })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'tracked-symptoms', 'checkin'],
        'POST',
        '/api/proxy/api/v1/patients/me/tracked-symptoms/checkin',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/tracked-symptoms/checkin' })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'tracked-symptoms', trackerId, 'logs'],
        'POST',
        `/api/proxy/api/v1/patients/me/tracked-symptoms/${trackerId}/logs`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/tracked-symptoms/${trackerId}/logs`,
    })
  })

  it('blocks unknown tracked symptom children at the BFF boundary', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'tracked-symptoms', 'unknown-child'],
        'GET',
        '/api/proxy/api/v1/patients/me/tracked-symptoms/unknown-child',
      ),
    ).toEqual({ ok: false, status: 404, code: 'proxy_path_not_allowed' })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'tracked-symptoms', 'not-a-uuid', 'logs'],
        'POST',
        '/api/proxy/api/v1/patients/me/tracked-symptoms/not-a-uuid/logs',
      ),
    ).toEqual({ ok: false, status: 404, code: 'proxy_path_not_allowed' })
  })

  it('allows assessment report routes explicitly', () => {
    const assessmentId = '10000000-0000-4000-8000-000000000001'
    const reportId = '10000000-0000-4000-8000-000000000002'

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'assessments', assessmentId, 'reports'],
        'POST',
        `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/reports`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/assessments/${assessmentId}/reports`,
    })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'reports', reportId],
        'GET',
        `/api/proxy/api/v1/patients/me/reports/${reportId}`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/reports/${reportId}`,
    })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'reports', reportId, 'download-url'],
        'POST',
        `/api/proxy/api/v1/patients/me/reports/${reportId}/download-url`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/reports/${reportId}/download-url`,
    })
  })

  it('blocks malformed assessment report routes at the BFF boundary', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'assessments', 'not-a-uuid', 'reports'],
        'POST',
        '/api/proxy/api/v1/patients/me/assessments/not-a-uuid/reports',
      ),
    ).toEqual({ ok: false, status: 404, code: 'proxy_path_not_allowed' })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'reports', 'not-a-uuid'],
        'GET',
        '/api/proxy/api/v1/patients/me/reports/not-a-uuid',
      ),
    ).toEqual({ ok: false, status: 404, code: 'proxy_path_not_allowed' })
  })

  it('does not allow arbitrary patient child routes through the patient profile route', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'unknown-child'],
        'GET',
        '/api/proxy/api/v1/patients/me/unknown-child',
      ),
    ).toEqual({ ok: false, status: 404, code: 'proxy_path_not_allowed' })
  })

  it('normalizes exact backend root routes to avoid auth-losing redirects', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me'],
        'GET',
        '/api/proxy/api/v1/patients/me',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/' })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'symptoms'],
        'GET',
        '/api/proxy/api/v1/patients/me/symptoms',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/symptoms/' })
  })

  it('allows patient intake onboarding calls', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'intake', 'steps', 'profile'],
        'PUT',
        '/api/proxy/api/v1/patients/me/intake/steps/profile',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/intake/steps/profile' })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'intake', 'route'],
        'POST',
        '/api/proxy/api/v1/patients/me/intake/route',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/intake/route' })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'intake', 'progress', 'complete'],
        'POST',
        '/api/proxy/api/v1/patients/me/intake/progress/complete',
      ),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/intake/progress/complete' })
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
