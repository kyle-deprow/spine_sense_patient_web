import type { NextRequest } from 'next/server'

import { completeGoogleOAuth } from '@/lib/server/google-oauth'

export async function GET(request: NextRequest) {
  return completeGoogleOAuth(request)
}
