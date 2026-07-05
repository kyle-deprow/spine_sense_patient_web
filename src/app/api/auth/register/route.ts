import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { forwardCredentialAuth, readRequestJson } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'
import { rateLimit, getClientIp } from '@/lib/server/rate-limit'
import type { RegisterResponse } from '@/types/auth'

const WINDOW_MS = 60 * 60 * 1000 // 60 minutes
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
  const failure = validateAuthMutation(request)
  if (failure) return failure

  const ip = getClientIp(request)
  if (!rateLimit(ip, { limit: 5, windowMs: WINDOW_MS })) {
    return jsonNoStore({ error: 'too_many_requests' }, { status: 429, headers: { 'Retry-After': '3600' } })
  }

  const requestId = request.headers.get('x-request-id') ?? undefined

  auditLog({ ts: new Date().toISOString(), event: 'auth.register.attempt', method: 'POST', requestId })

  const body = await readRequestJson(request)
  if (body == null) {
    return jsonNoStore({ error: 'invalid_json' }, { status: 400 })
  }
  const normalizedBody = normalizeRegistrationBody(body)

  let response: Response
  try {
    response = await forwardCredentialAuth(
      '/api/v1/auth/register/patient',
      normalizedBody,
      undefined,
      { errorMode: 'registration' },
    )
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
    }
    throw err
  }

  if (response.ok) {
    const data = await response.clone().json() as RegisterResponse
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.register.success',
      method: 'POST',
      userId: data.user_id ?? data.id ?? undefined,
      status: response.status,
      requestId,
    })
  } else {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.register.failure',
      method: 'POST',
      status: response.status,
      requestId,
    })
  }

  return response
}
