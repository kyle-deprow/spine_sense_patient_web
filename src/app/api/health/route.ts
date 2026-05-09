import { jsonNoStore } from '@/lib/server/responses'

export async function GET() {
  return jsonNoStore({
    status: 'ok',
    service: 'spine-sense-patient-web',
  })
}
