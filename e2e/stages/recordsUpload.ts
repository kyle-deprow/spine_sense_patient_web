import {
  expect,
  type APIRequestContext,
  type FileChooser,
  type Page,
  type Response as PlaywrightResponse,
} from "@playwright/test";

import {
  BACKEND_DOCUMENT_SCAN_RESULT_URL,
  SYNTHETIC_ASSESSMENT_UPLOAD,
  TEST_SUPPORT_TOKEN,
  TRANSITION_BUDGETS_MS,
  assessmentIdFromDocumentsUrl,
  documentIdFromUploadResponse,
  normalizeAssessmentDocument,
  type AssessmentDocumentRecord,
  type AssessmentUploadUrlResponse,
} from "../journey/context";
import {
  classifyRecovery,
  assertRecoveryAttempt,
} from "../support/recoveryPolicy";
import { actionableLocatorForTestId } from "../journey/selectors";

type SafeResponseMetadata = Readonly<{
  code?: string;
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

export async function waitForDocumentConfirmOrUploadError(
  confirmResponse: Promise<PlaywrightResponse>,
  uploadError: Promise<"upload_error">,
): Promise<PlaywrightResponse> {
  const outcome = await Promise.race([confirmResponse, uploadError]);
  if (outcome === "upload_error") {
    throw new Error("Assessment document byte upload failed before confirmation");
  }
  return outcome;
}

export async function uploadSyntheticAssessmentDocumentFromRecordsStep(
  page: Page,
  email: string,
): Promise<void> {
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
        { timeout: TRANSITION_BUDGETS_MS.stage },
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

      const confirmResponse = await waitForDocumentConfirmOrUploadError(
        confirmResponsePromise,
        uploadErrorPromise,
      );
      observedStatus = confirmResponse.status();
      expect(
        confirmResponse.ok(),
        `assessment document confirm status=${confirmResponse.status()}`,
      ).toBe(true);
      const confirmPayload =
        (await confirmResponse.json()) as AssessmentDocumentRecord;
      const confirmedStatus =
        normalizeAssessmentDocument(confirmPayload).processingStatus;
      expect(["processing", "complete"]).toContain(confirmedStatus);

      if (confirmedStatus === "processing") {
        await completeSyntheticDocumentScan(page.request, documentId, email);
      }

      await expect(
        page.getByTestId(`records-document-${documentId}`),
      ).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByText(SYNTHETIC_ASSESSMENT_UPLOAD.name),
      ).toBeVisible();

      const listResponse = await page.request.get(
        `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/documents`,
      );
      observedStatus = listResponse.status();
      expect(
        listResponse.ok(),
        `assessment document list status=${listResponse.status()}`,
      ).toBe(true);
      const listPayload = (await listResponse.json()) as {
        items?: AssessmentDocumentRecord[];
      };
      const landed = listPayload.items
        ?.map(normalizeAssessmentDocument)
        .find((record) => record.id === documentId);
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
      return;
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

async function completeSyntheticDocumentScan(
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
  const response = await completeScan();
  const payload = (await response.json()) as AssessmentDocumentRecord & {
    scan_status?: string;
    scanStatus?: string;
  };
  const metadata = safeResponseMetadata(payload);
  expect(
    response.status(),
    `document scan completion failed status=${response.status()} code=${metadata.code ?? "unknown"}`,
  ).toBe(200);
  const normalized = normalizeAssessmentDocument(payload);
  expect(normalized.processingStatus).toBe("complete");
  expect(payload.scan_status ?? payload.scanStatus).toBe("clean");
}
