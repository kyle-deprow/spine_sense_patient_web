import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { forwardCredentialAuth, readRequestJson } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'
import { rateLimit, getClientIp } from '@/lib/server/rate-limit'
import type { RegisterResponse } from '@/types/auth'

const WINDOW_MS = 60 * 60 * 1000 // 60 minutes

function normalizeRegistrationBody(body: unknown): Record<string, unknown> | null {
  if (body == null || typeof body !== 'object') {
    return null
  }

  const raw = body as Record<string, unknown>
  const payload: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'firstName' || key === 'first_name') {
      payload['first_name'] = value
    } else if (key === 'lastName' || key === 'last_name') {
      payload['last_name'] = value
    } else if (key === 'dateOfBirth' || key === 'date_of_birth') {
      payload['date_of_birth'] = value
    } else if (key === 'phoneNumber' || key === 'phone_number' || key === 'phone') {
      payload['phone'] = value === '' ? null : value
    } else {
      payload[key] = value
    }
  }

  return payload
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
  console.log("Next.js Register Route received body:", JSON.stringify(body))
  if (body == null) {
    return jsonNoStore({ error: 'invalid_json' }, { status: 400 })
  }

  const normalizedBody = normalizeRegistrationBody(body)
  if (normalizedBody == null) {
    return jsonNoStore({ error: 'invalid_json' }, { status: 400 })
  }

  let response: Response
  try {
    response = await forwardCredentialAuth('/api/v1/auth/register/patient', normalizedBody)
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
