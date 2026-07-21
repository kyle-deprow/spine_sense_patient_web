import { createHmac, randomUUID } from 'node:crypto'
import { isIP } from 'node:net'

import Redis from 'ioredis'
import type { NextRequest } from 'next/server'

import { getPatientWebConfig } from '@/lib/server/config'
import { jsonNoStore } from '@/lib/server/responses'

const MAX_KEYS = 10_000
const REDIS_KEY_PREFIX = 'spinesense:patient-web:credential-rate-limit:v1:'

const CONSUME_SCRIPT = `
local key = KEYS[1]
local server_time = redis.call('TIME')
local now = (tonumber(server_time[1]) * 1000) + math.floor(tonumber(server_time[2]) / 1000)
local window_ms = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local member = ARGV[3]
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window_ms)
local count = redis.call('ZCARD', key)
if count >= limit then
  redis.call('PEXPIRE', key, window_ms)
  return 0
end
redis.call('ZADD', key, now, member)
redis.call('PEXPIRE', key, window_ms)
return 1
`

interface RateLimitStore {
  consume(key: string, limit: number, windowMs: number): Promise<boolean>
  clear(): Promise<void>
}

// Map<key, timestamps[]> — timestamps are ms since epoch, sorted ascending
const store = new Map<string, number[]>()

const memoryStore: RateLimitStore = {
  async consume(key, limit, windowMs) {
    const now = Date.now()
    const windowStart = now - windowMs

    let timestamps = store.get(key)
    if (timestamps === undefined) {
      if (store.size >= MAX_KEYS) {
        const oldestKey = store.keys().next().value
        if (oldestKey !== undefined) store.delete(oldestKey)
      }
      timestamps = []
      store.set(key, timestamps)
    }

    let start = 0
    while (start < timestamps.length) {
      const timestamp = timestamps[start]
      if (timestamp === undefined || timestamp >= windowStart) break
      start++
    }
    if (start > 0) timestamps.splice(0, start)
    if (timestamps.length >= limit) return false
    timestamps.push(now)
    return true
  },
  async clear() {
    store.clear()
  },
}

let redisClient: Redis | null = null
let redisConnectPromise: Promise<void> | null = null

function createRedisClient(redisUrl: string): Redis {
  redisClient = new Redis(redisUrl, {
    connectTimeout: 1_500,
    commandTimeout: 2_000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  })
  // IORedis emits connection failures as events in addition to rejecting the
  // command. Consume the event without logging the credential-bearing URL.
  redisClient.on('error', () => undefined)
  return redisClient
}

async function getReadyRedisClient(redisUrl: string): Promise<Redis> {
  if (redisClient === null || redisClient.status === 'end') createRedisClient(redisUrl)
  const client = redisClient
  if (client === null) throw new Error('Credential rate-limit store is unavailable')
  if (client.status === 'ready') return client

  if (redisConnectPromise === null) {
    redisConnectPromise = client.connect().finally(() => {
      redisConnectPromise = null
    })
  }
  try {
    await redisConnectPromise
  } catch {
    client.disconnect(false)
    if (redisClient === client) redisClient = null
    throw new Error('Credential rate-limit store is unavailable')
  }
  if (String(client.status) !== 'ready') {
    throw new Error('Credential rate-limit store is unavailable')
  }
  return client
}

function redisStore(redisUrl: string): RateLimitStore {
  return {
    async consume(key, limit, windowMs) {
      const client = await getReadyRedisClient(redisUrl)
      const result = await client.eval(
        CONSUME_SCRIPT,
        1,
        `${REDIS_KEY_PREFIX}${key}`,
        windowMs,
        limit,
        randomUUID(),
      )
      if (result !== 0 && result !== 1) throw new Error('Unexpected credential rate-limit result')
      return result === 1
    },
    async clear() {
      const client = await getReadyRedisClient(redisUrl)
      let cursor = '0'
      do {
        const [nextCursor, keys] = await client.scan(
          cursor,
          'MATCH',
          `${REDIS_KEY_PREFIX}*`,
          'COUNT',
          100,
        )
        cursor = nextCursor
        if (keys.length > 0) await client.unlink(...keys)
      } while (cursor !== '0')
    },
  }
}

function configuredStore(): RateLimitStore {
  const config = getPatientWebConfig()
  if (config.credentialRateLimitStore === 'memory') return memoryStore
  if (config.redisUrl === null) throw new Error('Redis credential rate-limit store is unavailable')
  return redisStore(config.redisUrl)
}

function validateOptions(opts: { limit: number; windowMs: number }): void {
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) {
    throw new Error('Credential rate-limit limit must be a positive integer')
  }
  if (!Number.isSafeInteger(opts.windowMs) || opts.windowMs < 1) {
    throw new Error('Credential rate-limit windowMs must be a positive integer')
  }
}

export async function rateLimit(
  key: string,
  opts: { limit: number; windowMs: number },
): Promise<boolean> {
  if (shouldBypassRateLimit()) return true
  validateOptions(opts)
  return configuredStore().consume(key, opts.limit, opts.windowMs)
}

export async function clearRateLimitStore(): Promise<void> {
  await configuredStore().clear()
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
export type CredentialRateLimitResult =
  | 'allowed'
  | 'rate_limited'
  | 'client_ip_unavailable'
  | 'store_unavailable'

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

export async function checkCredentialRateLimit(
  request: NextRequest,
  scope: ClientRateLimitScope,
  opts: { limit: number; windowMs: number },
): Promise<CredentialRateLimitResult> {
  const key = getClientRateLimitKey(request, scope)
  if (key === null) return 'client_ip_unavailable'
  try {
    return (await rateLimit(key, opts)) ? 'allowed' : 'rate_limited'
  } catch {
    return 'store_unavailable'
  }
}

export async function credentialRateLimitFailureResponse(
  request: NextRequest,
  scope: ClientRateLimitScope,
  opts: { limit?: number; windowMs?: number } = {},
): Promise<Response | null> {
  const windowMs = opts.windowMs ?? 15 * 60 * 1000
  const result = await checkCredentialRateLimit(request, scope, {
    limit: opts.limit ?? 5,
    windowMs,
  })
  if (result === 'allowed') return null
  if (result === 'client_ip_unavailable' || result === 'store_unavailable') {
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
