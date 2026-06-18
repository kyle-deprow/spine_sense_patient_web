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

  return new NextResponse(body, {
    headers: noStoreHeaders(match.contentType),
  })
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

  const nonce = request.headers.get('x-nonce')
  if (!nonce) return body.toString('utf8')

  return body
    .toString('utf8')
    .replaceAll(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`)
    .replaceAll(/<style(?![^>]*\bnonce=)/g, `<style nonce="${nonce}"`)
}

export async function GET(request: NextRequest) {
  return servePatientApp(request, 'GET')
}

export async function HEAD(request: NextRequest) {
  return servePatientApp(request, 'HEAD')
}
