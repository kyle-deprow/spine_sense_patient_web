/**
 * Origins and shared copy for the two SpineSense web surfaces.
 *
 * These were literals inside the catch-all route handler, which was fine while
 * it was the only thing rendering HTML. The landing page needs the same values
 * for its canonical URL and its links back to the library, and two files
 * disagreeing about which origin is which is the kind of bug that only shows up
 * in a canonical tag nobody reads.
 */

/** This host: the patient application. */
export const APP_ORIGIN = 'https://app.spinesense.ai'

/** The marketing site and education library. Owns everything meant to rank. */
export const MARKETING_SITE_URL = 'https://spinesense.ai'

/**
 * Where the landing page's primary call to action goes.
 *
 * Straight to account creation rather than via `/welcome` (Ed, 2026-08-09).
 * `/welcome` exists to sell the product before the form, and the landing page
 * now does that job in front of it, so routing through it made the visitor read
 * the same pitch twice before being allowed to start.
 *
 * Safe to point at an `(auth)` route directly. Verified on the live app,
 * 2026-08-09: a cold load of `/register` with no session renders the form
 * (`register-form`) with no redirect, and the campaign query survives. A
 * visitor who *is* signed in is bounced to their own landing by the auth
 * segment layout, which owns that decision for every `(auth)` route, so the
 * server still does not need an opinion about what "signed in" means. Back from
 * a directly-loaded register screen falls through to `/welcome` rather than
 * dead-ending (AuthScaffold's `defaultBack`).
 *
 * Funnel consequence, if these counts ever look odd: traffic from `/` no longer
 * touches `/welcome`, so `cta_start` (which fires on the welcome screen's own
 * button) is now an ads-to-`/welcome` signal only. `root_cta_start` is the
 * landing page's equivalent, and `summarizeCampaigns` sums both.
 */
export const APP_ENTRY_PATH = '/register'

/** Sign-in goes to the form directly, for the same reason. */
export const APP_SIGNIN_PATH = '/login'
