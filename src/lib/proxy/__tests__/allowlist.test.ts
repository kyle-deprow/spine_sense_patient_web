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

  it('allows canonical assessment question-note live transcription session token minting', () => {
    const assessmentId = '10000000-0000-4000-8000-000000000001'
    const questionId = 'R_NEURO-2'

    expect(
      validateProxyTarget(
        [
          'api',
          'v1',
          'patients',
          'me',
          'assessments',
          assessmentId,
          'questions',
          questionId,
          'note',
          'live-transcription-session',
        ],
        'POST',
        `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/questions/${questionId}/note/live-transcription-session`,
      ),
    ).toEqual({
      ok: true,
      targetPath: `/api/v1/patients/me/assessments/${assessmentId}/questions/${questionId}/note/live-transcription-session`,
    })
  })

  it('blocks retired story voice aliases and arbitrary question-note live transcription child routes', () => {
    const assessmentId = '10000000-0000-4000-8000-000000000001'
    const cases = [
      `/api/v1/patients/me/assessments/${assessmentId}/story/live-transcription`,
      `/api/v1/patients/me/assessments/${assessmentId}/story/live-transcription-session`,
      `/api/v1/patients/me/assessments/${assessmentId}/story/live-transcription-session/extra`,
      `/api/v1/patients/me/assessments/${assessmentId}/story/voice-upload-url`,
      `/api/v1/patients/me/assessments/${assessmentId}/story/transcribe`,
      `/api/v1/patients/me/assessments/${assessmentId}/question-notes/live-transcription`,
      `/api/v1/patients/me/assessments/${assessmentId}/question-notes/live-transcription-session/extra`,
      `/api/v1/patients/me/assessments/${assessmentId}/questions/R01/note/live-transcription`,
      `/api/v1/patients/me/assessments/${assessmentId}/questions/R01/note/live-transcription-session/extra`,
      `/api/v1/patients/me/assessments/${assessmentId}/questions/not.valid/note/live-transcription-session`,
    ] as const

    for (const targetPath of cases) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), 'POST', `/api/proxy${targetPath}`)).toEqual({
        ok: false,
        status: 404,
        code: 'proxy_path_not_allowed',
      })
    }
  })

  it('allows assessment document list reads when a POST-only document route also matches the path', () => {
    const assessmentId = '10000000-0000-4000-8000-000000000001'
    const targetPath = `/api/v1/patients/me/assessments/${assessmentId}/documents`

    expect(validateProxyTarget(targetPath.slice(1).split('/'), 'GET', `/api/proxy${targetPath}`)).toEqual({
      ok: true,
      targetPath,
    })
  })

  it('allows only canonical completed-file onboarding story audio routes', () => {
    const cases = [
      '/api/v1/patients/me/intake/story/audio-uploads',
      '/api/v1/patients/me/intake/story/transcriptions',
    ] as const

    for (const targetPath of cases) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), 'POST', `/api/proxy${targetPath}`)).toEqual({
        ok: true,
        targetPath,
      })
    }
  })

  it('blocks retired intake voice aliases and malformed story recording routes', () => {
    const cases = [
      '/api/v1/patients/me/intake/voice-upload-url',
      '/api/v1/patients/me/intake/transcribe',
      '/api/v1/patients/me/intake/story/live-transcription',
      '/api/v1/patients/me/intake/story/live-transcription-session',
      '/api/v1/patients/me/intake/story/recordings',
      '/api/v1/patients/me/intake/story/recordings/not-a-uuid/transcription',
      '/api/v1/patients/me/intake/story/recordings/10000000-0000-4000-8000-000000000001/transcription/extra',
      '/api/v1/patients/me/intake/story/audio-uploads/extra',
      '/api/v1/patients/me/intake/story/transcriptions/extra',
    ] as const

    for (const targetPath of cases) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), 'POST', `/api/proxy${targetPath}`)).toEqual({
        ok: false,
        status: 404,
        code: 'proxy_path_not_allowed',
      })
    }
  })

  it('blocks method mismatches on canonical onboarding story audio routes', () => {
    const cases = [
      ['GET', '/api/v1/patients/me/intake/story/audio-uploads'],
      ['GET', '/api/v1/patients/me/intake/story/transcriptions'],
    ] as const

    for (const [method, targetPath] of cases) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), method, `/api/proxy${targetPath}`)).toEqual({
        ok: false,
        status: 405,
        code: 'proxy_method_not_allowed',
      })
    }
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
    ).toEqual({
      ok: true,
      targetPath: '/api/v1/patients/me/tracked-symptoms/',
    })

    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'tracked-symptoms', 'checkin'],
        'POST',
        '/api/proxy/api/v1/patients/me/tracked-symptoms/checkin',
      ),
    ).toEqual({
      ok: true,
      targetPath: '/api/v1/patients/me/tracked-symptoms/checkin',
    })

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

  it('allows only implemented patient document routes and methods', () => {
    const documentId = '10000000-0000-4000-8000-000000000001'
    const routes = [
      ['GET', '/api/v1/patients/me/documents'],
      ['GET', '/api/v1/patients/me/documents/overview'],
      ['POST', '/api/v1/patients/me/documents/text'],
      ['POST', '/api/v1/patients/me/documents/upload-url'],
      ['POST', `/api/v1/patients/me/documents/${documentId}/confirm`],
      ['GET', `/api/v1/patients/me/documents/${documentId}/download-url`],
      ['GET', `/api/v1/patients/me/documents/${documentId}/findings`],
      ['DELETE', `/api/v1/patients/me/documents/${documentId}`],
      ['PATCH', `/api/v1/patients/me/documents/${documentId}/text`],
      ['PATCH', `/api/v1/patients/me/documents/${documentId}/extracted-text`],
    ] as const

    for (const [method, targetPath] of routes) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), method, `/api/proxy${targetPath}`)).toEqual({
        ok: true,
        targetPath,
      })
    }
  })

  it('blocks arbitrary patient document children at the BFF boundary', () => {
    const documentId = '10000000-0000-4000-8000-000000000001'
    const cases = [
      ['GET', '/api/v1/patients/me/documents/recent'],
      ['GET', '/api/v1/patients/me/documents/not-a-uuid/findings'],
      ['POST', `/api/v1/patients/me/documents/${documentId}/share`],
    ] as const

    for (const [method, targetPath] of cases) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), method, `/api/proxy${targetPath}`)).toEqual({
        ok: false,
        status: 404,
        code: 'proxy_path_not_allowed',
      })
    }
  })

  it('blocks method mismatches on patient document routes before forwarding', () => {
    const documentId = '10000000-0000-4000-8000-000000000001'
    const cases = [
      ['POST', '/api/v1/patients/me/documents'],
      ['POST', '/api/v1/patients/me/documents/overview'],
      ['PUT', '/api/v1/patients/me/documents/upload-url'],
      ['PUT', `/api/v1/patients/me/documents/${documentId}`],
      ['GET', `/api/v1/patients/me/documents/${documentId}/confirm`],
      ['POST', `/api/v1/patients/me/documents/${documentId}/download-url`],
      ['POST', `/api/v1/patients/me/documents/${documentId}/findings`],
      ['DELETE', `/api/v1/patients/me/documents/${documentId}/findings`],
      ['POST', `/api/v1/patients/me/documents/${documentId}/extracted-text`],
    ] as const

    for (const [method, targetPath] of cases) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), method, `/api/proxy${targetPath}`)).toEqual({
        ok: false,
        status: 405,
        code: 'proxy_method_not_allowed',
      })
    }
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
    expect(validateProxyTarget(['api', 'v1', 'patients', 'me'], 'GET', '/api/proxy/api/v1/patients/me')).toEqual({
      ok: true,
      targetPath: '/api/v1/patients/me/',
    })

    expect(
      validateProxyTarget(['api', 'v1', 'patients', 'me', 'symptoms'], 'GET', '/api/proxy/api/v1/patients/me/symptoms'),
    ).toEqual({ ok: true, targetPath: '/api/v1/patients/me/symptoms/' })
  })

  it('allows patient intake onboarding calls', () => {
    expect(
      validateProxyTarget(
        ['api', 'v1', 'patients', 'me', 'intake', 'steps', 'profile'],
        'PUT',
        '/api/proxy/api/v1/patients/me/intake/steps/profile',
      ),
    ).toEqual({
      ok: true,
      targetPath: '/api/v1/patients/me/intake/steps/profile',
    })

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
    ).toEqual({
      ok: true,
      targetPath: '/api/v1/patients/me/intake/progress/complete',
    })
  })

  it('allows only the implemented MyScribe route and method combinations', () => {
    const recordingId = '10000000-0000-4000-8000-000000000001'
    const routes = [
      ['GET', '/api/v1/patients/me/miscribe/recording-policy'],
      ['GET', '/api/v1/patients/me/miscribe/recordings'],
      ['POST', '/api/v1/patients/me/miscribe/recordings/setup'],
      ['POST', `/api/v1/patients/me/miscribe/recordings/${recordingId}/all-party-attestation`],
      ['POST', `/api/v1/patients/me/miscribe/recordings/${recordingId}/begin`],
      ['POST', `/api/v1/patients/me/miscribe/recordings/${recordingId}/abandon`],
      ['POST', `/api/v1/patients/me/miscribe/recordings/${recordingId}/upload-url`],
      ['POST', `/api/v1/patients/me/miscribe/recordings/${recordingId}/upload-complete`],
      ['POST', `/api/v1/patients/me/miscribe/recordings/${recordingId}/process`],
      ['GET', `/api/v1/patients/me/miscribe/recordings/${recordingId}`],
      ['GET', `/api/v1/patients/me/miscribe/recordings/${recordingId}/summary`],
      ['DELETE', `/api/v1/patients/me/miscribe/recordings/${recordingId}`],
    ] as const

    for (const [method, targetPath] of routes) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), method, `/api/proxy${targetPath}`)).toEqual({
        ok: true,
        targetPath,
      })
    }
  })

  it('blocks unimplemented or malformed MyScribe paths', () => {
    const cases = [
      ['POST', '/api/v1/patients/me/miscribe/recordings/not-a-uuid/process'],
      ['POST', '/api/v1/patients/me/miscribe/recordings/10000000-0000-4000-8000-000000000001/share'],
      ['GET', '/api/v1/patients/me/miscribe/summaries'],
    ] as const

    for (const [method, targetPath] of cases) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), method, `/api/proxy${targetPath}`)).toEqual({
        ok: false,
        status: 404,
        code: 'proxy_path_not_allowed',
      })
    }
  })

  it('blocks method mismatches on implemented MyScribe paths', () => {
    const recordingId = '10000000-0000-4000-8000-000000000001'
    const cases = [
      ['POST', '/api/v1/patients/me/miscribe/recording-policy'],
      ['POST', '/api/v1/patients/me/miscribe/recordings'],
      ['DELETE', '/api/v1/patients/me/miscribe/recordings'],
      ['GET', '/api/v1/patients/me/miscribe/recordings/setup'],
      ['PUT', `/api/v1/patients/me/miscribe/recordings/${recordingId}`],
      ['GET', `/api/v1/patients/me/miscribe/recordings/${recordingId}/process`],
      ['DELETE', `/api/v1/patients/me/miscribe/recordings/${recordingId}/summary`],
    ] as const

    for (const [method, targetPath] of cases) {
      expect(validateProxyTarget(targetPath.slice(1).split('/'), method, `/api/proxy${targetPath}`)).toEqual({
        ok: false,
        status: 405,
        code: 'proxy_method_not_allowed',
      })
    }
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
    expect(validateProxyTarget(['api', 'v1', 'auth', 'session'], 'GET', '/api/proxy/api/v1/auth/session')).toEqual({
      ok: false,
      status: 404,
      code: 'proxy_auth_blocked',
    })
  })

  it('rejects encoded traversal and double slash prefix bypasses', () => {
    expect(validateProxyTarget(['api', 'v1', 'patients', 'me'], 'GET', '/api/proxy/api/v1/patients/%2e%2e/me')).toEqual(
      { ok: false, status: 400, code: 'proxy_path_invalid' },
    )

    expect(validateProxyTarget(['api', 'v1', 'patients', 'me'], 'GET', '/api/proxy//api/v1/patients/me')).toEqual({
      ok: false,
      status: 404,
      code: 'proxy_prefix_not_allowed',
    })
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
