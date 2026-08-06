'use client'

import { useEffect, useRef } from 'react'

import { selectLandingCampaign } from '@/lib/campaign-query'

const ENDPOINT = '/api/landing/events'

type RootLandingEvent = 'root_view' | 'root_cta_start' | 'root_cta_signin'

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

    function mark(event: RootLandingEvent): void {
      if (sentEvents.current.has(event) || visitId.current === null) return
      sentEvents.current.add(event)

      const body = JSON.stringify({
        v: visitId.current,
        c: campaign,
        d: device,
        e: [event],
      })

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

    function onClick(event: MouseEvent): void {
      const target = event.target
      if (!(target instanceof Element)) return
      const name = target.closest<HTMLElement>('[data-root-landing-event]')?.dataset
        .rootLandingEvent
      if (name === 'root_cta_start' || name === 'root_cta_signin') mark(name)
    }

    mark('root_view')
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  return null
}
