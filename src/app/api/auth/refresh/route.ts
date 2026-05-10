import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { refreshWithCookie } from '@/lib/server/auth'
import { auditLog, extractUserIdFromToken } from '@/lib/server/audit'
import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure

  const requestId = request.headers.get('x-request-id') ?? undefined
  const userId = extractUserIdFromToken(request.cookies.get(COOKIE_NAMES.access)?.value)

  auditLog({ ts: new Date().toISOString(), event: 'auth.refresh.attempt', method: 'POST', userId, requestId })

  let response: Response
  try {
    response = await refreshWithCookie(request)
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
    }
    throw err
  }

  if (response.ok) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.refresh.success',
      method: 'POST',
      userId,
      status: response.status,
      requestId,
    })
  } else {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.refresh.failure',
      method: 'POST',
      userId,
      status: response.status,
      requestId,
    })
  }

  return response
}
