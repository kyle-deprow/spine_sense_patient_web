import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { readRequestJson } from '@/lib/server/auth'
import { stepUpMfa } from '@/lib/server/mfa'
import { credentialRateLimitFailureResponse } from '@/lib/server/rate-limit'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  const rateLimitFailure = await credentialRateLimitFailureResponse(request, 'auth.mfa.step-up')
  if (rateLimitFailure) return rateLimitFailure
  return stepUpMfa(request, await readRequestJson(request))
}
