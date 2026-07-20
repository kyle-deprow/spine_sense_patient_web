export const FRONT_DOOR_ORIGIN_GUARD_MODES = ['off', 'audit', 'enforce'] as const

export type FrontDoorOriginGuardMode = (typeof FRONT_DOOR_ORIGIN_GUARD_MODES)[number]

export interface FrontDoorOriginGuardConfig {
  environment: string
  mode: FrontDoorOriginGuardMode
  expectedFrontDoorId: string | null
}

export type FrontDoorOriginGuardReason = 'missing' | 'malformed' | 'mismatch'

export interface FrontDoorOriginGuardAuditRecord {
  event: 'security.front_door_origin.rejected'
  app: 'patient-web'
  reason: FrontDoorOriginGuardReason
  mode: 'audit'
  environment: string
}

const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ENVIRONMENT_RE = /^[a-z][a-z0-9-]{0,31}$/
const AUDIT_WINDOW_MS = 60_000
const AUDIT_LIMIT_PER_WINDOW = 10

type AuditLogger = (record: FrontDoorOriginGuardAuditRecord) => void

let auditWindowStartedAt = 0
let auditRecordsInWindow = 0

export function getFrontDoorOriginGuardConfig(
  environment = process.env.ENVIRONMENT,
  mode = process.env.FRONT_DOOR_ORIGIN_GUARD_MODE,
  expectedFrontDoorId = process.env.AZURE_FRONT_DOOR_ID,
): FrontDoorOriginGuardConfig {
  const normalizedEnvironment = environment?.trim() || 'local'
  if (!ENVIRONMENT_RE.test(normalizedEnvironment)) {
    throw new Error('ENVIRONMENT must be a lowercase deployment label')
  }

  const normalizedMode = mode?.trim() || 'off'
  if (!isFrontDoorOriginGuardMode(normalizedMode)) {
    throw new Error('FRONT_DOOR_ORIGIN_GUARD_MODE must be off, audit, or enforce')
  }

  const normalizedFrontDoorId = expectedFrontDoorId?.trim() || null
  if (normalizedFrontDoorId !== null && !CANONICAL_UUID_RE.test(normalizedFrontDoorId)) {
    throw new Error('AZURE_FRONT_DOOR_ID must be a canonical lowercase UUID')
  }
  if (normalizedMode !== 'off' && normalizedFrontDoorId === null) {
    throw new Error('AZURE_FRONT_DOOR_ID is required when the Front Door origin guard is active')
  }

  return {
    environment: normalizedEnvironment,
    mode: normalizedMode,
    expectedFrontDoorId: normalizedFrontDoorId,
  }
}

export function frontDoorOriginRejectionReason(
  headers: Headers,
  expectedFrontDoorId: string,
): FrontDoorOriginGuardReason | null {
  const received = headers.get('x-azure-fdid')
  if (received === null || received === '') return 'missing'

  // Fetch combines duplicate header fields using a comma. Reject both that form
  // and an explicitly comma-separated value instead of selecting one value.
  if (received.includes(',') || !CANONICAL_UUID_RE.test(received)) return 'malformed'
  return received === expectedFrontDoorId ? null : 'mismatch'
}

export function auditFrontDoorOriginRejection(
  config: FrontDoorOriginGuardConfig,
  reason: FrontDoorOriginGuardReason,
  now = Date.now(),
  logger: AuditLogger = (record) => console.warn(record),
): void {
  if (config.mode !== 'audit') return

  if (now < auditWindowStartedAt || now - auditWindowStartedAt >= AUDIT_WINDOW_MS) {
    auditWindowStartedAt = now
    auditRecordsInWindow = 0
  }
  if (auditRecordsInWindow >= AUDIT_LIMIT_PER_WINDOW) return

  auditRecordsInWindow += 1
  logger({
    event: 'security.front_door_origin.rejected',
    app: 'patient-web',
    reason,
    mode: 'audit',
    environment: config.environment,
  })
}

export function resetFrontDoorOriginAuditWindowForTests(): void {
  auditWindowStartedAt = 0
  auditRecordsInWindow = 0
}

function isFrontDoorOriginGuardMode(value: string): value is FrontDoorOriginGuardMode {
  return (FRONT_DOOR_ORIGIN_GUARD_MODES as readonly string[]).includes(value)
}
