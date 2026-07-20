import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { resetFrontDoorOriginAuditWindowForTests } from '@/lib/front-door-origin-guard'
import { buildCspHeader, buildCspHeaderForPath, middleware } from '@/middleware'

const FRONT_DOOR_ID = '12345678-1234-1234-1234-123456789abc'

describe('middleware CSP', () => {
  beforeEach(() => {
    resetFrontDoorOriginAuditWindowForTests()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps script hardening while allowing Expo runtime styles', () => {
    const csp = buildCspHeader('nonce-value')

    expect(csp).toContain("script-src 'self' 'nonce-nonce-value'")
    expect(csp).toContain("style-src-elem 'self' 'nonce-nonce-value'")
    expect(csp).toContain("worker-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain("require-trusted-types-for 'script'")
  })

  it('uses exact storage connect sources from NEXT_PUBLIC_STORAGE_DOMAINS', () => {
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'production')
    vi.stubEnv(
      'NEXT_PUBLIC_STORAGE_DOMAINS',
      'https://storage.example.test https://cdn.example.test:8443',
    )

    const csp = buildCspHeader('nonce-value')

    expect(csp).toContain(
      "connect-src 'self' blob: https://storage.example.test https://cdn.example.test:8443",
    )
    expect(csp).not.toContain('https://*.storage.example.test')
    expect(csp).not.toContain('https://storage.example.test/')
  })

  it('can require Trusted Types on routes that do not serve the Expo app shell', () => {
    const csp = buildCspHeader('nonce-value', { requireTrustedTypes: true })

    expect(csp).toContain("require-trusted-types-for 'script'")
  })

  it('does not require Trusted Types on Expo app shell routes', () => {
    expect(buildCspHeaderForPath('nonce-value', '/login')).not.toContain(
      "require-trusted-types-for 'script'",
    )
    expect(buildCspHeaderForPath('nonce-value', '/login.html')).not.toContain(
      "require-trusted-types-for 'script'",
    )
  })

  it('retains Trusted Types on API routes', () => {
    expect(buildCspHeaderForPath('nonce-value', '/api/health')).toContain(
      "require-trusted-types-for 'script'",
    )
  })

  it.each([
    '/api/health',
    '/_next/static/chunks/app.js',
    '/_next/image',
    '/favicon.ico',
    '/robots.txt',
    '/login',
  ])('enforces the Front Door guard before handling %s', (pathname) => {
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', 'enforce')
    vi.stubEnv('AZURE_FRONT_DOOR_ID', FRONT_DOOR_ID)

    const response = middleware(new NextRequest(`https://patient.example.test${pathname}`))

    expect(response.status).toBe(403)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-security-policy')).toBeNull()
  })

  it('allows the health route only with the exact Front Door ID in enforce mode', () => {
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', 'enforce')
    vi.stubEnv('AZURE_FRONT_DOOR_ID', FRONT_DOOR_ID)

    const response = middleware(
      new NextRequest('https://patient.example.test/api/health', {
        headers: { 'x-azure-fdid': FRONT_DOOR_ID },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('audits and continues through CSP processing for a rejected shell request', () => {
    vi.stubEnv('ENVIRONMENT', 'staging')
    vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', 'audit')
    vi.stubEnv('AZURE_FRONT_DOOR_ID', FRONT_DOOR_ID)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = middleware(
      new NextRequest('https://patient.example.test/login?patient=secret'),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(warn).toHaveBeenCalledWith({
      event: 'security.front_door_origin.rejected',
      app: 'patient-web',
      reason: 'missing',
      mode: 'audit',
      environment: 'staging',
    })
    warn.mockRestore()
  })

  it.each(['/_next/static/chunks/app.js', '/_next/image', '/favicon.ico', '/robots.txt'])(
    'preserves the prior security-header bypass for %s after the guard passes',
    (pathname) => {
      vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', 'off')

      const response = middleware(new NextRequest(`https://patient.example.test${pathname}`))

      expect(response.status).toBe(200)
      expect(response.headers.get('content-security-policy')).toBeNull()
    },
  )

  it('does not inspect or log the Front Door header when the guard is off', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ENVIRONMENT', '')
    vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', '')
    vi.stubEnv('AZURE_FRONT_DOOR_ID', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const response = middleware(new NextRequest('https://localhost/login'))

    expect(response.status).toBe(200)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
