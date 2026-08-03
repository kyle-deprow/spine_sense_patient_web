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

const SAFE_PERSISTENCE_MISMATCHES = new Set([
  "analysis",
  "analysis_document_input",
  "assessment",
  "assessment_document_link",
  "document",
  "friendly_category",
  "friendly_doc_type",
  "ocr_page_count",
  "ocr_provider",
  "ocr_status",
  "ocr_text_length",
  "ocr_text_lineage",
  "ocr_text_markers",
  "patient_findings",
  "patient_summary",
  "scan",
  "summary_assessment",
  "summary_completed_at",
  "summary_status",
]);

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }
  const record = await readExactTestSupportObject(request, [
    "assessment_id",
    "document_id",
    "email",
    "expected_ocr_page_count",
    "expected_ocr_min_chars",
    "expected_ocr_markers",
    "expected_ocr_provider",
    "expected_summary_min_chars",
  ]);
  const assessmentId = record?.assessment_id;
  const documentId = record?.document_id;
  const email = record?.email;
  if (
    !isUuid(assessmentId) ||
    !isUuid(documentId) ||
    !isExactSyntheticEmail(email) ||
    record?.expected_ocr_page_count !==
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrPageCount ||
    record?.expected_ocr_min_chars !==
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumOcrTextLength ||
    !exactStringArray(
      record?.expected_ocr_markers,
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrMarkers,
    ) ||
    record?.expected_ocr_provider !==
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrProvider ||
    record?.expected_summary_min_chars !==
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumSummaryLength
  ) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }
  const forwarded = {
    assessment_id: assessmentId,
    document_id: documentId,
    email,
    expected_ocr_page_count:
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrPageCount,
    expected_ocr_min_chars:
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumOcrTextLength,
    expected_ocr_markers: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrMarkers,
    expected_ocr_provider:
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrProvider,
    expected_summary_min_chars:
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumSummaryLength,
  };

  try {
    const backendResponse = await forwardPatientWebTestSupport(
      "/test/document-analysis-persistence",
      forwarded,
    );
    if (backendResponse === null) return testSupportUnavailableResponse();
    if (!backendResponse.ok) {
      if (backendResponse.status === 409) {
        const conflict = safePersistenceConflict(
          await readJsonBody<unknown>(backendResponse),
        );
        if (conflict == null) return testSupportUnavailableResponse();
        return jsonNoStore(
          { error: "support_conflict", mismatches: conflict },
          { status: 409 },
        );
      }
      return testSupportBackendFailure(backendResponse.status);
    }

    const backendBody = await readJsonBody<unknown>(backendResponse);
    const body = asRecord(backendBody);
    const analysis = asRecord(body?.analysis);
    const document = asRecord(body?.document);
    const summary = asRecord(body?.summary);
    if (
      !sameUuid(body?.assessment_id, assessmentId) ||
      !sameUuid(body?.document_id, documentId) ||
      analysis?.assessment_complete !== true ||
      analysis.status !== "complete" ||
      analysis.document_input_provenance !== true ||
      document?.scan_status !== "clean" ||
      document.ocr_status !== "complete" ||
      document.ocr_provider_matches !== true ||
      document.extracted_text_substantive !== true ||
      document.expected_ocr_markers_present !== true ||
      document.ocr_text_sha256_matches !== true ||
      document.ocr_page_count_matches !== true ||
      summary?.status !== "complete" ||
      summary.materialized_for_assessment !== true ||
      summary.completed_at_present !== true ||
      summary.category_present !== true ||
      summary.document_type_present !== true ||
      summary.summary_present !== true ||
      summary.patient_summary_substantive !== true ||
      summary.findings_present !== true ||
      summary.source_sha256_matches_ocr_text !== true
    ) {
      return testSupportUnavailableResponse();
    }

    return jsonNoStore({
      assessment_id: assessmentId,
      document_id: documentId,
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
    });
  } catch {
    return testSupportUnavailableResponse();
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

function safePersistenceConflict(value: unknown): string[] | null {
  const record = asRecord(value);
  const mismatches = record?.mismatches;
  if (
    !Array.isArray(mismatches) ||
    mismatches.length === 0 ||
    mismatches.some(
      (item) =>
        typeof item !== "string" || !SAFE_PERSISTENCE_MISMATCHES.has(item),
    )
  ) {
    return null;
  }
  return [...new Set(mismatches)].sort();
}
