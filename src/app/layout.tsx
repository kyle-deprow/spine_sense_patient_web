import './globals.css'
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'Spine Sense Patient',
  description: 'Patient web BFF host for Spine Sense.',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <header className="topbar">
            <div className="topbar-inner">
              <p className="brand">Spine Sense Patient</p>
            </div>
          </header>
          {children}
        </div>
      </body>
    </html>
  )
}
