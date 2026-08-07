import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { GET } = await import('@/app/[...path]/route')

let exportDir: string | undefined

async function makeExportFile(fileName: string, body: string | Uint8Array): Promise<string> {
  exportDir = await mkdtemp(path.join(tmpdir(), 'spine-patient-web-export-'))
  const filePath = path.join(exportDir, fileName)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, body)
  vi.stubEnv('PATIENT_APP_WEB_EXPORT_DIR', exportDir)
  return filePath
}

describe('patient app export route', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'test-patient-web-csrf-secret-at-least-32-bytes')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    if (exportDir !== undefined) {
      await rm(exportDir, { recursive: true, force: true })
      exportDir = undefined
    }
  })

  it.each([
    // Content-hashed file names are immutable; unhashed ones stay no-store.
    ['Satoshi-Regular.ttf', 'font/ttf', 'no-store'],
    [
      'assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.b4eb097d35f44ed943676fd56f6bdc51.ttf',
      'font/ttf',
      'public, max-age=31536000, immutable',
    ],
    ['Satoshi-Regular.otf', 'font/otf', 'no-store'],
    ['Satoshi-Medium.otf', 'font/otf', 'no-store'],
    ['Satoshi-Bold.otf', 'font/otf', 'no-store'],
    ['ClashDisplay-Semibold.otf', 'font/otf', 'no-store'],
    ['ClashDisplay-Bold.otf', 'font/otf', 'no-store'],
  ])('serves %s with the expected font content type', async (fileName, contentType, cacheControl) => {
    await makeExportFile(fileName, new Uint8Array([0, 1, 2, 3]))

    const response = await GET(new NextRequest(`http://localhost/${fileName}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(contentType)
    expect(response.headers.get('Cache-Control')).toBe(cacheControl)
    expect((await response.arrayBuffer()).byteLength).toBe(4)
  })

  describe('caching and compression', () => {
    const HASHED_BUNDLE = '_expo/static/js/web/entry-bad5c6e2d7e958dcecba56b805dae447.js'
    const BUNDLE_SOURCE = 'const spine = "sense";\n'.repeat(400)

    it('treats everything under _expo/static as content-addressed and immutable', async () => {
      await makeExportFile(HASHED_BUNDLE, BUNDLE_SOURCE)

      const response = await GET(new NextRequest(`http://localhost/${HASHED_BUNDLE}`))

      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
      expect(response.headers.get('Expires')).toBeNull()
      expect(response.headers.get('Pragma')).toBeNull()
    })

    it('brotli-compresses the entry bundle when the client accepts it', async () => {
      await makeExportFile(HASHED_BUNDLE, BUNDLE_SOURCE)

      const response = await GET(
        new NextRequest(`http://localhost/${HASHED_BUNDLE}`, {
          headers: { 'accept-encoding': 'gzip, deflate, br' },
        }),
      )

      expect(response.headers.get('Content-Encoding')).toBe('br')
      expect(response.headers.get('Vary')).toBe('Accept-Encoding')
      const payload = Buffer.from(await response.arrayBuffer())
      expect(payload.byteLength).toBeLessThan(Buffer.byteLength(BUNDLE_SOURCE))
      expect(brotliDecompressSync(payload).toString('utf8')).toBe(BUNDLE_SOURCE)
    })

    it('falls back to gzip when brotli is not offered', async () => {
      await makeExportFile(HASHED_BUNDLE, BUNDLE_SOURCE)

      const response = await GET(
        new NextRequest(`http://localhost/${HASHED_BUNDLE}`, {
          headers: { 'accept-encoding': 'gzip' },
        }),
      )

      expect(response.headers.get('Content-Encoding')).toBe('gzip')
      const payload = Buffer.from(await response.arrayBuffer())
      expect(gunzipSync(payload).toString('utf8')).toBe(BUNDLE_SOURCE)
    })

    it('serves identity bytes when the client offers no supported encoding', async () => {
      await makeExportFile(HASHED_BUNDLE, BUNDLE_SOURCE)

      const response = await GET(new NextRequest(`http://localhost/${HASHED_BUNDLE}`))

      expect(response.headers.get('Content-Encoding')).toBeNull()
      expect(response.headers.get('Vary')).toBe('Accept-Encoding')
      expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe(BUNDLE_SOURCE)
    })

    it('does not compress already-compressed image formats', async () => {
      const image = 'assets/hipaa-shield.9c5ce064832b801274bd55305797c6bb.png'
      await makeExportFile(image, new Uint8Array([1, 2, 3, 4]))

      const response = await GET(
        new NextRequest(`http://localhost/${image}`, {
          headers: { 'accept-encoding': 'gzip, deflate, br' },
        }),
      )

      expect(response.headers.get('Content-Encoding')).toBeNull()
      expect(response.headers.get('Vary')).toBeNull()
      expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable')
      expect((await response.arrayBuffer()).byteLength).toBe(4)
    })

    it('gzips the HTML shell per request while keeping no-store and the nonce injections', async () => {
      await makeExportFile(
        'index.html',
        '<!doctype html><html><head><title>SpineSense</title></head><body></body></html>',
      )

      const response = await GET(
        new NextRequest('http://localhost/', {
          headers: { 'x-nonce': 'test-nonce', 'accept-encoding': 'gzip, deflate, br' },
        }),
      )

      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Content-Encoding')).toBe('gzip')
      expect(response.headers.get('Vary')).toBe('Accept-Encoding')

      const html = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')
      expect(html).toContain('data-patient-web-landing')
      expect(html).toContain('nonce="test-nonce"')
      expect(response.headers.getSetCookie().join('; ')).toContain('spine_patient_csrf=')
    })
  })

  it('injects nonce-compatible web compatibility CSS into exported HTML', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><title>SpineSense</title></head><body><script>window.__app = true</script></body></html>',
    )

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('no-store')

    const html = await response.text()
    expect(html).toContain('<style nonce="test-nonce" data-patient-web-compat>')
    expect(html).not.toContain("font-family: 'Ionicons'")
    expect(html).not.toContain('@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts')
    for (const [family, fileName] of [
      ['Satoshi-Regular', 'Satoshi-Regular.otf'],
      ['Satoshi-Medium', 'Satoshi-Medium.otf'],
      ['Satoshi-Bold', 'Satoshi-Bold.otf'],
      ['ClashDisplay-Semibold', 'ClashDisplay-Semibold.otf'],
      ['ClashDisplay-Bold', 'ClashDisplay-Bold.otf'],
    ]) {
      expect(html).toContain(
        `@font-face { font-family: '${family}'; src: url('/assets/fonts/${fileName}') format('opentype');`,
      )
    }
    expect(html).toContain("font-family: 'Satoshi-Bold', -apple-system")
    expect(html).toContain("font-family: 'ClashDisplay-Bold', -apple-system")
    expect(html).not.toContain(
      'font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display"',
    )
    expect(html).toContain('[class*="r-1my5303"]')
    expect(html).toContain('[data-testid="sticky-tab-wrapper"]')
    expect(html).toContain('<script data-patient-web-style-nonce nonce="test-nonce">')
    expect(html).toContain('d.createElement=function')
    expect(html).toContain('<script nonce="test-nonce">window.__app = true</script>')
    expect(response.headers.getSetCookie().join('; ')).toContain('spine_patient_csrf=')
  })

  it('does not duplicate the runtime style nonce bootstrap', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><script data-patient-web-style-nonce nonce="test-nonce"></script></head><body></body></html>',
    )

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html.match(/data-patient-web-style-nonce/g)).toHaveLength(1)
  })

  it('replaces the exported stock viewport with the zoom-pinned viewport', async () => {
    // Expo's stock single-output template ships exactly this tag.
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" /><title>SpineSense</title></head><body></body></html>',
    )

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    const html = await response.text()

    expect(html.match(/name="viewport"/g)).toHaveLength(1)
    expect(html).toContain('maximum-scale=1')
    expect(html).toContain('viewport-fit=cover')
    expect(html).toContain('interactive-widget=resizes-content')
    expect(html).not.toContain('shrink-to-fit=no')
  })

  it('injects the zoom-pinned viewport when the export ships none', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><title>SpineSense</title></head><body></body></html>',
    )

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html.match(/name="viewport"/g)).toHaveLength(1)
    expect(html).toContain('maximum-scale=1')
  })

  it('pins text inputs to 16px so iOS Safari cannot auto-zoom on focus', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><title>SpineSense</title></head><body></body></html>',
    )

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    const html = await response.text()

    // iOS Safari auto-zooms any focused input rendering below 16px and never
    // zooms back out, which shifts every subsequent screen.
    expect(html).toMatch(/textarea,\s*\n?select\s*{\s*\n?\s*font-size:\s*16px\s*!important/)
    // The enlarged code-entry fields opt out and keep their designed size.
    expect(html).toContain('input:not([id^="ss-zoom-exempt-"])')
  })

  it('keeps textareas scrollable while single-line inputs still truncate', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><title>SpineSense</title></head><body></body></html>',
    )

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    const compatBlock = html.match(/<style[^>]*data-patient-web-compat>([\s\S]*?)<\/style>/)?.[1] ?? ''

    // A story longer than the box must stay reachable: overflow hidden on a
    // textarea removes the scrollbar, wheel, and touch panning entirely.
    const textareaOverflowRules = [...compatBlock.matchAll(/([^{}]+){[^}]*overflow[^}]*}/g)]
      .filter(([, selector]) => /(^|,)\s*textarea\s*(,|$)/m.test((selector ?? '').trim()))
    expect(textareaOverflowRules.map(([rule]) => rule).join('\n')).not.toContain('overflow: hidden')
    expect(compatBlock).toMatch(/textarea\s*{[^}]*overflow-y:\s*auto\s*!important/)

    // The single-line input truncation behavior stays.
    expect(compatBlock).toMatch(/input\s*{[^}]*overflow:\s*hidden\s*!important/)
    expect(compatBlock).toMatch(/input\s*{[^}]*text-overflow:\s*ellipsis\s*!important/)
  })

  it('does not inject compatibility CSS into malformed HTML without a head', async () => {
    await makeExportFile('index.html', '<main>Patient app</main>')

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<main>Patient app</main>')
  })

  it('gives the app shell a share card and keeps it out of the search index', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><title>SpineSense</title></head><body></body></html>',
    )

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    const html = await response.text()

    // Without a preview card every shared link, including the paid ad URLs this
    // domain is the landing page for, renders as a bare URL.
    expect(html).toContain('<meta property="og:title" content="SpineSense: Understand Your Back')
    expect(html).toContain('<meta property="og:image" content="https://spinesense.ai/opengraph-image"')
    expect(html).toContain('<meta property="og:image:width" content="1200"')
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image"')
    expect(html).toMatch(/<meta name="description" content="Describe your back or neck pain/)

    // The stock Expo title is replaced, not appended to.
    expect(html.match(/<title>/g)).toHaveLength(1)
    expect(html).toContain('<title>SpineSense: Understand Your Back or Neck Pain Before Your Appointment</title>')

    // The catch-all answers /dashboard and /results with these same bytes, so
    // the shell must never be indexable. noindex is not paired with a canonical:
    // they are conflicting signals and only noindex removes a URL.
    expect(html).toContain('<meta data-patient-web-seo name="robots" content="noindex, follow"')
    expect(html).not.toContain('rel="canonical"')
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow')
  })

  it('serves the same noindex shell for authenticated-looking paths', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><title>SpineSense</title></head><body></body></html>',
    )

    const response = await GET(new NextRequest('http://localhost/results'))

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, follow')
    expect(await response.text()).toContain('content="noindex, follow"')
  })

  it('does not attach robots directives to static assets', async () => {
    await makeExportFile('Satoshi-Bold.otf', new Uint8Array([0, 1, 2, 3]))

    const response = await GET(new NextRequest('http://localhost/Satoshi-Bold.otf'))

    expect(response.status).toBe(200)
    expect(response.headers.get('X-Robots-Tag')).toBeNull()
  })

  it('does not duplicate the SEO block if it is already present', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><meta data-patient-web-seo name="robots" content="noindex, follow" /></head><body></body></html>',
    )

    const response = await GET(new NextRequest('http://localhost/'))

    expect(response.status).toBe(200)
    expect((await response.text()).match(/data-patient-web-seo/g)).toHaveLength(1)
  })

  it('does not duplicate an existing web compatibility CSS block', async () => {
    await makeExportFile(
      'index.html',
      '<!doctype html><html><head><style data-patient-web-compat>html { font-family: sans-serif; }</style></head><body></body></html>',
    )

    const response = await GET(
      new NextRequest('http://localhost/', {
        headers: { 'x-nonce': 'test-nonce' },
      }),
    )

    expect(response.status).toBe(200)
    const html = await response.text()
    expect(html.match(/data-patient-web-compat/g)).toHaveLength(1)
    expect(html).toContain('<style nonce="test-nonce" data-patient-web-compat>')
  })
})
