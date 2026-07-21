import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { readRequestJson } from '@/lib/server/auth'
import { confirmMfaEnrollment } from '@/lib/server/mfa'
import { credentialRateLimitFailureResponse } from '@/lib/server/rate-limit'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  const rateLimitFailure = credentialRateLimitFailureResponse(
    request,
    'auth.mfa.enrollment.confirm',
  )
  if (rateLimitFailure) return rateLimitFailure
  return confirmMfaEnrollment(request, await readRequestJson(request))
}
