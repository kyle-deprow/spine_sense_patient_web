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

    /**
     * Positioning, set by Ed 2026-08-09. The page previously sold itself as a
     * way to arrive at an appointment organized, which undersells the pipeline
     * and reads as a note-taking aid; it leads on cause now. A rewrite that
     * drifts back to "summary for your visit" should fail here.
     */
    it('leads on what is causing the pain rather than on visit preparation', async () => {
      const source = await pageSource()

      expect(source).toContain('Find out what is')
      expect(source).toContain('actually causing')
      expect(source).toContain('what is most likely driving your')
    })

    it('states the assessment depth that backs the claim', async () => {
      const source = await pageSource()

      // Both verified against the live question bank (13 sections, 271
      // question objects in v2.0.json). Never state them as anything else.
      expect(source).toContain('271')
      expect(source).toContain('13')
      expect(source).toContain('adaptive')
    })

    /**
     * A real-patient-volume claim shipped live on 2026-08-09 ("developed
     * against thousands of real clinical cases") and had to be pulled.
     * `GTM/research/product-05-clinical-evidence.md` records zero real patient
     * records in the system and states all 162 eval scenarios are synthetic,
     * and separately warns that scenario files are not validated cases.
     *
     * The brief keeps asking for this claim, so it gets a guard rather than a
     * note. If a future edit needs volume, the honest framings are the
     * 162-scenario library, the 67 recorded physician rulings, or the 6,923
     * backend tests.
     */
    it('never claims real-patient volume or clinical validation', async () => {
      const source = (await pageSource()).toLowerCase()

      for (const claim of [
        'real cases',
        'real clinical cases',
        'real patients',
        'real-world cases',
        'patient records',
        'clinically validated',
        'validated on',
      ]) {
        // The banned-claim comment above the trust rail names some of these,
        // so match only what the rendered copy would contain.
        const inCopy = source
          .split('\n')
          .filter((line) => !line.trimStart().startsWith('*') && !line.includes('//'))
          .join('\n')
        expect(inCopy).not.toContain(claim)
      }
    })

    it('shows a sample result and answers the free objection at the call to action', async () => {
      const source = await pageSource()

      expect(source).toContain('sample-result.webp')
      expect(source).toContain('shown with sample data')
      expect(source).toContain('No card, and nothing to cancel')
    })

    /**
     * The guideline bodies are the page's authority claim, and using their
     * marks is only defensible alongside the sentence that says what the
     * relationship is. The two ship together or not at all.
     */
    it('pairs the guideline logos with the no-endorsement statement', async () => {
      const source = await pageSource()

      for (const logo of ['nass', 'aaos', 'aans', 'aospine', 'eurospine', 'issls', 'nice', 'acr']) {
        expect(source).toContain(`./logos/${logo}.png`)
      }
      // JSX rewraps prose on edit, so match the sentence, not its line breaks.
      expect(source.replace(/\s+/g, ' ')).toContain(
        'not affiliated with SpineSense and have not reviewed or endorsed it',
      )
    })

    /**
     * The patient-facing name is MyScribe; MiScribe is the internal module
     * name and shipped here by mistake until 2026-08-09.
     */
    it('names the scribe feature the way the app does, with the recording disclaimer', async () => {
      const source = await pageSource()

      expect(source).toContain('MyScribe')
      expect(source).not.toContain('MiScribe')
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
