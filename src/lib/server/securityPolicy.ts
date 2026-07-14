/**
 * Build the patient-web Permissions-Policy from the shared web voice gate.
 * The microphone is enabled by default in deployed patient-web environments
 * and remains explicit for local/test/e2e builds.
 * This gate covers assessment voice capture and MyScribe web recording.
 */
const LOCAL_WEB_VOICE_ENVIRONMENTS = new Set(['development', 'test', 'e2e'])
const DEPLOYED_WEB_VOICE_ENVIRONMENTS = new Set(['staging', 'production'])
const PATIENT_APP_ENVIRONMENTS = new Set([
  ...LOCAL_WEB_VOICE_ENVIRONMENTS,
  ...DEPLOYED_WEB_VOICE_ENVIRONMENTS,
])

export function isWebVoiceEnabled(
  flag = process.env.EXPO_PUBLIC_ENABLE_WEB_VOICE,
  patientAppEnvironment = process.env.PATIENT_APP_ENVIRONMENT,
): boolean {
  if (!patientAppEnvironment || !PATIENT_APP_ENVIRONMENTS.has(patientAppEnvironment)) {
    if (flag === 'true') {
      throw new Error(
        'EXPO_PUBLIC_ENABLE_WEB_VOICE=true requires PATIENT_APP_ENVIRONMENT to be development, test, e2e, staging, or production',
      )
    }
    return false
  }
  if (DEPLOYED_WEB_VOICE_ENVIRONMENTS.has(patientAppEnvironment)) return true
  return flag === 'true'
}

export function buildPermissionsPolicyHeader(): string {
  const microphone = isWebVoiceEnabled() ? 'microphone=(self)' : 'microphone=()'
  return `camera=(), ${microphone}, geolocation=(), payment=(), usb=(), browsing-topics=()`
}

export function getStorageConnectOrigins(
  value = process.env.NEXT_PUBLIC_STORAGE_DOMAINS,
  patientAppEnvironment = process.env.PATIENT_APP_ENVIRONMENT,
  localMinioPublicOrigin = process.env.PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN,
  voiceFlag = process.env.EXPO_PUBLIC_ENABLE_WEB_VOICE,
): string[] {
  const environment = patientAppEnvironment ?? ''
  if (!value?.trim()) {
    throw new Error('NEXT_PUBLIC_STORAGE_DOMAINS must explicitly configure patient web storage connect origins')
  }

  const origins = value.split(/[\s,]+/).filter(Boolean)
  for (const origin of origins) validateConnectOrigin(origin, environment)

  const voiceEnabled = isWebVoiceEnabled(voiceFlag, environment)

  if (voiceEnabled && LOCAL_WEB_VOICE_ENVIRONMENTS.has(environment)) {
    if (!localMinioPublicOrigin) {
      throw new Error(
        'PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN is required when patient web voice is enabled',
      )
    }
    const normalizedMinioOrigin = exactOrigin(localMinioPublicOrigin)
    validateConnectOrigin(normalizedMinioOrigin, environment)
    if (!origins.includes(normalizedMinioOrigin)) {
      throw new Error(
        'NEXT_PUBLIC_STORAGE_DOMAINS must include PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN when patient web voice is enabled',
      )
    }
  }

  return [...new Set(origins)]
}

export function validateSecurityPolicyConfiguration(): void {
  isWebVoiceEnabled()
  getStorageConnectOrigins()
}

function validateConnectOrigin(origin: string, environment: string): void {
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`Invalid patient web storage connect origin: ${origin}`)
  }
  if (parsed.hostname.includes('*')) {
    throw new Error(`Patient web storage connect origins must be exact origins: ${origin}`)
  }
  if (parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error(`Patient web storage connect origins must be exact origins: ${origin}`)
  }
  if (parsed.protocol === 'https:') return
  if (
    parsed.protocol === 'http:' &&
    LOCAL_WEB_VOICE_ENVIRONMENTS.has(environment) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  ) return
  throw new Error(`Insecure patient web storage connect origin is not allowed: ${origin}`)
}

function exactOrigin(value: string): string {
  try {
    const parsed = new URL(value)
    if (parsed.origin !== value || parsed.username || parsed.password) throw new Error()
    return parsed.origin
  } catch {
    throw new Error('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN must be an exact URL origin')
  }
}
