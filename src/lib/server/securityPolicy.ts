/**
 * Build the patient-web Permissions-Policy from the shared web voice gate.
 * The microphone remains disabled unless the flag value is exactly "true"
 * and the exported patient app is explicitly non-production.
 * This gate covers assessment voice capture and MyScribe web recording.
 */
const WEB_VOICE_ENVIRONMENTS = new Set(['development', 'test', 'e2e'])
const PATIENT_APP_ENVIRONMENTS = new Set([...WEB_VOICE_ENVIRONMENTS, 'staging', 'production'])
const CSP_HOST_SOURCE_RE = /^https:\/\/(?:\*\.)?[A-Za-z0-9.-]+(?::[0-9]+)?$/

export function isWebVoiceEnabled(
  flag = process.env.EXPO_PUBLIC_ENABLE_WEB_VOICE,
  patientAppEnvironment = process.env.PATIENT_APP_ENVIRONMENT,
): boolean {
  if (flag !== 'true') return false
  if (!patientAppEnvironment || !WEB_VOICE_ENVIRONMENTS.has(patientAppEnvironment)) {
    throw new Error(
      'EXPO_PUBLIC_ENABLE_WEB_VOICE=true requires PATIENT_APP_ENVIRONMENT to be development, test, or e2e',
    )
  }
  return true
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
  if (!patientAppEnvironment || !PATIENT_APP_ENVIRONMENTS.has(patientAppEnvironment)) {
    throw new Error('PATIENT_APP_ENVIRONMENT must be explicitly set to development, test, e2e, staging, or production')
  }
  if (!value?.trim()) {
    throw new Error('NEXT_PUBLIC_STORAGE_DOMAINS must explicitly configure patient web storage connect origins')
  }

  const origins = value.split(/[\s,]+/).filter(Boolean)
  for (const origin of origins) validateConnectOrigin(origin, patientAppEnvironment)

  if (voiceFlag === 'true') {
    if (!WEB_VOICE_ENVIRONMENTS.has(patientAppEnvironment)) {
      throw new Error(
        'EXPO_PUBLIC_ENABLE_WEB_VOICE=true requires PATIENT_APP_ENVIRONMENT to be development, test, or e2e',
      )
    }
    if (!localMinioPublicOrigin) {
      throw new Error(
        'PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN is required when patient web voice is enabled',
      )
    }
    const normalizedMinioOrigin = exactOrigin(localMinioPublicOrigin)
    validateConnectOrigin(normalizedMinioOrigin, patientAppEnvironment)
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
  if (CSP_HOST_SOURCE_RE.test(origin)) return

  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    throw new Error(`Invalid patient web storage connect origin: ${origin}`)
  }
  if (parsed.origin !== origin || parsed.username || parsed.password) {
    throw new Error(`Patient web storage connect origins must be exact origins: ${origin}`)
  }
  if (parsed.protocol === 'https:') return
  if (
    parsed.protocol === 'http:' &&
    WEB_VOICE_ENVIRONMENTS.has(environment) &&
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
