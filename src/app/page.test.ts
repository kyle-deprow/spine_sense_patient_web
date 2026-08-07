import { readFile } from 'node:fs/promises'

import { describe, expect, it } from 'vitest'

import { campaignQuery } from '@/lib/campaign-query'

import { buildLandingLinks, landingMetadata } from './landing-page-config'

describe('root landing page', () => {
  it('publishes canonical social metadata with a share image', () => {
    expect(landingMetadata.alternates).toEqual({
      canonical: 'https://app.spinesense.ai/',
    })
    expect(landingMetadata.robots).toBeUndefined()
    expect(landingMetadata.openGraph).toMatchObject({
      url: 'https://app.spinesense.ai/',
      images: [{ url: 'https://spinesense.ai/opengraph-image', alt: 'SpineSense' }],
    })
    expect(landingMetadata.twitter).toMatchObject({
      card: 'summary_large_image',
      images: ['https://spinesense.ai/opengraph-image'],
    })
  })

  it('forwards only fixed campaign parameters', () => {
    const query = campaignQuery({
      c: 'paid-01',
      utm_source: 'search',
      utm_medium: 'cpc',
      utm_campaign: 'summer',
      utm_term: 'back pain',
      utm_content: ['hero', 'ignored'],
      token: 'secret-token',
      email: 'patient@example.test',
      arbitrary: 'drop-me',
    })

    expect(query).toBe(
      'c=paid-01&utm_source=search&utm_medium=cpc&utm_campaign=summer&utm_term=back+pain&utm_content=hero',
    )
    expect(query).not.toContain('token')
    expect(query).not.toContain('patient')
    expect(query).not.toContain('arbitrary')
  })

  it('preserves campaign attribution on start and sign-in links', () => {
    expect(buildLandingLinks({ utm_campaign: 'summer', token: 'secret-token' })).toEqual({
      startHref: '/welcome?utm_campaign=summer',
      signInHref: '/login?utm_campaign=summer',
    })
  })

  /**
   * The page copy is pinned at the source level: vitest cannot import the
   * .tsx (Next's `jsx: preserve` tsconfig), and the JSX-to-HTML step is
   * mechanical, so asserting on the source text pins the same thing.
   */
  describe('page copy', () => {
    async function pageSource(): Promise<string> {
      return readFile(new URL('./page.tsx', import.meta.url), 'utf8')
    }

    it('leads with the imaging-and-symptoms value proposition the ads sell', async () => {
      const source = await pageSource()

      expect(source).toContain('See what your symptoms and your MRI report actually describe')
      expect(source).toContain('MRI, CT, or X-ray report')
    })

    it('shows a sample result and answers the free objection at the call to action', async () => {
      const source = await pageSource()

      expect(source).toContain('sample-result.webp')
      expect(source).toContain('shown with sample data')
      expect(source).toContain('no card and nothing to cancel')
    })

    it('gives the MiScribe ads a landing section with the recording disclaimer', async () => {
      const source = await pageSource()

      expect(source).toContain('MiScribe')
      expect(source).toContain('permission before recording')
    })

    it('contains no em dashes anywhere in the copy', async () => {
      expect(await pageSource()).not.toContain('—')
    })

    it('keeps both calls to action wired to campaign-carrying links and analytics events', async () => {
      const source = await pageSource()

      expect(source).toContain('href={startHref}')
      expect(source).toContain('data-root-landing-event="root_cta_start"')
      expect(source).toContain('data-root-landing-event="root_cta_signin"')
    })
  })

  it('bounds campaign values and drops empty or unallowlisted values', () => {
    const query = new URLSearchParams(
      campaignQuery({
        c: 'c'.repeat(40),
        utm_source: `  ${'s'.repeat(140)}  `,
        utm_medium: '   ',
        token: 'secret-token',
      }),
    )

    expect(query.get('c')).toBe('c'.repeat(32))
    expect(query.get('utm_source')).toBe('s'.repeat(128))
    expect(query.has('utm_medium')).toBe(false)
    expect(query.has('token')).toBe(false)
  })
})
