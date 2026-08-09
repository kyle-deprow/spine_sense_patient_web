/**
 * Scroll-depth thresholds for the server-rendered landing page.
 *
 * This lives apart from the tracker component because the component is a
 * `.tsx` client module and the test runner here is node-environment and only
 * collects `.test.ts`, so a component test could only ever assert on the
 * file's text. The arithmetic is the part that can actually be wrong, so it
 * sits in a module the suite can execute.
 *
 * Fifths, matching the shell tracker's buckets, so a depth on the `/` arm and
 * a depth on the `/welcome` arm mean the same fraction of their page.
 */

export const ROOT_SCROLL_EVENTS = [
  'root_scroll_1',
  'root_scroll_2',
  'root_scroll_3',
  'root_scroll_4',
  'root_scroll_5',
] as const

export type RootScrollEvent = (typeof ROOT_SCROLL_EVENTS)[number]

/**
 * A short tolerance below each boundary.
 *
 * Sub-pixel layout, browser zoom, and a mobile URL bar that resizes the
 * viewport mid-scroll all leave the final scroll position a fraction short of
 * a true 1.0, which would otherwise make "read to the end" unreachable on the
 * devices most of this traffic arrives on. Same allowance the shell tracker
 * uses.
 */
const BOUNDARY_TOLERANCE = 0.02

/**
 * The depth buckets crossed at a given scroll position.
 *
 * Returns every bucket up to the current depth rather than only the newest,
 * so a caller that misses a scroll event (a fling that lands at the bottom in
 * one frame) still records the ones passed through. Callers are expected to
 * de-duplicate; these are cumulative marks, not increments.
 *
 * A page no taller than its viewport yields nothing at all: there is no
 * scrolling to measure, and reporting "read to the end" for a page that
 * cannot scroll would quietly inflate the one number this exists to inform.
 */
export function rootScrollEventsAt(
  scrollY: number,
  scrollHeight: number,
  viewportHeight: number,
): RootScrollEvent[] {
  const span = scrollHeight - viewportHeight
  if (!Number.isFinite(span) || span <= 0) return []

  const ratio = scrollY / span
  if (!Number.isFinite(ratio) || ratio <= 0) return []

  return ROOT_SCROLL_EVENTS.filter(
    (_event, index) => ratio >= (index + 1) * 0.2 - BOUNDARY_TOLERANCE,
  )
}
