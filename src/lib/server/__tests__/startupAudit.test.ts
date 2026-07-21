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
    vi.stubEnv('ENVIRONMENT', 'test')
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', 'https://patient.example.test')
    vi.stubEnv('PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY_ID', 'startup-current')
    vi.stubEnv(
      'PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY',
      'startup-audit-actor-signing-key-at-least-32-bytes',
    )
    vi.stubEnv(
      'NEXT_PUBLIC_STORAGE_DOMAINS',
      'https://patient-documents.example.test http://127.0.0.1:9000',
    )
    vi.stubEnv('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN', 'http://127.0.0.1:9000')
    mockedAuditLog.mockReset()
  })

  it('logs the enabled policy once per process module lifecycle', async () => {
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'test')
    const { auditWebVoicePolicyAtStartup } = await import('@/lib/server/startupAudit')

    auditWebVoicePolicyAtStartup()
    auditWebVoicePolicyAtStartup()

    expect(mockedAuditLog).toHaveBeenCalledTimes(1)
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security.web_voice.policy',
        reason: 'enabled',
      }),
    )
  })

  it('enables and audits the production voice policy', async () => {
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'production')
    vi.stubEnv('NEXT_PUBLIC_STORAGE_DOMAINS', 'https://patient-documents.example.test')
    vi.stubEnv('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN', '')
    const { auditWebVoicePolicyAtStartup } = await import('@/lib/server/startupAudit')

    expect(() => auditWebVoicePolicyAtStartup()).not.toThrow()
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'security.web_voice.policy',
        reason: 'enabled',
      }),
    )
  })

  it('fails startup before auditing when Front Door enforcement is misconfigured', async () => {
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', 'enforce')
    vi.stubEnv('AZURE_FRONT_DOOR_ID', '')
    const { auditWebVoicePolicyAtStartup } = await import('@/lib/server/startupAudit')

    expect(() => auditWebVoicePolicyAtStartup()).toThrow(
      'AZURE_FRONT_DOOR_ID is required when the Front Door origin guard is active',
    )
    expect(mockedAuditLog).not.toHaveBeenCalled()
  })

  it('fails startup before policy audit when the allowed-origin policy is missing', async () => {
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', '')
    const { auditWebVoicePolicyAtStartup } = await import('@/lib/server/startupAudit')

    expect(() => auditWebVoicePolicyAtStartup()).toThrow('PATIENT_WEB_ALLOWED_ORIGINS')
    expect(mockedAuditLog).not.toHaveBeenCalled()
  })
})
