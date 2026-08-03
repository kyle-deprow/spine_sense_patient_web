import { expect, type APIRequestContext, type Page } from "@playwright/test";

import {
  BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL,
  TEST_SUPPORT_TOKEN,
  isRecord,
  type JourneyContext,
  type UploadedAssessmentDocument,
} from "../journey/context";
import { waitForEnabledAndClick } from "../journey/selectors";
import { DOCUMENT_SUMMARY_READINESS_TIMEOUT_MS } from "../journey/timeouts";
import { safeResponseMetadata } from "./recordsUpload";
import { SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT } from "../../src/lib/e2e/document-upload-fixture";

type SummaryReadyDocument = Readonly<{ id: string }>;

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

export function safePersistenceMismatchAxes(payload: unknown): string[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.mismatches)) return null;
  if (
    payload.mismatches.length === 0 ||
    payload.mismatches.some(
      (item) =>
        typeof item !== "string" || !SAFE_PERSISTENCE_MISMATCHES.has(item),
    )
  ) {
    return null;
  }
  return [...new Set(payload.mismatches as string[])].sort();
}

export function requireSummaryReadyDocument(
  payload: unknown,
  documentId: string,
): SummaryReadyDocument | null {
  if (!isRecord(payload) || !Array.isArray(payload.documents)) return null;
  const document = payload.documents.find(
    (item) => isRecord(item) && item.id === documentId,
  );
  if (!isRecord(document)) return null;
  if (
    document.status !== "summary_ready" ||
    document.processing_stage !== "complete" ||
    document.is_terminal !== true
  ) {
    return null;
  }
  for (const field of [
    document.category,
    document.document_type,
    document.doc_type,
    document.summary,
  ]) {
    if (typeof field !== "string" || field.trim().length === 0) return null;
  }
  return { id: documentId };
}

export async function waitForSummaryReadyDocument(
  page: Page,
  documentId: string,
  timeout = DOCUMENT_SUMMARY_READINESS_TIMEOUT_MS,
  pollInterval = 5000,
): Promise<SummaryReadyDocument> {
  const deadline = Date.now() + timeout;
  let lastStatus: number | undefined;
  do {
    const response = await page.request.get(
      "/api/proxy/api/v1/patients/me/documents/overview",
    );
    lastStatus = response.status();
    expect(
      new URL(response.url()).origin,
      "document overview must be read through the same-origin BFF",
    ).toBe(new URL(page.url()).origin);
    if (response.ok()) {
      const payload: unknown = await response.json();
      const ready = requireSummaryReadyDocument(payload, documentId);
      if (ready != null) return ready;
      if (
        isRecord(payload) &&
        Array.isArray(payload.documents) &&
        payload.documents.some(
          (item) =>
            isRecord(item) &&
            item.id === documentId &&
            item.status === "failed",
        )
      ) {
        throw new Error(
          "Analyzed document entered failed state before summary readiness",
        );
      }
    }
    if (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    }
  } while (Date.now() < deadline);

  throw new Error(
    `Analyzed document summary did not become ready status=${lastStatus ?? "unknown"}`,
  );
}

export async function verifyDocumentAnalysisPersistence(
  request: APIRequestContext,
  email: string,
  uploaded: UploadedAssessmentDocument,
): Promise<void> {
  if (!BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL is required for post-analysis document verification",
    );
  }
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for post-analysis document verification",
    );
  }
  const response = await request.post(
    BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL,
    {
      headers: {
        authorization: `Bearer ${TEST_SUPPORT_TOKEN}`,
        "content-type": "application/json",
      },
      data: {
        assessment_id: uploaded.assessmentId,
        document_id: uploaded.documentId,
        email,
        expected_ocr_page_count:
          SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrPageCount,
        expected_ocr_min_chars:
          SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumOcrTextLength,
        expected_ocr_markers:
          SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrMarkers,
        expected_ocr_provider:
          SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrProvider,
        expected_summary_min_chars:
          SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumSummaryLength,
      },
      timeout: 30_000,
    },
  );
  const payload: unknown = await response.json();
  const metadata = safeResponseMetadata(payload);
  const mismatches = safePersistenceMismatchAxes(payload);
  expect(
    response.status(),
    `document analysis persistence verification failed status=${response.status()} code=${metadata.code ?? "unknown"} mismatches=${mismatches?.join(",") ?? "unknown"}`,
  ).toBe(200);
  expect(payload).toEqual({
    assessment_id: uploaded.assessmentId,
    document_id: uploaded.documentId,
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
}

async function renderExactDocumentSummary(
  page: Page,
  documentId: string,
): Promise<void> {
  const resultsUrl = page.url();
  await waitForEnabledAndClick(page, "tab-documents", 30_000);
  await expect(page.getByTestId("documents-screen")).toBeVisible({
    timeout: 60_000,
  });
  const card = page.getByTestId(`document-card-${documentId}`);
  await expect(card).toBeVisible({ timeout: 60_000 });
  await waitForEnabledAndClick(
    page,
    `document-card-${documentId}-toggle`,
    30_000,
  );
  const body = page.getByTestId(`document-card-${documentId}-body`);
  await expect(body).toBeVisible();
  const hasNonemptySummary = await body.evaluate((element) => {
    const summary = element.children.item(1)?.textContent?.trim() ?? "";
    return summary.length > 0;
  });
  expect(
    hasNonemptySummary,
    "expanded document card must render a nonempty server summary",
  ).toBe(true);

  await page.goto(resultsUrl);
  await expect(page.getByTestId("results-screen")).toBeVisible({
    timeout: 60_000,
  });
}

export async function verifyAnalyzedDocument(context: JourneyContext) {
  const uploaded = context.uploadedAssessmentDocument;
  if (uploaded == null) {
    throw new Error(
      "Post-analysis document verification requires the exact uploaded assessment document IDs",
    );
  }
  await waitForSummaryReadyDocument(context.page, uploaded.documentId);
  await verifyDocumentAnalysisPersistence(
    context.request,
    context.email,
    uploaded,
  );
  await renderExactDocumentSummary(context.page, uploaded.documentId);
}
