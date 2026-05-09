import type { BackendTokenPair } from '@/types/auth'
import { getPatientWebConfig } from '@/lib/server/config'

export class BackendUnavailableError extends Error {
  constructor() {
    super('Backend unavailable')
    this.name = 'BackendUnavailableError'
  }
}

export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { backendInternalUrl } = getPatientWebConfig()
  const target = new URL(path, backendInternalUrl)

  try {
    return await fetch(target, {
      ...init,
      cache: 'no-store',
    })
  } catch {
    throw new BackendUnavailableError()
  }
}

export async function readJsonBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export function hasTokenPair(value: unknown): value is BackendTokenPair {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record.access_token === 'string' && typeof record.refresh_token === 'string'
}

export function stripTokens<T extends Record<string, unknown>>(body: T): Omit<T, 'access_token' | 'refresh_token'> {
  const { access_token: _accessToken, refresh_token: _refreshToken, ...safeBody } = body
  return safeBody
}
