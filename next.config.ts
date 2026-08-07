import type { NextConfig } from 'next'

import { buildPermissionsPolicyHeader } from './src/lib/server/securityPolicy'

const nextConfig: NextConfig = {
  output: 'standalone',
  skipTrailingSlashRedirect: true,
  outputFileTracingIncludes: {
    '/*': [
      ...(process.env.PATIENT_APP_WEB_EXPORT_DIR
        ? []
        : ['./patient-app-export/**/*']),
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

    return [
      { source: '/(.*)', headers },
      {
        // Next's own build assets are content-hashed and carry no PHI;
        // `no-store` on them re-downloads the landing page's JS and CSS on
        // every visit. Later entries win on key collision, so this narrows
        // only Cache-Control while every security header above still applies.
        source: '/_next/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        // The Metro bundles the catch-all serves from _expo/static are equally
        // content-addressed. The route handler already marks them immutable,
        // but these header sources are applied after handlers run, so the
        // global no-store above was overriding it (verified live 08-07).
        source: '/_expo/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
    ]
  },
}

export default nextConfig
