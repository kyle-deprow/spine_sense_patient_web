import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { forwardCredentialAuth, readRequestJson } from '@/lib/server/auth'
import { auditLog } from '@/lib/server/audit'
import { jsonNoStore } from '@/lib/server/responses'
import type { RegisterResponse } from '@/types/auth'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure

  const requestId = request.headers.get('x-request-id') ?? undefined

  auditLog({ ts: new Date().toISOString(), event: 'auth.register.attempt', method: 'POST', requestId })

  const body = await readRequestJson(request)
  if (body == null) {
    return jsonNoStore({ error: 'invalid_json' }, { status: 400 })
  }

  const response = await forwardCredentialAuth('/api/v1/auth/register/patient', body)

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
