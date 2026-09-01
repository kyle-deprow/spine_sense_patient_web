import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { CSRF_HEADER, createCsrfToken } from "@/lib/auth/csrf";
import {
  BackendUnavailableError,
  LONG_BACKEND_TIMEOUT_MS,
  backendFetch,
} from "@/lib/server/backend";
import { auditLog, sessionCorrelationFromToken } from "@/lib/server/audit";
import { isLongRunningBackendCall } from "@/lib/server/backend-timeouts";

vi.mock("@/lib/server/backend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/backend")>();
  return {
    ...actual,
    backendFetch: vi.fn(),
  };
});

vi.mock("@/lib/server/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/audit")>();
  return { ...actual, auditLog: vi.fn() };
});

const mockedBackendFetch = vi.mocked(backendFetch);
const mockedAuditLog = vi.mocked(auditLog);

// Import after mocking so the route module picks up the mocked backendFetch.
const { DELETE, GET, POST, PUT } =
  await import("@/app/api/proxy/[...path]/route");

function makeProxyRequest(
  pathname: string,
  method = "GET",
  cookies: Record<string, string> = {},
  extraHeaders: Record<string, string> = {},
  body?: BodyInit,
): NextRequest {
  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`http://localhost${pathname}`, {
    method,
    headers: {
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body }),
  });
}

function makeContext(pathSegments: readonly string[]): {
  params: Promise<{ path: string[] }>;
} {
  return { params: Promise.resolve({ path: [...pathSegments] }) };
}

const VALID_PATHNAME = "/api/proxy/api/v1/patients/me/assessments";
const VALID_SEGMENTS = ["api", "v1", "patients", "me", "assessments"];
const CSRF_SECRET = "test-patient-web-csrf-secret-at-least-32-bytes";
const ORIGIN = "http://localhost";

describe("proxy route handler", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_CSRF_SECRET", CSRF_SECRET);
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", ORIGIN);
    mockedBackendFetch.mockReset();
    mockedAuditLog.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when no access token cookie is present", async () => {
    const request = makeProxyRequest(VALID_PATHNAME, "GET", {});
    const response = await GET(request, makeContext(VALID_SEGMENTS));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason: "authentication_required",
        status: 401,
      }),
    );
  });

  it("returns 403 when CSRF validation fails on a mutating request", async () => {
    // POST without CSRF header/cookie should fail CSRF (missing token)
    const request = makeProxyRequest(
      VALID_PATHNAME,
      "POST",
      { spine_patient_sess: "access-token" },
      { "Content-Type": "application/json", Origin: ORIGIN },
    );
    const response = await POST(request, makeContext(VALID_SEGMENTS));

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason: "csrf_missing",
        sessionCorrelation: sessionCorrelationFromToken("access-token"),
        status: 403,
      }),
    );
  });

  it("returns a sanitized 503 with zero backend calls when configuration is invalid", async () => {
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "");
    const request = makeProxyRequest(
      VALID_PATHNAME,
      "POST",
      { spine_patient_sess: "access-token" },
      { "Content-Type": "application/json", Origin: ORIGIN },
      JSON.stringify({ answer: "redacted" }),
    );

    const response = await POST(request, makeContext(VALID_SEGMENTS));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("keeps PHI proxy access audit records in production while preserving forwarding", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "unavailable");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "redis");
    vi.stubEnv(
      "REDIS_URL",
      "rediss://:test-password@redis.example.test:6380/0",
    );
    mockedBackendFetch.mockResolvedValue(Response.json({ ok: true }));

    const request = makeProxyRequest(VALID_PATHNAME, "GET", {
      spine_patient_sess: "access-token",
    });
    const response = await GET(request, makeContext(VALID_SEGMENTS));

    expect(response.status).toBe(200);
    expect(mockedBackendFetch).toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.access",
        method: "GET",
        resourceType: "patients.assessments",
        status: 200,
      }),
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      VALID_PATHNAME,
    );
    expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
      "access-token",
    );
  });

  it("keeps PHI proxy denial audit records in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ENVIRONMENT", "production");
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "unavailable");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "redis");
    vi.stubEnv(
      "REDIS_URL",
      "rediss://:test-password@redis.example.test:6380/0",
    );

    const request = makeProxyRequest(VALID_PATHNAME, "GET", {});
    const response = await GET(request, makeContext(VALID_SEGMENTS));

    expect(response.status).toBe(401);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        method: "GET",
        resourceType: "patients.assessments",
        status: 401,
        reason: "authentication_required",
      }),
    );
  });

  it.each([
    { Origin: "https://evil.example.test" },
    { Origin: ORIGIN, Referer: "https://evil.example.test/path" },
  ])(
    "does not forward unsafe PHI requests with invalid origin metadata",
    async (originHeaders) => {
      const csrf = createCsrfToken(CSRF_SECRET, "origin-negative");
      const response = await POST(
        makeProxyRequest(
          VALID_PATHNAME,
          "POST",
          { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
          {
            "Content-Type": "application/json",
            "X-CSRF-Token": csrf,
            ...originHeaders,
          },
          JSON.stringify({ answer: "redacted" }),
        ),
        makeContext(VALID_SEGMENTS),
      );

      expect(response.status).toBe(403);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(mockedBackendFetch).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when path is not in the allowlist", async () => {
    const request = makeProxyRequest("/api/proxy/api/v1/admin/users", "GET", {
      spine_patient_sess: "access-token",
    });
    const response = await GET(
      request,
      makeContext(["api", "v1", "admin", "users"]),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason: "proxy_path_not_allowed",
        status: 404,
      }),
    );
  });

  it("returns 503 when BackendUnavailableError is thrown", async () => {
    mockedBackendFetch.mockRejectedValue(new BackendUnavailableError());

    const request = makeProxyRequest(VALID_PATHNAME, "GET", {
      spine_patient_sess: "access-token",
    });
    const response = await GET(request, makeContext(VALID_SEGMENTS));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason: "backend_unavailable",
        status: 503,
      }),
    );
  });

  it("returns the backend response body and status for a valid authenticated GET", async () => {
    mockedBackendFetch.mockResolvedValue(
      new Response(JSON.stringify({ data: "test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const request = makeProxyRequest(VALID_PATHNAME, "GET", {
      spine_patient_sess: "access-token",
    });
    const response = await GET(request, makeContext(VALID_SEGMENTS));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: "test" });
  });

  it.each([
    {
      label: "completed replay",
      backendResponse: () =>
        new Response(null, {
          status: 204,
          headers: { "X-Idempotent-Replayed": "true" },
        }),
      expectedStatus: 204,
      expectedBody: "",
      expectedReplay: "true",
      expectedRetryAfter: null,
    },
    {
      label: "completed replay without a retained response representation",
      backendResponse: () =>
        Response.json(
          {
            code: "idempotency_result_unavailable",
            detail:
              "The prior mutation completed but its result is not replayable",
          },
          { status: 409 },
        ),
      expectedStatus: 409,
      expectedBody: JSON.stringify({
        code: "idempotency_result_unavailable",
        detail: "The prior mutation completed but its result is not replayable",
      }),
      expectedReplay: null,
      expectedRetryAfter: null,
    },
    {
      label: "active processing lease",
      backendResponse: () =>
        Response.json(
          {
            code: "idempotency_in_progress",
            detail: "A request with this idempotency key is still in progress",
          },
          { status: 503, headers: { "Retry-After": "3" } },
        ),
      expectedStatus: 503,
      expectedBody: JSON.stringify({
        code: "idempotency_in_progress",
        detail: "A request with this idempotency key is still in progress",
      }),
      expectedReplay: null,
      expectedRetryAfter: "3",
    },
    {
      label: "coordination store unavailable",
      backendResponse: () =>
        Response.json(
          {
            code: "idempotency_unavailable",
            detail: "Idempotency coordination is temporarily unavailable",
          },
          { status: 503, headers: { "Retry-After": "1" } },
        ),
      expectedStatus: 503,
      expectedBody: JSON.stringify({
        code: "idempotency_unavailable",
        detail: "Idempotency coordination is temporarily unavailable",
      }),
      expectedReplay: null,
      expectedRetryAfter: "1",
    },
  ])(
    "preserves the F7 idempotency contract for $label",
    async ({
      backendResponse,
      expectedStatus,
      expectedBody,
      expectedReplay,
      expectedRetryAfter,
    }) => {
      mockedBackendFetch.mockResolvedValue(backendResponse());
      const csrf = createCsrfToken(CSRF_SECRET, "idempotency-contract-test");
      const request = makeProxyRequest(
        VALID_PATHNAME,
        "POST",
        { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
        {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
          "X-Idempotency-Key": "stable-offline-mutation-key",
        },
        JSON.stringify({}),
      );

      const response = await POST(request, makeContext(VALID_SEGMENTS));

      expect(response.status).toBe(expectedStatus);
      await expect(response.text()).resolves.toBe(expectedBody);
      expect(response.headers.get("X-Idempotent-Replayed")).toBe(
        expectedReplay,
      );
      expect(response.headers.get("Retry-After")).toBe(expectedRetryAfter);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const forwardedHeaders = new Headers(
        mockedBackendFetch.mock.calls[0]?.[1]?.headers,
      );
      expect(forwardedHeaders.get("X-Idempotency-Key")).toBe(
        "stable-offline-mutation-key",
      );
    },
  );

  it("keeps the default backend timeout for normal proxy calls", async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ data: "test" }));

    const request = makeProxyRequest(VALID_PATHNAME, "GET", {
      spine_patient_sess: "access-token",
    });
    const response = await GET(request, makeContext(VALID_SEGMENTS));

    expect(response.status).toBe(200);
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      "/api/v1/patients/me/assessments/",
      expect.any(Object),
      {},
    );
    expect(mockedBackendFetch.mock.calls[0]?.[1]?.signal).toBe(request.signal);
  });

  it("uses the long backend timeout for LLM-backed assessment proxy calls", async () => {
    mockedBackendFetch.mockResolvedValue(Response.json({ questions: [] }));
    const csrf = createCsrfToken(CSRF_SECRET, "proxy-route-test-nonce");

    const request = makeProxyRequest(
      "/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/adaptive/prepare",
      "POST",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    );
    const response = await POST(
      request,
      makeContext([
        "api",
        "v1",
        "patients",
        "me",
        "assessments",
        "10000000-0000-4000-8000-000000000001",
        "adaptive",
        "prepare",
      ]),
    );

    expect(response.status).toBe(200);
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      "/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/adaptive/prepare",
      expect.any(Object),
      { timeoutMs: LONG_BACKEND_TIMEOUT_MS },
    );
  });

  it("forwards assessment report generation through the authenticated proxy", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json(
        {
          id: "report-1",
          downloadUrl: "https://storage.example.test/report.pdf",
        },
        { status: 201 },
      ),
    );
    const csrf = createCsrfToken(CSRF_SECRET, "proxy-route-test-nonce");
    const assessmentId = "10000000-0000-4000-8000-000000000001";

    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/reports`,
      "POST",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    );
    const response = await POST(
      request,
      makeContext([
        "api",
        "v1",
        "patients",
        "me",
        "assessments",
        assessmentId,
        "reports",
      ]),
    );

    expect(response.status).toBe(201);
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      `/api/v1/patients/me/assessments/${assessmentId}/reports`,
      expect.objectContaining({
        method: "POST",
      }),
      {},
    );
  });

  it("rejects retired assessment phase routes before backend forwarding", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "proxy-route-test-nonce");
    const request = makeProxyRequest(
      "/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/refinement/run",
      "POST",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    );

    const response = await POST(
      request,
      makeContext([
        "api",
        "v1",
        "patients",
        "me",
        "assessments",
        "10000000-0000-4000-8000-000000000001",
        "refinement",
        "run",
      ]),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "proxy_path_not_allowed",
    });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("forwards bodyless intake completion POSTs without an empty JSON body", async () => {
    mockedBackendFetch.mockResolvedValue(
      Response.json({ id: "intake-1", isComplete: true }),
    );
    const csrf = createCsrfToken(CSRF_SECRET, "proxy-route-test-nonce");

    const request = makeProxyRequest(
      "/api/proxy/api/v1/patients/me/intake/progress/complete",
      "POST",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    );
    const response = await POST(
      request,
      makeContext([
        "api",
        "v1",
        "patients",
        "me",
        "intake",
        "progress",
        "complete",
      ]),
    );

    expect(response.status).toBe(200);
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      "/api/v1/patients/me/intake/progress/complete",
      expect.objectContaining({
        method: "POST",
      }),
      {},
    );
    const requestInit = mockedBackendFetch.mock.calls[0]?.[1];
    expect(requestInit).not.toHaveProperty("body");
    expect(new Headers(requestInit?.headers).has("content-type")).toBe(false);
  });

  it("forwards bodyless document DELETEs without requiring Content-Type", async () => {
    mockedBackendFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const csrf = createCsrfToken(CSRF_SECRET, "document-delete");
    const documentId = "10000000-0000-4000-8000-000000000001";
    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/documents/${documentId}`,
      "DELETE",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    );

    const response = await DELETE(
      request,
      makeContext(["api", "v1", "patients", "me", "documents", documentId]),
    );

    expect(response.status).toBe(204);
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      `/api/v1/patients/me/documents/${documentId}`,
      expect.objectContaining({ method: "DELETE" }),
      {},
    );
    const requestInit = mockedBackendFetch.mock.calls[0]?.[1];
    expect(requestInit).not.toHaveProperty("body");
    expect(new Headers(requestInit?.headers).has("content-type")).toBe(false);
  });

  it("forwards bodyless onboarding assessment document DELETEs without requiring Content-Type", async () => {
    mockedBackendFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const csrf = createCsrfToken(CSRF_SECRET, "assessment-document-delete");
    const assessmentId = "10000000-0000-4000-8000-000000000001";
    const documentId = "10000000-0000-4000-8000-000000000002";
    const path = [
      "api",
      "v1",
      "patients",
      "me",
      "assessments",
      assessmentId,
      "documents",
      documentId,
    ];
    const request = makeProxyRequest(
      `/api/proxy/${path.join("/")}`,
      "DELETE",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    );

    const response = await DELETE(request, makeContext(path));

    expect(response.status).toBe(204);
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      `/api/v1/patients/me/assessments/${assessmentId}/documents/${documentId}`,
      expect.objectContaining({ method: "DELETE" }),
      {},
    );
    const requestInit = mockedBackendFetch.mock.calls[0]?.[1];
    expect(requestInit).not.toHaveProperty("body");
    expect(new Headers(requestInit?.headers).has("content-type")).toBe(false);
  });

  it.each([
    [
      "without CSRF proof",
      { spine_patient_sess: "access-token" },
      { Origin: ORIGIN },
      undefined,
      "csrf_missing",
    ],
    [
      "from a forbidden origin",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: createCsrfToken(CSRF_SECRET, "assessment-origin"),
      },
      {
        [CSRF_HEADER]: createCsrfToken(CSRF_SECRET, "assessment-origin"),
        Origin: "https://evil.example.test",
      },
      undefined,
      "origin_forbidden",
    ],
    [
      "with mismatched CSRF proof",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: createCsrfToken(CSRF_SECRET, "assessment-cookie"),
      },
      {
        [CSRF_HEADER]: createCsrfToken(CSRF_SECRET, "assessment-header"),
        Origin: ORIGIN,
      },
      undefined,
      "csrf_mismatch",
    ],
    [
      "with a body but no accepted Content-Type",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: createCsrfToken(CSRF_SECRET, "assessment-body"),
      },
      {
        [CSRF_HEADER]: createCsrfToken(CSRF_SECRET, "assessment-body"),
        Origin: ORIGIN,
      },
      "unexpected body",
      "content_type_unsupported",
    ],
  ] as const)(
    "rejects onboarding assessment document DELETEs %s",
    async (_title, cookies, headers, body, reason) => {
      const assessmentId = "10000000-0000-4000-8000-000000000001";
      const documentId = "10000000-0000-4000-8000-000000000002";
      const path = [
        "api",
        "v1",
        "patients",
        "me",
        "assessments",
        assessmentId,
        "documents",
        documentId,
      ];
      const request = makeProxyRequest(
        `/api/proxy/${path.join("/")}`,
        "DELETE",
        cookies,
        headers,
        body,
      );

      const response = await DELETE(request, makeContext(path));

      expect(response.status).toBe(
        reason === "content_type_unsupported" ? 415 : 403,
      );
      expect(mockedBackendFetch).not.toHaveBeenCalled();
      expect(mockedAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "phi.proxy.denied",
          reason,
          status: reason === "content_type_unsupported" ? 415 : 403,
        }),
      );
    },
  );

  it("forwards empty-stream document DELETEs without consuming the request", async () => {
    mockedBackendFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const csrf = createCsrfToken(CSRF_SECRET, "empty-stream-delete");
    const documentId = "10000000-0000-4000-8000-000000000001";
    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/documents/${documentId}`,
      "DELETE",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      }),
    );

    const response = await DELETE(
      request,
      makeContext(["api", "v1", "patients", "me", "documents", documentId]),
    );

    expect(response.status).toBe(204);
    expect(mockedBackendFetch).toHaveBeenCalledWith(
      `/api/v1/patients/me/documents/${documentId}`,
      expect.objectContaining({ method: "DELETE" }),
      {},
    );
    expect(mockedBackendFetch.mock.calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("preserves a bodyful document DELETE after the emptiness probe", async () => {
    mockedBackendFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const csrf = createCsrfToken(CSRF_SECRET, "bodyful-delete-forward");
    const documentId = "10000000-0000-4000-8000-000000000001";
    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/documents/${documentId}`,
      "DELETE",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
        "Content-Type": "application/json",
      },
      JSON.stringify({ reason: "user_requested" }),
    );

    const response = await DELETE(
      request,
      makeContext(["api", "v1", "patients", "me", "documents", documentId]),
    );

    expect(response.status).toBe(204);
    expect(mockedBackendFetch.mock.calls[0]?.[1]).toHaveProperty("body");
  });

  it("requires Content-Type for bodyless non-document DELETEs", async () => {
    const assessmentId = "10000000-0000-4000-8000-000000000001";
    const csrf = createCsrfToken(CSRF_SECRET, "assessment-delete");
    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/assessments/${assessmentId}`,
      "DELETE",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
    );

    const response = await DELETE(
      request,
      makeContext(["api", "v1", "patients", "me", "assessments", assessmentId]),
    );

    expect(response.status).toBe(415);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason: "content_type_required",
        status: 415,
      }),
    );
  });

  it.each([
    [
      "rejects bodyless document DELETEs without CSRF proof",
      { spine_patient_sess: "access-token" },
      { Origin: ORIGIN },
      undefined,
      "csrf_missing",
    ],
    [
      "rejects bodyless document DELETEs with mismatched CSRF proof",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: createCsrfToken(CSRF_SECRET, "csrf-cookie"),
      },
      {
        [CSRF_HEADER]: createCsrfToken(CSRF_SECRET, "different-token"),
        Origin: ORIGIN,
      },
      undefined,
      "csrf_mismatch",
    ],
    [
      "rejects bodyless document DELETEs from a forbidden origin",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: createCsrfToken(CSRF_SECRET, "origin-cookie"),
      },
      {
        [CSRF_HEADER]: createCsrfToken(CSRF_SECRET, "origin-cookie"),
        Origin: "https://evil.example.test",
      },
      undefined,
      "origin_forbidden",
    ],
  ] as const)("%s", async (_title, cookies, headers, body, reason) => {
    const documentId = "10000000-0000-4000-8000-000000000001";
    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/documents/${documentId}`,
      "DELETE",
      cookies,
      headers,
      body,
    );

    const response = await DELETE(
      request,
      makeContext(["api", "v1", "patients", "me", "documents", documentId]),
    );

    expect(response.status).toBe(403);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason,
        status: 403,
      }),
    );
  });

  it("rejects a bodyful document DELETE without an accepted Content-Type", async () => {
    const documentId = "10000000-0000-4000-8000-000000000001";
    const csrf = createCsrfToken(CSRF_SECRET, "bodyful-delete");
    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/documents/${documentId}`,
      "DELETE",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
      "unexpected body",
    );

    const response = await DELETE(
      request,
      makeContext(["api", "v1", "patients", "me", "documents", documentId]),
    );

    expect(response.status).toBe(415);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason: "content_type_unsupported",
        status: 415,
      }),
    );
  });

  it("classifies only explicitly long-running backend calls", () => {
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/assessments/assessment-123/adaptive/prepare",
      ),
    ).toBe(true);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/assessments/assessment-123/prefill",
      ),
    ).toBe(false);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/assessments/assessment-123/analysis/run",
      ),
    ).toBe(true);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/assessments/assessment-123/analysis",
      ),
    ).toBe(false);
    expect(isLongRunningBackendCall("/api/v1/patients/me/assessments")).toBe(
      false,
    );
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/intake/story/audio-uploads",
      ),
    ).toBe(false);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/intake/story/transcriptions",
      ),
    ).toBe(false);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/intake/story/transcriptions/audio",
      ),
    ).toBe(false);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/intake/story/transcriptions/extra",
      ),
    ).toBe(false);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/miscribe/recordings/10000000-0000-4000-8000-00000000000A/process",
      ),
    ).toBe(true);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/miscribe/recordings/10000000-0000-4000-8000-000000000001/upload-complete",
      ),
    ).toBe(false);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/miscribe/recordings/not-a-uuid/process",
      ),
    ).toBe(false);
    expect(
      isLongRunningBackendCall(
        "/api/v1/patients/me/miscribe/recordings/10000000-0000-7000-8000-000000000001/process",
      ),
    ).toBe(false);
  });

  it.each([
    "/api/v1/patients/me/intake/story/transcriptions",
    "/api/v1/patients/me/intake/story/transcriptions/audio",
    "/api/v1/patients/me/intake/story/live-transcription-session",
  ])(
    "blocks retired intake story route before backend forwarding: %s",
    async (targetPath) => {
      const csrf = createCsrfToken(CSRF_SECRET, "retired-story-route");
      const request = makeProxyRequest(
        `/api/proxy${targetPath}`,
        "POST",
        { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
        {
          "Content-Type": "audio/webm",
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        new Blob(["synthetic transcript"], { type: "audio/webm" }),
      );

      const response = await POST(
        request,
        makeContext(targetPath.slice(1).split("/")),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "proxy_path_not_allowed",
      });
      expect(mockedBackendFetch).not.toHaveBeenCalled();
      expect(mockedAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "phi.proxy.denied",
          reason: "proxy_path_not_allowed",
          status: 404,
        }),
      );
      expect(JSON.stringify(mockedAuditLog.mock.calls)).not.toContain(
        "synthetic transcript",
      );
    },
  );

  it("returns 405 when HTTP method is not allowed for the matched route", async () => {
    // /api/v1/patients/me/dashboard only allows GET
    const request = makeProxyRequest(
      "/api/proxy/api/v1/patients/me/dashboard",
      "POST",
      { spine_patient_sess: "access-token" },
      { "Content-Type": "application/json" },
    );
    const response = await POST(
      request,
      makeContext(["api", "v1", "patients", "me", "dashboard"]),
    );

    expect(response.status).toBe(405);
    const body = await response.json();
    expect(body).toHaveProperty("error");
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason: "proxy_method_not_allowed",
        status: 405,
      }),
    );
  });

  it("does not proxy document blob PUTs through the BFF upload-url route", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "document-upload-url-put-test");
    const request = makeProxyRequest(
      "/api/proxy/api/v1/patients/me/documents/upload-url",
      "PUT",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        "Content-Type": "application/octet-stream",
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
      new Uint8Array([1, 2, 3]),
    );
    const response = await PUT(
      request,
      makeContext(["api", "v1", "patients", "me", "documents", "upload-url"]),
    );

    expect(response.status).toBe(405);
    await expect(response.json()).resolves.toEqual({
      error: "proxy_method_not_allowed",
    });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("does not proxy binary bodies to allowed document API routes", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "document-confirm-binary-test");
    const documentId = "10000000-0000-4000-8000-000000000001";
    const request = makeProxyRequest(
      `/api/proxy/api/v1/patients/me/documents/${documentId}/confirm`,
      "POST",
      {
        spine_patient_sess: "access-token",
        spine_patient_csrf: csrf,
      },
      {
        "Content-Type": "application/octet-stream",
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
      new Uint8Array([1, 2, 3]),
    );
    const response = await POST(
      request,
      makeContext([
        "api",
        "v1",
        "patients",
        "me",
        "documents",
        documentId,
        "confirm",
      ]),
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "unsupported_media_type",
    });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
    expect(mockedAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "phi.proxy.denied",
        reason: "binary_document_payload_not_allowed",
        status: 415,
      }),
    );
  });

  it.each([
    ["GET", "/api/v1/fhir/policy"],
    [
      "POST",
      "/api/v1/fhir/connections/10000000-0000-4000-8000-000000000001/sync",
    ],
  ] as const)(
    "blocks excluded proxy target before forwarding: %s %s",
    async (method, targetPath) => {
      const csrf = createCsrfToken(CSRF_SECRET, "removed-route-denial");
      const request = makeProxyRequest(
        `/api/proxy${targetPath}`,
        method,
        {
          spine_patient_sess: "access-token",
          spine_patient_csrf: csrf,
        },
        {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        method === "GET" ? undefined : "{}",
      );
      const context = makeContext(targetPath.slice(1).split("/"));
      const response =
        method === "GET"
          ? await GET(request, context)
          : await POST(request, context);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "proxy_path_not_allowed",
      });
      expect(mockedBackendFetch).not.toHaveBeenCalled();
      expect(mockedAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "phi.proxy.denied",
          reason: "proxy_path_not_allowed",
          status: 404,
        }),
      );
    },
  );

  it("fails closed when a report-share request includes generic sharing fields", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "report-share-invalid-body");
    const request = makeProxyRequest(
      "/api/proxy/api/v1/shares",
      "POST",
      { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
      {
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
      JSON.stringify({
        scope_elements: ["visit_recordings"],
        ttl_hours: 72,
      }),
    );

    const response = await POST(request, makeContext(["api", "v1", "shares"]));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_report_share_request",
    });
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("never forwards a raw share token returned by the backend", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "report-share-raw-token");
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(
        {
          token: "raw-bearer-token",
          token_id: "10000000-0000-4000-8000-000000000001",
        },
        { status: 201 },
      ),
    );
    const request = makeProxyRequest(
      "/api/proxy/api/v1/shares",
      "POST",
      { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
      {
        "Content-Type": "application/json",
        [CSRF_HEADER]: csrf,
        Origin: ORIGIN,
      },
      JSON.stringify({
        report_share: true,
        report_id: "10000000-0000-4000-8000-000000000001",
        recipient_email: "recipient@example.test",
        acknowledged: true,
        acknowledgment_version: "share-consent-2026-01-01",
      }),
    );

    const response = await POST(request, makeContext(["api", "v1", "shares"]));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a share listing contains a non-report scope", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json({
        items: [{ scope_elements: ["visit_recordings"] }],
        total: 1,
      }),
    );

    const response = await GET(
      makeProxyRequest("/api/proxy/api/v1/shares", "GET", {
        spine_patient_sess: "access-token",
      }),
      makeContext(["api", "v1", "shares"]),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
    expect(mockedBackendFetch).toHaveBeenCalledTimes(1);
  });

  it("accepts only the strict report-share create receipt", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "report-share-valid-receipt");
    const receipt = {
      token_id: "10000000-0000-4000-8000-000000000001",
      expires_at: "2026-09-08T12:00:00Z",
      acknowledgment_version: "share-consent-2026-01-01",
      acknowledged_at: "2026-09-01T12:00:00Z",
      accepted: true,
      queued: true,
    };
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(receipt, { status: 201 }),
    );
    const response = await POST(
      makeProxyRequest(
        "/api/proxy/api/v1/shares",
        "POST",
        { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
        {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        JSON.stringify({
          report_share: true,
          report_id: "10000000-0000-4000-8000-000000000002",
          recipient_email: "recipient@example.test",
          acknowledged: true,
          acknowledgment_version: "share-consent-2026-01-01",
        }),
      ),
      makeContext(["api", "v1", "shares"]),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual(receipt);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects unknown nested report fields including transcripts", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "report-share-nested-field");
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(
        {
          token_id: "10000000-0000-4000-8000-000000000001",
          expires_at: "2026-09-08T12:00:00Z",
          acknowledgment_version: "share-consent-2026-01-01",
          acknowledged_at: "2026-09-01T12:00:00Z",
          accepted: true,
          queued: true,
          metadata: { transcript: "must-not-cross-the-BFF" },
        },
        { status: 201 },
      ),
    );
    const response = await POST(
      makeProxyRequest(
        "/api/proxy/api/v1/shares",
        "POST",
        { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
        {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        JSON.stringify({
          report_share: true,
          report_id: "10000000-0000-4000-8000-000000000002",
          recipient_email: "recipient@example.test",
          acknowledged: true,
          acknowledgment_version: "share-consent-2026-01-01",
        }),
      ),
      makeContext(["api", "v1", "shares"]),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "service_unavailable",
    });
  });

  it("accepts only strict report-share list items", async () => {
    const list = {
      items: [
        {
          id: "10000000-0000-4000-8000-000000000001",
          scope_elements: ["assessment_report"],
          target_provider_profile_id: null,
          expires_at: "2026-09-08T12:00:00Z",
          created_at: "2026-09-01T12:00:00Z",
          revoked_at: null,
          access_count: 0,
          last_accessed_at: null,
          status: "active",
        },
      ],
      total: 1,
      limit: 20,
      offset: 0,
      has_more: false,
    };
    mockedBackendFetch.mockResolvedValueOnce(Response.json(list));

    const response = await GET(
      makeProxyRequest("/api/proxy/api/v1/shares", "GET", {
        spine_patient_sess: "access-token",
      }),
      makeContext(["api", "v1", "shares"]),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(list);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("sanitizes report-share backend errors to an allowlisted schema", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      Response.json(
        {
          error: "private_backend_error",
          token: "raw-token",
          nested: { answers: ["private-answer"] },
        },
        { status: 409 },
      ),
    );
    const shareId = "10000000-0000-4000-8000-000000000001";
    const csrf = createCsrfToken(CSRF_SECRET, "share-delete-error");
    const response = await DELETE(
      makeProxyRequest(
        `/api/proxy/api/v1/shares/${shareId}`,
        "DELETE",
        { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
        {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        "",
      ),
      makeContext(["api", "v1", "shares", shareId]),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "conflict" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("accepts only a bodyless 204 report-share revocation receipt", async () => {
    mockedBackendFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );
    const shareId = "10000000-0000-4000-8000-000000000001";
    const csrf = createCsrfToken(CSRF_SECRET, "share-delete-success");
    const response = await DELETE(
      makeProxyRequest(
        `/api/proxy/api/v1/shares/${shareId}`,
        "DELETE",
        { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
        {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        "",
      ),
      makeContext(["api", "v1", "shares", shareId]),
    );

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects an oversized restored body from Content-Length before buffering", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "body-limit-content-length");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([123]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await POST(
      makeProxyRequest(
        "/api/proxy/api/v1/patients/me/intake/story/segments",
        "POST",
        { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
        {
          "Content-Type": "application/json",
          "Content-Length": String(8 * 1024 + 1),
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        stream,
      ),
      makeContext([
        "api",
        "v1",
        "patients",
        "me",
        "intake",
        "story",
        "segments",
      ]),
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "payload_too_large",
    });
    expect(cancelled).toBe(true);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });

  it("cancels an oversized chunked restored body with no Content-Length", async () => {
    const csrf = createCsrfToken(CSRF_SECRET, "body-limit-chunked");
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(5 * 1024));
        controller.enqueue(new Uint8Array(4 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await POST(
      makeProxyRequest(
        "/api/proxy/api/v1/patients/me/intake/story/segments",
        "POST",
        { spine_patient_sess: "access-token", spine_patient_csrf: csrf },
        {
          "Content-Type": "application/json",
          [CSRF_HEADER]: csrf,
          Origin: ORIGIN,
        },
        stream,
      ),
      makeContext([
        "api",
        "v1",
        "patients",
        "me",
        "intake",
        "story",
        "segments",
      ]),
    );

    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(mockedBackendFetch).not.toHaveBeenCalled();
  });
});
