import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { forwardCredentialAuth, readRequestJson } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'
import type { LoginResponse } from '@/types/auth'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure

  const requestId = request.headers.get('x-request-id') ?? undefined

  auditLog({ ts: new Date().toISOString(), event: 'auth.login.attempt', method: 'POST', requestId })

  const body = await readRequestJson(request)
  if (body == null) {
    return jsonNoStore({ error: 'invalid_json' }, { status: 400 })
  }

  let response: Response
  try {
    response = await forwardCredentialAuth('/api/v1/auth/login', body)
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
    }
    throw err
  }

  if (response.ok) {
    // Clone to read body without consuming the response sent to the client
    const data = await response.clone().json() as LoginResponse
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.login.success',
      method: 'POST',
      userId: data.user_id ?? undefined,
      status: response.status,
      requestId,
    })
  } else {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.login.failure',
      method: 'POST',
      status: response.status,
      requestId,
    })
  }

  return response
}
