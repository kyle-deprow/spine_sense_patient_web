import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getPatientWebConfig } from '@/lib/server/config'

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
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-web-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-web-client-secret')
    vi.stubEnv('GOOGLE_OAUTH_BAA_CONFIRMED', 'True')

    expect(getPatientWebConfig().googleOauthBaaConfirmed).toBe(true)
  })

  it('fails closed when Google OAuth is configured without production BAA confirmation', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('GOOGLE_CLIENT_ID', 'google-web-client-id')
    vi.stubEnv('GOOGLE_CLIENT_SECRET', 'google-web-client-secret')
    vi.stubEnv('GOOGLE_OAUTH_BAA_CONFIRMED', 'false')

    expect(() => getPatientWebConfig()).toThrow(
      'Google OAuth production traffic requires GOOGLE_OAUTH_BAA_CONFIRMED=true',
    )
  })

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
})
