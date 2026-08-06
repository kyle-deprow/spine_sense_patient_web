import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { NextRequest } from 'next/server'

import { clearLandingAnalytics, recordLandingBatch } from '@/lib/server/landing-analytics'

import { GET } from './route'

beforeEach(async () => {
  vi.stubEnv('REDIS_URL', '')
  vi.stubEnv('LANDING_ANALYTICS_TOKEN', 'summary-test-token')
  await clearLandingAnalytics()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('landing analytics summary', () => {
  it('reports shell and root distinct visits independently', async () => {
    await recordLandingBatch({
      visitId: 'root-visit-aaaaaaaa',
      campaign: 'rd-01',
      device: 'phone',
      events: ['root_view', 'root_cta_start'],
    })
    await recordLandingBatch({
      visitId: 'shell-visit-bbbbbbbb',
      campaign: 'rd-01',
      device: 'desktop',
      events: ['landing_view', 'cta_start'],
    })

    const response = await GET(
      new NextRequest('https://patient.example.test/api/landing/summary', {
        headers: { 'x-landing-token': 'summary-test-token' },
      }),
    )
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.visits).toBe(1)
    expect(body.rootVisits).toBe(1)
    expect(body.totals).toMatchObject({
      root_view: 1,
      root_cta_start: 1,
      landing_view: 1,
      cta_start: 1,
    })
    expect(body.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ device: 'phone', visits: 0, rootVisits: 1 }),
        expect.objectContaining({ device: 'desktop', visits: 1, rootVisits: 0 }),
      ]),
    )
  })
})
