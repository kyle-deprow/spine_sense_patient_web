import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
export const CSRF_HEADER = 'x-csrf-token'
const JSON_CONTENT_TYPES = new Set(['application/json'])

export type CsrfValidationResult = { ok: true } | { ok: false; status: 403 | 415; code: string }

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase())
}

export function createCsrfToken(
  secret: string,
  nonce = randomBytes(32).toString('base64url'),
): string {
  const signature = signCsrfNonce(secret, nonce)
  return `${nonce}.${signature}`
}

export function verifyCsrfToken(secret: string, token: string): boolean {
  const [nonce, signature, extra] = token.split('.')
  if (!nonce || !signature || extra) return false
  const expected = signCsrfNonce(secret, nonce)
  return safeEqual(signature, expected)
}

export function validateUnsafeRequest(
  request: Request,
  csrfCookieValue: string | undefined,
  options: { csrfSecret: string; allowedOrigins: string[] },
): CsrfValidationResult {
  if (isSafeMethod(request.method)) return { ok: true }

  const contentTypeResult = validateJsonContentType(request.headers.get('content-type'))
  if (!contentTypeResult.ok) return contentTypeResult

  const originResult = validateOriginHeaders(request, options.allowedOrigins)
  if (!originResult.ok) return originResult

  const headerValue = request.headers.get(CSRF_HEADER)
  if (!csrfCookieValue || !headerValue) {
    return { ok: false, status: 403, code: 'csrf_missing' }
  }
  if (headerValue !== csrfCookieValue) {
    return { ok: false, status: 403, code: 'csrf_mismatch' }
  }
  if (!verifyCsrfToken(options.csrfSecret, headerValue)) {
    return { ok: false, status: 403, code: 'csrf_invalid' }
  }
  return { ok: true }
}

export function validateOriginHeaders(
  request: Request,
  configuredAllowedOrigins: string[],
): CsrfValidationResult {
  // Do NOT seed from request.url: behind a reverse proxy (nginx, Azure Front Door)
  // Next.js route handlers see the internal upstream URL (e.g. http://localhost:3000),
  // so auto-seeding would whitelist that internal origin for any caller who can set
  // the Origin header. Use only explicitly configured origins.
  const allowedOrigins = new Set(configuredAllowedOrigins)

  if (allowedOrigins.size === 0) {
    return { ok: false, status: 403, code: 'origin_forbidden' }
  }

  const origin = request.headers.get('origin')
  if (!origin || !allowedOrigins.has(origin)) {
    return { ok: false, status: 403, code: 'origin_forbidden' }
  }

  const referer = request.headers.get('referer')
  if (referer) {
    try {
      if (!allowedOrigins.has(new URL(referer).origin)) {
        return { ok: false, status: 403, code: 'referer_forbidden' }
      }
    } catch {
      return { ok: false, status: 403, code: 'referer_forbidden' }
    }
  }

  return { ok: true }
}

export function validateJsonContentType(contentType: string | null): CsrfValidationResult {
  if (!contentType) return { ok: false, status: 415, code: 'content_type_required' }
  const [mediaType] = contentType.split(';', 1)
  if (!mediaType || !JSON_CONTENT_TYPES.has(mediaType.trim().toLowerCase())) {
    return { ok: false, status: 415, code: 'content_type_unsupported' }
  }
  return { ok: true }
}

function signCsrfNonce(secret: string, nonce: string): string {
  return createHmac('sha256', secret).update(nonce).digest('base64url')
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  if (leftBuffer.length !== rightBuffer.length) return false
  return timingSafeEqual(leftBuffer, rightBuffer)
}
