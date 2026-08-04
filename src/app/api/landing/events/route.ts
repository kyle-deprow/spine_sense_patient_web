/**
 * Ingest for anonymous landing-funnel events.
 *
 * Public and unauthenticated by necessity — every event it counts happens
 * before anyone has an account. That shapes the whole handler: it accepts only
 * an allowlisted vocabulary, caps everything it reads, and can create no
 * unbounded state. See `@/lib/server/landing-analytics` for what is and is not
 * stored.
 *
 * It always answers 204, whatever happened. A visitor is not the right party
 * to learn that our measurement store is down, and an error body would give an
 * unauthenticated caller a probe into infrastructure state.
 *
 * `navigator.sendBeacon` is the intended client, which is why the body is read
 * as text and parsed by hand: beacons send `text/plain` unless a Blob type is
 * forced, and rejecting on content-type would silently drop real arrivals.
 */
import { type NextRequest, NextResponse } from 'next/server'

import { validateLandingBeaconOrigin } from '@/lib/auth/route-guards'
import {
  isLandingEvent,
  normalizeCampaign,
  normalizeDeviceClass,
  recordLandingBatch,
  type LandingEvent,
} from '@/lib/server/landing-analytics'

/** Generous for a real page, small enough that a junk body is cheap to reject. */
const MAX_BODY_BYTES = 2_048
const MAX_EVENTS_PER_BATCH = 20
const VISIT_ID_PATTERN = /^[a-zA-Z0-9-]{8,64}$/

function noContent(): NextResponse {
  return new NextResponse(null, {
    status: 204,
    headers: { 'Cache-Control': 'no-store' },
  })
}

interface ParsedBatch {
  visitId: string
  campaign: string
  device: ReturnType<typeof normalizeDeviceClass>
  events: LandingEvent[]
}

function parseBatch(raw: string): ParsedBatch | null {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null

  const record = payload as Record<string, unknown>

  const visitId = record.v
  if (typeof visitId !== 'string' || !VISIT_ID_PATTERN.test(visitId)) return null

  const rawEvents = record.e
  if (!Array.isArray(rawEvents)) return null

  // De-duplicated: a scroll milestone re-crossed on the way back up is the same
  // milestone, and counting it twice would inflate depth against visits.
  const events = [...new Set(rawEvents.filter(isLandingEvent))].slice(0, MAX_EVENTS_PER_BATCH)
  if (events.length === 0) return null

  return {
    visitId,
    campaign: normalizeCampaign(record.c),
    device: normalizeDeviceClass(record.d),
    events,
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Same-origin only. Rejected callers get the guard's 403 rather than the 204
  // below: a cross-origin caller is not a visitor whose experience we protect.
  const originFailure = validateLandingBeaconOrigin(request)
  if (originFailure !== null) return originFailure

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return noContent()
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return noContent()

  const batch = parseBatch(raw)
  if (batch === null) return noContent()

  await recordLandingBatch(batch)
  return noContent()
}
