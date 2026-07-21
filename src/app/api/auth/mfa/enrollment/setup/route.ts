import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { setupMfaEnrollment } from '@/lib/server/mfa'
import { credentialRateLimitFailureResponse } from '@/lib/server/rate-limit'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  const rateLimitFailure = await credentialRateLimitFailureResponse(
    request,
    'auth.mfa.enrollment.setup',
  )
  if (rateLimitFailure) return rateLimitFailure
  return setupMfaEnrollment(request)
}
