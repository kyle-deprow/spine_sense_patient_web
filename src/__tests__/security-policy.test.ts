import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildPermissionsPolicyHeader,
  isWebVoiceDevEnabled,
} from '@/lib/server/securityPolicy'

describe('permissions policy', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('blocks the microphone by default', () => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', '')
    expect(isWebVoiceDevEnabled()).toBe(false)
    expect(buildPermissionsPolicyHeader()).toContain('microphone=()')
    expect(buildPermissionsPolicyHeader()).not.toContain('microphone=(self)')
  })

  it('allows the microphone when the dev flag is set', () => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'true')
    expect(isWebVoiceDevEnabled()).toBe(true)
    expect(buildPermissionsPolicyHeader()).toContain('microphone=(self)')
  })

  it('treats any non-"true" value as disabled', () => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'false')
    expect(isWebVoiceDevEnabled()).toBe(false)
    expect(buildPermissionsPolicyHeader()).toContain('microphone=()')
    expect(buildPermissionsPolicyHeader()).not.toContain('microphone=(self)')
  })

  it('does not depend on NODE_ENV (local patient web runs production-mode)', () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'true')
    expect(buildPermissionsPolicyHeader()).toContain('microphone=(self)')
  })

  it('preserves the other locked-down directives', () => {
    vi.stubEnv('EXPO_PUBLIC_ENABLE_WEB_VOICE', 'true')
    const header = buildPermissionsPolicyHeader()
    expect(header).toContain('camera=()')
    expect(header).toContain('geolocation=()')
    expect(header).toContain('payment=()')
    expect(header).toContain('usb=()')
    expect(header).toContain('browsing-topics=()')
  })
})
