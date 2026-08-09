import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import {
  clearLandingAnalytics,
  isLandingEvent,
  type LandingDayRow,
  normalizeCampaign,
  normalizeDeviceClass,
  readLandingSummary,
  recordLandingBatch,
  summarizeCampaigns,
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
    expect(isLandingEvent('root_view')).toBe(true)
    expect(isLandingEvent('root_cta_start')).toBe(true)
    expect(isLandingEvent('root_cta_signin')).toBe(true)
    expect(isLandingEvent('landing_view')).toBe(true)
    expect(isLandingEvent('consent_deadend')).toBe(true)
  })

  it('rejects anything else, so an unauthenticated caller cannot mint keys', () => {
    expect(isLandingEvent('arbitrary_key')).toBe(false)
    expect(isLandingEvent(42)).toBe(false)
  })

  it('admits root scroll depth, which the `/` tracker emits', () => {
    expect(isLandingEvent('root_scroll_1')).toBe(true)
    expect(isLandingEvent('root_scroll_5')).toBe(true)
    expect(isLandingEvent('root_scroll_6')).toBe(false)
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
    expect(row?.rootVisits).toBe(0)
    expect(row?.events.consent_shown).toBe(2)
    expect(row?.events.cta_start).toBe(1)
    expect(row?.events.consent_decline).toBe(1)
  })

  it('keeps root-page events separate from existing shell funnel events', async () => {
    await recordLandingBatch({
      visitId: 'visit-root-page',
      campaign: 'rd-01',
      device: 'phone',
      events: ['root_view', 'root_cta_start'],
    })

    const row = (await readLandingSummary(1)).find((r) => r.campaign === 'rd-01')
    expect(row?.events.root_view).toBe(1)
    expect(row?.events.root_cta_start).toBe(1)
    expect(row?.visits).toBe(0)
    expect(row?.rootVisits).toBe(1)
    expect(row?.events.landing_view).toBeUndefined()
    expect(row?.events.cta_start).toBeUndefined()
  })

  it('counts a scroll-depth beacon as a root arrival, never as a shell visit', async () => {
    // The tracker batches depth marks into their own beacon, so this arrives
    // with no `root_view` beside it. Classified as a shell event it would
    // inflate `visits`, which is the `/` arm's click-through counter, and the
    // arm would appear to convert people it never sent anywhere.
    await recordLandingBatch({
      visitId: 'visit-scroller',
      campaign: 'rd-02',
      device: 'phone',
      events: ['root_scroll_1', 'root_scroll_2'],
    })

    const row = (await readLandingSummary(1)).find((r) => r.campaign === 'rd-02')
    expect(row?.events.root_scroll_1).toBe(1)
    expect(row?.events.root_scroll_2).toBe(1)
    expect(row?.rootVisits).toBe(1)
    expect(row?.visits).toBe(0)
  })

  it('keeps shell and root distinct visits independent across a click-through', async () => {
    await recordLandingBatch({
      visitId: 'root-visit-aaaaaaaa',
      campaign: 'rd-03',
      device: 'desktop',
      events: ['root_view', 'root_cta_start'],
    })
    await recordLandingBatch({
      visitId: 'shell-visit-bbbbbbbb',
      campaign: 'rd-03',
      device: 'desktop',
      events: ['landing_view'],
    })

    const row = (await readLandingSummary(1)).find((r) => r.campaign === 'rd-03')
    expect(row?.visits).toBe(1)
    expect(row?.rootVisits).toBe(1)
  })

  it('classifies an adversarially mixed batch into both funnels', async () => {
    await recordLandingBatch({
      visitId: 'mixed-visit-aaaaaaaa',
      campaign: 'rd-04',
      device: 'desktop',
      events: ['root_view', 'landing_view'],
    })

    const row = (await readLandingSummary(1)).find((r) => r.campaign === 'rd-04')
    expect(row?.visits).toBe(1)
    expect(row?.rootVisits).toBe(1)
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
    expect(row?.rootVisits).toBe(0)
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

/**
 * The A/B test this exists for: one ad set points at `/`, another at
 * `/welcome`, and the winner decides where paid traffic lands. The two entry
 * points populate different visit counters, so a rollup that reads the same
 * field for both scores the `/` arm against the people who already clicked
 * through rather than against everyone the ad delivered.
 */
describe('campaign rollup for the entry-point A/B test', () => {
  const day = '2026-08-09'

  /** 100 land on `/`, 40 click through, 30 reach the form, 20 create an account. */
  const landingArm: LandingDayRow = {
    day,
    campaign: 'rd-landing',
    device: 'phone',
    rootVisits: 100,
    visits: 40,
    events: {
      root_view: 100,
      root_scroll_1: 55,
      root_scroll_5: 12,
      root_cta_start: 40,
      landing_view: 40,
      cta_start: 38,
      register_view: 30,
      register_submit: 20,
    },
  }

  /** 100 land straight on `/welcome`, 30 reach the form, 15 create an account. */
  const appArm: LandingDayRow = {
    day,
    campaign: 'rd-app',
    device: 'phone',
    rootVisits: 0,
    visits: 100,
    events: {
      landing_view: 100,
      scroll_1: 62,
      cta_start: 45,
      register_view: 30,
      register_submit: 15,
    },
  }

  it('reports depth from whichever entry page the arm actually served', () => {
    // The signal is "did they engage with the pitch", and each arm records it
    // under its own event name, so the rollup has to read both to be
    // comparable across arms.
    expect(summarizeCampaigns([landingArm]).at(0)?.scrolled).toBe(55)
    expect(summarizeCampaigns([appArm]).at(0)?.scrolled).toBe(62)
  })

  it('separates a bounce from a considered rejection', () => {
    const bounced: LandingDayRow = {
      day,
      campaign: 'rd-bounce',
      device: 'phone',
      rootVisits: 24,
      visits: 0,
      events: { root_view: 24 },
    }

    const [row] = summarizeCampaigns([bounced])
    expect(row?.arrivals).toBe(24)
    expect(row?.scrolled).toBe(0)
    expect(row?.ctaStart).toBe(0)
  })

  it('counts arrivals from the counter the arm actually populates', () => {
    const [landing, app] = [
      summarizeCampaigns([landingArm]).at(0),
      summarizeCampaigns([appArm]).at(0),
    ]

    expect(landing?.entry).toBe('landing')
    expect(landing?.arrivals).toBe(100)
    expect(app?.entry).toBe('app')
    expect(app?.arrivals).toBe(100)
  })

  it('scores both arms on signups against everyone the ad delivered', () => {
    const rollup = summarizeCampaigns([landingArm, appArm])

    expect(rollup.find((c) => c.campaign === 'rd-landing')?.conversion).toBe(0.2)
    expect(rollup.find((c) => c.campaign === 'rd-app')?.conversion).toBe(0.15)
  })

  it('sums a campaign across days and device classes', () => {
    const rollup = summarizeCampaigns([
      landingArm,
      { ...landingArm, day: '2026-08-08', device: 'desktop', rootVisits: 20 },
    ])

    expect(rollup).toHaveLength(1)
    expect(rollup[0]?.arrivals).toBe(120)
    expect(rollup[0]?.registerSubmit).toBe(40)
  })

  it('adds up both entry points’ start clicks under one `ctaStart`', () => {
    expect(summarizeCampaigns([landingArm]).at(0)?.ctaStart).toBe(78)
  })

  it('flags a tag serving both arms, whose numbers cannot be split', () => {
    expect(summarizeCampaigns([landingArm]).at(0)?.mixedEntrySuspected).toBe(false)

    const shared: LandingDayRow = {
      ...landingArm,
      visits: 300,
      events: { ...landingArm.events, landing_view: 300 },
    }
    expect(summarizeCampaigns([shared]).at(0)?.mixedEntrySuspected).toBe(true)
  })

  it('reports no conversion rate rather than a zero for a campaign with no arrivals', () => {
    const empty: LandingDayRow = {
      day,
      campaign: 'rd-dead',
      device: 'phone',
      rootVisits: 0,
      visits: 0,
      events: {},
    }
    const [row] = summarizeCampaigns([empty])

    expect(row?.entry).toBe('none')
    expect(row?.conversion).toBeNull()
  })

  it('ranks campaigns by arrivals so the biggest spend reads first', () => {
    const small: LandingDayRow = { ...appArm, campaign: 'rd-small', visits: 5 }

    expect(summarizeCampaigns([small, appArm]).map((c) => c.campaign)).toEqual([
      'rd-app',
      'rd-small',
    ])
  })
})

describe('day bucketing', () => {
  it('buckets by UTC so campaign days line up across time zones', () => {
    expect(utcDay(new Date('2026-08-03T23:59:00Z'))).toBe('2026-08-03')
    expect(utcDay(new Date('2026-08-04T00:01:00Z'))).toBe('2026-08-04')
  })
})
