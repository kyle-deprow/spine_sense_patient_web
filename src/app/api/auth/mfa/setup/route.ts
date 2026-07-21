import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { setupAuthenticatedMfa } from '@/lib/server/mfa'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  return setupAuthenticatedMfa(request)
}
