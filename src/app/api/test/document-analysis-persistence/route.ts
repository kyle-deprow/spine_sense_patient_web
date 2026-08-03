import type { NextRequest } from "next/server";

import { readJsonBody } from "@/lib/server/backend";
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

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }
  const record = await readExactTestSupportObject(request, [
    "assessment_id",
    "document_id",
    "email",
  ]);
  const assessmentId = record?.assessment_id;
  const documentId = record?.document_id;
  const email = record?.email;
  if (
    !isUuid(assessmentId) ||
    !isUuid(documentId) ||
    !isExactSyntheticEmail(email)
  ) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }
  const forwarded = {
    assessment_id: assessmentId,
    document_id: documentId,
    email,
  };

  try {
    const backendResponse = await forwardPatientWebTestSupport(
      "/test/document-analysis-persistence",
      forwarded,
    );
    if (backendResponse === null) return testSupportUnavailableResponse();
    if (!backendResponse.ok) {
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
      document.ocr_text_sha256_matches !== true ||
      summary?.status !== "complete" ||
      summary.materialized_for_assessment !== true ||
      summary.completed_at_present !== true ||
      summary.category_present !== true ||
      summary.document_type_present !== true ||
      summary.summary_present !== true ||
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
        ocr_text_sha256_matches: true,
      },
      summary: {
        status: "complete",
        materialized_for_assessment: true,
        completed_at_present: true,
        category_present: true,
        document_type_present: true,
        summary_present: true,
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
