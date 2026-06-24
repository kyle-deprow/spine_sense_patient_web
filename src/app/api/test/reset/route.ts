import { timingSafeEqual } from 'node:crypto'

import type { NextRequest } from 'next/server'

import { clearRateLimitStore } from '@/lib/server/rate-limit'
import { jsonNoStore } from '@/lib/server/responses'

function isLocalEnvironment(): boolean {
  return process.env.NODE_ENV !== 'production'
}

function hasTokenAccess(request: NextRequest): boolean {
  const expectedToken = process.env.PATIENT_WEB_E2E_TEST_SUPPORT_TOKEN
  if (!expectedToken) return false

  const authorization = request.headers.get('authorization') ?? ''
  const [scheme, token] = authorization.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'bearer' || !token) return false

  const expected = Buffer.from(expectedToken)
  const actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function hasResetAccess(request: NextRequest): boolean {
  if (isLocalEnvironment()) return true
  if (process.env.PATIENT_WEB_E2E_TEST_SUPPORT_ENABLED !== 'true') return false
  return hasTokenAccess(request)
}

export async function POST(request: NextRequest) {
  if (!hasResetAccess(request)) {
    return jsonNoStore({ detail: 'Not found' }, { status: 404 })
  }

  clearRateLimitStore()
  return jsonNoStore({ status: 'reset_complete' })
}
