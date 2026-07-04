export interface PatientWebConfig {
  backendInternalUrl: string
  csrfSecret: string
  allowedOrigins: string[]
  storageOrigins: string[]
  googleClientId: string
  googleClientSecret: string
  googleOauthBaaConfirmed: boolean
  publicUrl: string | null
}

function splitList(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function requireSecret(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback
  if (value) return value
  throw new Error(`${name} is required outside development`)
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
  const csrfSecret = requireSecret(
    'PATIENT_WEB_CSRF_SECRET',
    isDevelopment ? 'development-only-patient-web-csrf-secret' : undefined,
  )

  const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8000'
  validateBackendUrl(backendInternalUrl)

  const googleClientId = process.env.GOOGLE_CLIENT_ID ?? ''
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET ?? ''
  const googleOauthBaaConfirmed = parseBooleanEnv('GOOGLE_OAUTH_BAA_CONFIRMED')
  if (
    process.env.NODE_ENV === 'production' &&
    (googleClientId || googleClientSecret) &&
    !googleOauthBaaConfirmed
  ) {
    throw new Error('Google OAuth production traffic requires GOOGLE_OAUTH_BAA_CONFIRMED=true')
  }

  return {
    backendInternalUrl,
    csrfSecret,
    allowedOrigins: splitList(process.env.PATIENT_WEB_ALLOWED_ORIGINS),
    storageOrigins: splitList(
      process.env.NEXT_PUBLIC_STORAGE_DOMAINS ??
        'https://*.s3.amazonaws.com https://*.storage.googleapis.com',
    ),
    googleClientId,
    googleClientSecret,
    googleOauthBaaConfirmed,
    publicUrl: process.env.PATIENT_WEB_PUBLIC_URL ?? null,
  }
}
