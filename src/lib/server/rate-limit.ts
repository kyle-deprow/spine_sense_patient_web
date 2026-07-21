import { createHmac } from 'node:crypto'
import { isIP } from 'node:net'

import type { NextRequest } from 'next/server'

import { getPatientWebConfig } from '@/lib/server/config'
import { jsonNoStore } from '@/lib/server/responses'

const MAX_KEYS = 10_000

// Map<key, timestamps[]> — timestamps are ms since epoch, sorted ascending
const store = new Map<string, number[]>()

export function rateLimit(key: string, opts: { limit: number; windowMs: number }): boolean {
  if (shouldBypassRateLimit()) return true

  const now = Date.now()
  const windowStart = now - opts.windowMs

  let timestamps = store.get(key)

  if (timestamps === undefined) {
    // Evict the oldest entry when at capacity before inserting a new key
    if (store.size >= MAX_KEYS) {
      const oldestKey = store.keys().next().value
      if (oldestKey !== undefined) {
        store.delete(oldestKey)
      }
    }
    timestamps = []
    store.set(key, timestamps)
  }

  // Sliding window: drop timestamps that have fallen outside the window
  let start = 0
  while (start < timestamps.length) {
    const timestamp = timestamps[start]
    if (timestamp === undefined || timestamp >= windowStart) break
    start++
  }
  if (start > 0) {
    timestamps.splice(0, start)
  }

  if (timestamps.length >= opts.limit) {
    // At limit — do not record this attempt
    if (timestamps.length === 0) {
      store.delete(key)
    }
    return false
  }

  timestamps.push(now)
  return true
}

export function clearRateLimitStore(): void {
  store.clear()
}

export function shouldBypassRateLimit(
  bypassFlag = process.env.PATIENT_WEB_E2E_BYPASS_RATE_LIMITS,
  environment = process.env.ENVIRONMENT,
  clientIpMode = process.env.PATIENT_WEB_CLIENT_IP_MODE,
): boolean {
  if (bypassFlag !== 'true') return false
  if (
    !['local', 'development', 'dev', 'test', 'e2e'].includes(environment?.trim() ?? '') ||
    clientIpMode !== 'single-bucket'
  ) {
    throw new Error(
      'PATIENT_WEB_E2E_BYPASS_RATE_LIMITS requires an explicit local single-bucket environment',
    )
  }
  return true
}

export const CLIENT_RATE_LIMIT_SCOPES = [
  'auth.login',
  'auth.register',
  'auth.mfa.verify',
  'auth.mfa.enrollment.setup',
  'auth.mfa.enrollment.confirm',
  'auth.mfa.step-up',
  'auth.mfa.replace',
  'auth.mfa.disable',
] as const

export type ClientRateLimitScope = (typeof CLIENT_RATE_LIMIT_SCOPES)[number]
export type ClientRateLimitKey = string & {
  readonly __clientRateLimitKey: unique symbol
}
export type CredentialRateLimitResult = 'allowed' | 'rate_limited' | 'client_ip_unavailable'

const KEY_DOMAIN = 'spinesense.patient-web.rate-limit.v1'

export function getClientRateLimitKey(
  request: NextRequest,
  scope: ClientRateLimitScope,
): ClientRateLimitKey | null {
  const config = getPatientWebConfig()
  let bucket: string

  if (config.clientIpMode === 'unavailable') return null
  if (config.clientIpMode === 'single-bucket') {
    bucket = 'single-bucket'
  } else {
    const receivedFdid = request.headers.get('x-azure-fdid')
    const socketIp = request.headers.get('x-azure-socketip')
    if (
      config.azureFrontDoorId === null ||
      receivedFdid === null ||
      receivedFdid.includes(',') ||
      receivedFdid !== config.azureFrontDoorId ||
      socketIp === null ||
      socketIp.includes(',')
    ) {
      return null
    }
    const normalized = normalizeIp(socketIp)
    if (normalized === null) return null
    bucket = normalized
  }

  const digest = createHmac('sha256', config.csrfSecret)
    .update(`${KEY_DOMAIN}\0${scope}\0${bucket}`, 'utf8')
    .digest('base64url')
  return `rl:v1:${digest}` as ClientRateLimitKey
}

export function checkCredentialRateLimit(
  request: NextRequest,
  scope: ClientRateLimitScope,
  opts: { limit: number; windowMs: number },
): CredentialRateLimitResult {
  const key = getClientRateLimitKey(request, scope)
  if (key === null) return 'client_ip_unavailable'
  return rateLimit(key, opts) ? 'allowed' : 'rate_limited'
}

export function credentialRateLimitFailureResponse(
  request: NextRequest,
  scope: ClientRateLimitScope,
  opts: { limit?: number; windowMs?: number } = {},
): Response | null {
  const windowMs = opts.windowMs ?? 15 * 60 * 1000
  const result = checkCredentialRateLimit(request, scope, {
    limit: opts.limit ?? 5,
    windowMs,
  })
  if (result === 'allowed') return null
  if (result === 'client_ip_unavailable') {
    return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
  }
  return jsonNoStore(
    { error: 'too_many_requests' },
    { status: 429, headers: { 'Retry-After': String(windowMs / 1000) } },
  )
}

function normalizeIp(value: string): string | null {
  if (value !== value.trim() || value === '') return null
  const version = isIP(value)
  if (version === 4) return value.split('.').map(Number).join('.')
  if (version !== 6) return null

  // URL parsing uses the platform IPv6 serializer, yielding one canonical,
  // compressed representation for equivalent textual addresses.
  try {
    const hostname = new URL(`http://[${value}]/`).hostname
    return hostname.slice(1, -1)
  } catch {
    return null
  }
}
