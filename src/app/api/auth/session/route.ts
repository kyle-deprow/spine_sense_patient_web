import type { NextRequest } from 'next/server'

import { sessionFromCookie } from '@/lib/server/auth'
import { auditLog, extractUserIdFromToken } from '@/lib/server/audit'
import { COOKIE_NAMES } from '@/lib/auth/cookies'

export async function GET(request: NextRequest) {
  const requestId = request.headers.get('x-request-id') ?? undefined
  const userId = extractUserIdFromToken(request.cookies.get(COOKIE_NAMES.access)?.value)

  auditLog({
    ts: new Date().toISOString(),
    event: 'auth.session.check',
    method: 'GET',
    userId,
    requestId,
  })

  return sessionFromCookie(request)
}
