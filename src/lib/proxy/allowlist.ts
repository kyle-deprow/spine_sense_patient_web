const AUTH_PREFIX = '/api/v1/auth'
const RAW_PROXY_PREFIX = '/api/proxy'
const BACKEND_COLLECTION_PATHS_WITH_TRAILING_SLASH = new Set(['/api/v1/patients/me/assessments'])

export interface AllowedProxyRoute {
  prefix: string
  methods: readonly string[]
}

export const ALLOWED_PROXY_ROUTES: readonly AllowedProxyRoute[] = [
  { prefix: '/api/v1/patients/me/assessments', methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  { prefix: '/api/v1/patients/me/consents', methods: ['GET', 'POST', 'PUT', 'PATCH'] },
  { prefix: '/api/v1/patients/me/dashboard', methods: ['GET'] },
  { prefix: '/api/v1/patients/me/symptom-trends', methods: ['GET'] },
  { prefix: '/api/v1/patients/me/symptoms', methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
  { prefix: '/api/v1/patients/me/checkins', methods: ['GET', 'POST', 'PATCH', 'DELETE'] },
  { prefix: '/api/v1/patients/me/treatments', methods: ['GET'] },
  { prefix: '/api/v1/patients/me/documents', methods: ['GET', 'POST', 'DELETE'] },
  { prefix: '/api/v1/patients/me/intake', methods: ['GET', 'POST', 'PUT'] },
  // MyScribe visit recordings: start/stop/upload-url/process/share are POSTs,
  // delete is DELETE; recordings/summaries are GETs.
  { prefix: '/api/v1/patients/me/miscribe', methods: ['GET', 'POST', 'DELETE'] },
  { prefix: '/api/v1/patients/me/providers', methods: ['GET'] },
  { prefix: '/api/v1/patients/me', methods: ['GET', 'PATCH'] },
  { prefix: '/api/v1/invite-codes', methods: ['GET', 'POST'] },
  { prefix: '/api/v1/safety', methods: ['GET', 'POST'] },
]

export type ProxyPathValidation =
  | { ok: true; targetPath: string }
  | { ok: false; status: 400 | 404 | 405; code: string }

export function validateProxyTarget(
  pathSegments: readonly string[],
  method: string,
  rawPathname: string,
): ProxyPathValidation {
  if (!rawPathname.startsWith(`${RAW_PROXY_PREFIX}/api/v1/`)) {
    return { ok: false, status: 404, code: 'proxy_prefix_not_allowed' }
  }
  if (rawPathname.includes('//')) {
    return { ok: false, status: 400, code: 'proxy_path_invalid' }
  }
  if (hasEncodedTraversal(rawPathname)) {
    return { ok: false, status: 400, code: 'proxy_path_invalid' }
  }

  const baseTargetPath = `/${pathSegments.join('/')}`
  const targetPath =
    rawPathname.endsWith('/') || BACKEND_COLLECTION_PATHS_WITH_TRAILING_SLASH.has(baseTargetPath)
      ? `${baseTargetPath}/`
      : baseTargetPath
  if (targetPath.startsWith(`${AUTH_PREFIX}/`) || targetPath === AUTH_PREFIX) {
    return { ok: false, status: 404, code: 'proxy_auth_blocked' }
  }
  if (targetPath.includes('\\') || targetPath.includes('://')) {
    return { ok: false, status: 400, code: 'proxy_path_invalid' }
  }
  if (pathSegments.some((segment) => segment === '.' || segment === '..' || segment.length === 0)) {
    return { ok: false, status: 400, code: 'proxy_path_invalid' }
  }

  const route = ALLOWED_PROXY_ROUTES.find((candidate) => matchesPrefix(targetPath, candidate.prefix))
  if (!route) {
    return { ok: false, status: 404, code: 'proxy_path_not_allowed' }
  }

  if (!route.methods.includes(method.toUpperCase())) {
    return { ok: false, status: 405, code: 'proxy_method_not_allowed' }
  }

  return { ok: true, targetPath }
}

function matchesPrefix(targetPath: string, prefix: string): boolean {
  return targetPath === prefix || targetPath.startsWith(`${prefix}/`)
}

function hasEncodedTraversal(pathname: string): boolean {
  const lower = pathname.toLowerCase()
  return (
    lower.includes('%2e') ||
    lower.includes('%2f') ||
    lower.includes('%5c') ||
    lower.includes('%252e') ||
    lower.includes('%252f') ||
    lower.includes('%255c')
  )
}
