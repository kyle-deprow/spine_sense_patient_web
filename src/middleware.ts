import { NextResponse, type NextRequest } from 'next/server'
import { buildPermissionsPolicyHeader } from '@/lib/server/securityPolicy'

type CspOptions = {
  requireTrustedTypes?: boolean
}

export function buildCspHeader(nonce: string, options: CspOptions = {}): string {
  const storageOrigins =
    process.env.NEXT_PUBLIC_STORAGE_DOMAINS ??
    'https://*.s3.amazonaws.com https://*.storage.googleapis.com'

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
  // In development, React Native Web requires inline style attributes and
  // Expo dynamically injects <style> tags for icon fonts / layout animations.
  // The strict production CSP blocks both, so we relax it for local dev.
  //
  // IMPORTANT: Browsers ignore 'unsafe-inline' when a nonce is also present
  // in the same directive. To allow React Native Web's dynamic style injection
  // we must omit the nonce from style-src / style-src-elem in development.
  if (process.env.NODE_ENV === 'development') {
    return buildCspHeader(nonce, { requireTrustedTypes: false })
      .replace("style-src-attr 'none'", "style-src-attr 'unsafe-inline'")
      .replace(
        `style-src 'self' 'nonce-${nonce}'`,
        `style-src 'self' 'unsafe-inline'`,
      )
      .replace(
        `style-src-elem 'self' 'nonce-${nonce}'`,
        `style-src-elem 'self' 'unsafe-inline'`,
      )
  }

  // P13 James-Tucker batch (Ed-approved posture): react-native-web and
  // Reanimated inject <style> tags and inline style attributes at runtime —
  // the nonce-only policy blocked every injection (console floods, and the
  // Suggested Reading card left invisible in its pre-animation state). Allow
  // 'unsafe-inline' for STYLES ONLY, on the patient-app shell path ONLY.
  // Scripts stay strictly nonce-gated; every other PHI protection (no durable
  // storage, no service worker, BFF-only tokens, CSRF, cache-control) is
  // untouched. This is the standard accommodation for react-native-web.
  if (isPatientAppShellPath(_pathname)) {
    return buildCspHeader(nonce, { requireTrustedTypes: false })
      .replace("style-src-attr 'none'", "style-src-attr 'unsafe-inline'")
      .replace(
        `style-src 'self' 'nonce-${nonce}'`,
        `style-src 'self' 'unsafe-inline'`,
      )
      .replace(
        `style-src-elem 'self' 'nonce-${nonce}'`,
        `style-src-elem 'self' 'unsafe-inline'`,
      )
  }
  return buildCspHeader(nonce, { requireTrustedTypes: true })
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
