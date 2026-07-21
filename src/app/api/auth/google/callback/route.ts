import type { NextRequest } from 'next/server'

import { completeGoogleOAuth } from '@/lib/server/google-oauth'
import { validatePatientWebConfiguration } from '@/lib/auth/route-guards'

export async function GET(request: NextRequest) {
  const failure = validatePatientWebConfiguration()
  if (failure) return failure
  return completeGoogleOAuth(request)
}
