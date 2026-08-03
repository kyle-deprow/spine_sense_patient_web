import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT } from "@/lib/e2e/document-upload-fixture";

const TEST_TOKEN = "test-support-token-with-at-least-32-chars";
const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const ASSESSMENT_ID = "223e4567-e89b-42d3-a456-426614174000";
const EMAIL =
  "casey.assessment.123e4567-e89b-42d3-a456-426614174000@e2e.example.com";
const BODY = {
  assessment_id: ASSESSMENT_ID,
  document_id: DOCUMENT_ID,
  email: EMAIL,
  expected_ocr_page_count:
    SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrPageCount,
  expected_ocr_min_chars:
    SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumOcrTextLength,
  expected_ocr_markers: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrMarkers,
  expected_ocr_provider: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrProvider,
  expected_summary_min_chars:
    SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumSummaryLength,
};
const FACTS = {
  assessment_id: ASSESSMENT_ID,
  document_id: DOCUMENT_ID,
  analysis: {
    assessment_complete: true,
    status: "complete",
    document_input_provenance: true,
  },
  document: {
    scan_status: "clean",
    ocr_status: "complete",
    ocr_provider_matches: true,
    extracted_text_substantive: true,
    expected_ocr_markers_present: true,
    ocr_text_sha256_matches: true,
    ocr_page_count_matches: true,
  },
  summary: {
    status: "complete",
    materialized_for_assessment: true,
    completed_at_present: true,
    category_present: true,
    document_type_present: true,
    summary_present: true,
    patient_summary_substantive: true,
    findings_present: true,
    source_sha256_matches_ocr_text: true,
  },
};

function makeRequest(body: unknown, token = TEST_TOKEN): NextRequest {
  return new NextRequest(
    "https://patient-web.example.com/api/test/document-analysis-persistence",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
}

describe("patient web document-analysis-persistence support route", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);
    vi.stubEnv("PATIENT_WEB_BACKEND_TEST_SUPPORT_TOKEN", TEST_TOKEN);
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "document-analysis-test-csrf-secret-at-least-32-bytes",
    );
    vi.stubEnv("PATIENT_WEB_CLIENT_IP_MODE", "single-bucket");
    vi.stubEnv("PATIENT_WEB_CREDENTIAL_RATE_LIMIT_STORE", "memory");
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "https://patient.example.test");
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("returns only exact post-analysis metadata facts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        ...FACTS,
        summary: { ...FACTS.summary, summary_text: "must-not-leak" },
        analysis_payload: { document_text: "must-not-leak" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual(FACTS);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/test/document-analysis-persistence", "http://backend.internal"),
      expect.objectContaining({ body: JSON.stringify(BODY) }),
    );
  });

  it.each([
    { ...BODY, unexpected: true },
    { ...BODY, assessment_id: "not-a-uuid" },
    { ...BODY, document_id: "not-a-uuid" },
    { ...BODY, email: "patient@example.com" },
    { ...BODY, expected_ocr_page_count: 1 },
    { ...BODY, expected_ocr_min_chars: 1 },
    { ...BODY, expected_ocr_markers: ["SpineSense"] },
    { ...BODY, expected_ocr_provider: "azure_document_intelligence_read" },
    { ...BODY, expected_summary_min_chars: 1 },
  ])("rejects non-exact post-analysis metadata requests: %j", async (body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    expect((await POST(makeRequest(body))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when analysis-document materialization is unproven", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...FACTS,
          summary: { ...FACTS.summary, materialized_for_assessment: false },
        }),
      ),
    );
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
  });

  it("fails closed when the persisted OCR provider is unproven", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          ...FACTS,
          document: { ...FACTS.document, ocr_provider_matches: false },
        }),
      ),
    );
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
  });

  it.each([
    ["missing", { assessment_complete: true, status: "complete" }],
    ["false", { ...FACTS.analysis, document_input_provenance: false }],
    ["null", { ...FACTS.analysis, document_input_provenance: null }],
    ["string", { ...FACTS.analysis, document_input_provenance: "true" }],
    ["number", { ...FACTS.analysis, document_input_provenance: 1 }],
    ["object", { ...FACTS.analysis, document_input_provenance: {} }],
  ])(
    "fails closed when the main analysis input provenance is %s",
    async (_case, analysis) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          Response.json({
            ...FACTS,
            analysis,
          }),
        ),
      );
      const { POST } = await import("./route");

      const response = await POST(makeRequest(BODY));

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "service_unavailable" });
    },
  );

  it("maps backend mismatch details to a metadata-only conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { mismatches: ["summary_present"], detail: "must-not-leak" },
            { status: 409 },
          ),
        ),
    );
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "support_conflict" });
  });
});
