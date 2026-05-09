import type { NextRequest } from 'next/server'

import { sessionFromCookie } from '@/lib/server/auth'

export async function GET(request: NextRequest) {
  return sessionFromCookie(request)
}
