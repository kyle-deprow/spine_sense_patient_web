const SAFE_ERROR_CODES = new Set([
  "network_changed",
  "gateway",
  "schema",
  "authorization",
  "clinical",
  "assertion",
  "browser_console_error",
  "browser_page_error",
  "unknown",
]);

export type SafeResponseDiagnostic = Readonly<{
  route: string;
  status: number;
  requestId?: string;
  errorCode?: string;
}>;

export function safeErrorCode(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z_]/g, "_");
  return SAFE_ERROR_CODES.has(normalized) ? normalized : "unknown";
}

export function safeRoute(pathname: string): string {
  if (!pathname.startsWith("/") || /[\r\n]/.test(pathname)) return "[route]";
  return pathname.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
    "[id]",
  );
}

// Kept as a compatibility boundary for existing journey diagnostics. It never
// returns arbitrary input: only an already-resolved route is allowed through.
export function sanitizeDiagnostic(value: string): string {
  return value.startsWith("/") ? safeRoute(value) : "unknown";
}

export function safeRequestId(value: string | undefined): string | undefined {
  if (value == null || !/^[A-Za-z0-9._:-]{1,128}$/.test(value))
    return undefined;
  return value;
}

export function formatResponseDiagnostic(
  diagnostic: SafeResponseDiagnostic,
): string {
  const requestId =
    diagnostic.requestId == null ? "" : " request_id=" + diagnostic.requestId;
  const errorCode =
    diagnostic.errorCode == null
      ? ""
      : " error_code=" + safeErrorCode(diagnostic.errorCode);
  return (
    "[response] route=" +
    safeRoute(diagnostic.route) +
    " status=" +
    diagnostic.status +
    requestId +
    errorCode
  );
}
