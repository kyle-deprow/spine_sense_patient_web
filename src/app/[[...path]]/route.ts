import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BLOCKED_EXTENSIONS = new Set(['.map', '.ts', '.tsx', '.env'])

const CONTENT_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
  ['.otf', 'font/otf'],
])

function exportDir(): string {
  return path.resolve(
    process.env.PATIENT_APP_WEB_EXPORT_DIR ?? path.join(process.cwd(), 'patient-app-export'),
  )
}

function noStoreHeaders(contentType?: string): Headers {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    Expires: '0',
    Pragma: 'no-cache',
  })
  if (contentType) headers.set('Content-Type', contentType)
  return headers
}

function isInsideExportDir(root: string, filePath: string): boolean {
  const relativePath = path.relative(root, filePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function toSafeRelativePath(pathname: string): string | null {
  try {
    const decodedPath = decodeURIComponent(pathname)
    const normalizedPath = path.normalize(decodedPath).replace(/^[/\\]+/, '')
    return normalizedPath === '' ? 'index.html' : normalizedPath
  } catch {
    return null
  }
}

async function findFile(root: string, pathname: string): Promise<{ filePath: string; contentType: string } | null> {
  const relativePath = toSafeRelativePath(pathname)
  if (!relativePath) return null

  const candidates = [path.resolve(root, relativePath)]

  if (!path.extname(relativePath)) {
    candidates.push(path.resolve(root, `${relativePath}.html`))
    candidates.push(path.resolve(root, relativePath, 'index.html'))
    candidates.push(path.resolve(root, 'index.html'))
  }

  for (const candidate of candidates) {
    if (!isInsideExportDir(root, candidate)) continue

    try {
      const fileStat = await stat(candidate)
      if (!fileStat.isFile()) continue

      const extension = path.extname(candidate)
      if (BLOCKED_EXTENSIONS.has(extension)) return null
      return {
        filePath: candidate,
        contentType: CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
      }
    } catch (error) {
      const code =
        error instanceof Error && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined
      if (code !== 'ENOENT' && code !== 'EISDIR') throw error
    }
  }

  return null
}

async function servePatientApp(request: NextRequest, method: 'GET' | 'HEAD') {
  if (request.nextUrl.pathname === '/api' || request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'api_route_not_found' },
      { status: 404, headers: noStoreHeaders('application/json') },
    )
  }

  const match = await findFile(exportDir(), request.nextUrl.pathname)

  if (!match) {
    return NextResponse.json(
      { error: 'patient_app_export_not_found' },
      { status: 404, headers: noStoreHeaders('application/json') },
    )
  }

  const body = method === 'HEAD' ? null : await readResponseBody(match.filePath, match.contentType, request)

  return new NextResponse(body, {
    headers: noStoreHeaders(match.contentType),
  })
}

/**
 * System sans-serif font stack used as a web fallback for the custom native
 * fonts referenced in the Expo web export (Satoshi-*, ClashDisplay-*).
 * SF Pro is preferred (macOS/iOS), then Segoe UI (Windows), then Roboto
 * (Android/ChromeOS), then generic sans-serif.
 */
const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

const WEB_FONT_FACE_STYLES = `<style data-web-fonts>
/* ── Icon fonts (Expo injects these via JS, but CSP may block dynamic style injection) ── */
@font-face {
  font-family: 'Ionicons';
  src: url('/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.b4eb097d35f44ed943676fd56f6bdc51.ttf') format('truetype');
  font-display: block;
}
@font-face {
  font-family: 'MaterialCommunityIcons';
  src: url('/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialCommunityIcons.6e435534bd35da5fef04168860a9b8fa.ttf') format('truetype');
  font-display: block;
}
@font-face {
  font-family: 'MaterialIcons';
  src: url('/assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/MaterialIcons.4e85bc9ebe07e0340c9c4fc2f6c38908.ttf') format('truetype');
  font-display: block;
}

/* ── Text font fallbacks (native custom fonts → system sans-serif) ── */
@font-face { font-family: 'Satoshi-Regular'; src: local('unused'); font-weight: 400; }
@font-face { font-family: 'Satoshi-Medium';  src: local('unused'); font-weight: 500; }
@font-face { font-family: 'Satoshi-Bold';    src: local('unused'); font-weight: 700; }
@font-face { font-family: 'ClashDisplay-Semibold'; src: local('unused'); font-weight: 600; }

[style*="font-family"][style*="Satoshi-Regular"],
[class*="r-ctd730"] {
  font-family: ${SYSTEM_FONT_STACK} !important;
  font-weight: 400;
}
[style*="font-family"][style*="Satoshi-Medium"],
[class*="r-18jse50"] {
  font-family: ${SYSTEM_FONT_STACK} !important;
  font-weight: 500;
}
[style*="font-family"][style*="Satoshi-Bold"] {
  font-family: ${SYSTEM_FONT_STACK} !important;
  font-weight: 700;
}
[style*="font-family"][style*="ClashDisplay"],
[class*="r-1ai7t6e"] {
  font-family: ${SYSTEM_FONT_STACK} !important;
  font-weight: 600;
}

html, body {
  font-family: ${SYSTEM_FONT_STACK};
}

/* ── Web input overflow fix (text bleeds past container on web) ── */
input, textarea {
  max-width: 100% !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  box-sizing: border-box !important;
}

/* ── Web focus overrides (native mobile has no browser outline) ── */
input:focus,
textarea:focus,
select:focus,
[contenteditable]:focus {
  outline: none !important;
  box-shadow: none !important;
  border-bottom: 2px solid #E8985E !important;
}

/* Remove outline from non-input pressable/tappable elements too */
[role="button"]:focus,
[role="button"]:focus-visible,
button:focus,
a:focus,
[tabindex]:focus {
  outline: none !important;
}

/* ── Assessment results tab bar ──
   Tailwind Preflight sets *, :before, :after { border: 0 solid #e5e7eb }
   RNW View base sets border: 0 solid black.
   The cascade interaction leaves border-style: solid and border-color: #e5e7eb
   on all elements, making a thin grey outline visible on transparent-background
   containers against dark backgrounds. Kill it surgically here. */
[data-testid="sticky-tab-wrapper"],
[data-testid="tab-container"],
[data-testid="sticky-tab-wrapper"] > *,
[data-testid="tab-container"] > * {
  border-style: none !important;
  border-color: transparent !important;
  outline: none !important;
}
</style>`

async function readResponseBody(
  filePath: string,
  contentType: string,
  request: NextRequest,
): Promise<string | ArrayBuffer> {
  const body = await readFile(filePath)
  if (!contentType.startsWith('text/html')) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  }

  let html = body.toString('utf8')

  // Inject web font-face fallbacks into the <head>
  html = html.replace('</head>', `${WEB_FONT_FACE_STYLES}</head>`)

  const nonce = request.headers.get('x-nonce')
  if (!nonce) return html

  return html
    .replaceAll(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
    .replaceAll(/<style(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`)
}

export async function GET(request: NextRequest) {
  return servePatientApp(request, 'GET')
}

export async function HEAD(request: NextRequest) {
  return servePatientApp(request, 'HEAD')
}
