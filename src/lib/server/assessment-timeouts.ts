import { LONG_BACKEND_TIMEOUT_MS } from '@/lib/server/backend'

export function assessmentBackendTimeoutOptions(targetPath: string): { timeoutMs?: number } {
  return isLongAssessmentBackendCall(targetPath) ? { timeoutMs: LONG_BACKEND_TIMEOUT_MS } : {}
}

export function isLongAssessmentBackendCall(targetPath: string): boolean {
  return /^\/api\/v1\/patients\/me\/assessments\/[^/]+\/(?:adaptive\/prepare|refinement\/run|analysis\/run)\/?$/.test(
    targetPath,
  )
}
