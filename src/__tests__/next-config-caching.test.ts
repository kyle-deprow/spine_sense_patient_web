import { describe, expect, it } from 'vitest'

import nextConfig from '../../next.config'

/**
 * The blanket `no-store` exists for PHI-bearing responses. Next's own build
 * assets under /_next/static are content-hashed, carry no PHI, and re-download
 * on every visit when no-store reaches them. Header sources are applied in
 * order and the last matching key wins, so the immutable rule must come after
 * the global rule.
 */

async function headerRules() {
  if (nextConfig.headers === undefined) throw new Error('next config defines no headers()')
  return nextConfig.headers()
}

describe('next config caching headers', () => {
  it('keeps the global no-store rule for the app surface', async () => {
    const rules = await headerRules()
    const globalRule = rules.find((rule) => rule.source === '/(.*)')

    expect(globalRule?.headers).toContainEqual({ key: 'Cache-Control', value: 'no-store' })
  })

  it('overrides no-store with immutable caching for content-hashed build assets', async () => {
    const rules = await headerRules()
    const staticRuleIndex = rules.findIndex((rule) => rule.source === '/_next/static/:path*')
    const globalRuleIndex = rules.findIndex((rule) => rule.source === '/(.*)')

    expect(staticRuleIndex).toBeGreaterThan(globalRuleIndex)
    expect(rules[staticRuleIndex]?.headers).toEqual([
      { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
    ])
  })
})
