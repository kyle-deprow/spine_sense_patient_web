import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import {
  CLIENT_RATE_LIMIT_SCOPES,
  checkCredentialRateLimit,
  clearRateLimitStore,
  getClientRateLimitKey,
  rateLimit,
  shouldBypassRateLimit,
} from '@/lib/server/rate-limit'

const FRONT_DOOR_ID = '12345678-1234-1234-1234-123456789abc'

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://patient.example.test/api/auth/login', {
    headers,
  })
}

function useAzureMode(secret = 'rate-limit-test-csrf-secret-at-least-32-bytes'): void {
  vi.stubEnv('ENVIRONMENT', 'production')
  vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'azure-front-door')
  vi.stubEnv('AZURE_FRONT_DOOR_ID', FRONT_DOOR_ID)
  vi.stubEnv('PATIENT_WEB_CSRF_SECRET', secret)
}

describe('rate limiting', () => {
  beforeEach(() => {
    vi.stubEnv('ENVIRONMENT', 'test')
    vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'single-bucket')
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'rate-limit-test-csrf-secret-at-least-32-bytes')
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', 'https://patient.example.test')
    vi.stubEnv('PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY_ID', 'test-current')
    vi.stubEnv(
      'PATIENT_WEB_AUDIT_ACTOR_SIGNING_CURRENT_KEY',
      'patient-web-test-actor-signing-key-32-bytes',
    )
  })

  afterEach(() => {
    clearRateLimitStore()
    vi.unstubAllEnvs()
  })

  it('enforces the in-memory sliding window by default', () => {
    expect(rateLimit('default-rate-limit-test', { limit: 1, windowMs: 60_000 })).toBe(true)
    expect(rateLimit('default-rate-limit-test', { limit: 1, windowMs: 60_000 })).toBe(false)
  })

  it('supports an opt-in non-production E2E bypass', () => {
    vi.stubEnv('PATIENT_WEB_E2E_BYPASS_RATE_LIMITS', 'true')

    expect(rateLimit('e2e-rate-limit-test', { limit: 0, windowMs: 60_000 })).toBe(true)
  })

  it('supports the E2E bypass in local production-mode standalone builds', () => {
    expect(shouldBypassRateLimit('true', 'local', 'single-bucket')).toBe(true)
  })

  it('rejects the E2E bypass in hosted or trusted-header modes', () => {
    expect(() => shouldBypassRateLimit('true', 'production', 'azure-front-door')).toThrow(
      'requires an explicit local single-bucket environment',
    )
    expect(() => shouldBypassRateLimit('true', 'local', 'azure-front-door')).toThrow()
  })

  it('can clear the in-memory state for gated E2E resets', () => {
    expect(rateLimit('reset-rate-limit-test', { limit: 1, windowMs: 60_000 })).toBe(true)
    expect(rateLimit('reset-rate-limit-test', { limit: 1, windowMs: 60_000 })).toBe(false)

    clearRateLimitStore()

    expect(rateLimit('reset-rate-limit-test', { limit: 1, windowMs: 60_000 })).toBe(true)
  })

  it('ignores spoofable forwarding headers in local single-bucket mode', () => {
    const first = getClientRateLimitKey(
      request({
        'x-forwarded-for': '198.51.100.1, 203.0.113.2',
        'x-real-ip': '198.51.100.3',
        'x-azure-clientip': '198.51.100.4',
        'x-azure-socketip': '198.51.100.5',
        'x-azure-fdid': FRONT_DOOR_ID,
      }),
      'auth.login',
    )
    const second = getClientRateLimitKey(request(), 'auth.login')

    expect(first).toBe(second)
    expect(first).toMatch(/^rl:v1:[A-Za-z0-9_-]{43}$/)
    expect(first).not.toContain('198.51.100')
  })

  it('requires exact FDID and one valid SocketIP while ignoring spoofable headers', () => {
    useAzureMode()
    const trustedHeaders = {
      'x-azure-fdid': FRONT_DOOR_ID,
      'x-azure-socketip': '203.0.113.10',
    }
    const baseline = getClientRateLimitKey(request(trustedHeaders), 'auth.login')
    const spoofed = getClientRateLimitKey(
      request({
        ...trustedHeaders,
        'x-forwarded-for': '192.0.2.1, 192.0.2.2',
        'x-real-ip': '192.0.2.3',
        'x-azure-clientip': '192.0.2.4',
      }),
      'auth.login',
    )

    expect(spoofed).toBe(baseline)
    expect(baseline).not.toContain('203.0.113.10')
  })

  it('normalizes equivalent IPv6 forms and separates fixed scopes', () => {
    useAzureMode()
    const expanded = request({
      'x-azure-fdid': FRONT_DOOR_ID,
      'x-azure-socketip': '2001:0db8:0000:0000:0000:0000:0000:0001',
    })
    const compressed = request({
      'x-azure-fdid': FRONT_DOOR_ID,
      'x-azure-socketip': '2001:db8::1',
    })

    expect(getClientRateLimitKey(expanded, 'auth.login')).toBe(
      getClientRateLimitKey(compressed, 'auth.login'),
    )
    expect(getClientRateLimitKey(compressed, 'auth.login')).not.toBe(
      getClientRateLimitKey(compressed, 'auth.register'),
    )
  })

  it('keeps every inventoried credential scope in an independent opaque bucket', () => {
    const req = request({
      'x-forwarded-for': '198.51.100.1',
      'x-real-ip': '198.51.100.2',
      'x-azure-clientip': '198.51.100.3',
    })
    const keys = CLIENT_RATE_LIMIT_SCOPES.map((scope) => getClientRateLimitKey(req, scope))

    expect(keys).toHaveLength(8)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys.every((key) => key?.startsWith('rl:v1:'))).toBe(true)
  })

  it.each([
    [{ 'x-azure-socketip': '203.0.113.10' }, 'missing FDID'],
    [
      {
        'x-azure-fdid': `${FRONT_DOOR_ID},${FRONT_DOOR_ID}`,
        'x-azure-socketip': '203.0.113.10',
      },
      'duplicate FDID',
    ],
    [{ 'x-azure-fdid': 'not-a-uuid', 'x-azure-socketip': '203.0.113.10' }, 'malformed FDID'],
    [
      {
        'x-azure-fdid': 'aaaaaaaa-1234-1234-1234-123456789abc',
        'x-azure-socketip': '203.0.113.10',
      },
      'wrong FDID',
    ],
    [{ 'x-azure-fdid': FRONT_DOOR_ID }, 'missing SocketIP'],
    [
      {
        'x-azure-fdid': FRONT_DOOR_ID,
        'x-azure-socketip': '203.0.113.10, 203.0.113.11',
      },
      'duplicate SocketIP',
    ],
    [{ 'x-azure-fdid': FRONT_DOOR_ID, 'x-azure-socketip': 'not-an-ip' }, 'malformed SocketIP'],
  ] as const)('fails closed for %s (%s)', (headers, _label) => {
    useAzureMode()
    expect(getClientRateLimitKey(request(headers), 'auth.login')).toBeNull()
  })

  it('resets opaque buckets when the CSRF secret rotates', () => {
    useAzureMode('first-rate-limit-secret-at-least-thirty-two-bytes')
    const req = request({
      'x-azure-fdid': FRONT_DOOR_ID,
      'x-azure-socketip': '203.0.113.10',
    })
    const first = getClientRateLimitKey(req, 'auth.login')
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'second-rate-limit-secret-at-least-thirty-two-bytes')
    expect(getClientRateLimitKey(req, 'auth.login')).not.toBe(first)
  })

  it('returns unavailable without reading address headers in unavailable mode', () => {
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'unavailable')
    expect(
      checkCredentialRateLimit(
        request({
          'x-forwarded-for': '198.51.100.1',
          'x-real-ip': '198.51.100.2',
          'x-azure-clientip': '198.51.100.3',
          'x-azure-socketip': '198.51.100.4',
        }),
        'auth.login',
        { limit: 1, windowMs: 60_000 },
      ),
    ).toBe('client_ip_unavailable')
  })
})
