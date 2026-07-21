import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { readRequestJson } from '@/lib/server/auth'
import { disableMfa } from '@/lib/server/mfa'
import { credentialRateLimitFailureResponse } from '@/lib/server/rate-limit'

export async function DELETE(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  const rateLimitFailure = await credentialRateLimitFailureResponse(request, 'auth.mfa.disable')
  if (rateLimitFailure) return rateLimitFailure
  return disableMfa(request, await readRequestJson(request))
}
