import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { logoutWithCookie } from '@/lib/server/auth'
import { auditLog, extractUserIdFromToken } from '@/lib/server/audit'
import { COOKIE_NAMES } from '@/lib/auth/cookies'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure

  const requestId = request.headers.get('x-request-id') ?? undefined
  const userId = extractUserIdFromToken(request.cookies.get(COOKIE_NAMES.access)?.value)

  auditLog({
    ts: new Date().toISOString(),
    event: 'auth.logout',
    method: 'POST',
    userId,
    requestId,
  })

  return logoutWithCookie(request)
}
