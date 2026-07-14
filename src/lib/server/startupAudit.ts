import { auditLog } from '@/lib/server/audit'
import { getPatientWebConfig } from '@/lib/server/config'
import { validateSecurityPolicyConfiguration } from '@/lib/server/securityPolicy'

let voicePolicyAudited = false

export function auditWebVoicePolicyAtStartup(): void {
  if (voicePolicyAudited) return
  getPatientWebConfig()
  validateSecurityPolicyConfiguration()
  voicePolicyAudited = true

  auditLog({
    ts: new Date().toISOString(),
    event: 'security.web_voice.policy',
    reason: 'enabled',
  })
}
