/** Browser voice support is capability-detected by the deployed patient app. */

/**
 * Deployment tiers that must never accept an `http://` storage connect origin,
 * regardless of hostname. Every other tier may use loopback `http://` only
 * through the explicit local-MinIO configuration validated below.
 */
const HTTPS_ONLY_ENVIRONMENTS = new Set(['staging', 'production', 'prod'])

/** Hostnames a laptop MinIO may legitimately be published on. */
const LOOPBACK_UPLOAD_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

export function buildPermissionsPolicyHeader(): string {
  return 'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()'
}

/**
 * Resolves the exact origins the patient web CSP allows `connect-src` to reach.
 *
 * The local-MinIO requirement keys off the STORAGE configuration, never off the
 * deployment tier name. Tier and storage backend are orthogonal: Azure dev
 * legitimately runs `ENVIRONMENT=development` against HTTPS Azure Blob origins
 * and has no MinIO, while a laptop runs MinIO on loopback. Gating the
 * requirement on the tier name made deployed dev demand
 * PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN and crash-loop its startup probe.
 *
 * Rules:
 *  1. If PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN is set it must be an exact
 *     origin and must appear in NEXT_PUBLIC_STORAGE_DOMAINS.
 *  2. If any configured origin is `http://` a local stack is in play: the
 *     origin must be loopback, and the local MinIO origin must be set and
 *     present. This keeps the guard for a developer who forgot to configure it.
 *  3. `http://` origins are rejected outright in hosted tiers.
 *  4. All-HTTPS origins with no MinIO origin carry no extra requirement — this
 *     is every deployed environment, dev included.
 */
export function getStorageConnectOrigins(
  value = process.env.NEXT_PUBLIC_STORAGE_DOMAINS,
  deploymentEnvironment = process.env.ENVIRONMENT,
  localMinioPublicOrigin = process.env.PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN,
): string[] {
  const environment = deploymentEnvironment?.trim() ?? ''
  if (!value?.trim()) {
    throw new Error('NEXT_PUBLIC_STORAGE_DOMAINS must explicitly configure patient web storage connect origins')
  }

  const origins = value.split(/[\s,]+/).filter(Boolean)
  let hasLocalUploadOrigin = false
  for (const origin of origins) {
    if (validateConnectOrigin(origin, environment).protocol === 'http:') hasLocalUploadOrigin = true
  }

  const configuredMinioOrigin = localMinioPublicOrigin?.trim() ?? ''
  if (configuredMinioOrigin || hasLocalUploadOrigin) {
    if (!configuredMinioOrigin) {
      throw new Error('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN is required for local patient web audio uploads')
    }
    const normalizedMinioOrigin = exactOrigin(configuredMinioOrigin)
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

function validateConnectOrigin(origin: string, environment: string): URL {
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
  if (parsed.protocol === 'https:') return parsed
  if (
    parsed.protocol === 'http:' &&
    !HTTPS_ONLY_ENVIRONMENTS.has(environment) &&
    LOOPBACK_UPLOAD_HOSTNAMES.has(parsed.hostname)
  )
    return parsed
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
