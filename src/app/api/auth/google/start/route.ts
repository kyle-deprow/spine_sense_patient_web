import type { NextRequest } from 'next/server'

import { startGoogleOAuth } from '@/lib/server/google-oauth'

export function GET(request: NextRequest) {
  return startGoogleOAuth(request)
}
