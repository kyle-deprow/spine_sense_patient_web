import type { MetadataRoute } from 'next'

import { APP_ORIGIN } from '@/lib/site'

/**
 * One URL, on purpose.
 *
 * `/` is the only indexable page on this host. Every other path is served by the
 * catch-all route handler, which returns the Expo shell under a `noindex`
 * directive because it answers any extensionless path with the same
 * `index.html` -- listing those here would ask Google to crawl a set of
 * identical blank pages.
 *
 * The article library's sitemap lives on spinesense.ai and covers the ~113 URLs
 * that are meant to rank. This file exists so that the one page here is
 * discoverable without depending on an inbound link, and so `robots.txt` has
 * something to point at.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: `${APP_ORIGIN}/`,
      changeFrequency: 'monthly',
      priority: 1,
    },
  ]
}
