import { afterEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import nextConfig from '../../../../next.config'
import { middleware } from '@/middleware'
import {
  buildPermissionsPolicyHeader,
  getStorageConnectOrigins,
  isWebVoiceEnabled,
} from '@/lib/server/securityPolicy'

async function staticPermissionsPolicy(): Promise<string | undefined> {
  const headerSets = await nextConfig.headers?.()
  return headerSets?.[0]?.headers.find((header) => header.key === 'Permissions-Policy')?.value
}

describe('patient web Permissions-Policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it.each(['', 'false', 'TRUE', ' true '])('disables the microphone when the flag is %j', (value) => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', value)

    expect(isWebVoiceEnabled()).toBe(false)
    expect(buildPermissionsPolicyHeader()).toContain('microphone=()')
    expect(buildPermissionsPolicyHeader()).not.toContain('microphone=(self)')
  })

  it('enables only the microphone for same-origin use when the flag is exactly true', () => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'true')
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'development')

    expect(isWebVoiceEnabled()).toBe(true)
    expect(buildPermissionsPolicyHeader()).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
    )
  })

  it.each(['staging', 'production', 'preview', ''])(
    'fails closed when voice is enabled in %j',
    (environment) => {
      vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'true')
      vi.stubEnv('PATIENT_APP_ENVIRONMENT', environment)

      expect(() => isWebVoiceEnabled()).toThrow(
        'EXPO_PUBLIC_ENABLE_WEB_VOICE=true requires PATIENT_APP_ENVIRONMENT to be development, test, or e2e',
      )
      expect(() => buildPermissionsPolicyHeader()).toThrow()
    },
  )

  it.each(['development', 'test', 'e2e'])('allows voice in explicit %s builds', (environment) => {
    expect(isWebVoiceEnabled('true', environment)).toBe(true)
  })

  it.each([
    ['', 'microphone=()'],
    ['true', 'microphone=(self)'],
  ])('wires the %j gate into static and runtime headers', async (value, expected) => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', value)
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'test')

    expect(await staticPermissionsPolicy()).toContain(expected)
    const response = middleware(new NextRequest('http://localhost/login'))
    expect(response.headers.get('Permissions-Policy')).toContain(expected)
  })

  it('returns only the exact storage connect origins configured for patient web', () => {
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'test')
    vi.stubEnv(
      'NEXT_PUBLIC_STORAGE_DOMAINS',
      'https://storage.example.test https://cdn.example.test:8443 https://storage.example.test',
    )

    expect(getStorageConnectOrigins()).toEqual(['https://storage.example.test', 'https://cdn.example.test:8443'])
  })

  it.each([
    'https://storage.example.test/path',
    'https://storage.example.test?token=private',
    'https://user:pass@storage.example.test',
    'https://*.s3.amazonaws.com',
    'https://*.storage.googleapis.com',
  ])('rejects non-origin storage connect source %j', (origin) => {
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'test')
    vi.stubEnv('NEXT_PUBLIC_STORAGE_DOMAINS', origin)

    expect(() => getStorageConnectOrigins()).toThrow('Patient web storage connect origins must be exact origins')
  })
})
