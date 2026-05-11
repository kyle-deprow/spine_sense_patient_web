import { describe, expect, it } from 'vitest'
import {
  createCsrfToken,
  validateJsonContentType,
  validateOriginHeaders,
  validateUnsafeRequest,
  verifyCsrfToken,
} from '@/lib/auth/csrf'

const secret = 'test-csrf-secret'
const sameOrigin = 'https://patient.example.test'

function makeRequest(init: { headers?: Record<string, string> } = {}) {
  return new Request(`${sameOrigin}/api/auth/login`, {
    method: 'POST',
    headers: {
      Origin: sameOrigin,
      'Content-Type': 'application/json',
      ...init.headers,
    },
    ...init,
  })
}

describe('csrf helpers', () => {
  it('creates signed csrf tokens that verify with the same secret', () => {
    const token = createCsrfToken(secret, 'nonce')

    expect(verifyCsrfToken(secret, token)).toBe(true)
    expect(verifyCsrfToken('wrong-secret', token)).toBe(false)
  })

  it('accepts same-origin unsafe json requests with matching signed cookie and header', () => {
    const token = createCsrfToken(secret)
    const request = makeRequest({
      headers: {
        Origin: sameOrigin,
        'Content-Type': 'application/json; charset=utf-8',
        'X-CSRF-Token': token,
      },
    })

    expect(validateUnsafeRequest(request, token, { csrfSecret: secret })).toEqual({ ok: true })
  })

  it('blocks missing csrf headers before backend forwarding', () => {
    const token = createCsrfToken(secret)

    expect(validateUnsafeRequest(makeRequest(), token, { csrfSecret: secret })).toEqual({
      ok: false,
      status: 403,
      code: 'csrf_missing',
    })
  })

  it('blocks wrong-origin and wrong-content-type unsafe requests', () => {
    expect(
      validateOriginHeaders(
        makeRequest({
          headers: {
            Origin: 'https://evil.example.test',
            'Content-Type': 'application/json',
          },
        }),
        // Pass an explicit allowed origin so validation is active (empty list skips validation)
        [sameOrigin],
      ),
    ).toEqual({ ok: false, status: 403, code: 'origin_forbidden' })

    expect(validateJsonContentType('text/plain')).toEqual({
      ok: false,
      status: 415,
      code: 'content_type_unsupported',
    })
  })
})
