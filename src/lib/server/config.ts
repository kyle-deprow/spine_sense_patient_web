export interface PatientWebConfig {
  backendInternalUrl: string
  csrfSecret: string
  allowedOrigins: string[]
  storageOrigins: string[]
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

export function getPatientWebConfig(): PatientWebConfig {
  const isDevelopment = process.env.NODE_ENV === 'development'
  const csrfSecret = requireSecret(
    'PATIENT_WEB_CSRF_SECRET',
    isDevelopment ? 'development-only-patient-web-csrf-secret' : undefined,
  )

  return {
    backendInternalUrl: process.env.BACKEND_INTERNAL_URL ?? 'http://localhost:8000',
    csrfSecret,
    allowedOrigins: splitList(process.env.PATIENT_WEB_ALLOWED_ORIGINS),
    storageOrigins: splitList(
      process.env.NEXT_PUBLIC_STORAGE_DOMAINS ??
        'https://*.s3.amazonaws.com https://*.storage.googleapis.com',
    ),
  }
}
