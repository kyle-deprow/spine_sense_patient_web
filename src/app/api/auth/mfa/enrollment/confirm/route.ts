import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { readRequestJson } from '@/lib/server/auth'
import { confirmMfaEnrollment } from '@/lib/server/mfa'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  return confirmMfaEnrollment(request, await readRequestJson(request))
}
