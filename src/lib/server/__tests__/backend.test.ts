import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BACKEND_TIMEOUT_MS,
  BackendUnavailableError,
  LONG_BACKEND_TIMEOUT_MS,
  backendFetch,
} from '@/lib/server/backend'

describe('backendFetch', () => {
  beforeEach(() => {
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', 'test-patient-web-csrf-secret-at-least-32-bytes')
    vi.stubEnv('BACKEND_INTERNAL_URL', 'http://backend.internal')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses the default 30 second timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

    await backendFetch('/api/v1/health')

    expect(timeoutSpy).toHaveBeenCalledWith(BACKEND_TIMEOUT_MS)
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/api/v1/health', 'http://backend.internal'),
      expect.objectContaining({ cache: 'no-store' }),
    )
  })

  it('allows a narrow caller-selected long timeout', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')

    await backendFetch('/api/v1/slow', {}, { timeoutMs: LONG_BACKEND_TIMEOUT_MS })

    expect(timeoutSpy).toHaveBeenCalledWith(LONG_BACKEND_TIMEOUT_MS)
  })

  it('normalizes fetch timeout failures to backend unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('timed out', 'TimeoutError')))

    await expect(backendFetch('/api/v1/slow')).rejects.toThrow(BackendUnavailableError)
  })
})
