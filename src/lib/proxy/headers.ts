export const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const REQUEST_HEADER_ALLOWLIST = [
  'accept',
  'content-type',
  'x-idempotency-key',
  'x-request-id',
  'x-correlation-id',
  'x-client-version',
  'user-agent',
] as const

const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'x-integrity-hash',
  'x-request-id',
  'retry-after',
  'x-idempotent-replayed',
] as const

export function buildProxyRequestHeaders(request: Request, accessToken: string): Headers {
  const headers = new Headers()
  const hopByHopHeaders = getHopByHopHeaderNames(request.headers)

  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = request.headers.get(name)
    if (value && !hopByHopHeaders.has(name)) {
      headers.set(name, value)
    }
  }

  if (!headers.has('accept')) headers.set('Accept', 'application/json')
  headers.set('Authorization', `Bearer ${accessToken}`)

  const url = new URL(request.url)
  headers.set('X-Forwarded-Host', url.host)
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''))

  return headers
}

export function buildProxyResponseHeaders(response: Response): Headers {
  const headers = new Headers()
  const hopByHopHeaders = getHopByHopHeaderNames(response.headers)

  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    const value = response.headers.get(name)
    if (value && !hopByHopHeaders.has(name)) {
      headers.set(name, value)
    }
  }

  headers.set('Cache-Control', 'no-store')
  headers.set('Pragma', 'no-cache')
  headers.set('Expires', '0')
  return headers
}

function getHopByHopHeaderNames(headers: Headers): Set<string> {
  const names = new Set(HOP_BY_HOP_HEADERS)
  const connection = headers.get('connection')
  if (connection) {
    for (const value of connection.split(',')) {
      const name = value.trim().toLowerCase()
      if (name) names.add(name)
    }
  }
  return names
}
