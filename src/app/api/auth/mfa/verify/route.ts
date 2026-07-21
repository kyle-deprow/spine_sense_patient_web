import type { NextRequest } from 'next/server'

import { COOKIE_NAMES, clearMfaTransactionCookies } from '@/lib/auth/cookies'
import { validateAuthMutation } from '@/lib/auth/route-guards'
import {
  clearAccountTransitionState,
  forwardCredentialAuth,
  readRequestJson,
} from '@/lib/server/auth'
import { auditLog, createAuditContext } from '@/lib/server/audit'
import { BackendUnavailableError } from '@/lib/server/backend'
import { jsonNoStore } from '@/lib/server/responses'
import { checkCredentialRateLimit } from '@/lib/server/rate-limit'

const WINDOW_MS = 15 * 60 * 1000 // 15 minutes

export async function POST(request: NextRequest) {
  const auditContext = createAuditContext()
  const failure = validateAuthMutation(request)
  if (failure) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.mfa.verify.failure',
      method: 'POST',
      status: failure.status,
      reason: 'request_policy_denied',
      ...auditContext,
    })
    return clearAccountTransitionState(failure)
  }

  const rateLimitResult = await checkCredentialRateLimit(request, 'auth.mfa.verify', {
    limit: 5,
    windowMs: WINDOW_MS,
  })
  if (rateLimitResult === 'client_ip_unavailable' || rateLimitResult === 'store_unavailable') {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.mfa.verify.failure',
      method: 'POST',
      status: 503,
      reason: rateLimitResult,
      ...auditContext,
    })
    return clearAccountTransitionState(
      jsonNoStore({ error: 'service_unavailable' }, { status: 503 }),
    )
  }
  if (rateLimitResult === 'rate_limited') {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.mfa.verify.failure',
      method: 'POST',
      status: 429,
      reason: 'rate_limited',
      ...auditContext,
    })
    return clearAccountTransitionState(
      jsonNoStore(
        { error: 'too_many_requests' },
        { status: 429, headers: { 'Retry-After': '900' } },
      ),
    )
  }

  auditLog({
    ts: new Date().toISOString(),
    event: 'auth.mfa.verify.attempt',
    method: 'POST',
    ...auditContext,
  })

  const body = await readRequestJson(request)
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.mfa.verify.failure',
      method: 'POST',
      status: 400,
      reason: 'invalid_json',
      ...auditContext,
    })
    return clearAccountTransitionState(jsonNoStore({ error: 'invalid_json' }, { status: 400 }))
  }

  const mfaToken = request.cookies.get(COOKIE_NAMES.mfaTransaction)?.value
  const methodId = request.cookies.get(COOKIE_NAMES.mfaMethod)?.value
  if (!mfaToken || !methodId) {
    const response = jsonNoStore({ error: 'mfa_transaction_missing' }, { status: 401 })
    clearMfaTransactionCookies(response)
    return response
  }

  const code = (body as Record<string, unknown>).code
  const backendBody = { code, mfa_token: mfaToken, method_id: methodId }

  let response: Response
  try {
    response = await forwardCredentialAuth('/api/v1/auth/mfa/verify', backendBody, request, {
      auditContext,
    })
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      auditLog({
        ts: new Date().toISOString(),
        event: 'auth.mfa.verify.failure',
        method: 'POST',
        status: 503,
        reason: 'backend_unavailable',
        ...auditContext,
      })
      return clearAccountTransitionState(
        jsonNoStore({ error: 'service_unavailable' }, { status: 503 }),
      )
    }
    throw err
  }

  if (!response.ok) {
    auditLog({
      ts: new Date().toISOString(),
      event: 'auth.mfa.verify.failure',
      method: 'POST',
      status: response.status,
      ...auditContext,
    })
  }

  return response
}
