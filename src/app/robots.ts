import type { MetadataRoute } from 'next'

import { APP_ORIGIN } from '@/lib/site'

/**
 * app.spinesense.ai hosts the patient application. Exactly one URL on it is an
 * indexable content surface -- the landing page at `/` -- and the marketing site
 * at https://spinesense.ai owns every other page meant to rank.
 *
 * Crawling is deliberately allowed rather than blocked. The app shell carries a
 * `noindex` directive (see `injectSeoMeta` and the `X-Robots-Tag` header in the
 * catch-all route), and a crawler that is disallowed here never fetches the page
 * and therefore never sees that directive. A disallowed URL can still be indexed
 * from an inbound link, whereas a crawled `noindex` URL is dropped outright.
 * Blocking would also stop the social scrapers that render link preview cards.
 *
 * That reasoning is why the landing page needed a carved-out Next route rather
 * than a relaxed directive here: `noindex` is applied per response by the
 * catch-all, so the fix was to stop `/` being answered by the catch-all at all.
 *
 * `/api/` is disallowed because those paths are the BFF's own endpoints and
 * there is nothing there for a crawler.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: '/api/',
      },
    ],
    sitemap: `${APP_ORIGIN}/sitemap.xml`,
  }
}
