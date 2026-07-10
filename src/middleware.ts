import { NextResponse, type NextRequest } from 'next/server'

import { buildPermissionsPolicyHeader, getStorageConnectOrigins } from '@/lib/server/securityPolicy'

type CspOptions = {
  requireTrustedTypes?: boolean
}

export function buildCspHeader(nonce: string, options: CspOptions = {}): string {
  const storageOrigins = getStorageConnectOrigins().join(' ')

  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'none'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${storageOrigins}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "manifest-src 'self'",
    "worker-src 'none'",
  ]

  if (options.requireTrustedTypes) {
    directives.push("require-trusted-types-for 'script'")
  }

  return directives.join('; ')
}

export function buildCspHeaderForPath(nonce: string, _pathname: string): string {
  return buildCspHeader(nonce, {
    requireTrustedTypes: !isPatientAppShellPath(_pathname),
  })
}

function applySecurityHeaders(response: NextResponse, nonce: string, pathname: string): void {
  response.headers.set('Content-Security-Policy', buildCspHeaderForPath(nonce, pathname))
  response.headers.set('X-Frame-Options', 'DENY')
  response.headers.set('X-Content-Type-Options', 'nosniff')
  response.headers.set('Referrer-Policy', 'strict-origin')
  response.headers.set('Permissions-Policy', buildPermissionsPolicyHeader())

  if (process.env.NODE_ENV !== 'development') {
    response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
  }

  if (pathname.startsWith('/api/') || isPatientAppShellPath(pathname)) {
    response.headers.set('Cache-Control', 'no-store')
    response.headers.set('Pragma', 'no-cache')
    response.headers.set('Expires', '0')
  }
}

function isPatientAppShellPath(pathname: string): boolean {
  if (pathname.startsWith('/api/') || pathname.startsWith('/_next/')) return false
  return !pathname.includes('.') || pathname.endsWith('.html')
}

export function middleware(request: NextRequest) {
  const nonce = crypto.randomUUID()
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
  applySecurityHeaders(response, nonce, request.nextUrl.pathname)
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|robots.txt).*)'],
}
