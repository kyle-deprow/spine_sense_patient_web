import type { NextRequest } from 'next/server'
import { COOKIE_NAMES } from '@/lib/auth/cookies'
import { validateUnsafeRequest } from '@/lib/auth/csrf'
import { getPatientWebConfig } from '@/lib/server/config'
import { configurationUnavailableResponse, csrfFailureResponse } from '@/lib/server/responses'

export function validatePatientWebConfiguration() {
  try {
    getPatientWebConfig()
    return null
  } catch {
    return configurationUnavailableResponse()
  }
}

export function validateAuthMutation(request: NextRequest) {
  let config
  try {
    config = getPatientWebConfig()
  } catch {
    return configurationUnavailableResponse()
  }
  const validation = validateUnsafeRequest(request, request.cookies.get(COOKIE_NAMES.csrf)?.value, {
    csrfSecret: config.csrfSecret,
    allowedOrigins: config.allowedOrigins,
  })

  if (!validation.ok) {
    return csrfFailureResponse(validation.status, validation.code)
  }

  return null
}
