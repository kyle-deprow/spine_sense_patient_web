import type { NextRequest } from 'next/server'

import { sessionFromCookie } from '@/lib/server/auth'
import { auditLog, extractUserIdFromToken } from '@/lib/server/audit'
import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'

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

  try {
    return await sessionFromCookie(request)
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
    }
    throw err
  }
}
