import type { BackendTokenPair } from '@/types/auth'
import { getPatientWebConfig } from '@/lib/server/config'

export class BackendUnavailableError extends Error {
  constructor() {
    super('Backend unavailable')
    this.name = 'BackendUnavailableError'
  }
}

const BACKEND_TIMEOUT_MS = 30_000 // 30 seconds

export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { backendInternalUrl } = getPatientWebConfig()
  const target = new URL(path, backendInternalUrl)

  const timeoutSignal = AbortSignal.timeout(BACKEND_TIMEOUT_MS)
  const signal =
    init.signal != null
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal

  try {
    return await fetch(target, {
      ...init,
      cache: 'no-store',
      signal,
    })
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new BackendUnavailableError()
    }
    if (err instanceof TypeError) {
      throw new BackendUnavailableError()
    }
    throw err
  }
}

export async function readJsonBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  const contentType = response.headers.get('content-type')
  if (!contentType?.includes('application/json')) return {} as T
  try {
    return (await response.json()) as T
  } catch {
    return {} as T
  }
}

export function hasTokenPair(value: unknown): value is BackendTokenPair {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.access_token === 'string' && typeof record.refresh_token === 'string'
}

export function stripTokens<T extends Record<string, unknown>>(
  body: T,
): Omit<T, 'access_token' | 'refresh_token' | 'mfa_token' | 'user_id' | 'mfa_method_id'> {
  const {
    access_token: _accessToken,
    refresh_token: _refreshToken,
    mfa_token: _mfaToken,
    user_id: _userId,
    mfa_method_id: _mfaMethodId,
    ...safeBody
  } = body
  return safeBody
}
