import type { NextRequest } from 'next/server'

import { startGoogleOAuth } from '@/lib/server/google-oauth'
import { validatePatientWebConfiguration } from '@/lib/auth/route-guards'

export function GET(request: NextRequest) {
  const failure = validatePatientWebConfiguration()
  if (failure) return failure
  return startGoogleOAuth(request)
}
