import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { issueCsrfCookie } from '@/lib/server/auth'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const BLOCKED_EXTENSIONS = new Set(['.map', '.ts', '.tsx', '.env'])

const CONTENT_TYPES = new Map<string, string>([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.otf', 'font/otf'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
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

  const response = new NextResponse(body, {
    headers: noStoreHeaders(match.contentType),
  })
  if (match.contentType.startsWith('text/html')) {
    issueCsrfCookie(response)
  }
  return response
}

const SYSTEM_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'

const WEB_COMPATIBILITY_STYLES = `<style data-patient-web-compat>
@font-face { font-family: 'Satoshi-Regular'; src: local('unused'); font-weight: 400; }
@font-face { font-family: 'Satoshi-Medium'; src: local('unused'); font-weight: 500; }
@font-face { font-family: 'Satoshi-Bold'; src: local('unused'); font-weight: 700; }
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

html,
body {
  font-family: ${SYSTEM_FONT_STACK};
}

input,
textarea {
  box-sizing: border-box !important;
  max-width: 100% !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
}

input:focus,
textarea:focus,
select:focus,
[contenteditable]:focus {
  border-bottom: 2px solid #E8985E !important;
  box-shadow: none !important;
  outline: none !important;
}

[role="button"]:focus,
[role="button"]:focus-visible,
button:focus,
a:focus,
[tabindex]:focus {
  outline: none !important;
}

[data-testid="sticky-tab-wrapper"],
[data-testid="tab-container"],
[data-testid="sticky-tab-wrapper"] > *,
[data-testid="tab-container"] > * {
  border-color: transparent !important;
  border-style: none !important;
  outline: none !important;
}
</style>`

function injectWebCompatibilityStyles(html: string): string {
  if (!html.includes('</head>')) {
    return html
  }
  if (html.includes('data-patient-web-compat')) {
    return html
  }
  return html.replace('</head>', `${WEB_COMPATIBILITY_STYLES}</head>`)
}

function injectStyleNonceBootstrap(html: string, nonce: string): string {
  if (!html.includes('</head>') || html.includes('data-patient-web-style-nonce')) {
    return html
  }

  const script = `<script data-patient-web-style-nonce nonce="${nonce}">(function(){var n=${JSON.stringify(nonce)};var d=document;var c=d.createElement.bind(d);d.createElement=function(t,o){var e=c(t,o);if(typeof t==="string"&&t.toLowerCase()==="style"&&e&&e.setAttribute&&!e.getAttribute("nonce")){e.setAttribute("nonce",n);}return e;};})();</script>`
  return html.replace('</head>', `${script}</head>`)
}

async function readResponseBody(
  filePath: string,
  contentType: string,
  request: NextRequest,
): Promise<string | ArrayBuffer> {
  const body = await readFile(filePath)
  if (!contentType.startsWith('text/html')) {
    return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer
  }

  const html = injectWebCompatibilityStyles(body.toString('utf8'))
  const nonce = request.headers.get('x-nonce')
  if (!nonce) return html

  return injectStyleNonceBootstrap(html, nonce)
    .replaceAll(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
    .replaceAll(/<style(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`)
}

export async function GET(request: NextRequest) {
  return servePatientApp(request, 'GET')
}

export async function HEAD(request: NextRequest) {
  return servePatientApp(request, 'HEAD')
}
