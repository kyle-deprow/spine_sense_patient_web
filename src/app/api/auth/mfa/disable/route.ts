import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { readRequestJson } from '@/lib/server/auth'
import { disableMfa } from '@/lib/server/mfa'

export async function DELETE(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure
  return disableMfa(request, await readRequestJson(request))
}
