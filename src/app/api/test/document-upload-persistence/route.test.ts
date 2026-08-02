import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT } from "@/lib/e2e/document-upload-fixture";

const TEST_TOKEN = "test-support-token-with-at-least-32-chars";
const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const ASSESSMENT_ID = "223e4567-e89b-42d3-a456-426614174000";
const EMAIL =
  "casey.assessment.123e4567-e89b-42d3-a456-426614174000@e2e.example.com";
const BODY = {
  document_id: DOCUMENT_ID,
  assessment_id: ASSESSMENT_ID,
  email: EMAIL,
  expected_content_sha256: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.contentSha256,
  expected_content_type: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.mimeType,
  expected_file_size_bytes: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.fileSizeBytes,
  expected_processing_status:
    SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.processingStatus,
  expected_scan_status: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.scanStatus,
};
const DATABASE = {
  patient_document: true,
  assessment_document_link: true,
  upload_generation: true,
  processing_status: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.processingStatus,
  scan_status: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.scanStatus,
  generation_state: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.generationState,
  content_sha256_matches: true,
  final_receipt: true,
  ocr_status: "complete",
  ocr_source_sha256_matches: true,
  extracted_text_present: true,
  ocr_text_sha256_matches: true,
  ocr_page_count_positive: true,
};
const OBJECT = {
  promoted: true,
  receipt_matches: true,
  content_sha256_matches: true,
  size_matches: true,
};

function makeRequest(body: unknown, token = TEST_TOKEN): NextRequest {
  return new NextRequest(
    "https://patient-web.example.com/api/test/document-upload-persistence",
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

describe("patient web document-upload-persistence support route", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_ENABLED", "true");
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", TEST_TOKEN);
    vi.stubEnv("BACKEND_INTERNAL_URL", "http://backend.internal");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "document-persistence-test-csrf-secret-at-least-32-bytes",
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

  it("forwards exact synthetic metadata and returns only persistence facts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        document_id: DOCUMENT_ID,
        assessment_id: ASSESSMENT_ID,
        database: { ...DATABASE, content_sha256: "must-not-leak" },
        object: { ...OBJECT, storage_key: "must-not-leak" },
        document: { extracted_text: "must-not-leak" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({
      document_id: DOCUMENT_ID,
      assessment_id: ASSESSMENT_ID,
      database: DATABASE,
      object: OBJECT,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/test/document-upload-persistence", "http://backend.internal"),
      expect.objectContaining({ body: JSON.stringify(BODY) }),
    );
  });

  it.each([
    { ...BODY, unexpected: true },
    { ...BODY, document_id: "not-a-uuid" },
    { ...BODY, email: "patient@example.com" },
    { ...BODY, expected_content_sha256: "0".repeat(64) },
    { ...BODY, expected_file_size_bytes: 68 },
    { ...BODY, expected_processing_status: "processing" },
  ])("rejects non-exact persistence metadata: %j", async (body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { POST } = await import("./route");

    expect((await POST(makeRequest(body))).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an upstream identity mismatch without exposing its body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          document_id: "323e4567-e89b-42d3-a456-426614174000",
          assessment_id: ASSESSMENT_ID,
          database: DATABASE,
          object: OBJECT,
        }),
      ),
    );
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
  });

  it("fails closed when the backend cannot attest the final receipt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          document_id: DOCUMENT_ID,
          assessment_id: ASSESSMENT_ID,
          database: { ...DATABASE, final_receipt: false },
          object: OBJECT,
        }),
      ),
    );
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
  });

  it("fails closed when the backend cannot attest OCR lineage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          document_id: DOCUMENT_ID,
          assessment_id: ASSESSMENT_ID,
          database: { ...DATABASE, ocr_source_sha256_matches: false },
          object: OBJECT,
        }),
      ),
    );
    const { POST } = await import("./route");

    const response = await POST(makeRequest(BODY));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service_unavailable" });
  });

  it("maps a backend mismatch to a metadata-only conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            detail: "Document upload persistence mismatch",
            mismatches: ["file_size_bytes"],
          },
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
