import type { NextRequest } from 'next/server'

import {
  COOKIE_NAMES,
  clearAuthCookies,
  clearMfaTransactionCookies,
  issueAuthenticatedSessionCookies,
  setMfaPendingCookie,
} from '@/lib/auth/cookies'
import { backendFetch, BackendUnavailableError, hasTokenPair, readJsonBody } from '@/lib/server/backend'
import { issueCsrfCookie, resolveBackendAuthenticatedActorId } from '@/lib/server/auth'
import { jsonNoStore } from '@/lib/server/responses'

type JsonRecord = Record<string, unknown>

function objectBody(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null
}

function transactionFailure(error: string, status: number) {
  return jsonNoStore({ error }, { status })
}

async function postBackend(path: string, body: JsonRecord, accessToken?: string): Promise<Response> {
  const headers = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
  })
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  return backendFetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

export async function setupMfaEnrollment(request: NextRequest) {
  const transaction = request.cookies.get(COOKIE_NAMES.mfaTransaction)?.value
  if (!transaction) return transactionFailure('mfa_transaction_missing', 401)

  try {
    const backendResponse = await postBackend('/api/v1/auth/mfa/enrollment/setup', {
      mfa_token: transaction,
    })
    const data = await readJsonBody<JsonRecord>(backendResponse)
    if (!backendResponse.ok) return transactionFailure('mfa_setup_failed', backendResponse.status)

    const pendingId = data.pending_id
    const secret = data.secret
    const otpauthUri = data.otpauth_uri
    if (typeof pendingId !== 'string' || typeof secret !== 'string' || typeof otpauthUri !== 'string') {
      return transactionFailure('invalid_backend_response', 502)
    }

    const response = jsonNoStore({ secret, otpauth_uri: otpauthUri })
    setMfaPendingCookie(response, pendingId)
    issueCsrfCookie(response)
    return response
  } catch (error) {
    if (error instanceof BackendUnavailableError) {
      return transactionFailure('service_unavailable', 503)
    }
    throw error
  }
}

export async function confirmMfaEnrollment(request: NextRequest, body: unknown) {
  const parsed = objectBody(body)
  if (!parsed || typeof parsed.code !== 'string') {
    return transactionFailure('invalid_request', 400)
  }

  const transaction = request.cookies.get(COOKIE_NAMES.mfaTransaction)?.value
  const pendingId = request.cookies.get(COOKIE_NAMES.mfaPending)?.value
  if (!transaction || !pendingId) return transactionFailure('mfa_transaction_missing', 401)

  try {
    const backendResponse = await postBackend('/api/v1/auth/mfa/enrollment/confirm', {
      mfa_token: transaction,
      pending_id: pendingId,
      code: parsed.code,
    })
    const data = await readJsonBody<JsonRecord>(backendResponse)
    if (!backendResponse.ok || !hasTokenPair(data)) {
      return transactionFailure('mfa_confirmation_failed', backendResponse.ok ? 502 : backendResponse.status)
    }

    const actorId = await resolveBackendAuthenticatedActorId(data.user_id, data)
    if (!actorId) return transactionFailure('authenticated_actor_unavailable', 502)

    const response = jsonNoStore({ success: true })
    clearAuthCookies(response)
    clearMfaTransactionCookies(response)
    issueAuthenticatedSessionCookies(response, {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      actorId,
    })
    issueCsrfCookie(response)
    return response
  } catch (error) {
    if (error instanceof BackendUnavailableError) {
      return transactionFailure('service_unavailable', 503)
    }
    throw error
  }
}

export async function stepUpMfa(request: NextRequest, body: unknown) {
  const parsed = objectBody(body)
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value
  if (!accessToken) return transactionFailure('unauthorized', 401)
  if (!parsed || typeof parsed.code !== 'string') return transactionFailure('invalid_request', 400)

  try {
    const backendResponse = await postBackend('/api/v1/auth/mfa/step-up', { code: parsed.code }, accessToken)
    const data = await readJsonBody<JsonRecord>(backendResponse)
    if (!backendResponse.ok) return transactionFailure('mfa_step_up_failed', backendResponse.status)
    if (data.mfa_verified !== true || typeof data.mfa_verified_until !== 'string') {
      return transactionFailure('invalid_backend_response', 502)
    }
    return jsonNoStore({
      mfa_verified: true,
      mfa_verified_until: data.mfa_verified_until,
    })
  } catch (error) {
    if (error instanceof BackendUnavailableError) {
      return transactionFailure('service_unavailable', 503)
    }
    throw error
  }
}

export async function setupAuthenticatedMfa(request: NextRequest) {
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value
  if (!accessToken) return transactionFailure('unauthorized', 401)

  try {
    const backendResponse = await postBackend('/api/v1/auth/mfa/setup', {}, accessToken)
    const data = await readJsonBody<JsonRecord>(backendResponse)
    if (!backendResponse.ok) {
      if (backendResponse.status === 403 && data.code === 'mfa_step_up_required') {
        return jsonNoStore(
          { error: 'mfa_setup_failed', code: 'mfa_step_up_required' },
          { status: backendResponse.status },
        )
      }
      return transactionFailure('mfa_setup_failed', backendResponse.status)
    }
    if (
      typeof data.secret !== 'string' ||
      typeof data.otpauth_uri !== 'string' ||
      typeof data.method_id !== 'string'
    ) {
      return transactionFailure('invalid_backend_response', 502)
    }
    return jsonNoStore({ secret: data.secret, otpauth_uri: data.otpauth_uri, method_id: data.method_id })
  } catch (error) {
    if (error instanceof BackendUnavailableError) return transactionFailure('service_unavailable', 503)
    throw error
  }
}

export async function confirmAuthenticatedMfa(request: NextRequest, body: unknown) {
  const parsed = objectBody(body)
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value
  if (!accessToken) return transactionFailure('unauthorized', 401)
  if (!parsed || typeof parsed.code !== 'string' || typeof parsed.method_id !== 'string') {
    return transactionFailure('invalid_request', 400)
  }

  try {
    const backendResponse = await postBackend(
      '/api/v1/auth/mfa/confirm',
      { code: parsed.code, method_id: parsed.method_id },
      accessToken,
    )
    const data = await readJsonBody<JsonRecord>(backendResponse)
    if (!backendResponse.ok) return transactionFailure('mfa_confirmation_failed', backendResponse.status)
    if (
      typeof data.message !== 'string' ||
      typeof data.method_id !== 'string' ||
      typeof data.is_primary !== 'boolean'
    ) {
      return transactionFailure('invalid_backend_response', 502)
    }
    return jsonNoStore({ message: data.message, method_id: data.method_id, is_primary: data.is_primary })
  } catch (error) {
    if (error instanceof BackendUnavailableError) return transactionFailure('service_unavailable', 503)
    throw error
  }
}

export async function disableMfa(request: NextRequest, body: unknown) {
  const parsed = objectBody(body)
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value
  if (!accessToken) return transactionFailure('unauthorized', 401)
  if (!parsed || typeof parsed.current_password !== 'string' || typeof parsed.code !== 'string') {
    return transactionFailure('invalid_request', 400)
  }

  try {
    const headers = new Headers({
      Accept: 'application/json',
      'Content-Type': 'application/json',
    })
    headers.set('Authorization', `Bearer ${accessToken}`)
    const backendResponse = await backendFetch('/api/v1/auth/mfa', {
      method: 'DELETE',
      headers,
      body: JSON.stringify({
        current_password: parsed.current_password,
        code: parsed.code,
      }),
    })
    if (!backendResponse.ok) return transactionFailure('mfa_disable_failed', backendResponse.status)

    const response = jsonNoStore({ success: true })
    clearAuthCookies(response)
    clearMfaTransactionCookies(response)
    return response
  } catch (error) {
    if (error instanceof BackendUnavailableError) {
      return transactionFailure('service_unavailable', 503)
    }
    throw error
  }
}
