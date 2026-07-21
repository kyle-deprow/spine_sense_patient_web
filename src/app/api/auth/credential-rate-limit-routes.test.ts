import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

import { CSRF_HEADER, createCsrfToken } from '@/lib/auth/csrf'
import { backendFetch } from '@/lib/server/backend'
import { clearRateLimitStore } from '@/lib/server/rate-limit'

const redisMocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  eval: vi.fn(async () => 1),
  scan: vi.fn(async () => ['0', []] as [string, string[]]),
  unlink: vi.fn(async () => 0),
}))

vi.mock('ioredis', () => ({
  default: class MockRedis {
    status = 'wait'
    constructor() {
      redisMocks.connect.mockImplementationOnce(async () => {
        this.status = 'ready'
      })
    }
    on() {
      return this
    }
    async connect() {
      await redisMocks.connect()
      this.status = 'ready'
    }
    eval = redisMocks.eval
    scan = redisMocks.scan
    unlink = redisMocks.unlink
    disconnect() {
      this.status = 'end'
    }
  },
}))

vi.mock('@/lib/server/backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/backend')>()
  return { ...actual, backendFetch: vi.fn() }
})

const mockedBackendFetch = vi.mocked(backendFetch)
const CSRF_SECRET = 'credential-route-csrf-secret-at-least-thirty-two-bytes'
const ORIGIN = 'https://patient.example.test'

const { POST: login } = await import('@/app/api/auth/login/route')
const { POST: register } = await import('@/app/api/auth/register/route')
const { POST: enrollmentSetup } = await import('@/app/api/auth/mfa/enrollment/setup/route')
const { POST: enrollmentConfirm } = await import('@/app/api/auth/mfa/enrollment/confirm/route')
const { POST: verify } = await import('@/app/api/auth/mfa/verify/route')
const { POST: stepUp } = await import('@/app/api/auth/mfa/step-up/route')
const { POST: replaceSetup } = await import('@/app/api/auth/mfa/setup/route')
const { POST: replaceConfirm } = await import('@/app/api/auth/mfa/confirm/route')
const { DELETE: disable } = await import('@/app/api/auth/mfa/disable/route')

type CredentialHandler = (request: NextRequest) => Promise<Response>

function credentialRequest(
  path: string,
  method: 'POST' | 'DELETE' = 'POST',
  extraHeaders: Record<string, string> = {},
): NextRequest {
  const csrf = createCsrfToken(CSRF_SECRET, `credential-boundary-${path}`)
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `spine_patient_csrf=${csrf}; spine_patient_sess=synthetic-session`,
      [CSRF_HEADER]: csrf,
      Origin: ORIGIN,
      'x-forwarded-for': '198.51.100.1, 198.51.100.2',
      'x-real-ip': '198.51.100.3',
      'x-azure-clientip': '198.51.100.4',
      'x-azure-socketip': '198.51.100.5',
      ...extraHeaders,
    },
    body: JSON.stringify({
      email: 'synthetic@example.test',
      password: 'SyntheticPassword123!!',
      code: '123456',
      method_id: '20000000-0000-4000-8000-000000000001',
      current_password: 'SyntheticPassword123!!',
    }),
  })
}

describe('credential route rate-limit boundary', () => {
  let stdout: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.stubEnv('ENVIRONMENT', 'test')
    vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'single-bucket')
    vi.stubEnv('PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE', 'memory')
    vi.stubEnv('REDIS_URL', '')
    vi.stubEnv('PATIENT_WEB_CSRF_SECRET', CSRF_SECRET)
    vi.stubEnv('PATIENT_WEB_ALLOWED_ORIGINS', ORIGIN)
    await clearRateLimitStore()
    mockedBackendFetch.mockReset()
    redisMocks.eval.mockReset().mockResolvedValue(1)
    stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdout?.mockRestore()
    vi.unstubAllEnvs()
  })

  it.each([
    ['/api/auth/login', login, 'POST'],
    ['/api/auth/register', register, 'POST'],
    ['/api/auth/mfa/enrollment/setup', enrollmentSetup, 'POST'],
    ['/api/auth/mfa/enrollment/confirm', enrollmentConfirm, 'POST'],
    ['/api/auth/mfa/verify', verify, 'POST'],
    ['/api/auth/mfa/step-up', stepUp, 'POST'],
    ['/api/auth/mfa/setup', replaceSetup, 'POST'],
    ['/api/auth/mfa/confirm', replaceConfirm, 'POST'],
    ['/api/auth/mfa/disable', disable, 'DELETE'],
  ] as const)(
    'fails closed without backend calls when client identity is unavailable: %s',
    async (path, handler, method) => {
      vi.stubEnv('ENVIRONMENT', 'production')
      vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'unavailable')
      vi.stubEnv('PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE', 'redis')
      vi.stubEnv('REDIS_URL', 'rediss://:test-password@redis.example.test:6380/0')

      const response = await (handler as CredentialHandler)(
        credentialRequest(path, method as 'POST' | 'DELETE'),
      )

      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({
        error: 'service_unavailable',
      })
      expect(mockedBackendFetch).not.toHaveBeenCalled()
      const auditOutput = stdout.mock.calls.flat().join(' ')
      expect(auditOutput).not.toContain('198.51.100')
      expect(auditOutput).not.toContain('x-forwarded-for')
      expect(auditOutput).not.toContain('x-azure-socketip')
      expect(auditOutput).not.toMatch(/rl:v1:/)
    },
  )

  it('preserves 429 exhaustion and keeps route scopes independent', async () => {
    vi.stubEnv('ENVIRONMENT', 'test')
    vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'single-bucket')
    mockedBackendFetch.mockResolvedValue(
      Response.json({ error: 'invalid_credentials' }, { status: 401 }),
    )

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(credentialRequest('/api/auth/login'))).status).toBe(401)
    }
    const exhausted = await login(credentialRequest('/api/auth/login'))
    expect(exhausted.status).toBe(429)
    expect(exhausted.headers.get('Retry-After')).toBe('900')

    const separateScope = await register(credentialRequest('/api/auth/register'))
    expect(separateScope.status).toBe(401)
  })

  it.each([
    ['/api/auth/login', login, 'POST'],
    ['/api/auth/register', register, 'POST'],
    ['/api/auth/mfa/enrollment/setup', enrollmentSetup, 'POST'],
    ['/api/auth/mfa/enrollment/confirm', enrollmentConfirm, 'POST'],
    ['/api/auth/mfa/verify', verify, 'POST'],
    ['/api/auth/mfa/step-up', stepUp, 'POST'],
    ['/api/auth/mfa/setup', replaceSetup, 'POST'],
    ['/api/auth/mfa/confirm', replaceConfirm, 'POST'],
    ['/api/auth/mfa/disable', disable, 'DELETE'],
  ] as const)(
    'fails closed before backend access when Redis is unavailable: %s',
    async (path, handler, method) => {
      const frontDoorId = '12345678-1234-1234-1234-123456789abc'
      vi.stubEnv('ENVIRONMENT', 'production')
      vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'azure-front-door')
      vi.stubEnv('AZURE_FRONT_DOOR_ID', frontDoorId)
      vi.stubEnv('PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE', 'redis')
      vi.stubEnv('REDIS_URL', 'rediss://:test-password@redis.example.test:6380/0')
      redisMocks.eval.mockRejectedValue(new Error('synthetic Redis outage'))

      const response = await (handler as CredentialHandler)(
        credentialRequest(path, method as 'POST' | 'DELETE', {
          'x-azure-fdid': frontDoorId,
        }),
      )

      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(mockedBackendFetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['/api/auth/login', login, 'POST'],
    ['/api/auth/register', register, 'POST'],
    ['/api/auth/mfa/enrollment/setup', enrollmentSetup, 'POST'],
    ['/api/auth/mfa/enrollment/confirm', enrollmentConfirm, 'POST'],
    ['/api/auth/mfa/verify', verify, 'POST'],
    ['/api/auth/mfa/step-up', stepUp, 'POST'],
    ['/api/auth/mfa/setup', replaceSetup, 'POST'],
    ['/api/auth/mfa/confirm', replaceConfirm, 'POST'],
    ['/api/auth/mfa/disable', disable, 'DELETE'],
  ] as const)('preserves 429 exhaustion for %s', async (path, handler, method) => {
    vi.stubEnv('ENVIRONMENT', 'test')
    vi.stubEnv('PATIENT_WEB_CLIENT_IP_MODE', 'single-bucket')
    mockedBackendFetch.mockResolvedValue(
      Response.json({ error: 'invalid_credentials' }, { status: 401 }),
    )

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await (handler as CredentialHandler)(credentialRequest(path, method as 'POST' | 'DELETE'))
    }
    const exhausted = await (handler as CredentialHandler)(
      credentialRequest(path, method as 'POST' | 'DELETE'),
    )

    expect(exhausted.status).toBe(429)
    expect(exhausted.headers.get('Cache-Control')).toBe('no-store')
    expect(exhausted.headers.get('Retry-After')).toBe('900')
  })
})
