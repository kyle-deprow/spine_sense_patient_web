import {
  getFrontDoorOriginGuardConfig,
  type FrontDoorOriginGuardMode,
} from '@/lib/front-door-origin-guard'

export interface PatientWebConfig {
  backendInternalUrl: string
  csrfSecret: string
  auditActorSigningKeys: AuditActorSigningKeys
  allowedOrigins: string[]
  storageOrigins: string[]
  googleClientId: string
  googleClientSecret: string
  googleOauthBaaConfirmed: boolean
  publicUrl: string | null
  environment: string
  frontDoorOriginGuardMode: FrontDoorOriginGuardMode
  azureFrontDoorId: string | null
  clientIpMode: ClientIpMode
}

export const CLIENT_IP_MODES = ['azure-front-door', 'single-bucket', 'unavailable'] as const
export type ClientIpMode = (typeof CLIENT_IP_MODES)[number]

export interface AuditActorSigningKey {
  id: string
  secret: string
}

export interface AuditActorSigningKeys {
  current: AuditActorSigningKey
  previous?: AuditActorSigningKey | undefined
}

const SIGNING_KEY_ID_RE = /^[A-Za-z0-9_-]{1,32}$/
const LOCAL_ORIGIN_ENVIRONMENTS = new Set(['local', 'development', 'dev', 'test', 'e2e'])
const HOSTED_ENVIRONMENTS = new Set(['staging', 'production', 'prod'])

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function parseAllowedOrigins(
  value: string | undefined,
  environment: string | undefined,
): string[] {
  const entries = splitList(value)
  if (entries.length === 0) {
    throw new Error('PATIENT_WEB_ALLOWED_ORIGINS must contain at least one exact origin')
  }

  const allowLoopbackHttp = LOCAL_ORIGIN_ENVIRONMENTS.has(environment?.trim() || 'unknown')
  const origins = new Set<string>()
  for (const entry of entries) {
    let parsed: URL
    try {
      parsed = new URL(entry)
    } catch {
      throw new Error('PATIENT_WEB_ALLOWED_ORIGINS must contain exact URL origins')
    }
    const isLoopback =
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '[::1]'
    const validTransport =
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && isLoopback && allowLoopbackHttp)
    if (
      entry.includes('*') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      entry !== parsed.origin ||
      !validTransport
    ) {
      throw new Error('PATIENT_WEB_ALLOWED_ORIGINS must contain exact permitted origins')
    }
    origins.add(parsed.origin)
  }
  return [...origins]
}

function requireSecret(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value) return value
  throw new Error(`${name} is required outside development`)
}

function requireSecretBytes(name: string, minimumBytes: number, fallback?: string): string {
  const value = requireSecret(name, fallback)
  if (Buffer.byteLength(value, 'utf8') < minimumBytes) {
    throw new Error(`${name} must be at least ${minimumBytes} bytes`)
  }
  return value
}

export function parseClientIpMode(
  mode = process.env.PATIENT_WEB_CLIENT_IP_MODE,
  environment = process.env.ENVIRONMENT,
): ClientIpMode {
  const normalizedMode = mode?.trim()
  const normalizedEnvironment = environment?.trim()
  if (!normalizedMode || !(CLIENT_IP_MODES as readonly string[]).includes(normalizedMode)) {
    throw new Error(
      'PATIENT_WEB_CLIENT_IP_MODE must be azure-front-door, single-bucket, or unavailable',
    )
  }
  if (!normalizedEnvironment) {
    throw new Error('ENVIRONMENT is required for PATIENT_WEB_CLIENT_IP_MODE')
  }
  if (normalizedMode === 'single-bucket' && !LOCAL_ORIGIN_ENVIRONMENTS.has(normalizedEnvironment)) {
    throw new Error(
      'PATIENT_WEB_CLIENT_IP_MODE=single-bucket is allowed only in local environments',
    )
  }
  if (
    (normalizedMode === 'azure-front-door' || normalizedMode === 'unavailable') &&
    !HOSTED_ENVIRONMENTS.has(normalizedEnvironment)
  ) {
    throw new Error(
      `PATIENT_WEB_CLIENT_IP_MODE=${normalizedMode} is allowed only in hosted environments`,
    )
  }
  return normalizedMode as ClientIpMode
}

function requireValue(name: string): string {
  const value = process.env[name]
  if (value) return value
  throw new Error(`${name} is required`)
}

function auditActorSigningKeys(): AuditActorSigningKeys {
  const current = signingKey(
    'PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY_ID',
    'PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY',
  )
  const previousId = process.env.PATIENT_WEB_AUDIT_ACTOR_SIGNING_PREVIOUS_KEY_ID
  const previousSecret = process.env.PATIENT_WEB_AUDIT_ACTOR_SIGNING_PREVIOUS_KEY

  if (Boolean(previousId) !== Boolean(previousSecret)) {
    throw new Error(
      'PATIENT_WEB_AUDIT_ACTOR_SIGNING_PREVIOUS_KEY_ID and PATIENT_WEB_AUDIT_ACTOR_SIGNING_PREVIOUS_KEY must be set together',
    )
  }
  if (!previousId || !previousSecret) return { current }

  const previous = validateSigningKey(previousId, previousSecret, 'previous')
  if (previous.id === current.id) {
    throw new Error('Patient web audit actor current and previous signing key IDs must differ')
  }
  return { current, previous }
}

function signingKey(idName: string, secretName: string): AuditActorSigningKey {
  return validateSigningKey(requireValue(idName), requireValue(secretName), 'current')
}

function validateSigningKey(id: string, secret: string, label: string): AuditActorSigningKey {
  if (!SIGNING_KEY_ID_RE.test(id)) {
    throw new Error(`Patient web audit actor ${label} signing key ID is invalid`)
  }
  if (Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error(`Patient web audit actor ${label} signing key must be at least 32 bytes`)
  }
  return { id, secret }
}

function parseBooleanEnv(name: string): boolean {
  const value = process.env[name]
  if (value === undefined || value === '') return false

  const normalized = value.toLowerCase()
  if (normalized === 'true') return true
  if (normalized === 'false') return false

  throw new Error(`${name} must be true or false`)
}

function validateBackendUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`BACKEND_INTERNAL_URL is not a valid URL: ${url}`)
  }

  const allowedProtocols = new Set(['http:', 'https:'])
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new Error(`BACKEND_INTERNAL_URL must use http or https, got: ${parsed.protocol}`)
  }

  // In production, require HTTPS unless the host is localhost/127.0.0.1 (Docker internal)
  if (process.env.NODE_ENV === 'production') {
    const isLocalhost = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    if (!isLocalhost && parsed.protocol !== 'https:') {
      throw new Error(
        `BACKEND_INTERNAL_URL must use https in production for non-localhost hosts, got: ${url}`,
      )
    }
  }

  // Block cloud metadata endpoints
  const blockedHosts = new Set([
    '169.254.169.254',
    'metadata.google.internal',
    'metadata.azure.com',
  ])
  if (blockedHosts.has(parsed.hostname)) {
    throw new Error(`BACKEND_INTERNAL_URL points to a blocked host: ${parsed.hostname}`)
  }
}

export function getPatientWebConfig(): PatientWebConfig {
  const isDevelopment = process.env.NODE_ENV === 'development'
  const csrfSecret = requireSecretBytes(
    'PATIENT_WEB_CSRF_SECRET',
    32,
    isDevelopment ? 'development-only-patient-web-csrf-secret' : undefined,
  )

  const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8000'
  validateBackendUrl(backendInternalUrl)

  const allowedOrigins = parseAllowedOrigins(
    process.env.PATIENT_WEB_ALLOWED_ORIGINS,
    process.env.ENVIRONMENT,
  )
  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const googleOauthBaaConfirmed = parseBooleanEnv('GOOGLE_OAUTH_BAA_CONFIRMED')
  const frontDoorOriginGuard = getFrontDoorOriginGuardConfig()
  const isExplicitLocalEnvironment = LOCAL_ORIGIN_ENVIRONMENTS.has(
    process.env.ENVIRONMENT?.trim() || 'unknown',
  )
  if (
    !isExplicitLocalEnvironment &&
    (googleClientId || googleClientSecret) &&
    !googleOauthBaaConfirmed
  ) {
    throw new Error('Google OAuth production traffic requires GOOGLE_OAUTH_BAA_CONFIRMED=true')
  }
  const clientIpMode = parseClientIpMode()
  if (clientIpMode === 'azure-front-door' && frontDoorOriginGuard.expectedFrontDoorId === null) {
    throw new Error('AZURE_FRONT_DOOR_ID is required for azure-front-door client IP mode')
  }

  return {
    backendInternalUrl,
    csrfSecret,
    auditActorSigningKeys: auditActorSigningKeys(),
    allowedOrigins,
    storageOrigins: splitList(process.env.NEXT_PUBLIC_STORAGE_DOMAINS),
    googleClientId,
    googleClientSecret,
    googleOauthBaaConfirmed,
    publicUrl: process.env.PATIENT_WEB_PUBLIC_URL ?? null,
    environment: frontDoorOriginGuard.environment,
    frontDoorOriginGuardMode: frontDoorOriginGuard.mode,
    azureFrontDoorId: frontDoorOriginGuard.expectedFrontDoorId,
    clientIpMode,
  }
}
