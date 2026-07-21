import type { NextRequest } from 'next/server'

import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { sessionFromCookie } from '@/lib/server/auth'
import { auditLog, createRequestAuditContext } from '@/lib/server/audit'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'
import { validatePatientWebConfiguration } from '@/lib/auth/route-guards'

export async function GET(request: NextRequest) {
  const configurationFailure = validatePatientWebConfiguration()
  if (configurationFailure) return configurationFailure
  const auditContext = createRequestAuditContext(
    request,
    request.cookies.get(COOKIE_NAMES.access)?.value,
  )

  try {
    const response = await sessionFromCookie(request)
    auditLog({
      ts: new Date().toISOString(),
      event: response.ok ? 'auth.session.success' : 'auth.session.failure',
      method: 'GET',
      status: response.status,
      ...auditContext,
    })
    return response
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      auditLog({
        ts: new Date().toISOString(),
        event: 'auth.session.failure',
        method: 'GET',
        status: 503,
        reason: 'backend_unavailable',
        ...auditContext,
      })
      return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
    }
    throw err
  }
}
