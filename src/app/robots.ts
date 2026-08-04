import type { MetadataRoute } from 'next'

/**
 * app.spinesense.ai hosts the patient application. It is not an indexable
 * content surface, and the marketing site at https://spinesense.ai owns every
 * page that is meant to rank.
 *
 * Crawling is deliberately allowed rather than blocked. The app shell carries a
 * `noindex` directive (see `injectSeoMeta` and the `X-Robots-Tag` header in the
 * catch-all route), and a crawler that is disallowed here never fetches the page
 * and therefore never sees that directive. A disallowed URL can still be indexed
 * from an inbound link, whereas a crawled `noindex` URL is dropped outright.
 * Blocking would also stop the social scrapers that render link preview cards.
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
  }
}
