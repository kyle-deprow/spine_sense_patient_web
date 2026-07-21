import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { readRequestJson } from '@/lib/server/auth'
import { confirmAuthenticatedMfa } from '@/lib/server/mfa'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  return confirmAuthenticatedMfa(request, await readRequestJson(request))
}
