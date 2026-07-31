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
    'does not gate the microphone header on the %j deployment environment',
    (environment) => {
      vi.stubEnv('ENVIRONMENT', environment)

      expect(buildPermissionsPolicyHeader()).toBe(
        'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
      )
    },
  )

  it.each(['test', 'production'])('wires the same policy into %s static and runtime headers', async (environment) => {
    const isLocalStack = environment !== 'production'
    vi.stubEnv('ENVIRONMENT', environment)
    vi.stubEnv('NEXT_PUBLIC_STORAGE_DOMAINS', isLocalStack ? 'http://127.0.0.1:9000' : 'https://storage.example.test')
    vi.stubEnv('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN', isLocalStack ? 'http://127.0.0.1:9000' : '')

    expect(await staticPermissionsPolicy()).toContain('microphone=(self)')
    const response = middleware(new NextRequest('http://localhost/login'))
    expect(response.headers.get('Permissions-Policy')).toContain('microphone=(self)')
  })

  it('returns only the exact storage connect origins configured for patient web', () => {
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN', '')
    vi.stubEnv(
      'NEXT_PUBLIC_STORAGE_DOMAINS',
      'https://storage.example.test https://cdn.example.test:8443 https://storage.example.test',
    )

    expect(getStorageConnectOrigins()).toEqual(['https://storage.example.test', 'https://cdn.example.test:8443'])
  })

  it('allows production audio uploads with exact HTTPS storage origins and no local MinIO origin', () => {
    expect(getStorageConnectOrigins('https://patientdocuments.blob.core.windows.net', 'production', '')).toEqual([
      'https://patientdocuments.blob.core.windows.net',
    ])
  })

  it('requires the configured local upload origin in local environments', () => {
    expect(() => getStorageConnectOrigins('https://storage.example.test', 'test', 'http://127.0.0.1:9000')).toThrow(
      'NEXT_PUBLIC_STORAGE_DOMAINS must include PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN',
    )
  })

  // ── Storage-configuration rules, not tier-name rules ────────────────────
  // The tier and the storage backend are orthogonal. These four cases pin the
  // rule that replaced the old hardcoded development/test/e2e tier list.

  it('rule 1: rejects a local MinIO origin that is not an exact origin', () => {
    expect(() =>
      getStorageConnectOrigins('http://127.0.0.1:9000', 'local', 'http://127.0.0.1:9000/uploads'),
    ).toThrow('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN must be an exact URL origin')
  })

  it.each(['local', 'e2e', 'test', 'development', ''])(
    'rule 1: requires the configured local MinIO origin to be present in the %j environment',
    (environment) => {
      expect(() =>
        getStorageConnectOrigins('https://storage.example.test', environment, 'http://127.0.0.1:9000'),
      ).toThrow('NEXT_PUBLIC_STORAGE_DOMAINS must include PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN')
    },
  )

  it.each(['staging', 'production', 'prod'])(
    'rule 1 + rule 3: a hosted %s tier rejects a loopback MinIO origin outright',
    (environment) => {
      expect(() =>
        getStorageConnectOrigins('https://storage.example.test', environment, 'http://127.0.0.1:9000'),
      ).toThrow('Insecure patient web storage connect origin is not allowed: http://127.0.0.1:9000')
    },
  )

  it.each(['local', 'e2e', 'test', 'development', ''])(
    'rule 2: requires the local MinIO origin whenever an http origin is configured in %j',
    (environment) => {
      expect(() =>
        getStorageConnectOrigins('https://storage.example.test http://127.0.0.1:9000', environment, ''),
      ).toThrow('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN is required for local patient web audio uploads')
    },
  )

  it.each(['http://storage.example.test', 'http://192.168.1.10:9000', 'http://minio.internal:9000'])(
    'rule 2: rejects the non-loopback http origin %j even on a local stack',
    (origin) => {
      expect(() => getStorageConnectOrigins(origin, 'local', origin)).toThrow(
        'Insecure patient web storage connect origin is not allowed',
      )
    },
  )

  it.each(['http://127.0.0.1:9000', 'http://localhost:9000', 'http://[::1]:9000'])(
    'rule 2: accepts the loopback upload origin %j on a fully configured local stack',
    (origin) => {
      expect(getStorageConnectOrigins(`https://storage.example.test ${origin}`, 'local', origin)).toEqual([
        'https://storage.example.test',
        origin,
      ])
    },
  )

  it.each(['production', 'prod', 'staging'])('rule 3: rejects loopback http origins in %s', (environment) => {
    expect(() =>
      getStorageConnectOrigins(
        'https://storage.example.test http://127.0.0.1:9000',
        environment,
        'http://127.0.0.1:9000',
      ),
    ).toThrow('Insecure patient web storage connect origin is not allowed: http://127.0.0.1:9000')
  })

  it('rule 4: deployed dev runs ENVIRONMENT=development on HTTPS origins with no MinIO origin', () => {
    const deployedDevOrigins =
      'https://stphissaispinedev.blob.core.windows.net https://strawssaispinedev.blob.core.windows.net https://stastssaispinedev.blob.core.windows.net'

    expect(getStorageConnectOrigins(deployedDevOrigins, 'development', '')).toEqual([
      'https://stphissaispinedev.blob.core.windows.net',
      'https://strawssaispinedev.blob.core.windows.net',
      'https://stastssaispinedev.blob.core.windows.net',
    ])
    // Same thing again through process.env, which is how the container actually
    // starts: ENVIRONMENT=development, HTTPS blob origins, MinIO var absent.
    vi.stubEnv('ENVIRONMENT', 'development')
    vi.stubEnv('NEXT_PUBLIC_STORAGE_DOMAINS', deployedDevOrigins)
    vi.stubEnv('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN', '')

    expect(getStorageConnectOrigins()).toEqual(deployedDevOrigins.split(' '))
  })

  it.each(['development', 'test', 'e2e', 'staging', 'production', 'prod', 'local', ''])(
    'rule 4: an all-HTTPS deployment needs no MinIO origin in %j',
    (environment) => {
      expect(getStorageConnectOrigins('https://storage.example.test', environment, '')).toEqual([
        'https://storage.example.test',
      ])
    },
  )

  it.each([
    'https://storage.example.test/path',
    'https://storage.example.test?token=private',
    'https://user:pass@storage.example.test',
    'https://*.s3.amazonaws.com',
    'https://*.storage.googleapis.com',
  ])('rejects non-origin storage connect source %j', (origin) => {
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('PATIENT_WEB_LOCAL_MINIO_PUBLIC_ORIGIN', '')
    vi.stubEnv('NEXT_PUBLIC_STORAGE_DOMAINS', origin)

    expect(() => getStorageConnectOrigins()).toThrow('Patient web storage connect origins must be exact origins')
  })
})
