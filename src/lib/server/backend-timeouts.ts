import { LONG_BACKEND_TIMEOUT_MS } from '@/lib/server/backend'

export function backendTimeoutOptions(targetPath: string): {
  timeoutMs?: number
} {
  return isLongRunningBackendCall(targetPath) ? { timeoutMs: LONG_BACKEND_TIMEOUT_MS } : {}
}

export function isLongRunningBackendCall(targetPath: string): boolean {
  return (
    /^\/api\/v1\/patients\/me\/assessments\/[^/]+\/(?:adaptive\/prepare|analysis\/run)\/?$/.test(targetPath) ||
    /^\/api\/v1\/patients\/me\/miscribe\/recordings\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/process\/?$/i.test(
      targetPath,
    )
  )
}
