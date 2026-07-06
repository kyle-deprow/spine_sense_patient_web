import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { GET } = await import('@/app/[[...path]]/route')

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
  afterEach(async () => {
    vi.unstubAllEnvs()
    if (exportDir !== undefined) {
      await rm(exportDir, { recursive: true, force: true })
      exportDir = undefined
    }
  })

  it.each([
    ['Satoshi-Regular.ttf', 'font/ttf'],
    [
      'assets/node_modules/@expo/vector-icons/build/vendor/react-native-vector-icons/Fonts/Ionicons.b4eb097d35f44ed943676fd56f6bdc51.ttf',
      'font/ttf',
    ],
    ['Satoshi-Regular.otf', 'font/otf'],
  ])('serves %s with the expected font content type', async (fileName, contentType) => {
    await makeExportFile(fileName, new Uint8Array([0, 1, 2, 3]))

    const response = await GET(new NextRequest(`http://localhost/${fileName}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(contentType)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect((await response.arrayBuffer()).byteLength).toBe(4)
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
    expect(html).toContain('[data-testid="sticky-tab-wrapper"]')
    expect(html).toContain('<script data-patient-web-style-nonce nonce="test-nonce">')
    expect(html).toContain('d.createElement=function')
    expect(html).toContain('<script nonce="test-nonce">window.__app = true</script>')
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
