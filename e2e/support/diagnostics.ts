const SAFE_ERROR_CODES = new Set([
  "network_changed",
  "connection_failed",
  "dns",
  "timeout",
  "aborted",
  "gateway",
  "schema",
  "authorization",
  "clinical",
  "assertion",
  "browser_console_error",
  "browser_page_error",
  "unknown",
]);

const REQUEST_FAILURE_CODE_BY_ERROR_TEXT = new Map([
  ["net::err_network_changed", "network_changed"],
  ["net::err_network_io_suspended", "network_changed"],
  ["net::err_internet_disconnected", "network_changed"],
  ["net::err_connection_reset", "connection_failed"],
  ["net::err_connection_closed", "connection_failed"],
  ["net::err_connection_refused", "connection_failed"],
  ["net::err_connection_aborted", "connection_failed"],
  ["net::err_name_not_resolved", "dns"],
  ["net::err_address_unreachable", "dns"],
  ["net::err_timed_out", "timeout"],
  ["net::err_aborted", "aborted"],
]);

const SAFE_JS_ERROR_NAMES = new Set([
  "error",
  "typeerror",
  "referenceerror",
  "rangeerror",
  "syntaxerror",
  "evalerror",
  "urierror",
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

export function isSafeErrorCode(value: string): boolean {
  return SAFE_ERROR_CODES.has(value);
}

/** Classify a Playwright request-failure errorText into a fixed, PHI-safe code. Never returns the raw input. */
export function classifyRequestFailure(errorText: string | undefined): string {
  if (typeof errorText !== "string") return safeErrorCode(undefined);
  const normalized = errorText.trim().toLowerCase();
  return safeErrorCode(REQUEST_FAILURE_CODE_BY_ERROR_TEXT.get(normalized));
}

/** Classify a JS Error's .name into a fixed, PHI-safe value. Never returns the raw input (a custom Error subclass name is not trusted). */
export function safeErrorName(name: string | undefined): string {
  if (typeof name !== "string") return "unknown";
  const normalized = name.trim().toLowerCase();
  return SAFE_JS_ERROR_NAMES.has(normalized) ? normalized : "unknown";
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
