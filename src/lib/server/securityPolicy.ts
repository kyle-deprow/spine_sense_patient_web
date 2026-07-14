/** Browser voice support is capability-detected by the deployed patient app. */
const LOCAL_PATIENT_WEB_ENVIRONMENTS = new Set(['development', 'test', 'e2e'])

export function buildPermissionsPolicyHeader(): string {
  return 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()'
}

export function getStorageConnectOrigins(
  value = process.env.NEXT_PUBLIC_STORAGE_DOMAINS,
  patientAppEnvironment = process.env.PATIENT_APP_ENVIRONMENT,
  localMinioPublicOrigin = process.env.PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN,
): string[] {
  const environment = patientAppEnvironment ?? ''
  if (!value?.trim()) {
    throw new Error('NEXT_PUBLIC_STORAGE_DOMAINS must explicitly configure patient web storage connect origins')
  }

  const origins = value.split(/[\s,]+/).filter(Boolean)
  for (const origin of origins) validateConnectOrigin(origin, environment)

  if (LOCAL_PATIENT_WEB_ENVIRONMENTS.has(environment)) {
    if (!localMinioPublicOrigin) {
      throw new Error('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN is required for local patient web audio uploads')
    }
    const normalizedMinioOrigin = exactOrigin(localMinioPublicOrigin)
    validateConnectOrigin(normalizedMinioOrigin, environment)
    if (!origins.includes(normalizedMinioOrigin)) {
      throw new Error(
        'NEXT_PUBLIC_STORAGE_DOMAINS must include PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN for local patient web audio uploads',
      )
    }
  }

  return [...new Set(origins)]
}

export function validateSecurityPolicyConfiguration(): void {
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
    LOCAL_PATIENT_WEB_ENVIRONMENTS.has(environment) &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
  )
    return
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
