import {
  expect,
  type APIRequestContext,
  type FileChooser,
  type Page,
  type Response as PlaywrightResponse,
} from "@playwright/test";

import {
  BACKEND_DOCUMENT_SCAN_RESULT_URL,
  BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL,
  SYNTHETIC_ASSESSMENT_UPLOAD,
  TEST_SUPPORT_TOKEN,
  TRANSITION_BUDGETS_MS,
  assessmentDocumentConfirmationFromResponse,
  assessmentIdFromDocumentsUrl,
  documentIdFromUploadResponse,
  normalizeAssessmentDocument,
  type AssessmentDocumentRecord,
  type AssessmentUploadUrlResponse,
  type UploadedAssessmentDocument,
} from "../journey/context";
import { SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT } from "../../src/lib/e2e/document-upload-fixture";
import {
  classifyRecovery,
  assertRecoveryAttempt,
} from "../support/recoveryPolicy";
import { actionableLocatorForTestId } from "../journey/selectors";
import { DOCUMENT_OCR_READINESS_TIMEOUT_MS } from "../journey/timeouts";

export { DOCUMENT_OCR_READINESS_TIMEOUT_MS } from "../journey/timeouts";

type SafeResponseMetadata = Readonly<{
  code?: string;
}>;

type NormalizedAssessmentDocument = ReturnType<
  typeof normalizeAssessmentDocument
>;

export type DocumentConfirmationReadiness =
  | Readonly<{
      source: "response";
      response: PlaywrightResponse;
    }>
  | Readonly<{
      source: "persisted";
      document: NormalizedAssessmentDocument;
    }>;

export function safeResponseMetadata(payload: unknown): SafeResponseMetadata {
  if (
    payload == null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return {};
  }

  const record = payload as Record<string, unknown>;
  const nestedError =
    record.error != null &&
    typeof record.error === "object" &&
    !Array.isArray(record.error)
      ? (record.error as Record<string, unknown>)
      : undefined;
  const code =
    typeof record.code === "string"
      ? record.code
      : typeof nestedError?.code === "string"
        ? nestedError.code
        : undefined;
  return code == null ? {} : { code };
}

function uploadUrlFailureMessage(
  response: PlaywrightResponse,
  metadata: SafeResponseMetadata,
): string {
  const code = metadata.code ?? "unknown";
  return `assessment document upload-url status=${response.status()} code=${code}`;
}

export async function waitForDocumentConfirmationOrPersistence(
  confirmResponse: Promise<PlaywrightResponse>,
  persistedDocument: () => Promise<NormalizedAssessmentDocument>,
  uploadError: Promise<"upload_error">,
): Promise<DocumentConfirmationReadiness> {
  void confirmResponse.catch(() => undefined);
  const confirmation = confirmResponse
    .then(
      (response): DocumentConfirmationReadiness => ({
        source: "response",
        response,
      }),
    )
    .catch(() =>
      persistedDocument().then(
        (document): DocumentConfirmationReadiness => ({
          source: "persisted",
          document,
        }),
      ),
    );
  const outcome = await Promise.race([confirmation, uploadError]);
  if (outcome === "upload_error") {
    throw new Error(
      "Assessment document byte upload failed before confirmation",
    );
  }
  return outcome;
}

export async function uploadSyntheticAssessmentDocumentFromRecordsStep(
  page: Page,
  email: string,
): Promise<UploadedAssessmentDocument> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let observedStatus: number | undefined;
    let uploadUrlResponsePromise: Promise<PlaywrightResponse> | null = null;
    let confirmResponsePromise: Promise<PlaywrightResponse> | null = null;
    let uploadErrorPromise: Promise<"upload_error"> | null = null;
    let fileChooserPromise: Promise<FileChooser> | null = null;
    try {
      if (
        await page
          .getByTestId("records-assessment-error")
          .isVisible({ timeout: 1000 })
          .catch(() => false)
      ) {
        throw new Error(
          "Assessment document preparation failed before a correlated retryable response",
        );
      }

      const chooseFileButton = await actionableLocatorForTestId(
        page,
        "records-choose-file-button",
      );
      await expect(chooseFileButton).toBeVisible({ timeout: 60_000 });
      const chooseFileReady = await Promise.race([
        expect(chooseFileButton)
          .toBeEnabled({ timeout: 60_000 })
          .then(() => "enabled" as const)
          .catch(() => "not_enabled" as const),
        page
          .getByTestId("records-assessment-error")
          .waitFor({ state: "visible", timeout: 60_000 })
          .then(() => "assessment_error" as const)
          .catch(() => "no_assessment_error" as const),
      ]);
      if (chooseFileReady === "assessment_error") {
        throw new Error("Assessment document saving preparation failed");
      }
      if (chooseFileReady !== "enabled") {
        await expect(chooseFileButton).toBeEnabled({ timeout: 1_000 });
      }
      fileChooserPromise = page.waitForEvent("filechooser", {
        timeout: 30_000,
      });
      await chooseFileButton.click({ timeout: 10_000 });
      const fileChooser = await fileChooserPromise;

      uploadUrlResponsePromise = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes("/api/proxy/api/v1/patients/me/assessments/") &&
          response.url().endsWith("/documents/upload-url") &&
          response.request().method() === "POST",
        { timeout: TRANSITION_BUDGETS_MS.stage },
      );
      confirmResponsePromise = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes("/api/proxy/api/v1/patients/me/assessments/") &&
          /\/documents\/[0-9a-f-]+\/confirm$/i.test(
            new URL(response.url()).pathname,
          ) &&
          response.request().method() === "POST",
        { timeout: 30_000 },
      );
      uploadErrorPromise = page
        .getByTestId("records-file-error")
        .waitFor({ state: "visible", timeout: TRANSITION_BUDGETS_MS.stage })
        .then(() => "upload_error" as const);
      void uploadErrorPromise.catch(() => undefined);
      await fileChooser.setFiles(SYNTHETIC_ASSESSMENT_UPLOAD);

      const uploadUrlResponse = await uploadUrlResponsePromise;
      observedStatus = uploadUrlResponse.status();
      const uploadUrlPayload = await uploadUrlResponse.json();
      if (!uploadUrlResponse.ok()) {
        throw new Error(
          uploadUrlFailureMessage(
            uploadUrlResponse,
            safeResponseMetadata(uploadUrlPayload),
          ),
        );
      }
      expect(
        uploadUrlResponse.ok(),
        `assessment document upload-url status=${uploadUrlResponse.status()}`,
      ).toBe(true);
      const uploadPayload = uploadUrlPayload as AssessmentUploadUrlResponse;
      const documentId = documentIdFromUploadResponse(uploadPayload);
      const assessmentId = assessmentIdFromDocumentsUrl(
        uploadUrlResponse.url(),
      );

      const confirmation = await waitForDocumentConfirmationOrPersistence(
        confirmResponsePromise,
        () =>
          waitForPersistedDocumentConfirmation(
            page.request,
            assessmentId,
            documentId,
          ),
        uploadErrorPromise,
      );
      let confirmedDocument: Pick<
        NormalizedAssessmentDocument,
        "id" | "processingStatus"
      >;
      if (confirmation.source === "response") {
        observedStatus = confirmation.response.status();
        expect(
          new URL(confirmation.response.url()).pathname,
          "assessment document confirm response must match the issued assessment and document",
        ).toBe(
          `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/documents/${documentId}/confirm`,
        );
        expect(
          confirmation.response.ok(),
          `assessment document confirm status=${confirmation.response.status()}`,
        ).toBe(true);
        const confirmed = assessmentDocumentConfirmationFromResponse(
          await confirmation.response.json(),
        );
        confirmedDocument = {
          id: confirmed.documentId,
          processingStatus: confirmed.processingStatus,
        };
        expect(
          confirmedDocument.id,
          "assessment document confirm response must match the issued document",
        ).toBe(documentId);
      } else {
        confirmedDocument = confirmation.document;
      }
      expect(["processing", "complete"]).toContain(
        confirmedDocument.processingStatus,
      );
      if (confirmedDocument.processingStatus === "processing") {
        await completeSyntheticDocumentScan(page.request, documentId, email);
      }
      const landed = await waitForAssessmentDocumentComplete(
        page.request,
        assessmentId,
        documentId,
      );

      await expect(
        page.getByTestId(`records-document-${documentId}`),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByText(SYNTHETIC_ASSESSMENT_UPLOAD.name),
      ).toBeVisible();

      expect(
        landed,
        "uploaded assessment document must be returned by assessment document list",
      ).toEqual(
        expect.objectContaining({
          state: "complete",
          label: "Uploaded document",
          fileSizeBytes: SYNTHETIC_ASSESSMENT_UPLOAD.buffer.length,
        }),
      );
      await verifySyntheticDocumentUploadPersistence(page.request, {
        assessmentId,
        documentId,
        email,
      });
      return { assessmentId, documentId };
    } catch (error) {
      lastError = error;
      void uploadUrlResponsePromise?.catch(() => undefined);
      void confirmResponsePromise?.catch(() => undefined);
      void uploadErrorPromise?.catch(() => undefined);
      void fileChooserPromise?.catch(() => undefined);
      const recovery = classifyRecovery({
        ...(observedStatus == null ? {} : { status: observedStatus }),
        failureText: error instanceof Error ? error.message : String(error),
      });
      if (!recovery.retry || attempt >= 3) break;
      assertRecoveryAttempt(recovery, attempt, 3);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(
        "Assessment document upload did not complete after retryable upload errors",
      );
}

export async function waitForAssessmentDocumentComplete(
  request: APIRequestContext,
  assessmentId: string,
  documentId: string,
  timeout = DOCUMENT_OCR_READINESS_TIMEOUT_MS,
  pollInterval = 2000,
): Promise<NormalizedAssessmentDocument> {
  const deadline = Date.now() + timeout;
  let lastStatus: number | undefined;
  let lastState: string | undefined;
  do {
    const response = await request.get(
      `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/documents`,
    );
    lastStatus = response.status();
    if (response.ok()) {
      const payload = (await response.json()) as {
        items?: AssessmentDocumentRecord[];
      };
      const document = payload.items
        ?.map(normalizeAssessmentDocument)
        .find((record) => record.id === documentId);
      lastState = document?.state;
      if (document?.state === "complete") return document;
      if (document?.state === "failed") {
        throw new Error(
          "Assessment document entered failed state before OCR readiness",
        );
      }
    }
    if (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, pollInterval));
    }
  } while (Date.now() < deadline);

  throw new Error(
    `Assessment document did not become OCR-ready status=${lastStatus ?? "unknown"} state=${lastState ?? "missing"}`,
  );
}

async function waitForPersistedDocumentConfirmation(
  request: APIRequestContext,
  assessmentId: string,
  documentId: string,
): Promise<NormalizedAssessmentDocument> {
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const response = await request.get(
      `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/documents`,
    );
    lastStatus = response.status();
    if (response.ok()) {
      const payload = (await response.json()) as {
        items?: AssessmentDocumentRecord[];
      };
      const document = payload.items
        ?.map(normalizeAssessmentDocument)
        .find((record) => record.id === documentId);
      if (
        document?.processingStatus === "processing" ||
        document?.processingStatus === "complete"
      ) {
        return document;
      }
      if (document?.processingStatus === "failed") {
        throw new Error(
          "Assessment document entered failed state before confirmation recovery",
        );
      }
    }
    if (attempt < 60) {
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(
    `Assessment document confirmation was not persisted status=${lastStatus ?? "unknown"}`,
  );
}

export async function completeSyntheticDocumentScan(
  request: APIRequestContext,
  documentId: string,
  email: string,
): Promise<void> {
  if (!BACKEND_DOCUMENT_SCAN_RESULT_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_DOCUMENT_SCAN_RESULT_URL is required for document upload E2E",
    );
  }
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for document upload E2E scan completion",
    );
  }
  const scanResultUrl = BACKEND_DOCUMENT_SCAN_RESULT_URL;
  const completeScan = () =>
    request.post(scanResultUrl, {
      headers: {
        authorization: `Bearer ${TEST_SUPPORT_TOKEN}`,
        "content-type": "application/json",
      },
      data: {
        document_id: documentId,
        email,
        verdict: "clean",
      },
      timeout: 90_000,
    });
  let response = await completeScan();
  for (
    let attempt = 1;
    response.status() === 404 && attempt < 30;
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 3000));
    response = await completeScan();
  }
  const payload = (await response.json()) as AssessmentDocumentRecord & {
    scan_status?: string;
    scanStatus?: string;
  };
  const metadata = safeResponseMetadata(payload);
  expect(
    response.status(),
    `document scan completion failed status=${response.status()} code=${metadata.code ?? "unknown"}`,
  ).toBe(200);
  expect(payload.scan_status ?? payload.scanStatus).toBe("clean");
}

export async function verifySyntheticDocumentUploadPersistence(
  request: APIRequestContext,
  options: {
    assessmentId: string;
    documentId: string;
    email: string;
  },
): Promise<void> {
  if (!BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL is required for document upload database verification",
    );
  }
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for document upload database verification",
    );
  }

  const response = await request.post(BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL, {
    headers: {
      authorization: `Bearer ${TEST_SUPPORT_TOKEN}`,
      "content-type": "application/json",
    },
    data: {
      document_id: options.documentId,
      assessment_id: options.assessmentId,
      email: options.email,
      expected_content_type: SYNTHETIC_ASSESSMENT_UPLOAD.mimeType,
      expected_file_size_bytes: SYNTHETIC_ASSESSMENT_UPLOAD.buffer.length,
      expected_content_sha256: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.contentSha256,
      expected_processing_status: "complete",
      expected_scan_status: "clean",
    },
    timeout: 30_000,
  });
  const payload = (await response.json()) as {
    code?: string;
    database?: {
      patient_document?: boolean;
      assessment_document_link?: boolean;
      upload_generation?: boolean;
      processing_status?: string;
      scan_status?: string;
      generation_state?: string;
      content_sha256_matches?: boolean;
      final_receipt?: boolean;
      ocr_status?: string;
      ocr_source_sha256_matches?: boolean;
      extracted_text_present?: boolean;
      ocr_text_sha256_matches?: boolean;
      ocr_page_count_positive?: boolean;
    };
    object?: {
      promoted?: boolean;
      receipt_matches?: boolean;
      content_sha256_matches?: boolean;
      size_matches?: boolean;
    };
  };
  const metadata = safeResponseMetadata(payload);
  expect(
    response.status(),
    `document upload persistence verification failed status=${response.status()} code=${metadata.code ?? "unknown"}`,
  ).toBe(200);
  expect(payload.database).toEqual(
    expect.objectContaining({
      patient_document: true,
      assessment_document_link: true,
      upload_generation: true,
      processing_status: "complete",
      scan_status: "clean",
      generation_state: "clean",
      content_sha256_matches: true,
      final_receipt: true,
      ocr_status: "complete",
      ocr_source_sha256_matches: true,
      extracted_text_present: true,
      ocr_text_sha256_matches: true,
      ocr_page_count_positive: true,
    }),
  );
  expect(payload.object).toEqual({
    promoted: true,
    receipt_matches: true,
    content_sha256_matches: true,
    size_matches: true,
  });
}
