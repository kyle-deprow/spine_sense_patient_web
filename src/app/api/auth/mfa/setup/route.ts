import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { setupAuthenticatedMfa } from '@/lib/server/mfa'
import { credentialRateLimitFailureResponse } from '@/lib/server/rate-limit'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  const rateLimitFailure = await credentialRateLimitFailureResponse(request, 'auth.mfa.replace')
  if (rateLimitFailure) return rateLimitFailure
  return setupAuthenticatedMfa(request)
}
