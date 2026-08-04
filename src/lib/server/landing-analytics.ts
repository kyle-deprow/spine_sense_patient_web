/**
 * Anonymous landing-funnel counters for the public entry screen.
 *
 * This exists to answer one question paid traffic makes urgent: of the people
 * who click an ad, how many reach the welcome screen, how far do they read,
 * and where do they leave. Ad platforms report clicks; nothing on our side
 * reported arrivals, so a campaign could burn budget against a page nobody
 * successfully loaded and look identical to a page that simply did not
 * convert.
 *
 * What it deliberately is NOT:
 *
 *   - It stores counts, never rows. There is no per-person record to join, so
 *     no amount of later querying can reconstruct an individual's visit.
 *   - It never sees an account, an email, or any clinical value. Every event
 *     here fires before registration, on a screen that is public by design.
 *   - It sets no cookie and touches no durable browser storage. The visit id
 *     is generated in page memory and dies with the tab, which is why this
 *     needs no new consent category: there is nothing persisted on the device
 *     to consent to.
 *   - Nothing leaves our own infrastructure. No third-party tag, no ad-network
 *     pixel, no request to any host but this one.
 *
 * Unique visitors use a HyperLogLog rather than a set: it answers "how many
 * distinct visits" without retaining the visit ids that would make the answer
 * re-identifiable.
 *
 * Redis is the store because the BFF already speaks to it for credential rate
 * limiting. When Redis is unconfigured (local dev, tests) it degrades to an
 * in-process map — losing counts on restart is the correct trade for a
 * measurement surface that must never fail a patient's request.
 */
import 'server-only'

import Redis from 'ioredis'

import { getPatientWebConfig } from '@/lib/server/config'

const REDIS_KEY_PREFIX = 'spinesense:patient-web:landing:v1:'

/** Counters outlive a monthly campaign review and then expire themselves. */
const RETENTION_SECONDS = 40 * 24 * 60 * 60

/**
 * The complete set of events that may be counted.
 *
 * An allowlist rather than free-form names: this endpoint is unauthenticated,
 * so without it any caller could mint unbounded Redis keys. Order is funnel
 * order, which is what `summary` reports.
 */
export const LANDING_EVENTS = [
  'landing_view',
  'consent_shown',
  'consent_accept',
  'consent_decline',
  'consent_deadend',
  'consent_deadend_back',
  'scroll_1',
  'scroll_2',
  'scroll_3',
  'scroll_4',
  'scroll_5',
  'cta_start',
  'cta_signin',
  'register_view',
  'register_submit',
] as const

export type LandingEvent = (typeof LANDING_EVENTS)[number]

const EVENT_SET: ReadonlySet<string> = new Set(LANDING_EVENTS)

export const DEVICE_CLASSES = ['phone', 'tablet', 'desktop'] as const
export type DeviceClass = (typeof DEVICE_CLASSES)[number]

const DEVICE_SET: ReadonlySet<string> = new Set(DEVICE_CLASSES)

/** Campaign tags come from an ad URL, so they are constrained hard. */
const CAMPAIGN_PATTERN = /^[a-zA-Z0-9_-]{1,32}$/
const NO_CAMPAIGN = 'none'

export function isLandingEvent(value: unknown): value is LandingEvent {
  return typeof value === 'string' && EVENT_SET.has(value)
}

export function normalizeDeviceClass(value: unknown): DeviceClass {
  return typeof value === 'string' && DEVICE_SET.has(value) ? (value as DeviceClass) : 'desktop'
}

/**
 * An unrecognised tag becomes `none` rather than being rejected: a mistyped
 * campaign in a live ad should still count as an arrival. Untagged organic
 * traffic lands here too, which is what makes the two comparable.
 */
export function normalizeCampaign(value: unknown): string {
  if (typeof value !== 'string') return NO_CAMPAIGN
  const trimmed = value.trim()
  if (!CAMPAIGN_PATTERN.test(trimmed)) return NO_CAMPAIGN
  return trimmed.toLowerCase()
}

/** UTC day. Campaign reporting spans time zones; local dates would not line up. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}

export interface LandingBatch {
  visitId: string
  campaign: string
  device: DeviceClass
  events: readonly LandingEvent[]
}

export interface LandingDayRow {
  day: string
  campaign: string
  device: DeviceClass
  visits: number
  events: Record<string, number>
}

interface LandingStore {
  record(batch: LandingBatch, day: string): Promise<void>
  read(days: readonly string[]): Promise<LandingDayRow[]>
  clear(): Promise<void>
}

function counterKey(day: string, campaign: string, device: string, event: string): string {
  return `${REDIS_KEY_PREFIX}c:${day}:${campaign}:${device}:${event}`
}

function visitsKey(day: string, campaign: string, device: string): string {
  return `${REDIS_KEY_PREFIX}u:${day}:${campaign}:${device}`
}

/** Lets `read` enumerate the campaign/device pairs seen without scanning Redis. */
function indexKey(day: string): string {
  return `${REDIS_KEY_PREFIX}i:${day}`
}

// ── in-process fallback ────────────────────────────────────────────────────
const memoryCounters = new Map<string, number>()
const memoryVisits = new Map<string, Set<string>>()
const memoryIndex = new Map<string, Set<string>>()

const memoryStore: LandingStore = {
  async record({ visitId, campaign, device, events }, day) {
    const pair = `${campaign}|${device}`
    const index = memoryIndex.get(day) ?? new Set<string>()
    index.add(pair)
    memoryIndex.set(day, index)

    const vKey = visitsKey(day, campaign, device)
    const visits = memoryVisits.get(vKey) ?? new Set<string>()
    visits.add(visitId)
    memoryVisits.set(vKey, visits)

    for (const event of events) {
      const key = counterKey(day, campaign, device, event)
      memoryCounters.set(key, (memoryCounters.get(key) ?? 0) + 1)
    }
  },
  async read(days) {
    const rows: LandingDayRow[] = []
    for (const day of days) {
      for (const pair of memoryIndex.get(day) ?? []) {
        const [campaign = NO_CAMPAIGN, device = 'desktop'] = pair.split('|')
        const events: Record<string, number> = {}
        for (const event of LANDING_EVENTS) {
          const count = memoryCounters.get(counterKey(day, campaign, device, event)) ?? 0
          if (count > 0) events[event] = count
        }
        rows.push({
          day,
          campaign,
          device: normalizeDeviceClass(device),
          visits: memoryVisits.get(visitsKey(day, campaign, device))?.size ?? 0,
          events,
        })
      }
    }
    return rows
  },
  async clear() {
    memoryCounters.clear()
    memoryVisits.clear()
    memoryIndex.clear()
  },
}

// ── redis ──────────────────────────────────────────────────────────────────
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
  // Consume connection failures without logging the credential-bearing URL.
  redisClient.on('error', () => undefined)
  return redisClient
}

async function getReadyRedisClient(redisUrl: string): Promise<Redis> {
  if (redisClient === null || redisClient.status === 'end') createRedisClient(redisUrl)
  const client = redisClient
  if (client === null) throw new Error('Landing analytics store is unavailable')
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
    throw new Error('Landing analytics store is unavailable')
  }
  if (String(client.status) !== 'ready') {
    throw new Error('Landing analytics store is unavailable')
  }
  return client
}

function redisStore(redisUrl: string): LandingStore {
  return {
    async record({ visitId, campaign, device, events }, day) {
      const client = await getReadyRedisClient(redisUrl)
      const pipeline = client.pipeline()

      pipeline.sadd(indexKey(day), `${campaign}|${device}`)
      pipeline.expire(indexKey(day), RETENTION_SECONDS)

      const vKey = visitsKey(day, campaign, device)
      pipeline.pfadd(vKey, visitId)
      pipeline.expire(vKey, RETENTION_SECONDS)

      for (const event of events) {
        const key = counterKey(day, campaign, device, event)
        pipeline.incr(key)
        pipeline.expire(key, RETENTION_SECONDS)
      }

      await pipeline.exec()
    },

    async read(days) {
      const client = await getReadyRedisClient(redisUrl)
      const rows: LandingDayRow[] = []

      for (const day of days) {
        const pairs = await client.smembers(indexKey(day))
        for (const pair of pairs) {
          const [campaign = NO_CAMPAIGN, device = 'desktop'] = pair.split('|')

          const pipeline = client.pipeline()
          pipeline.pfcount(visitsKey(day, campaign, device))
          for (const event of LANDING_EVENTS) {
            pipeline.get(counterKey(day, campaign, device, event))
          }
          const results = await pipeline.exec()
          if (results === null) continue

          const visits = Number(results[0]?.[1] ?? 0)
          const events: Record<string, number> = {}
          LANDING_EVENTS.forEach((event, i) => {
            const count = Number(results[i + 1]?.[1] ?? 0)
            if (count > 0) events[event] = count
          })

          rows.push({ day, campaign, device: normalizeDeviceClass(device), visits, events })
        }
      }
      return rows
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

/**
 * Resolve the store, degrading to memory rather than throwing.
 *
 * `getPatientWebConfig` validates the whole BFF configuration surface and
 * throws when any unrelated secret is missing. Measurement must not be able to
 * fail for a reason that has nothing to do with measurement, so a config error
 * costs counts, never a request.
 */
function configuredStore(): LandingStore {
  try {
    const config = getPatientWebConfig()
    if (config.redisUrl === null) return memoryStore
    return redisStore(config.redisUrl)
  } catch {
    return memoryStore
  }
}

/**
 * Count a batch of events.
 *
 * Never throws: a measurement failure must not surface to a visitor, and the
 * caller returns 204 either way. The boolean is for tests.
 */
export async function recordLandingBatch(
  batch: LandingBatch,
  now: Date = new Date(),
): Promise<boolean> {
  if (batch.events.length === 0) return true
  try {
    await configuredStore().record(batch, utcDay(now))
    return true
  } catch {
    return false
  }
}

/** Most recent `days` first. */
export async function readLandingSummary(
  dayCount: number,
  now: Date = new Date(),
): Promise<LandingDayRow[]> {
  const days: string[] = []
  for (let i = 0; i < dayCount; i += 1) {
    const day = new Date(now.getTime() - i * 24 * 60 * 60 * 1000)
    days.push(utcDay(day))
  }
  return configuredStore().read(days)
}

/** Test-support only. */
export async function clearLandingAnalytics(): Promise<void> {
  await configuredStore().clear()
}
