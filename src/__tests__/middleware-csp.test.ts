import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCspHeader, buildCspHeaderForPath } from '@/middleware'

describe('middleware CSP', () => {
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
    vi.stubEnv('NEXT_PUBLIC_STORAGE_DOMAINS', 'https://storage.example.test https://cdn.example.test:8443')

    const csp = buildCspHeader('nonce-value')

    expect(csp).toContain("connect-src 'self' https://storage.example.test https://cdn.example.test:8443")
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
})
