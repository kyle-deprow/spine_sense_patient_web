import type { NextRequest } from 'next/server'
import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { validateUnsafeRequest } from '@/lib/auth/csrf'
import { getPatientWebConfig } from '@/lib/server/config'
import { csrfFailureResponse } from '@/lib/server/responses'

export function validateAuthMutation(request: NextRequest) {
  const config = getPatientWebConfig()
  const validation = validateUnsafeRequest(request, request.cookies.get(COOKIE_NAMES.csrf)?.value, {
    csrfSecret: config.csrfSecret,
    allowedOrigins: config.allowedOrigins,
  })

  if (!validation.ok) {
    return csrfFailureResponse(validation.status, validation.code)
  }

  return null
}
