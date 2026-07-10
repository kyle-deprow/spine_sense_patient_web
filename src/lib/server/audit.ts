/**
 * Server-side audit logging for HIPAA §164.312(b) ePHI access recording.
 *
 * Rules:
 * - Never log PHI (no request/response bodies, no full URL paths)
 * - Never log tokens (access_token, refresh_token, mfa_token)
 * - Browser-controlled identifiers and free-form values are never emitted
 * - Actor IDs come only from authenticated backend responses, never decoded JWTs
 * - Emits structured JSON to stdout; a log shipper picks it up from the container
 *
 * This module must only be imported from Node.js route handlers.
 */

import { randomUUID } from 'node:crypto'

import type { NextRequest } from 'next/server'

import {
  auditActorIdFromRequest,
  normalizeAuditActorId,
  tokenSessionCorrelation,
  COOKIE_NAMES,
} from '@/lib/auth/cookies'
import { getPatientWebConfig } from '@/lib/server/config'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SESSION_CORRELATION_RE = /^sess_[A-Za-z0-9_-]{43}$/
const SAFE_LABEL_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const SAFE_METHODS = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'])

export interface AuditContext {
  requestId: string
  actorId?: string | undefined
  sessionCorrelation?: string | undefined
}

export interface AuditRecord {
  ts: string
  event: string
  method?: string | undefined
  resourceType?: string | undefined
  actorId?: string | undefined
  status?: number | undefined
  requestId?: string | undefined
  sessionCorrelation?: string | undefined
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
  const segments = withoutPrefix.split('/').filter((s) => s.length > 0 && s !== 'me')
  return segments.slice(0, 2).join('.') || 'unknown'
}

export function createAuditContext(token?: string): AuditContext {
  const requestId = randomUUID()
  const sessionCorrelation = token ? sessionCorrelationFromToken(token) : undefined
  return sessionCorrelation === undefined ? { requestId } : { requestId, sessionCorrelation }
}

export function createRequestAuditContext(
  request: NextRequest,
  token = request.cookies.get(COOKIE_NAMES.access)?.value,
): AuditContext {
  const context = createAuditContext(token)
  const actorId = auditActorIdFromRequest(request)
  return actorId === undefined ? context : { ...context, actorId }
}

export function sessionCorrelationFromToken(token: string): string {
  const { auditActorSigningKeys } = getPatientWebConfig()
  return tokenSessionCorrelation(token, auditActorSigningKeys.current)
}

export function backendAuthenticatedActorId(value: unknown): string | undefined {
  return normalizeAuditActorId(value)
}

export function auditLog(record: AuditRecord): void {
  const entry: Record<string, unknown> = {
    ts: isIsoTimestamp(record.ts) ? record.ts : new Date().toISOString(),
    event: safeLabel(record.event) ?? 'audit.invalid_event',
  }
  const method = record.method?.toUpperCase()
  const resourceType = safeLabel(record.resourceType)
  const reason = safeLabel(record.reason)
  if (method && SAFE_METHODS.has(method)) entry['method'] = method
  if (resourceType !== undefined) entry['resourceType'] = resourceType
  const actorId = backendAuthenticatedActorId(record.actorId)
  if (actorId !== undefined) entry['actorId'] = actorId
  if (record.status !== undefined && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599) {
    entry['status'] = record.status
  }
  if (record.requestId !== undefined && UUID_RE.test(record.requestId)) {
    entry['requestId'] = record.requestId.toLowerCase()
  }
  if (record.sessionCorrelation !== undefined && SESSION_CORRELATION_RE.test(record.sessionCorrelation)) {
    entry['sessionCorrelation'] = record.sessionCorrelation
  }
  if (reason !== undefined) entry['reason'] = reason
  process.stdout.write(`${JSON.stringify(entry)}\n`)
}

function safeLabel(value: string | undefined): string | undefined {
  if (value === undefined || value.length > 80 || !SAFE_LABEL_RE.test(value)) return undefined
  return value
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && !Number.isNaN(Date.parse(value))
}
