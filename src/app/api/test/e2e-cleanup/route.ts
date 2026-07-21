import { timingSafeEqual } from 'node:crypto'

import type { NextRequest } from 'next/server'

import { clearRateLimitStore } from '@/lib/server/rate-limit'
import { jsonNoStore } from '@/lib/server/responses'

function isLocalEnvironment(): boolean {
  return process.env.NODE_ENV !== 'production'
}

function testSupportEnabled(): boolean {
  return process.env.PATIENT_WEB_TEST_SUPPORT_ENABLED === 'true'
}

function testSupportToken(): string {
  return process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN ?? ''
}

function hasTokenAccess(request: NextRequest): boolean {
  const expectedToken = testSupportToken()
  if (!expectedToken) return false

  const authorization = request.headers.get('authorization') ?? ''
  const [scheme, token] = authorization.split(/\s+/, 2)
  if (scheme?.toLowerCase() !== 'bearer' || !token) return false

  const expected = Buffer.from(expectedToken)
  const actual = Buffer.from(token)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

function hasCleanupAccess(request: NextRequest): boolean {
  if (isLocalEnvironment()) return true
  if (!testSupportEnabled()) return false
  return hasTokenAccess(request)
}

export async function POST(request: NextRequest) {
  if (!hasCleanupAccess(request)) {
    return jsonNoStore({ detail: 'Not found' }, { status: 404 })
  }

  try {
    await clearRateLimitStore()
    return jsonNoStore({ status: 'cleanup_complete' })
  } catch {
    return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
  }
}
