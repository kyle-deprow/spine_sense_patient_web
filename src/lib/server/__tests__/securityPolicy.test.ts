import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import nextConfig from '../../../../next.config'
import { middleware } from '@/middleware'
import { buildPermissionsPolicyHeader, getStorageConnectOrigins } from '@/lib/server/securityPolicy'

async function staticPermissionsPolicy(): Promise<string | undefined> {
  const headerSets = await nextConfig.headers?.()
  return headerSets?.[0]?.headers.find((header) => header.key === 'Permissions-Policy')?.value
}

describe('patient web Permissions-Policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('always allows same-origin microphone access for capability-detected browser voice support', () => {
    expect(buildPermissionsPolicyHeader()).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
    )
  })

  it('includes the Sharp native runtime in the standalone production trace', () => {
    expect(nextConfig.outputFileTracingIncludes?.['/*']).toContain(
      './node_modules/.pnpm/@img+sharp-libvips-*/**/*',
    )
    expect(nextConfig.outputFileTracingIncludes?.['/*']).toContain(
      './node_modules/.pnpm/@img+sharp-*/node_modules/@img/sharp-libvips-*/**/*',
    )
    expect(nextConfig.outputFileTracingIncludes?.['/*']).toContain(
      './node_modules/.pnpm/sharp@0.35.0/node_modules/@img/sharp-libvips-*/**/*',
    )
  })

  it.each(['development', 'test', 'e2e', 'staging', 'production', 'preview', ''])(
    'does not gate the microphone header on the %j app environment',
    (environment) => {
      vi.stubEnv('PATIENT_APP_ENVIRONMENT', environment)

      expect(buildPermissionsPolicyHeader()).toBe(
        'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
      )
    },
  )

  it.each(['test', 'production'])('wires the same policy into %s static and runtime headers', async (environment) => {
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', environment)
    vi.stubEnv(
      'NEXT_PUBLIC_STORAGE_DOMAINS',
      environment === 'production' ? 'https://storage.example.test' : 'http://127.0.0.1:9000',
    )

    expect(await staticPermissionsPolicy()).toContain('microphone=(self)')
    const response = middleware(new NextRequest('http://localhost/login'))
    expect(response.headers.get('Permissions-Policy')).toContain('microphone=(self)')
  })

  it('returns only the exact storage connect origins configured for patient web', () => {
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'production')
    vi.stubEnv(
      'NEXT_PUBLIC_STORAGE_DOMAINS',
      'https://storage.example.test https://cdn.example.test:8443 https://storage.example.test',
    )

    expect(getStorageConnectOrigins()).toEqual(['https://storage.example.test', 'https://cdn.example.test:8443'])
  })

  it('allows production audio uploads with exact HTTPS storage origins and no local MinIO origin', () => {
    expect(getStorageConnectOrigins('https://patientdocuments.blob.core.windows.net', 'production')).toEqual([
      'https://patientdocuments.blob.core.windows.net',
    ])
  })

  it('requires the configured local upload origin in local environments', () => {
    expect(() => getStorageConnectOrigins('https://storage.example.test', 'test', 'http://127.0.0.1:9000')).toThrow(
      'NEXT_PUBLIC_STORAGE_DOMAINS must include PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN',
    )
  })

  it.each([
    'https://storage.example.test/path',
    'https://storage.example.test?token=private',
    'https://user:pass@storage.example.test',
    'https://*.s3.amazonaws.com',
    'https://*.storage.googleapis.com',
  ])('rejects non-origin storage connect source %j', (origin) => {
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'production')
    vi.stubEnv('NEXT_PUBLIC_STORAGE_DOMAINS', origin)

    expect(() => getStorageConnectOrigins()).toThrow('Patient web storage connect origins must be exact origins')
  })
})
