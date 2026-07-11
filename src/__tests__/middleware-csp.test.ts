import { describe, expect, it } from 'vitest'
import { buildCspHeader, buildCspHeaderForPath } from '@/middleware'

describe('middleware CSP', () => {
  it('keeps script hardening while allowing Expo runtime styles', () => {
    const csp = buildCspHeader('nonce-value')

    expect(csp).toContain("script-src 'self' 'nonce-nonce-value'")
    expect(csp).toContain("style-src-elem 'self' 'nonce-nonce-value'")
    expect(csp).toContain("worker-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).not.toContain("require-trusted-types-for 'script'")
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

  // P13 James-Tucker batch: styles-only unsafe-inline on the app shell path,
  // scripts stay strictly nonce-gated.
  it('allows runtime style injection on the app shell while keeping scripts nonce-gated', () => {
    const csp = buildCspHeaderForPath('nonce-value', '/login')

    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src-elem 'self' 'unsafe-inline'")
    expect(csp).toContain("style-src-attr 'unsafe-inline'")
    // Browsers ignore 'unsafe-inline' when a nonce shares the directive — the
    // nonce must be absent from every style directive.
    expect(csp).not.toContain("style-src 'self' 'nonce-nonce-value'")
    expect(csp).not.toContain("style-src-elem 'self' 'nonce-nonce-value'")
    // Scripts keep the nonce and never gain unsafe-inline.
    expect(csp).toContain("script-src 'self' 'nonce-nonce-value'")
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'")
  })

  it('keeps the strict nonce-only style policy off the app shell', () => {
    for (const path of ['/api/health', '/_next/some.js']) {
      const csp = buildCspHeaderForPath('nonce-value', path)
      expect(csp).toContain("style-src 'self' 'nonce-nonce-value'")
      expect(csp).toContain("style-src-attr 'none'")
      expect(csp).not.toContain("'unsafe-inline'")
    }
  })
})
