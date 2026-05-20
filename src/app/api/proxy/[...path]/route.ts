import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { validateUnsafeRequest } from '@/lib/auth/csrf'
import { validateProxyTarget } from '@/lib/proxy/allowlist'
import { buildProxyRequestHeaders, buildProxyResponseHeaders } from '@/lib/proxy/headers'
import { auditLog, deriveResourceType, extractUserIdFromToken } from '@/lib/server/audit'
import { assessmentBackendTimeoutOptions } from '@/lib/server/assessment-timeouts'
import { BackendUnavailableError, backendFetch } from '@/lib/server/backend'
import { getPatientWebConfig } from '@/lib/server/config'
import { csrfFailureResponse, jsonNoStore } from '@/lib/server/responses'

type ProxyContext = {
  params: Promise<{ path: string[] }>
}

async function handler(request: NextRequest, context: ProxyContext) {
  const { path } = await context.params
  const target = validateProxyTarget(path, request.method, request.nextUrl.pathname)
  if (!target.ok) {
    return jsonNoStore({ error: target.code }, { status: target.status })
  }

  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value
  if (!accessToken) {
    return jsonNoStore({ error: 'unauthorized' }, { status: 401 })
  }

  const config = getPatientWebConfig()
  const csrf = validateUnsafeRequest(request, request.cookies.get(COOKIE_NAMES.csrf)?.value, {
    csrfSecret: config.csrfSecret,
    allowedOrigins: config.allowedOrigins,
  })
  if (!csrf.ok) {
    return csrfFailureResponse(csrf.status, csrf.code)
  }

  const headers = buildProxyRequestHeaders(request, accessToken)
  const backendRequest: RequestInit = {
    method: request.method,
    headers,
  }
  if (shouldForwardBody(request.method)) {
    const body = await request.arrayBuffer()
    if (body.byteLength > 0) {
      backendRequest.body = body
    } else {
      headers.delete('content-type')
    }
  }

  let backendResponse: Response
  try {
    backendResponse = await backendFetch(
      `${target.targetPath}${request.nextUrl.search}`,
      backendRequest,
      assessmentBackendTimeoutOptions(target.targetPath),
    )
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
    }
    throw err
  }

  // Emit audit event after the backend response so status is available.
  // userId is extracted from the access token JWT payload (sub claim) without
  // signature verification — for audit correlation only, not authentication.
  // resourceType is derived from the target path, never the full request path.
  auditLog({
    ts: new Date().toISOString(),
    event: 'phi.proxy.access',
    method: request.method,
    resourceType: deriveResourceType(target.targetPath),
    userId: extractUserIdFromToken(accessToken),
    status: backendResponse.status,
    requestId: request.headers.get('x-request-id') ?? undefined,
  })

  const responseHeaders = buildProxyResponseHeaders(backendResponse)
  if (backendResponse.status === 204) {
    return new NextResponse(null, { status: 204, headers: responseHeaders })
  }

  return new NextResponse(await backendResponse.arrayBuffer(), {
    status: backendResponse.status,
    headers: responseHeaders,
  })
}

function shouldForwardBody(method: string): boolean {
  return !['GET', 'HEAD'].includes(method.toUpperCase())
}

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST, handler as PUT }
