import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  clearLandingAnalytics,
  isLandingEvent,
  normalizeCampaign,
  normalizeDeviceClass,
  readLandingSummary,
  recordLandingBatch,
  utcDay,
} from '@/lib/server/landing-analytics'

// No REDIS_URL -> the in-process store, which is what these assert against.
beforeEach(async () => {
  vi.stubEnv('REDIS_URL', '')
  await clearLandingAnalytics()
})

describe('campaign normalization', () => {
  it('accepts an ad tag and lowercases it', () => {
    expect(normalizeCampaign('RD-01')).toBe('rd-01')
  })

  it('falls back to `none` rather than rejecting, so a mistyped tag still counts as an arrival', () => {
    expect(normalizeCampaign('rd 01; DROP')).toBe('none')
    expect(normalizeCampaign(undefined)).toBe('none')
    expect(normalizeCampaign('x'.repeat(33))).toBe('none')
  })
})

describe('event allowlist', () => {
  it('admits known funnel events', () => {
    expect(isLandingEvent('landing_view')).toBe(true)
    expect(isLandingEvent('consent_deadend')).toBe(true)
  })

  it('rejects anything else, so an unauthenticated caller cannot mint keys', () => {
    expect(isLandingEvent('arbitrary_key')).toBe(false)
    expect(isLandingEvent(42)).toBe(false)
  })
})

describe('device class', () => {
  it('defaults unknown values to desktop instead of throwing', () => {
    expect(normalizeDeviceClass('phone')).toBe('phone')
    expect(normalizeDeviceClass('watch')).toBe('desktop')
  })
})

describe('recording and reading the funnel', () => {
  it('counts events and distinct visits for a campaign', async () => {
    await recordLandingBatch({
      visitId: 'visit-aaaaaaaa',
      campaign: 'rd-01',
      device: 'phone',
      events: ['landing_view', 'consent_shown', 'consent_accept', 'cta_start'],
    })
    await recordLandingBatch({
      visitId: 'visit-bbbbbbbb',
      campaign: 'rd-01',
      device: 'phone',
      events: ['landing_view', 'consent_shown', 'consent_decline'],
    })

    const rows = await readLandingSummary(1)
    const row = rows.find((r) => r.campaign === 'rd-01')

    expect(row).toBeDefined()
    expect(row?.visits).toBe(2)
    expect(row?.events.landing_view).toBe(2)
    expect(row?.events.consent_shown).toBe(2)
    expect(row?.events.cta_start).toBe(1)
    expect(row?.events.consent_decline).toBe(1)
  })

  it('counts one visitor once, however many batches that tab sends', async () => {
    const visitId = 'visit-cccccccc'
    await recordLandingBatch({
      visitId,
      campaign: 'rd-02',
      device: 'phone',
      events: ['landing_view'],
    })
    await recordLandingBatch({ visitId, campaign: 'rd-02', device: 'phone', events: ['cta_start'] })

    const row = (await readLandingSummary(1)).find((r) => r.campaign === 'rd-02')
    expect(row?.visits).toBe(1)
  })

  it('keeps campaigns separate so per-ad performance is readable', async () => {
    await recordLandingBatch({
      visitId: 'visit-dddddddd',
      campaign: 'rd-01',
      device: 'phone',
      events: ['landing_view'],
    })
    await recordLandingBatch({
      visitId: 'visit-eeeeeeee',
      campaign: 'rd-09',
      device: 'desktop',
      events: ['landing_view'],
    })

    const rows = await readLandingSummary(1)
    expect(rows.find((r) => r.campaign === 'rd-01')?.visits).toBe(1)
    expect(rows.find((r) => r.campaign === 'rd-09')?.visits).toBe(1)
  })

  it('records untagged organic traffic under `none` so it can be compared to paid', async () => {
    await recordLandingBatch({
      visitId: 'visit-ffffffff',
      campaign: normalizeCampaign(null),
      device: 'desktop',
      events: ['landing_view'],
    })
    expect((await readLandingSummary(1)).find((r) => r.campaign === 'none')?.visits).toBe(1)
  })

  it('is a no-op for an empty batch', async () => {
    await recordLandingBatch({
      visitId: 'visit-gggggggg',
      campaign: 'rd-01',
      device: 'phone',
      events: [],
    })
    expect(await readLandingSummary(1)).toHaveLength(0)
  })
})

describe('day bucketing', () => {
  it('buckets by UTC so campaign days line up across time zones', () => {
    expect(utcDay(new Date('2026-08-03T23:59:00Z'))).toBe('2026-08-03')
    expect(utcDay(new Date('2026-08-04T00:01:00Z'))).toBe('2026-08-04')
  })
})
