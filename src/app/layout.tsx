import './globals.css'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

import { APP_ORIGIN } from '@/lib/site'

/**
 * Root layout for this app's genuine Next pages.
 *
 * Until the landing page at `/` was added, nothing in this app used a layout at
 * all: every URL was answered by the catch-all *route handler*, and route
 * handlers bypass layouts entirely. What lived here was untouched
 * create-next-app scaffold -- a "Spine Sense Patient" topbar over a `.shell`
 * grid -- which had never rendered for anyone. It is removed rather than styled
 * around, because the landing page draws its own chrome and a stray scaffold
 * header on it would be the only thing this file ever shipped.
 *
 * Deliberately no `robots` metadata here. The app shell is kept out of search by
 * the `noindex` the catch-all injects, and putting a blanket directive at the
 * layout level would apply it to the landing page too, which is the one URL on
 * this host that is supposed to be indexed.
 */

export const metadata: Metadata = {
  metadataBase: new URL(APP_ORIGIN),
  title: 'SpineSense',
  description: 'A free spine assessment for back and neck pain, built by spine surgeons.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
