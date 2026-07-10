import type { NextRequest } from 'next/server'

import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { validateAuthMutation } from '@/lib/auth/route-guards'
import { refreshWithCookie, type IssuedSessionAudit } from '@/lib/server/auth'
import { auditLog, createRequestAuditContext } from '@/lib/server/audit'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'

export async function POST(request: NextRequest) {
  const correlationToken =
    request.cookies.get(COOKIE_NAMES.access)?.value ?? request.cookies.get(COOKIE_NAMES.refresh)?.value
  const auditContext = createRequestAuditContext(request, correlationToken)
  const failure = validateAuthMutation(request)
  if (failure) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.refresh.failure',
      method: 'POST',
      status: failure.status,
      reason: 'request_policy_denied',
      ...auditContext,
    })
    return failure
  }

  auditLog({ ts: new Date().toISOString(), event: 'auth.refresh.attempt', method: 'POST', ...auditContext })

  let response: Response
  let issuedSession: IssuedSessionAudit | undefined
  try {
    response = await refreshWithCookie(request, (issued) => {
      issuedSession = issued
    })
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      auditLog({
        ts: new Date().toISOString(),
        event: 'auth.refresh.failure',
        method: 'POST',
        status: 503,
        reason: 'backend_unavailable',
        ...auditContext,
      })
      return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
    }
    throw err
  }

  if (response.ok) {
    if (!issuedSession) {
      throw new Error('Successful refresh did not issue an authenticated session')
    }
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.refresh.success',
      method: 'POST',
      status: response.status,
      ...auditContext,
    })
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.token.issued',
      method: 'POST',
      status: response.status,
      ...auditContext,
      actorId: issuedSession.actorId,
      sessionCorrelation: issuedSession.sessionCorrelation,
      reason: 'refresh_token_pair',
    })
  } else {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.refresh.failure',
      method: 'POST',
      status: response.status,
      ...auditContext,
    })
  }

  return response
}
