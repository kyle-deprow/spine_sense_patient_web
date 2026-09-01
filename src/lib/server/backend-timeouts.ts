import { LONG_BACKEND_TIMEOUT_MS } from "@/lib/server/backend";

export function backendTimeoutOptions(targetPath: string): {
  timeoutMs?: number;
} {
  return isLongRunningBackendCall(targetPath)
    ? { timeoutMs: LONG_BACKEND_TIMEOUT_MS }
    : {};
}

export function isLongRunningBackendCall(targetPath: string): boolean {
  return /^\/api\/v1\/patients\/me\/assessments\/[^/]+\/(?:adaptive\/prepare|analysis\/run)\/?$/.test(
    targetPath,
  );
}
