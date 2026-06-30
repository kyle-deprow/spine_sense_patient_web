/**
 * Server-side audit logging for HIPAA §164.312(b) ePHI access recording.
 *
 * Rules:
 * - Never log PHI (no request/response bodies, no full URL paths)
 * - Never log tokens (access_token, refresh_token, mfa_token)
 * - userId is extracted from the JWT payload only (sub claim), never from bodies
 * - Emits structured JSON to stdout; a log shipper picks it up from the container
 *
 * This module must only be imported from Node.js route handlers.
 * It does NOT verify JWT signatures — extraction is for audit correlation only.
 */

export interface AuditRecord {
  ts: string
  event: string
  method?: string | undefined
  resourceType?: string | undefined
  userId?: string | undefined
  status?: number | undefined
  requestId?: string | undefined
  reason?: string | undefined
}

/**
 * Derive a safe resourceType label from a backend target path such as
 * "/api/v1/patients/me/assessments/123" → "patients.assessments"
 * "/api/v1/safety" → "safety"
 *
 * The full path is never logged.
 */
export function deriveResourceType(targetPath: string): string {
  // Strip leading /api/v1/ prefix
  const withoutPrefix = targetPath.replace(/^\/api\/v1\//, '')
  // Take the first two meaningful segments; normalise "me" away so that
  // /patients/me/assessments → patients.assessments
  const segments = withoutPrefix
    .split('/')
    .filter((s) => s.length > 0 && s !== 'me')
  return segments.slice(0, 2).join('.') || 'unknown'
}

/**
 * Extract the `sub` claim from a JWT without verifying the signature.
 * Returns undefined if the token is missing, malformed, or the claim is absent.
 * The token value itself is never retained.
 */
export function extractUserIdFromToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  try {
    const parts = token.split('.')
    if (parts.length < 2) return undefined
    // Base64url → Base64 → JSON
    const rawPart = parts[1]
    if (rawPart == null) return undefined
    const payload = rawPart.replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(payload, 'base64').toString('utf8')
    const claims = JSON.parse(json) as Record<string, unknown>
    const sub = claims['sub']
    return typeof sub === 'string' ? sub : undefined
  } catch {
    return undefined
  }
}

export function auditLog(record: AuditRecord): void {
  const entry: Record<string, unknown> = {
    ts: record.ts,
    event: record.event,
  }
  if (record.method !== undefined) entry['method'] = record.method
  if (record.resourceType !== undefined) entry['resourceType'] = record.resourceType
  if (record.userId !== undefined) entry['userId'] = record.userId
  if (record.status !== undefined) entry['status'] = record.status
  if (record.requestId !== undefined) entry['requestId'] = record.requestId
  if (record.reason !== undefined) entry['reason'] = record.reason
  process.stdout.write(`${JSON.stringify(entry)}\n`)
}
