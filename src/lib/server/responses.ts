import { NextResponse } from 'next/server'

export function withNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'no-store')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

export function jsonNoStore(body: unknown, init?: ResponseInit): NextResponse {
  return withNoStore(NextResponse.json(body, init))
}

export function csrfFailureResponse(status: 403 | 415, code: string): NextResponse {
  return jsonNoStore({ error: code }, { status })
}

export function configurationUnavailableResponse(): NextResponse {
  return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
}
