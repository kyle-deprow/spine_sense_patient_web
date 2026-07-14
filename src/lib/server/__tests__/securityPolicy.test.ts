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

  it.each(['', 'false', 'TRUE', ' true '])('disables local microphone when the flag is %j', (value) => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', value)
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'test')

    expect(isWebVoiceEnabled()).toBe(false)
    expect(buildPermissionsPolicyHeader()).toContain('microphone=()')
    expect(buildPermissionsPolicyHeader()).not.toContain('microphone=(self)')
  })

  it('enables only the microphone for same-origin use locally when the flag is exactly true', () => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'true')
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'development')

    expect(isWebVoiceEnabled()).toBe(true)
    expect(buildPermissionsPolicyHeader()).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
    )
  })

  it.each(['preview', ''])('fails closed when voice is enabled in %j', (environment) => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'true')
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', environment)

    expect(() => isWebVoiceEnabled()).toThrow(
      'EXPO_PUBLIC_ENABLE_WEB_VOICE=true requires PATIENT_APP_ENVIRONMENT to be development, test, e2e, staging, or production',
    )
    expect(() => buildPermissionsPolicyHeader()).toThrow()
  })

  it.each(['preview', ''])('fails closed without throwing when voice is not enabled in %j', (environment) => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', '')
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', environment)
    vi.stubEnv('NEXT_PUBLIC_STORAGE_DOMAINS', 'https://storage.example.test')

    expect(isWebVoiceEnabled()).toBe(false)
    expect(buildPermissionsPolicyHeader()).toContain('microphone=()')
    expect(getStorageConnectOrigins()).toEqual(['https://storage.example.test'])
  })

  it.each(['development', 'test', 'e2e'])(
    'requires explicit voice opt-in in %s builds',
    (environment) => {
      expect(isWebVoiceEnabled('true', environment)).toBe(true)
      expect(isWebVoiceEnabled('', environment)).toBe(false)
    },
  )

  it.each(['staging', 'production'])('enables same-origin microphone access by default in %s', (environment) => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', '')
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', environment)

    expect(isWebVoiceEnabled()).toBe(true)
    expect(buildPermissionsPolicyHeader()).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
    )
  })

  it('allows same-origin microphone access in production even when the legacy flag is false', () => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'false')
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', 'production')

    expect(buildPermissionsPolicyHeader()).toBe(
      'camera=(), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()',
    )
  })

  it.each([
    ['test', '', 'microphone=()'],
    ['test', 'true', 'microphone=(self)'],
    ['production', '', 'microphone=(self)'],
  ])('wires %s/%j into static and runtime headers', async (environment, value, expected) => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', value)
    vi.stubEnv('PATIENT_APP_ENVIRONMENT', environment)
    vi.stubEnv(
      'NEXT_PUBLIC_STORAGE_DOMAINS',
      environment === 'production' ? 'https://storage.example.test' : 'http://127.0.0.1:9000',
    )

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

  it('allows production voice with exact HTTPS storage origins and no local MinIO origin', () => {
    expect(
      getStorageConnectOrigins('https://patientdocuments.blob.core.windows.net', 'production', undefined, ''),
    ).toEqual(['https://patientdocuments.blob.core.windows.net'])
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
