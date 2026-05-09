import type { NextRequest } from 'next/server'

import { validateAuthMutation } from '@/lib/auth/route-guards'
import { forwardCredentialAuth, readRequestJson } from '@/lib/server/auth'
import { jsonNoStore } from '@/lib/server/responses'

export async function POST(request: NextRequest) {
  const failure = validateAuthMutation(request)
  if (failure) return failure

  const body = await readRequestJson(request)
  if (body == null) {
    return jsonNoStore({ error: 'invalid_json' }, { status: 400 })
  }

  return forwardCredentialAuth('/api/v1/auth/mfa/verify', body)
}
