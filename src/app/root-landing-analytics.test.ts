import { describe, expect, it } from 'vitest'

import { campaignQuery, selectLandingCampaign } from '@/lib/campaign-query'

describe('root landing analytics campaign selection', () => {
  it('matches shell precedence: c, then utm_content, then utm_campaign', () => {
    expect(
      selectLandingCampaign(
        new URLSearchParams('c=direct&utm_content=creative&utm_campaign=campaign'),
      ),
    ).toBe('direct')
    expect(
      selectLandingCampaign(new URLSearchParams('utm_content=creative&utm_campaign=campaign')),
    ).toBe('creative')
    expect(selectLandingCampaign(new URLSearchParams('utm_campaign=campaign'))).toBe('campaign')
  })

  it('does not use arbitrary or token-like query parameters', () => {
    expect(
      selectLandingCampaign(new URLSearchParams('token=secret&campaign=not-allowlisted')),
    ).toBe('')
  })

  it.each(['', '   '])('falls through a blank c value (%j)', (c) => {
    expect(
      selectLandingCampaign(
        new URLSearchParams({ c, utm_content: ' creative ', utm_campaign: 'campaign' }),
      ),
    ).toBe('creative')
  })

  it('falls through blank c and utm_content values to utm_campaign', () => {
    expect(
      selectLandingCampaign(
        new URLSearchParams({ c: ' ', utm_content: '  ', utm_campaign: ' campaign ' }),
      ),
    ).toBe('campaign')
  })

  it('uses the same trim and bounds as the forwarded shell query', () => {
    const source = {
      c: `  ${'c'.repeat(40)}  `,
      utm_content: `  ${'u'.repeat(140)}  `,
      utm_campaign: `  ${'m'.repeat(140)}  `,
    }
    const forwarded = new URLSearchParams(campaignQuery(source))

    expect(selectLandingCampaign(new URLSearchParams(source))).toBe(forwarded.get('c'))
    expect(forwarded.get('c')).toBe('c'.repeat(32))
    expect(forwarded.get('utm_content')).toBe('u'.repeat(128))
    expect(forwarded.get('utm_campaign')).toBe('m'.repeat(128))
  })

  it('normalizes an overlong UTM fallback exactly like campaignQuery', () => {
    const source = { c: ' ', utm_content: `  ${'u'.repeat(140)}  ` }
    const forwarded = new URLSearchParams(campaignQuery(source))

    expect(selectLandingCampaign(new URLSearchParams(source))).toBe(
      forwarded.get('utm_content'),
    )
    expect(forwarded.get('utm_content')).toBe('u'.repeat(128))
  })
})
