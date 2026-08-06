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
