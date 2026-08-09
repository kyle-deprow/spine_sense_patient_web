import { describe, expect, it } from 'vitest'

import { ROOT_SCROLL_EVENTS, rootScrollEventsAt } from './root-scroll-depth'

/**
 * Dimensions taken from the live landing page on a phone: 8146px of content in
 * an 852px viewport, which is the shape these thresholds actually run against.
 */
const PAGE = 8146
const VIEWPORT = 852
const SPAN = PAGE - VIEWPORT

describe('root landing scroll depth', () => {
  it('records nothing for a visitor who never scrolls', () => {
    expect(rootScrollEventsAt(0, PAGE, VIEWPORT)).toEqual([])
  })

  it('records nothing for a nudge that falls short of the first fifth', () => {
    expect(rootScrollEventsAt(SPAN * 0.15, PAGE, VIEWPORT)).toEqual([])
  })

  it('marks the first fifth once it is reached', () => {
    expect(rootScrollEventsAt(SPAN * 0.2, PAGE, VIEWPORT)).toEqual(['root_scroll_1'])
  })

  it('applies the boundary tolerance to every bucket, not only the last', () => {
    // The tolerance puts the first bucket's real trigger just under 0.18, so a
    // bucket reads "reached about this far". Pinned either side rather than on
    // the boundary itself, which is not exactly representable: 0.2 - 0.02 is
    // 0.18000000000000002. The first bucket is the engagement signal the
    // funnel leans on, so its trigger point should not move silently.
    expect(rootScrollEventsAt(SPAN * 0.19, PAGE, VIEWPORT)).toEqual(['root_scroll_1'])
    expect(rootScrollEventsAt(SPAN * 0.17, PAGE, VIEWPORT)).toEqual([])
  })

  it('returns every bucket passed through, so a fling to the bottom is not undercounted', () => {
    expect(rootScrollEventsAt(SPAN, PAGE, VIEWPORT)).toEqual([...ROOT_SCROLL_EVENTS])
  })

  it('still credits the end when the last pixel is never reached', () => {
    // A mobile URL bar resizing mid-scroll leaves the position a hair short.
    expect(rootScrollEventsAt(SPAN * 0.99, PAGE, VIEWPORT)).toContain('root_scroll_5')
  })

  it('reports nothing for a page that cannot scroll, rather than crediting a read', () => {
    expect(rootScrollEventsAt(0, VIEWPORT, VIEWPORT)).toEqual([])
    expect(rootScrollEventsAt(0, 400, VIEWPORT)).toEqual([])
  })

  it('ignores a negative offset from overscroll rubber-banding', () => {
    expect(rootScrollEventsAt(-120, PAGE, VIEWPORT)).toEqual([])
  })
})
