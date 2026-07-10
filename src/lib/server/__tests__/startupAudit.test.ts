import { beforeEach, describe, expect, it, vi } from 'vitest'

import { auditLog } from '@/lib/server/audit'

vi.mock('@/lib/server/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/audit')>()
  return { ...actual, auditLog: vi.fn() }
})

const mockedAuditLog = vi.mocked(auditLog)

describe('web voice startup audit', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'startup-audit-test-csrf-secret')
    vi.stubEnv('PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY_ID', 'startup-current')
    vi.stubEnv(
      'PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY',
      'startup-audit-actor-signing-key-at-least-32-bytes',
    )
    vi.stubEnv(
      'NEXT_PUBLIC_STORAGE_DOMAINS',
      'https://*.s3.amazonaws.com http://127.0.0.1:9000',
    )
    vi.stubEnv('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN', 'http://127.0.0.1:9000')
    mockedAuditLog.mockReset()
  })

  it.each([
    ['true', 'enabled'],
    ['', 'disabled'],
  ])('logs the %s policy once per process module lifecycle', async (flag, reason) => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', flag)
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'test')
    const { auditWebVoicePolicyAtStartup } = await import('@/lib/server/startupAudit')

    auditWebVoicePolicyAtStartup()
    auditWebVoicePolicyAtStartup()

    expect(mockedAuditLog).toHaveBeenCalledTimes(1)
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security.web_voice.policy',
        reason,
      }),
    )
  })

  it('fails startup before auditing an unsafe production voice policy', async () => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'true')
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'production')
    const { auditWebVoicePolicyAtStartup } = await import('@/lib/server/startupAudit')

    expect(() => auditWebVoicePolicyAtStartup()).toThrow(
      'EXPO_PUBLIC_ENABLE_WEB_VOICE=true requires PATIENT_APP_ENVIRONMENT',
    )
    expect(mockedAuditLog).not.toHaveBeenCalled()
  })
})
