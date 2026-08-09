import type { Metadata } from 'next'

import { campaignQuery } from '@/lib/campaign-query'
import { APP_ENTRY_PATH, APP_ORIGIN, APP_SIGNIN_PATH, MARKETING_SITE_URL } from '@/lib/site'

const TITLE = 'SpineSense: Find Out What Is Causing Your Back or Neck Pain'
const DESCRIPTION =
  'A thorough clinical spine assessment built by spine surgeons. An adaptive interview and your own MRI, CT or X-ray reports produce a detailed explanation of what is most likely driving your symptoms, and how soon it should be looked at. Free.'
const SOCIAL_IMAGE = `${MARKETING_SITE_URL}/opengraph-image`

export const landingMetadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: APP_ORIGIN + '/' },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: APP_ORIGIN + '/',
    siteName: 'SpineSense',
    type: 'website',
    locale: 'en_US',
    images: [{ url: SOCIAL_IMAGE, alt: 'SpineSense' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    images: [SOCIAL_IMAGE],
  },
}

function withQuery(path: string, query: string): string {
  return query.length > 0 ? `${path}?${query}` : path
}

export function buildLandingLinks(searchParams: Record<string, string | string[] | undefined>): {
  startHref: string
  signInHref: string
} {
  const query = campaignQuery(searchParams)
  return {
    startHref: withQuery(APP_ENTRY_PATH, query),
    signInHref: withQuery(APP_SIGNIN_PATH, query),
  }
}
