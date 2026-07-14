import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { clearAccountTransitionState, forwardCredentialAuth, readRequestJson } from '@/lib/server/auth'
import { auditLog, createAuditContext } from '@/lib/server/audit'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'
import { rateLimit, getClientIp } from '@/lib/server/rate-limit'

const RATE_LIMIT_ATTEMPTS = 10
const WINDOW_MS = 15 * 60 * 1000 // 15 minutes
const RETRY_AFTER_SECONDS = String(WINDOW_MS / 1000)
type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function firstString(body: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

function optionalString(body: JsonRecord, ...keys: string[]): string | null | undefined {
  const value = firstString(body, ...keys)
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? value : null
}

function normalizeRegistrationBody(body: unknown): JsonRecord {
  if (!isRecord(body)) return {}

  const normalized: JsonRecord = {}

  const email = firstString(body, 'email')
  if (email !== undefined) normalized.email = email

  const password = firstString(body, 'password')
  if (password !== undefined) normalized.password = password

  const firstName = firstString(body, 'first_name', 'firstName')
  if (firstName !== undefined) normalized.first_name = firstName

  const lastName = firstString(body, 'last_name', 'lastName')
  if (lastName !== undefined) normalized.last_name = lastName

  const dateOfBirth = firstString(body, 'date_of_birth', 'dateOfBirth')
  if (dateOfBirth !== undefined) normalized.date_of_birth = dateOfBirth

  const phone = optionalString(body, 'phone', 'phone_number', 'phoneNumber')
  if (phone !== undefined && phone !== null) normalized.phone = phone

  return normalized
}

export async function POST(request: NextRequest) {
  const auditContext = createAuditContext()
  const failure = validateAuthMutation(request)
  if (failure) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.register.failure',
      method: 'POST',
      status: failure.status,
      reason: 'request_policy_denied',
      ...auditContext,
    })
    return clearAccountTransitionState(failure)
  }

  const ip = getClientIp(request)
  if (!rateLimit(ip, { limit: RATE_LIMIT_ATTEMPTS, windowMs: WINDOW_MS })) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.register.failure',
      method: 'POST',
      status: 429,
      reason: 'rate_limited',
      ...auditContext,
    })
    return clearAccountTransitionState(jsonNoStore({ error: 'too_many_requests' }, { status: 429, headers: { 'Retry-After': RETRY_AFTER_SECONDS } }))
  }

  auditLog({ ts: new Date().toISOString(), event: 'auth.register.attempt', method: 'POST', ...auditContext })

  const body = await readRequestJson(request)
  if (body == null) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.register.failure',
      method: 'POST',
      status: 400,
      reason: 'invalid_json',
      ...auditContext,
    })
    return clearAccountTransitionState(jsonNoStore({ error: 'invalid_json' }, { status: 400 }))
  }
  const normalizedBody = normalizeRegistrationBody(body)

  let response: Response
  let authenticatedActorId: string | undefined
  try {
    response = await forwardCredentialAuth(
      '/api/v1/auth/register/patient',
      normalizedBody,
      undefined,
      {
        errorMode: 'registration',
        auditContext,
        onAuthenticatedActor: (actorId) => {
          authenticatedActorId = actorId
        },
      },
    )
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      auditLog({
        ts: new Date().toISOString(),
        event: 'auth.register.failure',
        method: 'POST',
        status: 503,
        reason: 'backend_unavailable',
        ...auditContext,
      })
      return clearAccountTransitionState(jsonNoStore({ error: 'service_unavailable' }, { status: 503 }))
    }
    throw err
  }

  if (response.ok) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.register.success',
      method: 'POST',
      status: response.status,
      ...auditContext,
      ...(authenticatedActorId === undefined ? {} : { actorId: authenticatedActorId }),
    })
  } else {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.register.failure',
      method: 'POST',
      status: response.status,
      ...auditContext,
    })
  }

  return response
}
