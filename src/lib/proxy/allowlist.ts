const AUTH_PREFIX = '/api/v1/auth'
const RAW_PROXY_PREFIX = '/api/proxy'
const BACKEND_ROOT_PATHS_WITH_TRAILING_SLASH = new Set([
  '/api/v1/patients/me',
  '/api/v1/patients/me/assessments',
  '/api/v1/patients/me/symptoms',
  '/api/v1/patients/me/tracked-symptoms',
])

export interface AllowedProxyRoute {
  prefix: string
  methods: readonly string[]
  match?: 'exact' | 'prefix'
  pathPattern?: RegExp
}

const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const ASSESSMENT_RE = `^\\/api\\/v1\\/patients\\/me\\/assessments\\/${UUID_RE}`
const ASSESSMENT_EXACT_RE = new RegExp(`${ASSESSMENT_RE}$`, 'i')
const ASSESSMENT_DOCUMENT_RE = new RegExp(`${ASSESSMENT_RE}\\/documents\\/${UUID_RE}$`, 'i')
const ASSESSMENT_DOCUMENT_CONFIRM_RE = new RegExp(`${ASSESSMENT_RE}\\/documents\\/${UUID_RE}\\/confirm$`, 'i')
const ASSESSMENT_REPORT_RE = new RegExp(`${ASSESSMENT_RE}\\/reports$`, 'i')
const ASSESSMENT_QUESTION_NOTE_LIVE_TRANSCRIPTION_SESSION_RE = new RegExp(
  `${ASSESSMENT_RE}\\/questions\\/[A-Za-z0-9_-]+\\/note\\/live-transcription-session$`,
  'i',
)
const INTAKE_STORY_AUDIO_UPLOADS_RE = /^\/api\/v1\/patients\/me\/intake\/story\/audio-uploads$/i
const INTAKE_STORY_TRANSCRIPTIONS_RE = /^\/api\/v1\/patients\/me\/intake\/story\/transcriptions$/i
const INTAKE_ALLOWED_RE =
  /^\/api\/v1\/patients\/me\/intake(?:\/(?:route|progress|progress\/latest|progress\/complete|steps|steps\/[^/]+|complete))?$/i
const REPORT_RE = `^\\/api\\/v1\\/patients\\/me\\/reports\\/${UUID_RE}`
const REPORT_EXACT_RE = new RegExp(`${REPORT_RE}$`, 'i')
const REPORT_DOWNLOAD_URL_RE = new RegExp(`${REPORT_RE}\\/download-url$`, 'i')
const DOCUMENTS_PREFIX = '/api/v1/patients/me/documents'
const DOCUMENT_RE = `^\\/api\\/v1\\/patients\\/me\\/documents\\/${UUID_RE}`
const DOCUMENT_EXACT_RE = new RegExp(`${DOCUMENT_RE}$`, 'i')
const DOCUMENT_CONFIRM_RE = new RegExp(`${DOCUMENT_RE}\\/confirm$`, 'i')
const DOCUMENT_DOWNLOAD_URL_RE = new RegExp(`${DOCUMENT_RE}\\/download-url$`, 'i')
const DOCUMENT_FINDINGS_RE = new RegExp(`${DOCUMENT_RE}\\/findings$`, 'i')
const DOCUMENT_TEXT_UPDATE_RE = new RegExp(`${DOCUMENT_RE}\\/(?:text|extracted-text)$`, 'i')
const MISCRIBE_PREFIX = '/api/v1/patients/me/miscribe'
const MISCRIBE_RECORDINGS_PREFIX = `${MISCRIBE_PREFIX}/recordings`
const MISCRIBE_RECORDING_RE = `^\\/api\\/v1\\/patients\\/me\\/miscribe\\/recordings\\/${UUID_RE}`
const MISCRIBE_RECORDING_EXACT_RE = new RegExp(`${MISCRIBE_RECORDING_RE}$`, 'i')
const MISCRIBE_RECORDING_ACTION_RE = new RegExp(
  `${MISCRIBE_RECORDING_RE}\\/(?:all-party-attestation|begin|abandon|upload-url|upload-complete|process)$`,
  'i',
)
const MISCRIBE_RECORDING_SUMMARY_RE = new RegExp(`${MISCRIBE_RECORDING_RE}\\/summary$`, 'i')

export const ALLOWED_PROXY_ROUTES: readonly AllowedProxyRoute[] = [
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['GET', 'POST'],
    match: 'exact',
  },
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['GET', 'DELETE'],
    pathPattern: ASSESSMENT_EXACT_RE,
  },
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['POST'],
    pathPattern: new RegExp(
      `${ASSESSMENT_RE}\\/(?:story|screening\\/complete|prefill|adaptive\\/prepare|adaptive\\/complete|analysis\\/run|documents|documents\\/upload-url|documents\\/text)$`,
      'i',
    ),
  },
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['PATCH'],
    pathPattern: new RegExp(`${ASSESSMENT_RE}\\/(?:screening\\/answers|adaptive\\/answers)$`, 'i'),
  },
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['GET'],
    pathPattern: new RegExp(`${ASSESSMENT_RE}\\/(?:screening\\/state|analysis|documents)$`, 'i'),
  },
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['POST'],
    pathPattern: ASSESSMENT_DOCUMENT_CONFIRM_RE,
  },
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['POST'],
    pathPattern: ASSESSMENT_REPORT_RE,
  },
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['POST'],
    pathPattern: ASSESSMENT_QUESTION_NOTE_LIVE_TRANSCRIPTION_SESSION_RE,
  },
  {
    prefix: '/api/v1/patients/me/assessments',
    methods: ['DELETE'],
    pathPattern: ASSESSMENT_DOCUMENT_RE,
  },
  {
    prefix: '/api/v1/patients/me/reports',
    methods: ['GET'],
    pathPattern: REPORT_EXACT_RE,
  },
  {
    prefix: '/api/v1/patients/me/reports',
    methods: ['POST'],
    pathPattern: REPORT_DOWNLOAD_URL_RE,
  },
  {
    prefix: '/api/v1/patients/me/consents',
    methods: ['GET', 'POST', 'PUT', 'PATCH'],
  },
  {
    prefix: '/api/v1/patients/me/intake',
    methods: ['POST'],
    pathPattern: INTAKE_STORY_AUDIO_UPLOADS_RE,
  },
  {
    prefix: '/api/v1/patients/me/intake',
    methods: ['POST'],
    pathPattern: INTAKE_STORY_TRANSCRIPTIONS_RE,
  },
  { prefix: '/api/v1/patients/me/dashboard', methods: ['GET'] },
  { prefix: '/api/v1/patients/me/symptom-trends', methods: ['GET'] },
  {
    prefix: '/api/v1/patients/me/symptoms',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  },
  {
    prefix: '/api/v1/patients/me/tracked-symptoms',
    methods: ['GET'],
    match: 'exact',
  },
  {
    prefix: '/api/v1/patients/me/tracked-symptoms/checkin',
    methods: ['POST'],
    match: 'exact',
  },
  {
    prefix: '/api/v1/patients/me/tracked-symptoms',
    methods: ['POST'],
    pathPattern:
      /^\/api\/v1\/patients\/me\/tracked-symptoms\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/logs$/i,
  },
  {
    prefix: '/api/v1/patients/me/checkins',
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  },
  { prefix: '/api/v1/patients/me/treatments', methods: ['GET'] },
  { prefix: DOCUMENTS_PREFIX, methods: ['GET'], match: 'exact' },
  { prefix: `${DOCUMENTS_PREFIX}/overview`, methods: ['GET'], match: 'exact' },
  { prefix: `${DOCUMENTS_PREFIX}/text`, methods: ['POST'], match: 'exact' },
  {
    prefix: `${DOCUMENTS_PREFIX}/upload-url`,
    methods: ['POST'],
    match: 'exact',
  },
  {
    prefix: DOCUMENTS_PREFIX,
    methods: ['DELETE'],
    pathPattern: DOCUMENT_EXACT_RE,
  },
  {
    prefix: DOCUMENTS_PREFIX,
    methods: ['POST'],
    pathPattern: DOCUMENT_CONFIRM_RE,
  },
  {
    prefix: DOCUMENTS_PREFIX,
    methods: ['GET'],
    pathPattern: DOCUMENT_DOWNLOAD_URL_RE,
  },
  {
    prefix: DOCUMENTS_PREFIX,
    methods: ['GET'],
    pathPattern: DOCUMENT_FINDINGS_RE,
  },
  {
    prefix: DOCUMENTS_PREFIX,
    methods: ['PATCH'],
    pathPattern: DOCUMENT_TEXT_UPDATE_RE,
  },
  {
    prefix: '/api/v1/patients/me/intake',
    methods: ['GET', 'POST', 'PUT'],
    pathPattern: INTAKE_ALLOWED_RE,
  },
  {
    prefix: `${MISCRIBE_PREFIX}/recording-policy`,
    methods: ['GET'],
    match: 'exact',
  },
  { prefix: MISCRIBE_RECORDINGS_PREFIX, methods: ['GET'], match: 'exact' },
  {
    prefix: `${MISCRIBE_RECORDINGS_PREFIX}/setup`,
    methods: ['POST'],
    match: 'exact',
  },
  {
    prefix: MISCRIBE_RECORDINGS_PREFIX,
    methods: ['GET', 'DELETE'],
    pathPattern: MISCRIBE_RECORDING_EXACT_RE,
  },
  {
    prefix: MISCRIBE_RECORDINGS_PREFIX,
    methods: ['POST'],
    pathPattern: MISCRIBE_RECORDING_ACTION_RE,
  },
  {
    prefix: MISCRIBE_RECORDINGS_PREFIX,
    methods: ['GET'],
    pathPattern: MISCRIBE_RECORDING_SUMMARY_RE,
  },
  { prefix: '/api/v1/patients/me/providers', methods: ['GET'] },
  { prefix: '/api/v1/patients/me', methods: ['GET', 'PATCH'], match: 'exact' },
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
    rawPathname.endsWith('/') || BACKEND_ROOT_PATHS_WITH_TRAILING_SLASH.has(baseTargetPath)
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

  const matchingRoutes = ALLOWED_PROXY_ROUTES.filter((candidate) => matchesRoute(targetPath, candidate))
  if (matchingRoutes.length === 0) {
    return { ok: false, status: 404, code: 'proxy_path_not_allowed' }
  }

  if (!matchingRoutes.some((route) => route.methods.includes(method.toUpperCase()))) {
    return { ok: false, status: 405, code: 'proxy_method_not_allowed' }
  }

  return { ok: true, targetPath }
}

function matchesRoute(targetPath: string, route: AllowedProxyRoute): boolean {
  if (route.pathPattern) return route.pathPattern.test(targetPath)
  if (targetPath === route.prefix) return true
  if (route.match === 'exact' && targetPath === `${route.prefix}/`) return true
  if (route.match === 'exact') return false
  return targetPath.startsWith(`${route.prefix}/`)
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
