import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { COOKIE_NAMES } from "@/lib/auth/cookies";
import { validateUnsafeRequest } from "@/lib/auth/csrf";
import {
  isPatientAssessmentDocumentDeleteTarget,
  isPatientDocumentDeleteTarget,
  isPatientReportShareCollectionTarget,
  isPatientReportShareRevocationTarget,
  isQuestionNoteTranscriptionTarget,
  restoredProxyRequestBodyLimit,
  validateProxyTarget,
} from "@/lib/proxy/allowlist";
import {
  buildProxyRequestHeaders,
  buildProxyResponseHeaders,
} from "@/lib/proxy/headers";
import {
  auditLog,
  createRequestAuditContext,
  deriveResourceType,
  type AuditContext,
} from "@/lib/server/audit";
import { BackendUnavailableError, backendFetch } from "@/lib/server/backend";
import { backendTimeoutOptions } from "@/lib/server/backend-timeouts";
import { getPatientWebConfig } from "@/lib/server/config";
import {
  configurationUnavailableResponse,
  csrfFailureResponse,
  jsonNoStore,
} from "@/lib/server/responses";

export const runtime = "nodejs";

type ProxyContext = {
  params: Promise<{ path: string[] }>;
};

const DEFAULT_CSRF_CONTENT_TYPES = new Set(["application/json"]);
const QUESTION_NOTE_CSRF_CONTENT_TYPES = new Set(["multipart/form-data"]);
const QUESTION_NOTE_AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const QUESTION_NOTE_AUDIO_TYPES = new Set([
  "audio/m4a",
  "audio/mp4",
  "audio/wav",
  "audio/webm",
]);
const DOCUMENT_DELETE_BODY_PROBE_TIMEOUT_MS = 250;

async function handler(request: NextRequest, context: ProxyContext) {
  let config;
  try {
    config = getPatientWebConfig();
  } catch {
    return configurationUnavailableResponse();
  }
  const accessToken = request.cookies.get(COOKIE_NAMES.access)?.value;
  const auditContext = createRequestAuditContext(request, accessToken);
  const { path } = await context.params;
  const target = validateProxyTarget(
    path,
    request.method,
    request.nextUrl.pathname,
  );
  if (!target.ok) {
    auditDenial(request.method, target.status, target.code, auditContext);
    return jsonNoStore({ error: target.code }, { status: target.status });
  }

  const resourceType = deriveResourceType(target.targetPath);
  const isQuestionNoteTranscription = isQuestionNoteTranscriptionTarget(
    request.method,
    target.targetPath,
  );

  if (!accessToken) {
    auditDenial(
      request.method,
      401,
      "authentication_required",
      auditContext,
      resourceType,
    );
    return jsonNoStore({ error: "unauthorized" }, { status: 401 });
  }
  if (isBinaryDocumentPayload(target.targetPath, request)) {
    auditDenial(
      request.method,
      415,
      "binary_document_payload_not_allowed",
      auditContext,
      resourceType,
    );
    return jsonNoStore({ error: "unsupported_media_type" }, { status: 415 });
  }

  const isDocumentDelete =
    isPatientDocumentDeleteTarget(request.method, target.targetPath) ||
    isPatientAssessmentDocumentDeleteTarget(request.method, target.targetPath);
  const requestBodyEmpty = isDocumentDelete
    ? await hasEmptyRequestBody(request)
    : undefined;

  const csrf = validateUnsafeRequest(
    request,
    request.cookies.get(COOKIE_NAMES.csrf)?.value,
    {
      csrfSecret: config.csrfSecret,
      allowedOrigins: config.allowedOrigins,
      allowedContentTypes: isQuestionNoteTranscription
        ? QUESTION_NOTE_CSRF_CONTENT_TYPES
        : DEFAULT_CSRF_CONTENT_TYPES,
      allowBodylessDelete: isDocumentDelete,
      ...(requestBodyEmpty !== undefined ? { requestBodyEmpty } : {}),
    },
  );
  if (!csrf.ok) {
    auditDenial(
      request.method,
      csrf.status,
      csrf.code,
      auditContext,
      resourceType,
    );
    return csrfFailureResponse(csrf.status, csrf.code);
  }

  const isReportShareCollection = isPatientReportShareCollectionTarget(
    request.method,
    target.targetPath,
  );
  const isReportShareRevocation = isPatientReportShareRevocationTarget(
    request.method,
    target.targetPath,
  );

  const headers = buildProxyRequestHeaders(request, accessToken);
  headers.set("X-Request-Id", auditContext.requestId);
  const backendRequest: RequestInit = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (shouldForwardBody(request.method)) {
    const bodyLimit = restoredProxyRequestBodyLimit(
      request.method,
      target.targetPath,
    );
    const bodyResult =
      bodyLimit === null
        ? { ok: true as const, body: await request.arrayBuffer() }
        : await readBoundedRequestBody(request, bodyLimit);
    if (!bodyResult.ok) {
      auditDenial(
        request.method,
        bodyResult.status,
        bodyResult.code,
        auditContext,
        resourceType,
      );
      return jsonNoStore(
        { error: bodyResult.error },
        { status: bodyResult.status },
      );
    }
    const body = bodyResult.body;
    if (
      isQuestionNoteTranscription &&
      !(await isValidQuestionNoteMultipart(
        body,
        request.headers.get("content-type"),
      ))
    ) {
      auditDenial(
        request.method,
        400,
        "question_note_transcription_request_invalid",
        auditContext,
        resourceType,
      );
      return jsonNoStore({ error: "invalid_request" }, { status: 400 });
    }
    if (
      request.method.toUpperCase() === "POST" &&
      isReportShareCollection &&
      !isReportShareRequestBody(body)
    ) {
      auditDenial(
        request.method,
        400,
        "report_share_request_invalid",
        auditContext,
        resourceType,
      );
      return jsonNoStore(
        { error: "invalid_report_share_request" },
        { status: 400 },
      );
    }
    if (body.byteLength > 0) {
      backendRequest.body = body;
    } else {
      headers.delete("content-type");
    }
  }

  let backendResponse: Response;
  try {
    backendResponse = await backendFetch(
      `${target.targetPath}${request.nextUrl.search}`,
      backendRequest,
      backendTimeoutOptions(target.targetPath),
    );
  } catch (err) {
    if (err instanceof BackendUnavailableError) {
      auditDenial(
        request.method,
        503,
        "backend_unavailable",
        auditContext,
        resourceType,
      );
      return jsonNoStore({ error: "service_unavailable" }, { status: 503 });
    }
    throw err;
  }

  if (isReportShareCollection || isReportShareRevocation) {
    const protectedResponse = await protectReportShareResponse(
      backendResponse,
      request.method.toUpperCase() as "GET" | "POST" | "DELETE",
    );
    if (protectedResponse === null) {
      auditDenial(
        request.method,
        502,
        "report_share_response_invalid",
        auditContext,
        resourceType,
      );
      return jsonNoStore({ error: "service_unavailable" }, { status: 502 });
    }
    backendResponse = protectedResponse;
  }

  if (isQuestionNoteTranscription) {
    const protectedResponse = await protectQuestionNoteResponse(backendResponse);
    if (protectedResponse === null) {
      auditDenial(
        request.method,
        502,
        "question_note_transcription_response_invalid",
        auditContext,
        resourceType,
      );
      return jsonNoStore({ error: "service_unavailable" }, { status: 502 });
    }
    backendResponse = protectedResponse;
  }

  auditLog({
    ts: new Date().toISOString(),
    event: "phi.proxy.access",
    method: request.method,
    resourceType,
    status: backendResponse.status,
    ...auditContext,
  });

  const responseHeaders = buildProxyResponseHeaders(backendResponse);
  if (backendResponse.status === 204) {
    return new NextResponse(null, { status: 204, headers: responseHeaders });
  }

  return new NextResponse(await backendResponse.arrayBuffer(), {
    status: backendResponse.status,
    headers: responseHeaders,
  });
}

function auditDenial(
  method: string,
  status: number,
  reason: string,
  auditContext: AuditContext,
  resourceType = "proxy",
): void {
  auditLog({
    ts: new Date().toISOString(),
    event: "phi.proxy.denied",
    method,
    resourceType,
    status,
    ...auditContext,
    reason,
  });
}

function shouldForwardBody(method: string): boolean {
  return !["GET", "HEAD"].includes(method.toUpperCase());
}

async function hasEmptyRequestBody(request: Request): Promise<boolean> {
  if (request.body === null) return true;
  const reader = request.clone().body?.getReader();
  if (reader == null) return true;

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read().then(({ done }) => done),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(
          () => resolve(false),
          DOCUMENT_DELETE_BODY_PROBE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function isBinaryDocumentPayload(
  targetPath: string,
  request: NextRequest,
): boolean {
  if (!targetPath.startsWith("/api/v1/patients/me/documents")) return false;
  if (!shouldForwardBody(request.method)) return false;
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType) return false;
  return (
    contentType.startsWith("application/octet-stream") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("application/pdf") ||
    contentType.startsWith("multipart/form-data")
  );
}

type BoundedBodyResult =
  | { ok: true; body: ArrayBuffer }
  | {
      ok: false;
      status: 400 | 413;
      code: "request_body_invalid" | "request_body_too_large";
      error: "invalid_request" | "payload_too_large";
    };

async function readBoundedRequestBody(
  request: Request,
  maxBytes: number,
): Promise<BoundedBodyResult> {
  const rawLength = request.headers.get("content-length");
  if (rawLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(rawLength)) {
      void request.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        status: 400,
        code: "request_body_invalid",
        error: "invalid_request",
      };
    }
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength)) {
      void request.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        status: 400,
        code: "request_body_invalid",
        error: "invalid_request",
      };
    }
    if (contentLength > maxBytes) {
      void request.body?.cancel().catch(() => undefined);
      return {
        ok: false,
        status: 413,
        code: "request_body_too_large",
        error: "payload_too_large",
      };
    }
  }
  if (request.body === null) return { ok: true, body: new ArrayBuffer(0) };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          status: 413,
          code: "request_body_too_large",
          error: "payload_too_large",
        };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body: body.buffer };
}

async function isValidQuestionNoteMultipart(
  body: ArrayBuffer,
  contentType: string | null,
): Promise<boolean> {
  if (
    body.byteLength === 0 ||
    contentType === null ||
    !/^multipart\/form-data\s*;\s*boundary=(?:"[^"]{1,70}"|[^;\s]{1,70})$/i.test(
      contentType,
    )
  ) {
    return false;
  }
  try {
    const form = await new Response(body, {
      headers: { "Content-Type": contentType },
    }).formData();
    const keys = [...form.keys()].sort();
    if (
      keys.length !== 2 ||
      keys[0] !== "audio" ||
      keys[1] !== "question_id" ||
      form.getAll("audio").length !== 1 ||
      form.getAll("question_id").length !== 1
    ) {
      return false;
    }
    const questionId = form.get("question_id");
    const audio = form.get("audio");
    return (
      typeof questionId === "string" &&
      /^[A-Za-z0-9_-]{1,100}$/.test(questionId) &&
      audio instanceof Blob &&
      audio.size > 0 &&
      audio.size <= QUESTION_NOTE_AUDIO_MAX_BYTES &&
      QUESTION_NOTE_AUDIO_TYPES.has(audio.type.toLowerCase())
    );
  } catch {
    return false;
  }
}

const REPORT_SHARE_REQUEST_FIELDS = new Set([
  "report_share",
  "report_id",
  "recipient_email",
  "acknowledged",
  "acknowledgment_version",
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isReportShareRequestBody(body: ArrayBuffer): boolean {
  if (body.byteLength === 0 || body.byteLength > 32 * 1024) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return false;
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== REPORT_SHARE_REQUEST_FIELDS.size ||
    keys.some((key) => !REPORT_SHARE_REQUEST_FIELDS.has(key))
  ) {
    return false;
  }
  return (
    record.report_share === true &&
    typeof record.report_id === "string" &&
    UUID_RE.test(record.report_id) &&
    typeof record.recipient_email === "string" &&
    record.recipient_email.length > 0 &&
    record.recipient_email.length <= 254 &&
    record.acknowledged === true &&
    record.acknowledgment_version === "share-consent-2026-01-01"
  );
}

async function protectReportShareResponse(
  response: Response,
  operation: "GET" | "POST" | "DELETE",
): Promise<Response | null> {
  if (!response.ok) return sanitizedShareErrorResponse(response);
  if (operation === "DELETE") {
    if (response.status !== 204) return null;
    const body = await response.arrayBuffer();
    return body.byteLength === 0
      ? new Response(null, {
          status: 204,
          headers: { "Cache-Control": "no-store" },
        })
      : null;
  }
  if (response.status !== (operation === "POST" ? 201 : 200)) return null;
  if (!response.headers.get("content-type")?.includes("application/json")) {
    return null;
  }
  const parsed = await readBoundedJsonResponse(response, 256 * 1024);
  if (parsed === undefined) return null;
  if (operation === "POST" && !isReportShareCreateResponse(parsed)) {
    return null;
  }
  if (operation === "GET" && !isReportShareListResponse(parsed)) return null;
  return jsonNoStore(parsed, { status: response.status });
}

async function protectQuestionNoteResponse(
  response: Response,
): Promise<Response | null> {
  if (!response.ok) return sanitizedProxyErrorResponse(response);
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return null;
  }
  const parsed = await readBoundedJsonResponse(response, 64 * 1024);
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    containsCredentialField(parsed)
  ) {
    return null;
  }
  return jsonNoStore(parsed, { status: 200 });
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    return (
      normalized.includes("token") ||
      normalized.includes("websocket") ||
      normalized.includes("credential") ||
      normalized.includes("authorization") ||
      normalized.includes("bearer") ||
      containsCredentialField(nested)
    );
  });
}

function isReportShareListResponse(value: unknown): boolean {
  if (!hasExactKeys(value, ["items", "total", "limit", "offset", "has_more"])) {
    return false;
  }
  return (
    Array.isArray(value.items) &&
    value.items.every(isReportShareListItem) &&
    isNonNegativeInteger(value.total) &&
    isPositiveInteger(value.limit) &&
    isNonNegativeInteger(value.offset) &&
    typeof value.has_more === "boolean"
  );
}

function isReportShareCreateResponse(value: unknown): boolean {
  if (
    !hasExactKeys(value, [
      "token_id",
      "expires_at",
      "acknowledgment_version",
      "acknowledged_at",
      "accepted",
      "queued",
    ])
  ) {
    return false;
  }
  return (
    typeof value.token_id === "string" &&
    UUID_RE.test(value.token_id) &&
    isIsoDateTime(value.expires_at) &&
    value.acknowledgment_version === "share-consent-2026-01-01" &&
    isIsoDateTime(value.acknowledged_at) &&
    value.accepted === true &&
    value.queued === true
  );
}

function isReportShareListItem(value: unknown): boolean {
  if (
    !hasExactKeys(value, [
      "id",
      "scope_elements",
      "target_provider_profile_id",
      "expires_at",
      "created_at",
      "revoked_at",
      "access_count",
      "last_accessed_at",
      "status",
    ])
  ) {
    return false;
  }
  return (
    typeof value.id === "string" &&
    UUID_RE.test(value.id) &&
    Array.isArray(value.scope_elements) &&
    value.scope_elements.length === 1 &&
    value.scope_elements[0] === "assessment_report" &&
    value.target_provider_profile_id === null &&
    isIsoDateTime(value.expires_at) &&
    isIsoDateTime(value.created_at) &&
    (value.revoked_at === null || isIsoDateTime(value.revoked_at)) &&
    isNonNegativeInteger(value.access_count) &&
    (value.last_accessed_at === null ||
      isIsoDateTime(value.last_accessed_at)) &&
    ["active", "expired", "revoked"].includes(String(value.status))
  );
}

function hasExactKeys<T extends string>(
  value: unknown,
  keys: readonly T[],
): value is Record<T, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key as T))
  );
}

function isIsoDateTime(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

async function sanitizedShareErrorResponse(
  response: Response,
): Promise<Response> {
  return sanitizedProxyErrorResponse(response);
}

async function sanitizedProxyErrorResponse(
  response: Response,
): Promise<Response> {
  await response.body?.cancel().catch(() => undefined);
  const status = sanitizedShareErrorStatus(response.status);
  const retryAfter = response.headers.get("retry-after");
  const headers =
    retryAfter !== null && /^[1-9][0-9]{0,3}$/.test(retryAfter)
      ? { "Retry-After": retryAfter }
      : undefined;
  return jsonNoStore(
    { error: sanitizedShareErrorCode(status) },
    { status, ...(headers === undefined ? {} : { headers }) },
  );
}

function sanitizedShareErrorStatus(status: number): number {
  if ([400, 401, 403, 404, 409, 429, 502, 503].includes(status)) return status;
  if (status === 422) return 400;
  return 502;
}

function sanitizedShareErrorCode(status: number): string {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "too_many_requests";
  return "service_unavailable";
}

export {
  handler as DELETE,
  handler as GET,
  handler as PATCH,
  handler as POST,
  handler as PUT,
};
