import type { NextRequest } from 'next/server'
import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { validateUnsafeRequest } from '@/lib/auth/csrf'
import { getPatientWebConfig } from '@/lib/server/config'
import { configurationUnavailableResponse, csrfFailureResponse } from '@/lib/server/responses'

export function validatePatientWebConfiguration() {
  try {
    getPatientWebConfig()
    return null
  } catch {
    return configurationUnavailableResponse()
  }
}

/**
 * Same-origin guard for the anonymous landing beacon.
 *
 * The landing endpoint cannot use `validateAuthMutation`: it is called by
 * `navigator.sendBeacon`, which cannot set the CSRF header, and — verified
 * against a real browser — sends **no `Origin` header at all** on a same-origin
 * POST. Requiring either would reject every genuine arrival and leave the
 * funnel silently empty, which is worse than the risk being defended against.
 *
 * So this accepts a request whose `Origin` **or** `Referer` resolves to a
 * configured origin. There is no session, no PHI and no stored state behind
 * this endpoint — the only thing an attacker gains is inflated marketing
 * counters — so a proportionate same-origin check is the right control rather
 * than full CSRF.
 *
 * Returns null when allowed, mirroring the other guards in this module.
 */
export function validateLandingBeaconOrigin(request: NextRequest) {
  let config
  try {
    config = getPatientWebConfig()
  } catch {
    return configurationUnavailableResponse()
  }

  const allowed = new Set(config.allowedOrigins)
  if (allowed.size === 0) return csrfFailureResponse(403, 'origin_forbidden')

  const origin = request.headers.get('origin')
  if (origin && allowed.has(origin)) return null

  const referer = request.headers.get('referer')
  if (referer) {
    try {
      if (allowed.has(new URL(referer).origin)) return null
    } catch {
      return csrfFailureResponse(403, 'referer_forbidden')
    }
  }

  return csrfFailureResponse(403, 'origin_forbidden')
}

export function validateAuthMutation(request: NextRequest) {
  let config
  try {
    config = getPatientWebConfig()
  } catch {
    return configurationUnavailableResponse()
  }
  const validation = validateUnsafeRequest(request, request.cookies.get(COOKIE_NAMES.csrf)?.value, {
    csrfSecret: config.csrfSecret,
    allowedOrigins: config.allowedOrigins,
  })

  if (!validation.ok) {
    return csrfFailureResponse(validation.status, validation.code)
  }

  return null
}
