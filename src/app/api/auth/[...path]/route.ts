import type { NextRequest } from 'next/server'

import { COOKIE_NAMES, setAuthCookies } from '@/lib/auth/cookies'
import { validateAuthMutation } from '@/lib/auth/route-guards'
import { backendFetch, hasTokenPair, readJsonBody, stripTokens } from '@/lib/server/backend'
import { issueCsrfCookie } from '@/lib/server/auth'
import { jsonNoStore } from '@/lib/server/responses'
import type { BackendTokenPair } from '@/types/auth'

type AuthProxyContext = {
  params: Promise<{ path: string[] }>
}

type JsonRecord = Record<string, unknown>

const BLOCKED_AUTH_PATHS = new Set(['login', 'logout', 'refresh', 'register', 'session'])

async function handler(request: NextRequest, context: AuthProxyContext) {
  const { path } = await context.params
  const authPath = path.join('/')

  if (!authPath || BLOCKED_AUTH_PATHS.has(authPath)) {
    return jsonNoStore({ error: 'auth_route_not_found' }, { status: 404 })
  }

  if (shouldForwardBody(request.method)) {
    const failure = validateAuthMutation(request)
    if (failure) return failure
  }

  const backendRequest: RequestInit = {
    method: request.method,
    headers: buildAuthHeaders(request),
  }

  if (shouldForwardBody(request.method)) {
    backendRequest.body = await request.arrayBuffer()
  }

  const backendResponse = await backendFetch(
    `/api/v1/auth/${authPath}${request.nextUrl.search}`,
    backendRequest,
  )
  const data = await readJsonBody<JsonRecord>(backendResponse)

  const response = jsonNoStore(safeAuthBody(data), { status: backendResponse.status })
  if (backendResponse.ok && hasTokenPair(data)) {
    setAuthCookies(response, toTokenPair(data))
    issueCsrfCookie(response)
  }
  return response
}

function buildAuthHeaders(request: NextRequest): Headers {
  const headers = new Headers({
    Accept: 'application/json',
  })
  const contentType = request.headers.get('content-type')
  if (contentType) headers.set('Content-Type', contentType)

  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`)
  }

  return headers
}

function safeAuthBody(data: JsonRecord | undefined): JsonRecord {
  return data ? stripTokens(data) : {}
}

function shouldForwardBody(method: string): boolean {
  return !['GET', 'HEAD'].includes(method.toUpperCase())
}

function toTokenPair(data: BackendTokenPair): { accessToken: string; refreshToken: string } {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
  }
}

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST, handler as PUT }
