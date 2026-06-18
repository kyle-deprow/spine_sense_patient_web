import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const { GET } = await import('@/app/[[...path]]/route')

let exportDir: string | undefined

async function makeExportFile(fileName: string, body: string | Uint8Array): Promise<string> {
  exportDir = await mkdtemp(path.join(tmpdir(), 'spine-patient-web-export-'))
  const filePath = path.join(exportDir, fileName)
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
    ['Satoshi-Regular.otf', 'font/otf'],
  ])('serves %s with the expected font content type', async (fileName, contentType) => {
    await makeExportFile(fileName, new Uint8Array([0, 1, 2, 3]))

    const response = await GET(new NextRequest(`http://localhost/${fileName}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(contentType)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect((await response.arrayBuffer()).byteLength).toBe(4)
  })
})
