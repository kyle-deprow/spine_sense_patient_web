import type { NextConfig } from 'next'

import { buildPermissionsPolicyHeader } from './src/lib/server/securityPolicy'

const nextConfig: NextConfig = {
  output: 'standalone',
  skipTrailingSlashRedirect: true,
  outputFileTracingIncludes: {
    '/*': [
      './patient-app-export/**/*',
      './node_modules/.pnpm/@img+sharp-libvips-*/**/*',
      './node_modules/.pnpm/@img+sharp-*/node_modules/@img/sharp-libvips-*/**/*',
      './node_modules/.pnpm/sharp@0.35.0/node_modules/@img/sharp-libvips-*/**/*',
    ],
  },
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    const headers = [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin' },
      {
        key: 'Permissions-Policy',
        value: buildPermissionsPolicyHeader(),
      },
      { key: 'Cache-Control', value: 'no-store' },
    ]

    if (process.env.NODE_ENV !== 'development') {
      headers.push({
        key: 'Strict-Transport-Security',
        value: 'max-age=63072000; includeSubDomains; preload',
      })
    }

    return [{ source: '/(.*)', headers }]
  },
}

export default nextConfig
