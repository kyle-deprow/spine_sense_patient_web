'use client'

import { useEffect, useRef } from 'react'

import { selectLandingCampaign } from '@/lib/campaign-query'

import { type RootScrollEvent, rootScrollEventsAt } from './root-scroll-depth'

const ENDPOINT = '/api/landing/events'

/**
 * Scroll marks are batched for this long before being sent.
 *
 * Scrolling crosses several thresholds in quick succession, and one request
 * carrying four marks is cheaper for the visitor than four carrying one each.
 * Anything that precedes a navigation is sent immediately instead, and a
 * pending batch is flushed when the page is hidden.
 */
const SCROLL_BATCH_MS = 250

type RootLandingEvent = 'root_view' | 'root_cta_start' | 'root_cta_signin' | RootScrollEvent

function deviceClass(width: number): 'phone' | 'tablet' | 'desktop' {
  if (width > 0 && width < 768) return 'phone'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

/**
 * Anonymous counters for the server-rendered root page only.
 *
 * The identifier lives in this component instance, never in a cookie or
 * browser storage. The request contains only an allowlisted event, a tightly
 * normalized campaign value, and a coarse device class; it never contains the
 * URL, referrer, account data, or health information.
 */
export default function RootLandingAnalytics() {
  const visitId = useRef<string | null>(null)
  const sentEvents = useRef<Set<RootLandingEvent>>(new Set())

  useEffect(() => {
    visitId.current ??=
      globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`

    const campaign = selectLandingCampaign(new URLSearchParams(window.location.search))
    const device = deviceClass(window.innerWidth)

    const pending = new Set<RootLandingEvent>()
    let batchTimer: ReturnType<typeof setTimeout> | null = null

    function flush(): void {
      if (batchTimer !== null) {
        clearTimeout(batchTimer)
        batchTimer = null
      }
      if (pending.size === 0 || visitId.current === null) return

      const body = JSON.stringify({
        v: visitId.current,
        c: campaign,
        d: device,
        e: [...pending],
      })
      pending.clear()

      try {
        const blob = new Blob([body], { type: 'application/json' })
        if (navigator.sendBeacon?.(ENDPOINT, blob)) return
        void fetch(ENDPOINT, {
          method: 'POST',
          body,
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
        }).catch(() => undefined)
      } catch {
        // Measurement must never interfere with navigation.
      }
    }

    /**
     * `immediate` is for anything a navigation is about to follow. A batched
     * mark would race the unload and be lost, which is how a funnel comes to
     * under-report the exact step it was built to measure.
     */
    function mark(event: RootLandingEvent, immediate = false): void {
      if (sentEvents.current.has(event) || visitId.current === null) return
      sentEvents.current.add(event)
      pending.add(event)

      if (immediate) {
        flush()
        return
      }
      batchTimer ??= setTimeout(flush, SCROLL_BATCH_MS)
    }

    function onClick(event: MouseEvent): void {
      const target = event.target
      if (!(target instanceof Element)) return
      const name = target.closest<HTMLElement>('[data-root-landing-event]')?.dataset
        .rootLandingEvent
      if (name === 'root_cta_start' || name === 'root_cta_signin') mark(name, true)
    }

    function onScroll(): void {
      const depths = rootScrollEventsAt(
        window.scrollY,
        document.documentElement.scrollHeight,
        window.innerHeight,
      )
      for (const depth of depths) mark(depth)
    }

    function onHide(): void {
      // `pagehide` is the one teardown signal iOS Safari reliably delivers,
      // and it is the traffic this page mostly receives.
      flush()
    }

    mark('root_view', true)
    // A restored scroll position or a back-navigation can land the visitor
    // mid-page without ever firing a scroll event.
    onScroll()

    document.addEventListener('click', onClick, true)
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', onHide)

    return () => {
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', onHide)
      flush()
    }
  }, [])

  return null
}
