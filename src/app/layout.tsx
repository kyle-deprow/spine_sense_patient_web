import './globals.css'
import type { Metadata } from 'next'
import localFont from 'next/font/local'
import type { ReactNode } from 'react'

import { APP_ORIGIN } from '@/lib/site'

/**
 * Satoshi, the patient app's typeface.
 *
 * The landing page and the app screen behind it are one product to a visitor,
 * and a typeface change across the click is the loudest possible signal that
 * they are not. The files are the same three weights the Expo app loads, copied
 * rather than shared because the two builds have no common asset root.
 *
 * `next/font/local` hashes them into `/_next/static/media`, which the
 * `next.config` cache rule already marks immutable; served from `public/` they
 * would inherit the global `no-store` and re-download on every ad click.
 */
const satoshi = localFont({
  src: [
    { path: './fonts/Satoshi-Regular.otf', weight: '400', style: 'normal' },
    { path: './fonts/Satoshi-Medium.otf', weight: '500', style: 'normal' },
    { path: './fonts/Satoshi-Bold.otf', weight: '700', style: 'normal' },
  ],
  variable: '--font-satoshi',
  // Text must paint on the fallback immediately: this page is the first thing a
  // paid click sees, and a blocked first paint is a bounce.
  display: 'swap',
})

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
    <html lang="en" className={satoshi.variable}>
      <body>{children}</body>
    </html>
  )
}
