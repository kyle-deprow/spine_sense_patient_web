import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { validateUnsafeRequest } from '@/lib/auth/csrf'
import { validateProxyTarget } from '@/lib/proxy/allowlist'
import { buildProxyRequestHeaders, buildProxyResponseHeaders } from '@/lib/proxy/headers'
import { auditLog, createRequestAuditContext, deriveResourceType, type AuditContext } from '@/lib/server/audit'
import { BackendUnavailableError, backendFetch } from '@/lib/server/backend'
import { backendTimeoutOptions } from '@/lib/server/backend-timeouts'
import { getPatientWebConfig } from '@/lib/server/config'
import { csrfFailureResponse, jsonNoStore } from '@/lib/server/responses'

type ProxyContext = {
  params: Promise<{ path: string[] }>
}

async function handler(request: NextRequest, context: ProxyContext) {
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value
  const auditContext = createRequestAuditContext(request, accessToken)
  const { path } = await context.params
  const target = validateProxyTarget(path, request.method, request.nextUrl.pathname)
  if (!target.ok) {
    auditDenial(request.method, target.status, target.code, auditContext)
    return jsonNoStore({ error: target.code }, { status: target.status })
  }

  const resourceType = deriveResourceType(target.targetPath)

  if (!accessToken) {
    auditDenial(request.method, 401, 'authentication_required', auditContext, resourceType)
    return jsonNoStore({ error: 'unauthorized' }, { status: 401 })
  }
  if (isBinaryDocumentPayload(target.targetPath, request)) {
    auditDenial(request.method, 415, 'binary_document_payload_not_allowed', auditContext, resourceType)
    return jsonNoStore({ error: 'unsupported_media_type' }, { status: 415 })
  }

  const config = getPatientWebConfig()
  const csrf = validateUnsafeRequest(request, request.cookies.get(COOKIE_NAMES.csrf)?.value, {
    csrfSecret: config.csrfSecret,
    allowedOrigins: config.allowedOrigins,
  })
  if (!csrf.ok) {
    auditDenial(request.method, csrf.status, csrf.code, auditContext, resourceType)
    return csrfFailureResponse(csrf.status, csrf.code)
  }

  const headers = buildProxyRequestHeaders(request, accessToken)
  headers.set('X-Request-Id', auditContext.requestId)
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
      backendTimeoutOptions(target.targetPath),
    )
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      auditDenial(request.method, 503, 'backend_unavailable', auditContext, resourceType)
      return jsonNoStore({ error: 'service_unavailable' }, { status: 503 })
    }
    throw err
  }

  auditLog({
    ts: new Date().toISOString(),
    event: 'phi.proxy.access',
    method: request.method,
    resourceType,
    status: backendResponse.status,
    ...auditContext,
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

function auditDenial(
  method: string,
  status: number,
  reason: string,
  auditContext: AuditContext,
  resourceType = 'proxy',
): void {
  auditLog({
    ts: new Date().toISOString(),
    event: 'phi.proxy.denied',
    method,
    resourceType,
    status,
    ...auditContext,
    reason,
  })
}

function shouldForwardBody(method: string): boolean {
  return !['GET', 'HEAD'].includes(method.toUpperCase())
}

function isBinaryDocumentPayload(targetPath: string, request: NextRequest): boolean {
  if (!targetPath.startsWith('/api/v1/patients/me/documents')) return false
  if (!shouldForwardBody(request.method)) return false
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType) return false
  return (
    contentType.startsWith('application/octet-stream') ||
    contentType.startsWith('image/') ||
    contentType.startsWith('application/pdf') ||
    contentType.startsWith('multipart/form-data')
  )
}

export { handler as DELETE, handler as GET, handler as PATCH, handler as POST, handler as PUT }
