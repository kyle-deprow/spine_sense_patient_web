import { NextResponse, type NextRequest } from 'next/server'

import {
  auditFrontDoorOriginRejection,
  frontDoorOriginRejectionReason,
  getFrontDoorOriginGuardConfig,
} from '@/lib/front-door-origin-guard'
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
    `connect-src 'self' blob: ${storageOrigins}`,
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
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload',
    )
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
  const guardConfig = getFrontDoorOriginGuardConfig()
  if (guardConfig.mode !== 'off') {
    const expectedFrontDoorId = guardConfig.expectedFrontDoorId
    if (expectedFrontDoorId === null) {
      return new NextResponse('Service unavailable', {
        status: 503,
        headers: { 'Cache-Control': 'no-store', Pragma: 'no-cache' },
      })
    }
    const reason = frontDoorOriginRejectionReason(
      request.headers,
      expectedFrontDoorId,
    )
    if (reason !== null) {
      if (guardConfig.mode === 'enforce') {
        return new NextResponse('Forbidden', {
          status: 403,
          headers: {
            'Cache-Control': 'no-store',
            Pragma: 'no-cache',
          },
        })
      }
      auditFrontDoorOriginRejection(guardConfig, reason)
    }
  }

  if (isSecurityHeaderBypassPath(request.nextUrl.pathname)) {
    return NextResponse.next()
  }

  const nonce = crypto.randomUUID()
  const csp = buildCspHeaderForPath(nonce, request.nextUrl.pathname)
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  // Also on the *request*, which is how Next itself learns the nonce: it reads
  // this header and stamps its own inline scripts with it. Without this, the
  // first genuine Next page in this app (the landing page at `/`) renders its
  // HTML fine but has its inline RSC payload blocked by our own CSP, so it
  // never hydrates. The catch-all route handler is unaffected either way --
  // it builds its HTML by hand and applies the nonce from `x-nonce` itself.
  requestHeaders.set('Content-Security-Policy', csp)

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
  applySecurityHeaders(response, nonce, request.nextUrl.pathname)
  return response
}

function isSecurityHeaderBypassPath(pathname: string): boolean {
  return (
    pathname.startsWith('/_next/static') ||
    pathname.startsWith('/_next/image') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt'
  )
}

export const config = {
  matcher: ['/:path*'],
}
