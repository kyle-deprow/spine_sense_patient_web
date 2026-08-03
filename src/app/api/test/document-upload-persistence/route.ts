import type { NextRequest } from "next/server";

import { readJsonBody } from "@/lib/server/backend";
import { SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT } from "@/lib/e2e/document-upload-fixture";
import { jsonNoStore } from "@/lib/server/responses";
import {
  forwardPatientWebTestSupport,
  hasPatientWebTestSupportAccess,
  isExactSyntheticEmail,
  isUuid,
  readExactTestSupportObject,
  testSupportBackendFailure,
  testSupportUnavailableResponse,
} from "@/lib/server/test-support";

const EXPECTED_CONTENT_TYPE = SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.mimeType;
const EXPECTED_FILE_SIZE_BYTES =
  SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.fileSizeBytes;
const EXPECTED_PROCESSING_STATUS =
  SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.processingStatus;
const EXPECTED_SCAN_STATUS = SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.scanStatus;

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  const record = await readExactTestSupportObject(request, [
    "assessment_id",
    "document_id",
    "email",
    "expected_content_sha256",
    "expected_content_type",
    "expected_file_size_bytes",
    "expected_processing_status",
    "expected_scan_status",
    "expected_ocr_page_count",
    "expected_ocr_min_chars",
    "expected_ocr_markers",
    "expected_ocr_provider",
  ]);
  const assessmentId = record?.assessment_id;
  const documentId = record?.document_id;
  const email = record?.email;
  if (
    !isUuid(assessmentId) ||
    !isUuid(documentId) ||
    !isExactSyntheticEmail(email) ||
    record?.expected_content_sha256 !==
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.contentSha256 ||
    record?.expected_content_type !== EXPECTED_CONTENT_TYPE ||
    record?.expected_file_size_bytes !== EXPECTED_FILE_SIZE_BYTES ||
    record?.expected_processing_status !== EXPECTED_PROCESSING_STATUS ||
    record?.expected_scan_status !== EXPECTED_SCAN_STATUS ||
    record?.expected_ocr_page_count !==
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrPageCount ||
    record?.expected_ocr_min_chars !==
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumOcrTextLength ||
    !exactStringArray(
      record?.expected_ocr_markers,
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrMarkers,
    ) ||
    record?.expected_ocr_provider !==
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrProvider
  ) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  const forwarded = {
    document_id: documentId,
    assessment_id: assessmentId,
    email,
    expected_content_sha256: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.contentSha256,
    expected_content_type: EXPECTED_CONTENT_TYPE,
    expected_file_size_bytes: EXPECTED_FILE_SIZE_BYTES,
    expected_processing_status: EXPECTED_PROCESSING_STATUS,
    expected_scan_status: EXPECTED_SCAN_STATUS,
    expected_ocr_page_count:
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrPageCount,
    expected_ocr_min_chars:
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumOcrTextLength,
    expected_ocr_markers: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrMarkers,
    expected_ocr_provider:
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrProvider,
  };

  try {
    const backendResponse = await forwardPatientWebTestSupport(
      "/test/document-upload-persistence",
      forwarded,
    );
    if (backendResponse === null) return testSupportUnavailableResponse();
    if (!backendResponse.ok) {
      return testSupportBackendFailure(backendResponse.status);
    }

    const backendBody = await readJsonBody<unknown>(backendResponse);
    const body =
      backendBody != null &&
      typeof backendBody === "object" &&
      !Array.isArray(backendBody)
        ? (backendBody as Record<string, unknown>)
        : null;
    const database =
      body?.database != null &&
      typeof body.database === "object" &&
      !Array.isArray(body.database)
        ? (body.database as Record<string, unknown>)
        : null;
    const object =
      body?.object != null &&
      typeof body.object === "object" &&
      !Array.isArray(body.object)
        ? (body.object as Record<string, unknown>)
        : null;
    if (
      !sameUuid(body?.document_id, documentId) ||
      !sameUuid(body?.assessment_id, assessmentId) ||
      database?.patient_document !== true ||
      database.assessment_document_link !== true ||
      database.upload_generation !== true ||
      database.processing_status !== EXPECTED_PROCESSING_STATUS ||
      database.scan_status !== EXPECTED_SCAN_STATUS ||
      database.generation_state !==
        SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.generationState ||
      database.content_sha256_matches !== true ||
      database.final_receipt !== true ||
      database.ocr_status !== "complete" ||
      database.ocr_provider_matches !== true ||
      database.ocr_source_sha256_matches !== true ||
      database.extracted_text_substantive !== true ||
      database.expected_ocr_markers_present !== true ||
      database.ocr_text_sha256_matches !== true ||
      database.ocr_page_count_matches !== true ||
      object?.promoted !== true ||
      object.receipt_matches !== true ||
      object.content_sha256_matches !== true ||
      object.size_matches !== true
    ) {
      return testSupportUnavailableResponse();
    }

    return jsonNoStore({
      document_id: documentId,
      assessment_id: assessmentId,
      database: {
        patient_document: true,
        assessment_document_link: true,
        upload_generation: true,
        processing_status: EXPECTED_PROCESSING_STATUS,
        scan_status: EXPECTED_SCAN_STATUS,
        generation_state: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.generationState,
        content_sha256_matches: true,
        final_receipt: true,
        ocr_status: "complete",
        ocr_provider_matches: true,
        ocr_source_sha256_matches: true,
        extracted_text_substantive: true,
        expected_ocr_markers_present: true,
        ocr_text_sha256_matches: true,
        ocr_page_count_matches: true,
      },
      object: {
        promoted: true,
        receipt_matches: true,
        content_sha256_matches: true,
        size_matches: true,
      },
    });
  } catch {
    return testSupportUnavailableResponse();
  }
}

function sameUuid(value: unknown, expected: string): boolean {
  return (
    typeof value === "string" && value.toLowerCase() === expected.toLowerCase()
  );
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}
