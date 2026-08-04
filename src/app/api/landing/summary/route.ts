/**
 * Read side of the landing funnel.
 *
 * The counts here are not PHI and identify nobody, but they are commercial
 * data and the endpoint sits on the public internet, so it is gated by a
 * shared token supplied out of band. With no token configured the route does
 * not exist at all — 404, not 401, so an unconfigured deployment does not
 * advertise that there is something here to guess at.
 *
 * Comparison is timing-safe and length-padded: a plain `===` on a secret leaks
 * its length and a prefix oracle to anyone willing to measure.
 */
import { createHash, timingSafeEqual } from 'node:crypto'

import { type NextRequest, NextResponse } from 'next/server'

import { LANDING_EVENTS, readLandingSummary } from '@/lib/server/landing-analytics'

const DEFAULT_DAYS = 7
const MAX_DAYS = 40

function tokenMatches(provided: string, expected: string): boolean {
  // Hashing first makes both sides fixed-length, so the compare cannot leak
  // the secret's length.
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function notFound(): NextResponse {
  return new NextResponse('Not found', {
    status: 404,
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const expected = process.env.LANDING_ANALYTICS_TOKEN?.trim()
  if (!expected) return notFound()

  const provided =
    request.nextUrl.searchParams.get('token') ??
    request.headers.get('x-landing-token') ??
    ''
  if (!provided || !tokenMatches(provided, expected)) return notFound()

  const requestedDays = Number(request.nextUrl.searchParams.get('days') ?? DEFAULT_DAYS)
  const days =
    Number.isFinite(requestedDays) && requestedDays >= 1
      ? Math.min(Math.floor(requestedDays), MAX_DAYS)
      : DEFAULT_DAYS

  const rows = await readLandingSummary(days)

  // Roll up across device classes so the headline funnel reads at a glance;
  // the per-row detail stays available underneath for the mobile-vs-desktop
  // split, which is the question paid social traffic usually raises.
  const totals: Record<string, number> = {}
  let visits = 0
  for (const row of rows) {
    visits += row.visits
    for (const event of LANDING_EVENTS) {
      const count = row.events[event]
      if (count) totals[event] = (totals[event] ?? 0) + count
    }
  }

  return NextResponse.json(
    { days, generatedAt: new Date().toISOString(), visits, totals, rows },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
