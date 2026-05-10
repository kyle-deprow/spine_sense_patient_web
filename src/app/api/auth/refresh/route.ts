import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { refreshWithCookie } from '@/lib/server/auth'
import { auditLog, extractUserIdFromToken } from '@/lib/server/audit'
import { COOKIE_NAMES } from '@/lib/auth/cookies'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure

  const requestId = request.headers.get('x-request-id') ?? undefined
  const userId = extractUserIdFromToken(request.cookies.get(COOKIE_NAMES.access)?.value)

  auditLog({ ts: new Date().toISOString(), event: 'auth.refresh.attempt', method: 'POST', userId, requestId })

  const response = await refreshWithCookie(request)

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
