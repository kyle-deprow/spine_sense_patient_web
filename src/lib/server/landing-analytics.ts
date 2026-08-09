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
  // The server-rendered `/` funnel is deliberately separate from the Expo
  // shell funnel below so changing the paid entry URL does not redefine the
  // historical meaning of `landing_view` or either shell CTA.
  'root_view',
  // Scroll depth on the server-rendered `/` page, in fifths. Kept distinct
  // from the shell's `scroll_*` for the same reason `root_view` is kept
  // distinct from `landing_view`: the two pages are different lengths and
  // different pitches, so one name must not come to mean two things.
  'root_scroll_1',
  'root_scroll_2',
  'root_scroll_3',
  'root_scroll_4',
  'root_scroll_5',
  'root_cta_start',
  'root_cta_signin',
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
const ROOT_EVENT_SET: ReadonlySet<LandingEvent> = new Set([
  'root_view',
  'root_scroll_1',
  'root_scroll_2',
  'root_scroll_3',
  'root_scroll_4',
  'root_scroll_5',
  'root_cta_start',
  'root_cta_signin',
])

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
  rootVisits: number
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

function rootVisitsKey(day: string, campaign: string, device: string): string {
  return `${REDIS_KEY_PREFIX}ru:${day}:${campaign}:${device}`
}

function visitFunnels(events: readonly LandingEvent[]): { root: boolean; shell: boolean } {
  let root = false
  let shell = false
  for (const event of events) {
    if (ROOT_EVENT_SET.has(event)) root = true
    else shell = true
  }
  return { root, shell }
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

    const funnels = visitFunnels(events)
    for (const key of [
      funnels.shell ? visitsKey(day, campaign, device) : null,
      funnels.root ? rootVisitsKey(day, campaign, device) : null,
    ]) {
      if (key === null) continue
      const visits = memoryVisits.get(key) ?? new Set<string>()
      visits.add(visitId)
      memoryVisits.set(key, visits)
    }

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
          rootVisits: memoryVisits.get(rootVisitsKey(day, campaign, device))?.size ?? 0,
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

      const funnels = visitFunnels(events)
      for (const key of [
        funnels.shell ? visitsKey(day, campaign, device) : null,
        funnels.root ? rootVisitsKey(day, campaign, device) : null,
      ]) {
        if (key === null) continue
        pipeline.pfadd(key, visitId)
        pipeline.expire(key, RETENTION_SECONDS)
      }

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
          pipeline.pfcount(rootVisitsKey(day, campaign, device))
          for (const event of LANDING_EVENTS) {
            pipeline.get(counterKey(day, campaign, device, event))
          }
          const results = await pipeline.exec()
          if (results === null) continue

          const visits = Number(results[0]?.[1] ?? 0)
          const rootVisits = Number(results[1]?.[1] ?? 0)
          const events: Record<string, number> = {}
          LANDING_EVENTS.forEach((event, i) => {
            const count = Number(results[i + 2]?.[1] ?? 0)
            if (count > 0) events[event] = count
          })

          rows.push({
            day,
            campaign,
            device: normalizeDeviceClass(device),
            visits,
            rootVisits,
            events,
          })
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

// ── campaign rollup ────────────────────────────────────────────────────────

/**
 * Which URL an ad for this campaign pointed at.
 *
 *   `landing` — the server-rendered `/`. Its arrivals are `rootVisits`; the
 *               shell events underneath it are people who clicked through.
 *   `app`     — straight to `/welcome`. Its arrivals are `visits`.
 *   `none`    — the campaign recorded nothing yet.
 */
export type LandingEntry = 'landing' | 'app' | 'none'

export interface CampaignFunnel {
  campaign: string
  entry: LandingEntry
  /**
   * Distinct people the ad delivered, read from whichever counter the entry
   * URL actually populates. Comparing a `/` arm against a `/welcome` arm on
   * the same field is the mistake this exists to prevent: on the `/` arm
   * `visits` counts only the people who already clicked through, so using it
   * as a denominator scores that arm against its own survivors.
   */
  arrivals: number
  rootVisits: number
  visits: number
  /**
   * Reached the first fifth of the entry page, from either entry point.
   *
   * The signal this exists for is the difference between "read the pitch and
   * declined" and "left before the page registered", which arrivals alone
   * cannot tell apart. Read it against `arrivals`, not against `ctaStart`.
   */
  scrolled: number
  /** Chose to begin, from either entry point. */
  ctaStart: number
  registerView: number
  /** Account-creation click: the conversion an ad is buying. */
  registerSubmit: number
  /** `registerSubmit / arrivals`, rounded to four places; null with no arrivals. */
  conversion: number | null
  /**
   * Both entry points are feeding one campaign tag, so the arms cannot be
   * separated. On a `/` arm the shell is reached only by clicking through, so
   * shell arrivals should not exceed the click-throughs by much; when they do,
   * the same tag is almost certainly live on both ad sets. Give each arm its
   * own tag and this clears.
   */
  mixedEntrySuspected: boolean
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return Math.round((numerator / denominator) * 10_000) / 10_000
}

/**
 * Collapse the day/device grid into one row per campaign.
 *
 * The raw rows are the source of truth and stay in the response, but reading an
 * A/B result off them means summing three device classes across N days and then
 * knowing which visit counter belongs to which arm. That is exactly the kind of
 * arithmetic that gets a launch decision made off the wrong number.
 */
export function summarizeCampaigns(rows: readonly LandingDayRow[]): CampaignFunnel[] {
  const byCampaign = new Map<string, CampaignFunnel & { landingView: number }>()

  for (const row of rows) {
    const existing = byCampaign.get(row.campaign)
    const acc = existing ?? {
      campaign: row.campaign,
      entry: 'none' as LandingEntry,
      arrivals: 0,
      rootVisits: 0,
      visits: 0,
      scrolled: 0,
      ctaStart: 0,
      registerView: 0,
      registerSubmit: 0,
      conversion: null,
      mixedEntrySuspected: false,
      landingView: 0,
    }
    if (!existing) byCampaign.set(row.campaign, acc)

    acc.rootVisits += row.rootVisits
    acc.visits += row.visits
    acc.landingView += row.events.landing_view ?? 0
    acc.scrolled += (row.events.root_scroll_1 ?? 0) + (row.events.scroll_1 ?? 0)
    acc.ctaStart += (row.events.root_cta_start ?? 0) + (row.events.cta_start ?? 0)
    acc.registerView += row.events.register_view ?? 0
    acc.registerSubmit += row.events.register_submit ?? 0
  }

  return [...byCampaign.values()]
    .map(({ landingView, ...funnel }) => {
      const rootEntry = funnel.rootVisits > 0
      const entry: LandingEntry = rootEntry ? 'landing' : funnel.visits > 0 ? 'app' : 'none'
      const arrivals = rootEntry ? funnel.rootVisits : funnel.visits
      return {
        ...funnel,
        entry,
        arrivals,
        conversion: rate(funnel.registerSubmit, arrivals),
        // Heuristic, and named as one: a handful of shell views above the
        // click-through count is ordinary noise (a reload, a back-navigation),
        // a multiple of it is two ad sets sharing a tag.
        mixedEntrySuspected: rootEntry && landingView > funnel.ctaStart * 1.5 + 5,
      }
    })
    .sort((a, b) => b.arrivals - a.arrivals)
}
