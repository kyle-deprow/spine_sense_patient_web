import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getPatientWebConfig, parseAllowedOrigins } from '@/lib/server/config'

describe('patient web config', () => {
  beforeEach(() => {
    vi.stubEnv('BACKEND_INTERNAL_URL', 'https://api.example.test')
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'test-patient-web-csrf-secret')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts Azure Bicep boolean casing for Google OAuth BAA confirmation', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-web-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-web-client-secret')
    vi.stubEnv('GOOGLE_OAUTH_BAA_CONFIRMED', 'True')

    expect(getPatientWebConfig().googleOauthBaaConfirmed).toBe(true)
  })

  it('fails closed when Google OAuth is configured without production BAA confirmation', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-web-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-web-client-secret')
    vi.stubEnv('GOOGLE_OAUTH_BAA_CONFIRMED', 'false')

    expect(() => getPatientWebConfig()).toThrow(
      'Google OAuth production traffic requires GOOGLE_OAUTH_BAA_CONFIRMED=true',
    )
  })

  it('does not claim a BAA is required for an explicitly local production build runtime', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('ENVIRONMENT', 'local')
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://127.0.0.1:8010')
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', 'http://127.0.0.1:43101')
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-web-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-web-client-secret')
    vi.stubEnv('GOOGLE_OAUTH_BAA_CONFIRMED', 'false')

    expect(getPatientWebConfig().environment).toBe('local')
  })

  it.each([undefined, '', '   '])(
    'fails closed on Google OAuth when the raw environment is unknown (%s)',
    (environment) => {
      const originalEnvironment = process.env.ENVIRONMENT
      if (environment === undefined) delete process.env.ENVIRONMENT
      else vi.stubEnv('ENVIRONMENT', environment)
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', 'https://patient.example.test')
      vi.stubEnv('GOOGLE_CLIENT_ID', 'google-web-client-id')
      vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-web-client-secret')
      vi.stubEnv('GOOGLE_OAUTH_BAA_CONFIRMED', 'false')

      try {
        expect(() => getPatientWebConfig()).toThrow(
          'Google OAuth production traffic requires GOOGLE_OAUTH_BAA_CONFIRMED=true',
        )
      } finally {
        if (environment === undefined) {
          if (originalEnvironment === undefined) delete process.env.ENVIRONMENT
          else process.env.ENVIRONMENT = originalEnvironment
        }
      }
    },
  )

  it('fails closed when the Google OAuth BAA flag is not a boolean', () => {
    vi.stubEnv('GOOGLE_OAUTH_BAA_CONFIRMED', 'yes')

    expect(() => getPatientWebConfig()).toThrow('GOOGLE_OAUTH_BAA_CONFIRMED must be true or false')
  })

  it('includes the explicit Front Door origin guard configuration', () => {
    vi.stubEnv('ENVIRONMENT', 'production')
    vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', 'enforce')
    vi.stubEnv('AZURE_FRONT_DOOR_ID', '12345678-1234-1234-1234-123456789abc')

    expect(getPatientWebConfig()).toMatchObject({
      environment: 'production',
      frontDoorOriginGuardMode: 'enforce',
      azureFrontDoorId: '12345678-1234-1234-1234-123456789abc',
    })
  })

  it('fails startup config validation for an active guard without a canonical ID', () => {
    vi.stubEnv('ENVIRONMENT', 'staging')
    vi.stubEnv('FRONT_DOOR_ORIGIN_GUARD_MODE', 'audit')
    vi.stubEnv('AZURE_FRONT_DOOR_ID', '')

    expect(() => getPatientWebConfig()).toThrow(
      'AZURE_FRONT_DOOR_ID is required when the Front Door origin guard is active',
    )
  })

  it.each([undefined, '', '   '])('rejects an unset or blank allowed-origin list (%s)', (value) => {
    expect(() => parseAllowedOrigins(value, 'test')).toThrow('PATIENT_WEB_ALLOWED_ORIGINS')
  })

  it.each([
    '*',
    'https://*.example.test',
    'https://user:pass@patient.example.test',
    'https://patient.example.test/path',
    'https://patient.example.test?query=1',
    'https://patient.example.test#fragment',
    'https://patient.example.test/',
    'http://patient.example.test',
  ])('rejects a non-exact or insecure allowed origin: %s', (origin) => {
    expect(() => parseAllowedOrigins(origin, 'production')).toThrow('PATIENT_WEB_ALLOWED_ORIGINS')
  })

  it('accepts exact HTTPS origins and deduplicates them', () => {
    expect(
      parseAllowedOrigins(
        'https://patient.example.test, https://patient.example.test https://other.example.test:8443',
        'production',
      ),
    ).toEqual(['https://patient.example.test', 'https://other.example.test:8443'])
  })

  it.each(['local', 'development', 'test', 'e2e'])(
    'accepts HTTP loopback in explicit %s',
    (environment) => {
      expect(
        parseAllowedOrigins(
          'http://localhost:3000 http://127.0.0.1:43101 http://[::1]:43101',
          environment,
        ),
      ).toEqual(['http://localhost:3000', 'http://127.0.0.1:43101', 'http://[::1]:43101'])
    },
  )

  it.each([undefined, '', 'production', 'staging'])(
    'rejects HTTP loopback in hosted or unknown %s',
    (environment) => {
      expect(() => parseAllowedOrigins('http://127.0.0.1:43101', environment)).toThrow(
        'PATIENT_WEB_ALLOWED_ORIGINS',
      )
    },
  )
})
