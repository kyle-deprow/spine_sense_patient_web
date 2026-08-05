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
 * Where the app's own cold-start screen lives.
 *
 * The landing page hands off here rather than deeper into the app: `/welcome`
 * is the app's existing entry point, it already knows how to route someone with
 * a session and someone without, and duplicating that decision on the server
 * would mean two places that have to agree about what "signed in" means.
 */
export const APP_ENTRY_PATH = '/welcome'

export const APP_SIGNIN_PATH = '/login'
