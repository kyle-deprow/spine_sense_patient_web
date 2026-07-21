import { createHash, timingSafeEqual } from 'node:crypto'

import type { NextRequest } from 'next/server'

import { clearRateLimitStore } from '@/lib/server/rate-limit'
import { jsonNoStore } from '@/lib/server/responses'

const TEST_SUPPORT_ENVIRONMENTS = new Set([
  'local',
  'development',
  'dev',
  'test',
  'e2e',
  'staging',
  'production',
  'prod',
])

function hasExplicitEnvironment(): boolean {
  return TEST_SUPPORT_ENVIRONMENTS.has(process.env.ENVIRONMENT?.trim() ?? '')
}

function testSupportEnabled(): boolean {
  return process.env.PATIENT_WEB_TEST_SUPPORT_ENABLED === 'true'
}

function testSupportToken(): string {
  return process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN ?? ''
}

function hasTokenAccess(request: NextRequest): boolean {
  const expectedToken = testSupportToken()
  if (Buffer.byteLength(expectedToken, 'utf8') < 32) return false

  const authorization = request.headers.get('authorization') ?? ''
  const match = /^Bearer[\t ]+(\S+)$/i.exec(authorization)
  const token = match?.[1]
  if (!token) return false

  const expected = createHash('sha256').update(expectedToken, 'utf8').digest()
  const actual = createHash('sha256').update(token, 'utf8').digest()
  return timingSafeEqual(expected, actual)
}

function hasCleanupAccess(request: NextRequest): boolean {
  if (!hasExplicitEnvironment()) return false
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
