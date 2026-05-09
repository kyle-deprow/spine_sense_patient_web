import { describe, expect, it } from 'vitest'
import { buildProxyRequestHeaders, buildProxyResponseHeaders } from '@/lib/proxy/headers'

describe('proxy headers', () => {
  it('injects bearer auth server-side and does not forward hop-by-hop headers', () => {
    const request = new Request('https://patient.example.test/api/proxy/api/v1/patients/me', {
      headers: {
        Accept: 'application/json',
        Connection: 'keep-alive',
        'X-Idempotency-Key': 'idem-1',
      },
    })

    const headers = buildProxyRequestHeaders(request, 'access-token')

    expect(headers.get('Authorization')).toBe('Bearer access-token')
    expect(headers.get('Connection')).toBeNull()
    expect(headers.get('X-Idempotency-Key')).toBe('idem-1')
    expect(headers.get('X-Forwarded-Host')).toBe('patient.example.test')
  })

  it('strips headers named by the request Connection header', () => {
    const request = new Request('https://patient.example.test/api/proxy/api/v1/patients/me', {
      headers: {
        Connection: 'X-Request-Id',
        'X-Request-Id': 'smuggled-request-id',
      },
    })

    const headers = buildProxyRequestHeaders(request, 'access-token')

    expect(headers.get('X-Request-Id')).toBeNull()
  })

  it('forwards integrity, request, retry, and replay headers from backend responses', () => {
    const backendResponse = new Response('{}', {
      headers: {
        'Content-Type': 'application/json',
        'X-Integrity-Hash': 'sha256:abc',
        'X-Request-Id': 'req-1',
        'Retry-After': '30',
        'X-Idempotent-Replayed': 'true',
        Connection: 'close',
      },
    })

    const headers = buildProxyResponseHeaders(backendResponse)

    expect(headers.get('X-Integrity-Hash')).toBe('sha256:abc')
    expect(headers.get('X-Request-Id')).toBe('req-1')
    expect(headers.get('Retry-After')).toBe('30')
    expect(headers.get('X-Idempotent-Replayed')).toBe('true')
    expect(headers.get('Connection')).toBeNull()
    expect(headers.get('Cache-Control')).toBe('no-store')
  })

  it('strips headers named by the backend Connection header', () => {
    const backendResponse = new Response('{}', {
      headers: {
        Connection: 'X-Request-Id',
        'X-Request-Id': 'smuggled-request-id',
      },
    })

    const headers = buildProxyResponseHeaders(backendResponse)

    expect(headers.get('X-Request-Id')).toBeNull()
    expect(headers.get('Cache-Control')).toBe('no-store')
  })
})
