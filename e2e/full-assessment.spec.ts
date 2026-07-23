import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type FileChooser,
  type Locator,
  type Page,
  type Response as PlaywrightResponse,
  type TestInfo,
} from "@playwright/test";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { fullAssessmentScenario } from "./fixtures/fullAssessmentScenario";

const BACKEND_CLEANUP_URL = process.env.PATIENT_WEB_BACKEND_E2E_CLEANUP_URL;
const BACKEND_REGISTRATION_CODE_URL =
  process.env.PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL;
const BACKEND_DOCUMENT_SCAN_RESULT_URL =
  process.env.PATIENT_WEB_BACKEND_DOCUMENT_SCAN_RESULT_URL;
const GATEWAY_CLEANUP_URL = process.env.PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL;
const TEST_SUPPORT_TOKEN = process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN;
const EXPECT_SECURE_COOKIES =
  process.env.PATIENT_WEB_EXPECT_SECURE_COOKIES === "true";
const ENABLE_FULL_ASSESSMENT_STRESS =
  process.env.PATIENT_WEB_FULL_ASSESSMENT_STRESS !== "false";
const FULL_FLOW_TIMEOUT_MS = readPositiveIntegerEnv(
  "PATIENT_WEB_E2E_FULL_FLOW_TIMEOUT_MS",
  15 * 60 * 1000,
);
const ENABLE_TRANSITION_PROFILING =
  process.env.PATIENT_WEB_E2E_PROFILE_TRANSITIONS !== "false";
const ASSESSMENT_REPORT_PROXY_PATH_RE =
  /^\/api\/proxy\/api\/v1\/patients\/me\/assessments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/reports$/i;
const STRESS_RELOAD_AFTER_SCREENING_QUESTION_ID =
  fullAssessmentScenario.stress.reloadAfterScreeningQuestionId;
const STRESS_BACKTRACK_AFTER_SCREENING_QUESTION_ID =
  fullAssessmentScenario.stress.backtrackAfterScreeningQuestionId;
const SYNTHETIC_ASSESSMENT_UPLOAD = {
  name: "synthetic-e2e-upload.png",
  mimeType: "image/png",
  // 1x1 transparent PNG. Keep synthetic; no PHI fixture file is needed.
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
    "base64",
  ),
} as const;

type BrowserCookie = {
  name: string;
  httpOnly: boolean;
  path: string;
  sameSite: "Lax" | "None" | "Strict";
  secure: boolean;
};

type AssessmentAnswer = {
  readonly id: string;
  readonly value: string | number | readonly (string | number)[];
};

type TextAnswer = {
  readonly id: string;
  readonly text: string;
};

type ScreeningStressState = {
  reloadedDuringScreening: boolean;
  backtrackedDuringScreening: boolean;
};

type QuestionnaireMutation = {
  path: string;
  payload: unknown;
};

type AssessmentUploadUrlResponse = {
  document_id?: string;
  documentId?: string;
};

type AssessmentDocumentRecord = {
  id?: string;
  file_name?: string | null;
  fileName?: string | null;
  file_type?: string | null;
  fileType?: string | null;
  file_size_bytes?: number | null;
  fileSizeBytes?: number | null;
  processing_status?: string;
  processingStatus?: string;
};

type AssessmentReportGenerationPayload = {
  id?: unknown;
  format?: unknown;
  file_name?: unknown;
  content_type?: unknown;
  byte_size?: unknown;
  sha256?: unknown;
  download_url?: unknown;
  expires_in_seconds?: unknown;
};

type AssessmentReportRequestPayload = {
  format?: unknown;
  variant?: unknown;
  include_documents?: unknown;
  include_trends?: unknown;
  delivery?: unknown;
};

type TransitionProfileKind =
  | "page"
  | "question"
  | "sync"
  | "recovery"
  | "stage"
  | "analysis"
  | "report";

type TransitionProfileSample = {
  label: string;
  kind: TransitionProfileKind;
  durationMs: number;
  budgetMs: number;
  status: "ok" | "slow";
};

type TransitionProfileSummary = {
  kind: TransitionProfileKind;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  slowCount: number;
};

const SCREENING_ANSWERS_BY_ID = new Map(
  fullAssessmentScenario.screening.map((answer) => [answer.id, answer]),
);
const SCREENING_TEXT_ANSWERS_BY_ID = new Map(
  fullAssessmentScenario.screeningText.map((answer) => [answer.id, answer]),
);
const ADAPTIVE_ANSWERS_BY_ID = new Map(
  fullAssessmentScenario.adaptive.map((answer) => [answer.id, answer]),
);
const FINAL_SCREENING_QUESTION_ID =
  fullAssessmentScenario.finalScreeningQuestionId;
const EXPECTED_SCREENING_GOAL_QUESTION_IDS: readonly string[] = [
  ...fullAssessmentScenario.requiredScreeningGoalQuestionIds,
  ...fullAssessmentScenario.optionalScreeningGoalQuestionIds.filter(
    (id) =>
      SCREENING_ANSWERS_BY_ID.has(id) || SCREENING_TEXT_ANSWERS_BY_ID.has(id),
  ),
];
const SCREENING_GOAL_QUESTION_IDS: ReadonlySet<string> = new Set([
  ...fullAssessmentScenario.requiredScreeningGoalQuestionIds,
  ...fullAssessmentScenario.optionalScreeningGoalQuestionIds,
]);

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer number of milliseconds`,
    );
  }
  return value;
}

const TRANSITION_BUDGETS_MS: Record<TransitionProfileKind, number> = {
  page: readPositiveIntegerEnv("PATIENT_WEB_E2E_PAGE_BUDGET_MS", 90_000),
  question: readPositiveIntegerEnv("PATIENT_WEB_E2E_QUESTION_BUDGET_MS", 2_000),
  sync: readPositiveIntegerEnv("PATIENT_WEB_E2E_SYNC_BUDGET_MS", 500),
  recovery: readPositiveIntegerEnv(
    "PATIENT_WEB_E2E_RECOVERY_BUDGET_MS",
    30_000,
  ),
  stage: readPositiveIntegerEnv("PATIENT_WEB_E2E_STAGE_BUDGET_MS", 180_000),
  analysis: readPositiveIntegerEnv(
    "PATIENT_WEB_E2E_ANALYSIS_BUDGET_MS",
    480_000,
  ),
  report: readPositiveIntegerEnv("PATIENT_WEB_E2E_REPORT_BUDGET_MS", 120_000),
};

class TransitionProfiler {
  private readonly samples: TransitionProfileSample[] = [];

  async measure<T>(
    label: string,
    kind: TransitionProfileKind,
    action: () => Promise<T>,
  ): Promise<T> {
    if (!ENABLE_TRANSITION_PROFILING) {
      return action();
    }

    const startedAt = performance.now();
    let actionFailed = false;
    try {
      return await action();
    } catch (error) {
      actionFailed = true;
      throw error;
    } finally {
      const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
      const budgetMs = TRANSITION_BUDGETS_MS[kind];
      const status = durationMs > budgetMs ? "slow" : "ok";
      this.samples.push({ label, kind, durationMs, budgetMs, status });
      console.log(
        `[perf] label=${label} kind=${kind} duration_ms=${durationMs.toFixed(1)} budget_ms=${budgetMs} status=${status}`,
      );
      if (!actionFailed) {
        expect(
          durationMs,
          `${label} exceeded ${budgetMs}ms budget (${durationMs.toFixed(1)}ms)`,
        ).toBeLessThanOrEqual(budgetMs);
      }
    }
  }

  async attach(testInfo: TestInfo): Promise<void> {
    if (!ENABLE_TRANSITION_PROFILING) return;
    const summaries = this.summaries();
    for (const summary of summaries) {
      console.log(
        `[perf-summary] kind=${summary.kind} count=${summary.count} p50_ms=${summary.p50Ms.toFixed(1)} p95_ms=${summary.p95Ms.toFixed(1)} max_ms=${summary.maxMs.toFixed(1)} slow_count=${summary.slowCount}`,
      );
    }
    await testInfo.attach("transition-profile.json", {
      body: JSON.stringify(
        {
          budgetsMs: TRANSITION_BUDGETS_MS,
          summaries,
          samples: this.samples,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
  }

  private summaries(): TransitionProfileSummary[] {
    const summaries: TransitionProfileSummary[] = [];
    for (const kind of Object.keys(
      TRANSITION_BUDGETS_MS,
    ) as TransitionProfileKind[]) {
      const samples = this.samples
        .filter((sample) => sample.kind === kind)
        .sort((left, right) => left.durationMs - right.durationMs);
      if (samples.length === 0) continue;
      summaries.push({
        kind,
        count: samples.length,
        p50Ms: percentile(samples, 0.5),
        p95Ms: percentile(samples, 0.95),
        maxMs: samples[samples.length - 1]?.durationMs ?? 0,
        slowCount: samples.filter((sample) => sample.status === "slow").length,
      });
    }
    return summaries;
  }
}

function percentile(
  samples: readonly TransitionProfileSample[],
  fraction: number,
): number {
  if (samples.length === 0) return 0;
  const boundedFraction = Math.max(0, Math.min(1, fraction));
  const index = Math.min(
    samples.length - 1,
    Math.round((samples.length - 1) * boundedFraction),
  );
  return samples[index]?.durationMs ?? 0;
}

function logMilestone(message: string): void {
  console.log(`[milestone] ${message}`);
}

function uniqueSyntheticEmail(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `casey.assessment.${unique}@e2e.example.com`;
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s)]+/g, "[origin]")
    .replace(/\?[^)\]\s"']+/g, "?[query]")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      "[uuid]",
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/\b(cookie|set-cookie)\b\s*[:=]\s*[^\n\r]+/gi, "$1=[redacted]")
    .replace(
      /\b(authorization|x-csrf-token|csrf-token)\b\s*[:=]\s*[^;\n\r]+/gi,
      "$1=[redacted]",
    )
    .replace(/"(cookie|set-cookie)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/"(cookie|set-cookie)"\s*:\s*\[[^\]]*\]/gi, '"$1":["[redacted]"]')
    .replace(
      /"(authorization|x-csrf-token|csrf-token)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    )
    .replace(
      /\b(password|verification_code|verificationCode|mfa_code|mfaCode)\b\s*[:=]\s*[^,\s)]+/gi,
      "$1=[redacted]",
    )
    .replace(/"[^"]*token[^"]*"\s*:\s*"[^"]+"/gi, (match) =>
      match.replace(/:\s*"[^"]+"/, ':"[token]"'),
    )
    .replace(/"password"\s*:\s*"[^"]+"/gi, '"password":"[redacted]"')
    .replace(/"csrfToken"\s*:\s*"[^"]+"/gi, '"csrfToken":"[redacted]"')
    .replace(/"csrf_token"\s*:\s*"[^"]+"/gi, '"csrf_token":"[redacted]"')
    .slice(0, 800);
}

function sanitizeDiagnosticStack(error: Error): string | null {
  if (!error.stack) return null;
  const frames = error.stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 6)
    .map(sanitizeDiagnostic);
  if (frames.length === 0) return null;
  return [sanitizeDiagnostic(error.name || "Error"), ...frames].join("\n");
}

function installPhiSafeDiagnostics(page: Page) {
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    console.log(
      `[browser:${message.type()}] ${sanitizeDiagnostic(message.text())}`,
    );
  });
  page.on("pageerror", (error) => {
    console.log(`[pageerror] ${sanitizeDiagnostic(error.message)}`);
    const stack = sanitizeDiagnosticStack(error);
    if (stack) {
      console.log(`[pageerror-stack] ${stack}`);
    }
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    const isAssessmentApi = url.pathname.includes(
      "/api/proxy/api/v1/patients/me/assessments/",
    );
    if (
      response.status() < 400 &&
      !isAssessmentApi &&
      !url.pathname.endsWith("/api/proxy/api/v1/patients/me/intake/route")
    ) {
      return;
    }
    const requestId =
      response.headers()["x-request-id"] ?? response.headers()["request-id"];
    const suffix =
      requestId != null ? ` request_id=${sanitizeDiagnostic(requestId)}` : "";
    console.log(
      `[response:${response.status()}] ${sanitizeDiagnostic(url.pathname)}${suffix}`,
    );
    if (
      url.pathname.endsWith("/api/proxy/api/v1/patients/me/intake/route") ||
      (response.status() === 422 &&
        url.pathname.endsWith("/api/proxy/api/v1/patients/me/")) ||
      (response.status() === 422 && url.pathname.endsWith("/screening/answers"))
    ) {
      void response
        .text()
        .then((body) =>
          console.log(
            `[response-body:${response.status()}] ${sanitizeDiagnostic(body)}`,
          ),
        )
        .catch(() => undefined);
    }
  });
}

function captureQuestionnaireMutations(page: Page): QuestionnaireMutation[] {
  const mutations: QuestionnaireMutation[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (
      !/(screening|adaptive)\/(answers|complete|complete-with-answers)$/.test(
        path,
      )
    )
      return;

    let payload: unknown = null;
    try {
      payload = request.postDataJSON();
    } catch {
      payload = null;
    }
    mutations.push({ path, payload });
  });
  return mutations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function expectRawAnswerValue(
  path: string,
  questionId: string,
  value: unknown,
): void {
  const validScalar =
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isInteger(value)) ||
    typeof value === "boolean";
  const validList =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.length > 0) &&
    new Set(value).size === value.length;
  expect(
    validScalar || validList,
    `${path} answer ${questionId} must use the exact raw scalar-or-string-list shape`,
  ).toBe(true);
}

function assessmentIdFromDocumentsUrl(url: string): string {
  const pathname = new URL(url).pathname;
  const match = pathname.match(
    /\/assessments\/([^/]+)\/documents(?:\/upload-url)?$/,
  );
  if (match?.[1] == null) {
    throw new Error(
      `Could not resolve assessment id from document upload URL: ${sanitizeDiagnostic(pathname)}`,
    );
  }
  return match[1];
}

function documentIdFromUploadResponse(
  payload: AssessmentUploadUrlResponse,
): string {
  const documentId = payload.document_id ?? payload.documentId;
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new Error(
      "Assessment document upload response did not include a document id",
    );
  }
  return documentId;
}

function normalizeAssessmentDocument(record: AssessmentDocumentRecord) {
  return {
    id: record.id,
    fileName: record.file_name ?? record.fileName ?? null,
    fileType: record.file_type ?? record.fileType ?? null,
    fileSizeBytes: record.file_size_bytes ?? record.fileSizeBytes ?? null,
    processingStatus: record.processing_status ?? record.processingStatus,
  };
}

async function uploadSyntheticAssessmentDocumentFromRecordsStep(
  page: Page,
  email: string,
  profiler: TransitionProfiler,
): Promise<void> {
  await clickByTestId(page, "records-documents-file-tab");

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let uploadUrlResponsePromise: Promise<PlaywrightResponse> | null = null;
    let confirmResponsePromise: Promise<PlaywrightResponse> | null = null;
    let fileChooserPromise: Promise<FileChooser> | null = null;
    try {
      if (
        await page
          .getByTestId("records-assessment-error")
          .isVisible({ timeout: 1000 })
          .catch(() => false)
      ) {
        await profiler.measure(
          `records.assessment_prep_retry.attempt_${attempt}`,
          "recovery",
          async () => {
            await waitForEnabledAndClick(page, "records-assessment-retry");
            await expect(
              page.getByTestId("records-assessment-error"),
            ).toBeHidden({
              timeout: 60_000,
            });
          },
        );
      }

      const chooseFileButton = await actionableLocatorForTestId(
        page,
        "records-choose-file-button",
      );
      await expect(chooseFileButton).toBeVisible({ timeout: 60_000 });
      await expect(chooseFileButton).toBeEnabled({ timeout: 60_000 });
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
      await fileChooser.setFiles(SYNTHETIC_ASSESSMENT_UPLOAD);

      const uploadUrlResponse = await uploadUrlResponsePromise;
      expect(
        uploadUrlResponse.ok(),
        `assessment document upload-url status=${uploadUrlResponse.status()}`,
      ).toBe(true);
      const uploadPayload =
        (await uploadUrlResponse.json()) as AssessmentUploadUrlResponse;
      const documentId = documentIdFromUploadResponse(uploadPayload);
      const assessmentId = assessmentIdFromDocumentsUrl(
        uploadUrlResponse.url(),
      );

      const confirmResponse = await confirmResponsePromise;
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
          fileName: SYNTHETIC_ASSESSMENT_UPLOAD.name,
          fileType: SYNTHETIC_ASSESSMENT_UPLOAD.mimeType,
          fileSizeBytes: SYNTHETIC_ASSESSMENT_UPLOAD.buffer.length,
          processingStatus: "complete",
        }),
      );
      return;
    } catch (error) {
      lastError = error;
      void uploadUrlResponsePromise?.catch(() => undefined);
      void confirmResponsePromise?.catch(() => undefined);
      void fileChooserPromise?.catch(() => undefined);
      const retryableUploadError = await page
        .getByTestId("records-file-error")
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      if (!retryableUploadError || attempt >= 3) break;
      await page.waitForTimeout(1_500);
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
  const completeScan = () =>
    request.post(BACKEND_DOCUMENT_SCAN_RESULT_URL, {
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
    response.status() === 404 && attempt < 5;
    attempt += 1
  ) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    response = await completeScan();
  }
  expect(
    response.status(),
    `document scan completion failed status=${response.status()}`,
  ).toBe(200);
  const payload = (await response.json()) as AssessmentDocumentRecord & {
    scan_status?: string;
    scanStatus?: string;
  };
  const normalized = normalizeAssessmentDocument(payload);
  expect(normalized.processingStatus).toBe("complete");
  expect(payload.scan_status ?? payload.scanStatus).toBe("clean");
}

function expectQuestionnaireMutationContracts(
  mutations: readonly QuestionnaireMutation[],
  generatedAdaptiveAnswers: ReadonlyMap<string, unknown>,
) {
  const screeningAnswers = new Map<string, unknown>([
    ...fullAssessmentScenario.screening.map(
      ({ id, value }) => [id, value] as const,
    ),
    ...fullAssessmentScenario.screeningText.map(
      ({ id, text }) => [id, text] as const,
    ),
  ]);
  const adaptiveAnswers = new Map<string, unknown>([
    ...fullAssessmentScenario.adaptive.map(
      ({ id, value }) => [id, value] as const,
    ),
    ...generatedAdaptiveAnswers,
  ]);
  const screeningGoalSubmissionCounts = new Map(
    EXPECTED_SCREENING_GOAL_QUESTION_IDS.map((id) => [id, 0]),
  );
  const adaptiveGoalSubmissionIds = new Set<string>();
  const contracts = {
    "/screening/answers": {
      allowedKeys: ["answers", "expected_revision", "question_notes"],
      requiredKeys: ["answers", "expected_revision"],
      fixtureAnswers: screeningAnswers,
    },
    "/screening/complete": {
      allowedKeys: ["answers", "expected_revision", "question_notes"],
      requiredKeys: ["expected_revision"],
      fixtureAnswers: screeningAnswers,
    },
    "/adaptive/answers": {
      allowedKeys: ["answers", "expected_revision", "question_notes"],
      requiredKeys: ["answers", "expected_revision"],
      fixtureAnswers: adaptiveAnswers,
    },
    "/adaptive/complete-with-answers": {
      allowedKeys: ["answers", "expected_revision", "question_notes"],
      requiredKeys: ["answers", "expected_revision"],
      fixtureAnswers: adaptiveAnswers,
    },
  } as const;

  const requiredMutationSuffixes: readonly (keyof typeof contracts)[] = [
    "/screening/answers",
    "/screening/complete",
    "/adaptive/complete-with-answers",
  ];
  for (const suffix of requiredMutationSuffixes) {
    expect(
      mutations.some(({ path }) => path.endsWith(suffix)),
      `${suffix} must be exercised`,
    ).toBe(true);
  }

  for (const { path, payload } of mutations) {
    const suffix = (
      Object.keys(contracts) as Array<keyof typeof contracts>
    ).find((candidate) => path.endsWith(candidate));
    expect(
      suffix,
      `${path} must have an endpoint-specific request contract`,
    ).toBeDefined();
    if (suffix == null) continue;

    expect(isRecord(payload), `${path} must send a plain JSON object`).toBe(
      true,
    );
    if (!isRecord(payload)) continue;

    const contract = contracts[suffix];
    expect(
      Object.keys(payload).filter(
        (key) => !(contract.allowedKeys as readonly string[]).includes(key),
      ),
      `${path} must not send aliases, derived fields, or arbitrary extras`,
    ).toEqual([]);
    for (const requiredKey of contract.requiredKeys) {
      expect(payload, `${path} must send ${requiredKey}`).toHaveProperty(
        requiredKey,
      );
    }
    expect(
      Number.isSafeInteger(payload.expected_revision) &&
        (payload.expected_revision as number) >= 0,
      `${path} expected_revision must be a non-negative integer`,
    ).toBe(true);

    if ("answers" in payload) {
      expect(
        isRecord(payload.answers),
        `${path} answers must be a raw answer map`,
      ).toBe(true);
      if (isRecord(payload.answers) && contract.fixtureAnswers != null) {
        for (const [questionId, value] of Object.entries(payload.answers)) {
          expect(
            !(
              (path.endsWith("/adaptive/answers") ||
                path.endsWith("/adaptive/complete-with-answers")) &&
              SCREENING_GOAL_QUESTION_IDS.has(questionId)
            ),
            `${path} must not submit screening goal ${questionId} as an adaptive follow-up`,
          ).toBe(true);
          if (
            path.endsWith("/screening/answers") &&
            screeningGoalSubmissionCounts.has(questionId)
          ) {
            screeningGoalSubmissionCounts.set(
              questionId,
              (screeningGoalSubmissionCounts.get(questionId) ?? 0) + 1,
            );
          }
          if (
            (path.endsWith("/adaptive/answers") ||
              path.endsWith("/adaptive/complete-with-answers")) &&
            SCREENING_GOAL_QUESTION_IDS.has(questionId)
          ) {
            adaptiveGoalSubmissionIds.add(questionId);
          }
          expect(
            contract.fixtureAnswers.has(questionId),
            `${path} answer ${questionId} must be an exact scenario fixture ID`,
          ).toBe(true);
          expectRawAnswerValue(path, questionId, value);
          expect(
            value,
            `${path} answer ${questionId} must equal its exact fixture value`,
          ).toEqual(contract.fixtureAnswers.get(questionId));
        }
      }
    }

    if ("question_notes" in payload) {
      expect(
        isRecord(payload.question_notes),
        `${path} question_notes must be a keyed map`,
      ).toBe(true);
      if (isRecord(payload.question_notes) && contract.fixtureAnswers != null) {
        for (const [questionId, note] of Object.entries(
          payload.question_notes,
        )) {
          expect(contract.fixtureAnswers.has(questionId)).toBe(true);
          expect(typeof note === "string" && note.trim().length > 0).toBe(true);
        }
      }
    }
  }

  const missingScreeningGoals = [...screeningGoalSubmissionCounts.entries()]
    .filter(([, count]) => count < 1)
    .map(([id]) => id);
  expect(
    missingScreeningGoals,
    "Each screening goal must be PATCHed as a screening answer",
  ).toEqual([]);
  expect(
    [...adaptiveGoalSubmissionIds],
    "Adaptive answers must never include screening goals",
  ).toEqual([]);
}

function isAssessmentReportGenerationResponse(
  response: PlaywrightResponse,
): boolean {
  const url = new URL(response.url());
  return (
    response.request().method() === "POST" &&
    ASSESSMENT_REPORT_PROXY_PATH_RE.test(url.pathname)
  );
}

async function expectRenderedAssessmentPdf(
  request: APIRequestContext,
  response: PlaywrightResponse,
): Promise<void> {
  let requestPayload: AssessmentReportRequestPayload;
  try {
    requestPayload = response
      .request()
      .postDataJSON() as AssessmentReportRequestPayload;
  } catch {
    requestPayload = {};
  }
  expect(requestPayload.format).toBe("pdf");
  expect(requestPayload.variant).toBe("summary");
  expect(requestPayload.include_documents).toBe(false);
  expect(requestPayload.include_trends).toBe(false);
  expect(requestPayload.delivery).toBe("download_url");

  const payload = (await response.json()) as AssessmentReportGenerationPayload;
  expect(typeof payload.id).toBe("string");
  expect(payload.format).toBe("pdf");
  expect(typeof payload.file_name).toBe("string");
  expect(payload.file_name).toMatch(
    /^spinesense-assessment-report-[0-9a-f]{8}\.pdf$/i,
  );
  expect(payload.content_type).toBe("application/pdf");
  expect(
    Number.isInteger(payload.byte_size) && Number(payload.byte_size) > 0,
  ).toBe(true);
  expect(payload.sha256).toMatch(/^[0-9a-f]{64}$/i);
  expect(
    Number.isInteger(payload.expires_in_seconds) &&
      Number(payload.expires_in_seconds) > 0,
  ).toBe(true);
  expect(typeof payload.download_url).toBe("string");

  const downloadUrl = new URL(String(payload.download_url));
  expect(["http:", "https:"]).toContain(downloadUrl.protocol);
  if (EXPECT_SECURE_COOKIES) expect(downloadUrl.protocol).toBe("https:");

  const download = await request.get(downloadUrl.toString(), {
    timeout: 60_000,
  });
  expect(download.status(), "generated report download failed").toBe(200);
  expect(download.headers()["content-type"]?.split(";", 1)[0]).toBe(
    "application/pdf",
  );
  expect(download.headers()["content-disposition"]).toContain("attachment;");
  expect(download.headers()["content-disposition"]).toContain(
    String(payload.file_name),
  );

  const pdf = await download.body();
  expect(pdf.byteLength).toBe(payload.byte_size);
  expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  expect(
    pdf
      .subarray(Math.max(0, pdf.byteLength - 1024))
      .toString("latin1")
      .trimEnd()
      .endsWith("%%EOF"),
  ).toBe(true);
  expect(createHash("sha256").update(pdf).digest("hex")).toBe(payload.sha256);
}

async function expectOptionalReportSwitchCanOnlySubmitWhenAvailable(
  switchLocator: Locator,
  label: string,
): Promise<void> {
  await expect(
    switchLocator,
    `${label} option must start unchecked`,
  ).not.toBeChecked();
  if (await switchLocator.isDisabled()) {
    await expect(
      switchLocator,
      `${label} option must be disabled when unavailable`,
    ).toBeDisabled();
    return;
  }

  await expect(
    switchLocator,
    `${label} option must be enabled when available`,
  ).toBeEnabled();
  await switchLocator.click();
  await expect(
    switchLocator,
    `${label} option must be selectable when available`,
  ).toBeChecked();
  await switchLocator.click();
  await expect(
    switchLocator,
    `${label} option must be clearable before core download`,
  ).not.toBeChecked();
}

async function postTestSupport(
  request: APIRequestContext,
  url: string,
  token: string | undefined,
  label: string,
): Promise<APIResponse> {
  const options: Parameters<APIRequestContext["post"]>[1] = { timeout: 90_000 };
  if (token) options.headers = { authorization: `Bearer ${token}` };
  const response = await request.post(url, options);
  expect(response.status(), `${label} failed status=${response.status()}`).toBe(
    200,
  );
  return response;
}

async function cleanupE2eState(request: APIRequestContext) {
  if (!BACKEND_CLEANUP_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_E2E_CLEANUP_URL is required for full assessment E2E",
    );
  }
  if (!GATEWAY_CLEANUP_URL) {
    throw new Error(
      "PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL is required for full assessment E2E",
    );
  }
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for full assessment E2E",
    );
  }

  await postTestSupport(
    request,
    GATEWAY_CLEANUP_URL,
    TEST_SUPPORT_TOKEN,
    "patient web gateway cleanup",
  );
  await postTestSupport(
    request,
    BACKEND_CLEANUP_URL,
    TEST_SUPPORT_TOKEN,
    "backend synthetic cleanup",
  );
}

async function getRegistrationVerificationCode(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  if (!BACKEND_REGISTRATION_CODE_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL is required for full assessment E2E",
    );
  }
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for registration-code lookup",
    );
  }

  const response = await request.post(BACKEND_REGISTRATION_CODE_URL, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_SUPPORT_TOKEN}`,
    },
    data: { email },
    timeout: 30_000,
  });
  expect(
    response.status(),
    `registration verification code lookup failed status=${response.status()}`,
  ).toBe(200);
  const payload = (await response.json()) as { code?: unknown };
  if (typeof payload.code !== "string") {
    throw new Error("registration verification code lookup returned no code");
  }
  return payload.code;
}

async function expectNoTokenLeak(responseText: string) {
  expect(responseText.includes("access_token")).toBe(false);
  expect(responseText.includes("refresh_token")).toBe(false);
  expect(responseText.includes("accessToken")).toBe(false);
  expect(responseText.includes("refreshToken")).toBe(false);
  expect(responseText.includes("mfa_token")).toBe(false);
  expect(responseText.includes("mfaToken")).toBe(false);
}

async function expectNoBrowserStorage(page: Page) {
  const storage = await page.evaluate(async () => {
    const indexedDbDatabases =
      typeof indexedDB.databases === "function"
        ? await indexedDB.databases()
        : [];

    return {
      localStorageLength: localStorage.length,
      sessionStorageLength: sessionStorage.length,
      indexedDbDatabases: indexedDbDatabases
        .map((db) => db.name)
        .filter(Boolean),
      serviceWorkerCount: navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0,
    };
  });

  expect(storage).toEqual({
    localStorageLength: 0,
    sessionStorageLength: 0,
    indexedDbDatabases: [],
    serviceWorkerCount: 0,
  });
}

function hasCookie(cookies: BrowserCookie[], name: string): boolean {
  return cookies.some((entry) => entry.name === name);
}

function cookieHasExpectedShape(
  cookies: BrowserCookie[],
  name: string,
  expected: {
    httpOnly: boolean;
    path: string;
    sameSite: "Lax" | "Strict";
    secure: boolean;
  },
): boolean {
  const cookie = cookies.find((entry) => entry.name === name);
  return (
    cookie?.httpOnly === expected.httpOnly &&
    cookie.path === expected.path &&
    cookie.sameSite === expected.sameSite &&
    cookie.secure === expected.secure
  );
}

async function warmCsrfSession(page: Page) {
  const response = await page.request.get("/api/auth/session");
  expect([200, 401]).toContain(response.status());
  const cookies = await page.context().cookies();
  expect(hasCookie(cookies, "spine_patient_csrf")).toBe(true);
}

async function gotoWelcome(page: Page) {
  const isBrowserNavigationErrorPage = async () =>
    page
      .evaluate(() => location.protocol === "chrome-error:")
      .catch(() => page.url().startsWith("chrome-error://"));
  const isBlankAppDocument = async () =>
    page
      .evaluate(
        () =>
          location.protocol !== "chrome-error:" &&
          document.body.innerText.trim().length === 0,
      )
      .catch(() => false);
  const isWelcomeVisible = async () =>
    (await page
      .getByTestId("welcome-screen")
      .isVisible({ timeout: 1000 })
      .catch(() => false)) ||
    (await page
      .getByRole("button", { name: /start my assessment/i })
      .isVisible({ timeout: 1000 })
      .catch(() => false)) ||
    (await page
      .getByText(/Understand Your Spine/i)
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false));

  const startedAt = Date.now();
  const pageBudgetMs = TRANSITION_BUDGETS_MS.page;
  const navigationTimeoutMs = Math.min(45_000, Math.max(10_000, pageBudgetMs));

  for (let attempt = 0; Date.now() - startedAt < pageBudgetMs; attempt += 1) {
    await page
      .goto("/welcome", { waitUntil: "commit", timeout: navigationTimeoutMs })
      .catch(() => undefined);
    if (await isWelcomeVisible()) {
      return;
    }
    const recoverableLaunchMiss =
      (await isBrowserNavigationErrorPage()) || (await isBlankAppDocument());
    if (!recoverableLaunchMiss && attempt >= 2) {
      break;
    }
    await page.waitForTimeout(750);
  }

  for (let attempt = 0; Date.now() - startedAt < pageBudgetMs; attempt += 1) {
    await page
      .goto("/", { waitUntil: "commit", timeout: navigationTimeoutMs })
      .catch(() => undefined);
    if (await isWelcomeVisible()) {
      return;
    }
    const recoverableLaunchMiss =
      (await isBrowserNavigationErrorPage()) || (await isBlankAppDocument());
    if (!recoverableLaunchMiss && attempt >= 5) {
      break;
    }
    await page.waitForTimeout(750);
  }

  for (let attempt = 0; Date.now() - startedAt < pageBudgetMs; attempt += 1) {
    await page
      .goto("/welcome", { waitUntil: "commit", timeout: navigationTimeoutMs })
      .catch(() => undefined);
    if (await isWelcomeVisible()) {
      return;
    }
    const recoverableLaunchMiss =
      (await isBrowserNavigationErrorPage()) || (await isBlankAppDocument());
    if (!recoverableLaunchMiss && attempt >= 2) {
      break;
    }
    await page.waitForTimeout(750);
  }

  let visible = false;
  while (Date.now() - startedAt < pageBudgetMs) {
    await page
      .goto("/", {
        waitUntil: "domcontentloaded",
        timeout: navigationTimeoutMs,
      })
      .catch(() => undefined);
    visible = await expect
      .poll(isWelcomeVisible, {
        timeout: Math.min(
          10_000,
          Math.max(1_000, pageBudgetMs - (Date.now() - startedAt)),
        ),
        message:
          "Expected the welcome screen or Start My Assessment CTA to be visible",
      })
      .toBe(true)
      .then(() => true)
      .catch(() => false);
    if (visible) break;
    if (
      !(await isBrowserNavigationErrorPage()) &&
      !(await isBlankAppDocument())
    ) {
      break;
    }
    await page.waitForTimeout(750);
  }
  if (!visible) {
    const diagnostic = await page
      .evaluate(() => ({
        href: location.href,
        text: document.body.innerText.slice(0, 500),
      }))
      .catch((error) => ({
        href: page.url(),
        text: `diagnostic unavailable: ${error.message}`,
      }));
    throw new Error(
      `Expected welcome screen. href=${sanitizeDiagnostic(diagnostic.href)} text=${sanitizeDiagnostic(diagnostic.text)}`,
    );
  }
}

async function clickWelcomeGetStarted(page: Page) {
  if (await clickIfPresent(page, "welcome-get-started", 2000)) {
    return;
  }
  await page.getByRole("button", { name: /start my assessment/i }).click();
}

async function expectAuthenticatedCookieSession(page: Page) {
  const browserVisibleCookies = await page.evaluate(() => document.cookie);
  expect(browserVisibleCookies.includes("spine_patient_sess")).toBe(false);
  expect(browserVisibleCookies.includes("spine_patient_refresh")).toBe(false);

  const cookies = await page.context().cookies();
  expect(
    cookieHasExpectedShape(cookies, "spine_patient_sess", {
      httpOnly: true,
      path: "/api",
      sameSite: "Lax",
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true);
  expect(
    cookieHasExpectedShape(cookies, "spine_patient_refresh", {
      httpOnly: true,
      path: "/api/auth/refresh",
      sameSite: "Strict",
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true);
  expect(
    cookieHasExpectedShape(cookies, "spine_patient_csrf", {
      httpOnly: false,
      path: "/",
      sameSite: "Strict",
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true);
  expect(hasCookie(cookies, "spine_patient_sess_iat")).toBe(true);
}

async function expectConsentScreenAfterVerification(page: Page) {
  if (
    await page
      .getByTestId("consent-screen")
      .isVisible({ timeout: 60_000 })
      .catch(() => false)
  ) {
    return;
  }
  await expect(
    page.getByRole("heading", { name: /Privacy & Consent/i }),
  ).toBeVisible({
    timeout: 60_000,
  });
}

async function byTestId(page: Page, testId: string): Promise<Locator> {
  const locator = page.getByTestId(testId);
  await expect(locator).toBeVisible({ timeout: 30_000 });
  return locator;
}

async function clickByTestId(page: Page, testId: string) {
  const locator = await byTestId(page, testId);
  await locator.click();
}

async function fillByTestId(page: Page, testId: string, value: string) {
  const locator = await byTestId(page, testId);
  await locator.fill(value);
}

async function clickIfPresent(
  page: Page,
  testId: string,
  timeout = 1000,
): Promise<boolean> {
  const locator = page.getByTestId(testId);
  const visible = await locator.isVisible({ timeout }).catch(() => false);
  if (!visible) return false;
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  return true;
}

async function waitForAnyVisibleTestId(
  page: Page,
  testIds: readonly string[],
  timeout = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const testId of testIds) {
      if (await isVisibleByTestIdOrSemantic(page, testId, 500)) {
        return testId;
      }
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    `None of these test IDs became visible: ${testIds.join(", ")}`,
  );
}

async function waitForAssessmentStage(
  page: Page,
  testIds: readonly string[],
  timeout = 360_000,
): Promise<string> {
  return waitForAnyVisibleTestId(page, testIds, timeout);
}

async function waitForRetryOutcome(
  page: Page,
  errorTestId: string,
  nextTestIds: readonly string[],
  timeout = 30_000,
): Promise<string> {
  const nextStage = await waitForAnyVisibleTestId(
    page,
    nextTestIds,
    timeout,
  ).catch(() => null);
  if (nextStage != null) return nextStage;

  if (await isVisibleByTestIdOrSemantic(page, errorTestId, 1000)) {
    return errorTestId;
  }

  return waitForAnyVisibleTestId(page, nextTestIds, 30_000);
}

function semanticLocatorForTestId(page: Page, testId: string): Locator | null {
  switch (testId) {
    case "adaptive-loading-state":
      return page
        .getByText(
          /Preparing follow-up questions|Generating follow-up questions/i,
        )
        .first();
    case "adaptive-loading-error-state":
      return page.getByText(/Could not prepare follow-up questions/i).first();
    case "adaptive-loading-retry":
      return page
        .getByRole("button", { name: /retry preparing follow-up questions/i })
        .first();
    case "adaptive-screen":
    case "adaptive-list":
      return page.getByText(/^Adaptive\s*·\s*Q\d+\s+of\s+\d+$/i).first();
    case "review-screen":
      return page.getByTestId("review-ready-title");
    case "assessment-processing":
      return page
        .getByText(
          /Your assessment is being generated by our clinical AI engine|Determining clinical pathway/i,
        )
        .first();
    case "results-screen":
      return page.getByText("Assessment Results").first();
    case "tab-home":
      return page.getByRole("tab", { name: /Home/i }).last();
    case "adaptive-submit":
      return page
        .getByRole("button", {
          name: /^(Continue to next question|Submit answers)$/i,
        })
        .first();
    default:
      return null;
  }
}

async function isVisibleByTestIdOrSemantic(
  page: Page,
  testId: string,
  timeout = 500,
): Promise<boolean> {
  if (
    await page
      .getByTestId(testId)
      .isVisible({ timeout })
      .catch(() => false)
  )
    return true;
  const semantic = semanticLocatorForTestId(page, testId);
  return (
    semantic != null &&
    (await semantic.isVisible({ timeout }).catch(() => false))
  );
}

async function actionableLocatorForTestId(
  page: Page,
  testId: string,
): Promise<Locator> {
  const semantic = semanticLocatorForTestId(page, testId);
  if (
    semantic != null &&
    (await semantic.isVisible({ timeout: 500 }).catch(() => false))
  ) {
    return semantic;
  }

  const visibleLocator = page
    .locator(`[data-testid="${testId}"]:visible`)
    .first();
  if (await visibleLocator.isVisible({ timeout: 500 }).catch(() => false))
    return visibleLocator;

  return page.getByTestId(testId).first();
}

async function visibleDynamicQuestionTestId(
  page: Page,
  questionPrefix: string,
): Promise<string | null> {
  return page
    .locator(`[data-testid^="${questionPrefix}-"]:visible`)
    .evaluateAll((elements, prefix) => {
      const escapedPrefix = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exactQuestionTestId = new RegExp(
        `^${escapedPrefix}-[A-Za-z0-9_]+$`,
      );
      for (const element of elements) {
        const testId = element.getAttribute("data-testid");
        if (testId != null && exactQuestionTestId.test(testId)) {
          return testId;
        }
      }
      return null;
    }, questionPrefix)
    .catch(() => null);
}

async function waitForDynamicQuestionAdvance(
  page: Page,
  currentScreenTestId: string,
  questionPrefix: string,
  previousQuestionTestId: string | null,
  submitTestId: string,
  nextStageTestIds: readonly string[],
  timeout = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const testId of nextStageTestIds) {
      if (await isVisibleByTestIdOrSemantic(page, testId, 250)) {
        return testId;
      }
    }

    if (!(await isVisibleByTestIdOrSemantic(page, currentScreenTestId, 250))) {
      return "left-current-screen";
    }

    const currentQuestionTestId = await visibleDynamicQuestionTestId(
      page,
      questionPrefix,
    );
    if (
      previousQuestionTestId != null &&
      currentQuestionTestId != null &&
      currentQuestionTestId !== previousQuestionTestId
    ) {
      return currentScreenTestId;
    }

    const submit = await actionableLocatorForTestId(page, submitTestId);
    if (await submit.isVisible({ timeout: 250 }).catch(() => false)) {
      if (
        previousQuestionTestId == null &&
        !(await submit.isEnabled({ timeout: 250 }).catch(() => false))
      ) {
        return currentScreenTestId;
      }
    }

    await page.waitForTimeout(250);
  }

  throw new Error(`Timed out waiting for ${currentScreenTestId} to advance`);
}

async function maybeContinueSectionTransition(page: Page) {
  await clickIfPresent(page, "screening-section-transition-continue");
}

async function waitForEnabledAndClick(
  page: Page,
  testId: string,
  timeout = 30_000,
  attempts = 4,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const locator = await actionableLocatorForTestId(page, testId);
    await expect(locator).toBeVisible({ timeout });
    await expect(locator).toBeEnabled({ timeout });
    try {
      await locator.scrollIntoViewIfNeeded();
      await locator.click({ timeout: 10_000 });
      return;
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(250);
      if (!(await locator.isVisible({ timeout: 250 }).catch(() => false))) {
        return;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not click ${testId}`);
}

async function clickAndWaitForResponse({
  page,
  testId,
  matches,
  retryErrorTestId,
  timeout = 60_000,
  attempts = retryErrorTestId == null ? 1 : 3,
}: {
  page: Page;
  testId: string;
  matches: (response: PlaywrightResponse) => boolean;
  retryErrorTestId?: string;
  timeout?: number;
  attempts?: number;
}): Promise<PlaywrightResponse> {
  if (attempts > 1 && retryErrorTestId == null) {
    throw new Error(`Retries for ${testId} require a retryErrorTestId`);
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const responsePromise = page.waitForResponse(matches, { timeout });
    await waitForEnabledAndClick(page, testId);

    try {
      return await responsePromise;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }

      if (retryErrorTestId != null) {
        const retryableErrorVisible = await page
          .getByTestId(retryErrorTestId)
          .isVisible({ timeout: 1000 })
          .catch(() => false);
        if (!retryableErrorVisible) {
          break;
        }
      }

      await page.waitForTimeout(1500);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`No response matched after clicking ${testId}`);
}

async function isOfflineBannerVisible(page: Page): Promise<boolean> {
  return page
    .getByText(/No internet connection/i)
    .isVisible({ timeout: 1000 })
    .catch(() => false);
}

async function fillVerificationCode(
  page: Page,
  verificationCode: string,
): Promise<void> {
  await fillByTestId(page, "verify-otp-digit-0", verificationCode);
}

async function submitVerificationWithTransientRetry(
  page: Page,
  verificationCode: string,
): Promise<PlaywrightResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await expect(page.getByTestId("verify-screen")).toBeVisible({
      timeout: 60_000,
    });
    if (await isOfflineBannerVisible(page)) {
      await page
        .reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
        .catch(() => undefined);
      await expect(page.getByTestId("verify-screen")).toBeVisible({
        timeout: 60_000,
      });
    }
    await fillVerificationCode(page, verificationCode);
    try {
      return await clickAndWaitForResponse({
        page,
        testId: "verify-submit",
        matches: (response) =>
          response.url().includes("/api/auth/verify/registration/confirm") &&
          response.request().method() === "POST",
      });
    } catch (error) {
      lastError = error;
      if (attempt >= 3) break;
      if (await isOfflineBannerVisible(page)) {
        await page
          .reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
          .catch(() => undefined);
      }
      await page.waitForTimeout(1500);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out submitting verification after transient retries");
}

async function clickAndWaitForResponseOrSuccess({
  page,
  testId,
  matches,
  successTestId,
  timeout = 60_000,
}: {
  page: Page;
  testId: string;
  matches: (response: PlaywrightResponse) => boolean;
  successTestId: string;
  timeout?: number;
}): Promise<PlaywrightResponse | null> {
  const observedResponses: PlaywrightResponse[] = [];
  const collectResponse = (response: PlaywrightResponse) => {
    if (matches(response)) {
      observedResponses.push(response);
    }
  };

  page.on("response", collectResponse);
  try {
    await waitForEnabledAndClick(page, testId);

    const response = await Promise.race([
      page.waitForResponse(matches, { timeout }).catch(() => null),
      page
        .getByTestId(successTestId)
        .waitFor({ state: "visible", timeout })
        .then(() => null),
    ]);

    return (
      response ??
      observedResponses.find((candidate) => candidate.ok()) ??
      observedResponses[0] ??
      null
    );
  } finally {
    page.off("response", collectResponse);
  }
}

async function isConsentVisible(page: Page): Promise<boolean> {
  return (
    (await page
      .getByTestId("consent-screen")
      .isVisible({ timeout: 500 })
      .catch(() => false)) ||
    (await page
      .getByRole("heading", { name: /Privacy & Consent/i })
      .isVisible({ timeout: 500 })
      .catch(() => false))
  );
}

async function acceptConsentIfPresent(page: Page): Promise<boolean> {
  if (!(await isConsentVisible(page))) {
    return false;
  }

  const consentScroll = page.getByTestId("consent-flow-scroll");
  const initialScrollTop = await consentScroll.evaluate(
    (element) => element.scrollTop,
  );
  const firstConsent = page.getByTestId("consent-checkbox-pa-cons-privacy");
  if (await firstConsent.isVisible({ timeout: 1000 }).catch(() => false)) {
    await firstConsent.click();
  } else {
    await page
      .getByRole("checkbox", {
        name: /I agree to Privacy and Health Data Use/i,
      })
      .click();
  }
  await expect
    .poll(() => consentScroll.evaluate((element) => element.scrollTop), {
      message: "first consent should auto-scroll to the next required consent",
    })
    .toBeGreaterThan(initialScrollTop);

  const nextConsent = page.getByTestId("consent-checkbox-pa-cons-educational");
  await expect
    .poll(
      async () => {
        const [containerBox, consentBox] = await Promise.all([
          consentScroll.boundingBox(),
          nextConsent.boundingBox(),
        ]);
        if (containerBox == null || consentBox == null) return false;
        return (
          consentBox.y >= containerBox.y &&
          consentBox.y + consentBox.height <=
            containerBox.y + containerBox.height
        );
      },
      { message: "auto-scroll should reveal the next required consent" },
    )
    .toBe(true);

  if (!(await clickIfPresent(page, "consent-checkbox-pa-cons-educational"))) {
    await page
      .getByRole("checkbox", {
        name: /I understand SpineSense is educational use only/i,
      })
      .click();
  }
  await page.waitForTimeout(250);
  if (!(await clickIfPresent(page, "consent-checkbox-pa-cons-ai-analysis"))) {
    await page
      .getByRole("checkbox", { name: /I authorize AI-assisted assessment/i })
      .click();
  }
  await page.waitForTimeout(250);

  if (
    await page
      .getByTestId("consent-accept")
      .isVisible({ timeout: 1000 })
      .catch(() => false)
  ) {
    await waitForEnabledAndClick(page, "consent-accept");
  } else {
    const accept = page.getByRole("button", { name: /Accept & Continue/i });
    await expect(accept).toBeEnabled({ timeout: 30_000 });
    await accept.click();
  }
  return true;
}

async function waitForFirstVisibleEnabledAndClick(
  page: Page,
  testId: string,
  timeout = 30_000,
) {
  const locators = page.getByTestId(testId);
  await expect(locators.first()).toBeVisible({ timeout });

  const count = await locators.count();
  for (let index = 0; index < count; index += 1) {
    const locator = locators.nth(index);
    if (!(await locator.isVisible({ timeout: 1000 }).catch(() => false)))
      continue;
    await expect(locator).toBeEnabled({ timeout });
    await locator.scrollIntoViewIfNeeded();
    await locator.click();
    return;
  }

  throw new Error(`No visible enabled control found for ${testId}`);
}

function answerValues(
  value: AssessmentAnswer["value"],
): readonly (string | number)[] {
  return typeof value === "string" || typeof value === "number"
    ? [value]
    : value;
}

function expectScreeningGoalRoutePrefix(
  observedQuestionIds: readonly string[],
): void {
  const firstGoalIndex = observedQuestionIds.findIndex((id) =>
    SCREENING_GOAL_QUESTION_IDS.has(id),
  );
  if (firstGoalIndex < 0) return;

  const goalTail = observedQuestionIds.slice(firstGoalIndex);
  expect(
    goalTail.filter((id) => !SCREENING_GOAL_QUESTION_IDS.has(id)),
    "Screening must not route back to Symptoms or earlier screening questions after goals start",
  ).toEqual([]);
  expect(
    goalTail,
    "Screening goals must appear once in target order before adaptive loading",
  ).toEqual(EXPECTED_SCREENING_GOAL_QUESTION_IDS.slice(0, goalTail.length));
}

function expectCompletedScreeningGoalRoute(
  observedQuestionIds: readonly string[],
): void {
  expectScreeningGoalRoutePrefix(observedQuestionIds);
  const observedGoalIds = observedQuestionIds.filter((id) =>
    SCREENING_GOAL_QUESTION_IDS.has(id),
  );
  expect(
    observedGoalIds,
    "Screening goals must appear exactly once in target order",
  ).toEqual(EXPECTED_SCREENING_GOAL_QUESTION_IDS);
}

async function findVisibleCandidate(
  page: Page,
  candidates: readonly string[],
): Promise<Locator | null> {
  for (const testId of candidates) {
    const locators = page.getByTestId(testId);
    const count = await locators.count();
    for (let index = 0; index < count; index += 1) {
      const locator = locators.nth(index);
      await locator.scrollIntoViewIfNeeded().catch(() => undefined);
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        return locator;
      }
    }
  }
  return null;
}

async function clickScreeningSubmitIfPresent(
  page: Page,
  timeout = 30_000,
): Promise<boolean> {
  const footerSubmit = page.getByTestId("screening-nav-next");
  if (await footerSubmit.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!(await isScreeningSubmitButton(page))) return false;
    await expect(footerSubmit).toBeEnabled({ timeout });
    await footerSubmit.click();
    return true;
  }

  const submit = page.getByRole("button", { name: /submit answers/i }).first();
  if (await submit.isVisible({ timeout }).catch(() => false)) {
    await expect(submit).toBeEnabled({ timeout });
    await submit.click({ timeout: 10_000 });
    return true;
  }

  return false;
}

const POST_SCREENING_STAGE_TEST_IDS = [
  "adaptive-loading-state",
  "adaptive-loading-error-state",
  "adaptive-screen",
  "adaptive-error-state",
  "review-screen",
  "assessment-processing",
  "results-screen",
  "home-screen",
] as const;

async function submitScreening(page: Page, profiler: TransitionProfiler) {
  const existingStage = await waitForAnyVisibleTestId(
    page,
    POST_SCREENING_STAGE_TEST_IDS,
    1000,
  ).catch(() => null);
  if (existingStage != null) return;

  await expect(page.getByTestId("screening-nav-next")).toBeVisible({
    timeout: 30_000,
  });
  const finalQuestionId = await currentVisibleScreeningQuestionId(page).catch(
    () => null,
  );
  expect(
    finalQuestionId,
    "Screening submit must start from the final screening question",
  ).toBe(FINAL_SCREENING_QUESTION_ID);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    let clickedSubmit = false;
    const nextStage = await profiler
      .measure("screening.submit_to_post_screening", "stage", async () => {
        clickedSubmit = await clickScreeningSubmitIfPresent(page);
        if (!clickedSubmit) return null;
        return waitForAnyVisibleTestId(
          page,
          POST_SCREENING_STAGE_TEST_IDS,
          20_000,
        ).catch(() => null);
      })
      .catch((error) => {
        if (attempt === 4) throw error;
        return null;
      });
    if (nextStage != null) return;
    expect(clickedSubmit).toBe(true);
    await expect(page.getByTestId("screening-nav-next")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.getByTestId("screening-nav-next")).toBeEnabled({
      timeout: 30_000,
    });
  }

  await profiler.measure(
    "screening.submit_to_post_screening.final_wait",
    "stage",
    () => waitForAnyVisibleTestId(page, POST_SCREENING_STAGE_TEST_IDS, 120_000),
  );
}

function answerCandidateTestIds(
  prefix: string,
  id: string,
  value: string | number,
): string[] {
  const normalized = String(value);
  return [
    `${prefix}-${id}-option-${normalized}`,
    `${prefix}-${id}-stop-${normalized}`,
    `${prefix}-${id}-zone-${normalized}`,
    `${prefix}-${id}-region-${normalized}`,
    `${prefix}-${id}-acknowledge-btn`,
  ];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function answerLabelCandidates(value: string | number): string[] {
  const normalized = String(value);
  const spaced = normalized.replaceAll("_", " ");
  const explicit: Record<string, string[]> = {
    none: ["None of these", "None"],
    pain: ["Pain or tingling", "Pain"],
    pain_tingling: ["Pain or tingling"],
    numbness_tingling: ["Numbness", "Numbness or tingling"],
    no_walking_problem: ["I don't really have a walking problem"],
    none_now: ["None currently"],
    not_applicable: [
      "Not applicable",
      "Not applicable — leg symptoms do not force me to stop walking",
    ],
    one_ongoing_problem: ["It's all one ongoing problem"],
    same_all_day: ["Same all day"],
    not_sure: ["Not sure"],
    no_change: ["No change"],
    lt_10_min: ["Under 10 min", "Less than 10 min"],
    under_10_min: ["Under 10 min", "Less than 10 min"],
  };
  return [...(explicit[normalized] ?? []), spaced, normalized];
}

async function answerOneValue(
  page: Page,
  prefix: string,
  id: string,
  value: string | number,
) {
  const normalized = String(value);
  const locator = await findVisibleCandidate(
    page,
    answerCandidateTestIds(prefix, id, value),
  );
  if (locator != null) {
    await locator.click();
    return;
  }

  if (typeof value === "number") {
    const painLevel = page
      .getByRole("radio", {
        name: new RegExp(`^Pain level ${normalized}\\b`, "i"),
      })
      .first();
    if (await painLevel.isVisible({ timeout: 1000 }).catch(() => false)) {
      await painLevel.click();
      return;
    }
  }

  for (const label of answerLabelCandidates(value)) {
    const exactOptionLabel = new RegExp(
      `^Option \\d+ of \\d+:\\s*${escapeRegExp(label)}$`,
      "i",
    );
    const exactLabel = new RegExp(`^${escapeRegExp(label)}$`, "i");
    for (const role of ["radio", "checkbox"] as const) {
      for (const name of [exactOptionLabel, exactLabel]) {
        const control = page.getByRole(role, { name }).first();
        if (await control.isVisible({ timeout: 500 }).catch(() => false)) {
          await control.click();
          return;
        }
      }
    }
  }

  const input = page.getByTestId(`${prefix}-${id}-input`);
  if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
    await input.fill(normalized);
    return;
  }

  if (normalized === "acknowledged") {
    const acknowledge = page
      .getByRole("button", { name: /i understand|acknowledge/i })
      .first();
    if (await acknowledge.isVisible({ timeout: 1000 }).catch(() => false)) {
      await acknowledge.click();
      return;
    }
  }

  throw new Error(`No visible control found for ${prefix}-${id}=${normalized}`);
}

async function answerQuestion(
  page: Page,
  prefix: string,
  answer: AssessmentAnswer,
) {
  for (const value of answerValues(answer.value)) {
    await answerOneValue(page, prefix, answer.id, value);
  }
}

async function answerTextQuestion(
  page: Page,
  prefix: string,
  answer: TextAnswer,
) {
  const input = page.getByTestId(`${prefix}-${answer.id}-input`);
  if (!(await input.isVisible({ timeout: 1000 }).catch(() => false)))
    return false;
  await input.scrollIntoViewIfNeeded();
  await input.fill(answer.text);
  return true;
}

async function currentVisibleScreeningQuestionId(page: Page): Promise<string> {
  const visibleQuestionIds = await page
    .locator('[data-testid^="question-"]:visible')
    .evaluateAll((elements) => {
      const ids: string[] = [];
      for (const element of elements) {
        const testId = element.getAttribute("data-testid");
        const match = /^question-([A-Za-z0-9_]+)$/.exec(testId ?? "");
        if (match?.[1] != null) {
          ids.push(match[1]);
        }
      }
      return ids;
    });

  if (visibleQuestionIds.length === 0) {
    throw new Error(
      "No current visible screening question container was found",
    );
  }

  const questionId = visibleQuestionIds[0];
  if (questionId == null) {
    throw new Error("No current visible screening question id was resolved");
  }
  return questionId;
}

async function waitForScreeningNavIdle(page: Page, timeout = 30_000) {
  const next = page.getByTestId("screening-nav-next");
  await expect(next).toBeVisible({ timeout });
  await expect(next).not.toHaveAttribute("aria-busy", "true", { timeout });
  await expect(next).not.toContainText(/Saving/i, { timeout });
}

function isScreeningAnswersResponse(response: PlaywrightResponse): boolean {
  const url = new URL(response.url());
  return (
    url.pathname.endsWith("/screening/answers") &&
    response.request().method() === "PATCH"
  );
}

async function waitForScreeningAnswerSave(
  responsePromise: Promise<PlaywrightResponse>,
) {
  const response = await responsePromise;
  expect(
    response.ok(),
    `screening answer save failed with status ${response.status()}`,
  ).toBe(true);
}

async function isScreeningSubmitButton(page: Page): Promise<boolean> {
  const next = page.getByTestId("screening-nav-next");
  if (!(await next.isVisible({ timeout: 500 }).catch(() => false)))
    return false;

  const [ariaLabel, text] = await Promise.all([
    next.getAttribute("aria-label").catch(() => null),
    next.innerText().catch(() => ""),
  ]);

  if (!/submit answers/i.test(`${ariaLabel ?? ""} ${text}`)) return false;

  const currentQuestionId = await currentVisibleScreeningQuestionId(page).catch(
    () => null,
  );
  return currentQuestionId === FINAL_SCREENING_QUESTION_ID;
}

async function waitForScreeningAdvance(
  page: Page,
  previousQuestionId: string,
  timeout = 60_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const postScreeningStage = await waitForAnyVisibleTestId(
      page,
      POST_SCREENING_STAGE_TEST_IDS,
      250,
    ).catch(() => null);
    if (postScreeningStage != null) {
      return;
    }

    const screeningNavGone = !(await page
      .getByTestId("screening-nav-next")
      .isVisible({ timeout: 250 })
      .catch(() => false));
    if (screeningNavGone) {
      return;
    }

    if (
      await page
        .getByTestId("screening-section-transition-continue")
        .isVisible({ timeout: 250 })
        .catch(() => false)
    ) {
      await maybeContinueSectionTransition(page);
      continue;
    }

    const currentQuestionId = await currentVisibleScreeningQuestionId(
      page,
    ).catch(() => null);
    if (currentQuestionId != null && currentQuestionId !== previousQuestionId) {
      return;
    }

    await page.waitForTimeout(250);
  }

  throw new Error(
    `Timed out waiting for screening question ${previousQuestionId} to advance`,
  );
}

async function clickScreeningNextAndWaitForAdvance(
  page: Page,
  previousQuestionId: string,
) {
  const next = page.getByTestId("screening-nav-next");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForEnabledAndClick(page, "screening-nav-next", 30_000, 1);

    try {
      await waitForScreeningAdvance(
        page,
        previousQuestionId,
        attempt === 2 ? 60_000 : 20_000,
      );
      return;
    } catch (error) {
      const currentQuestionId = await currentVisibleScreeningQuestionId(
        page,
      ).catch(() => null);
      if (attempt === 2 || currentQuestionId !== previousQuestionId) {
        throw error;
      }

      await waitForScreeningNavIdle(page, 10_000);
      if (!(await next.isEnabled({ timeout: 500 }).catch(() => false))) {
        throw error;
      }
    }
  }
}

async function expectNoAssessmentBlockingState(page: Page) {
  await expect(page.getByTestId("emergency-screen")).toBeHidden({
    timeout: 500,
  });
  await expect(page.getByTestId("adaptive-loading-error-state")).toBeHidden({
    timeout: 500,
  });
  await expect(page.getByTestId("adaptive-error-state")).toBeHidden({
    timeout: 500,
  });
  await expect(page.getByTestId("assessment-processing-failed")).toBeHidden({
    timeout: 500,
  });
}

async function stressReloadCurrentScreeningQuestion(page: Page) {
  const questionIdBeforeReload = await currentVisibleScreeningQuestionId(page);
  logMilestone(
    `stress: reloading during screening at ${questionIdBeforeReload}`,
  );

  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
  const reloadStage = await waitForAnyVisibleTestId(
    page,
    ["screening-screen", "home-screen", "assessment-entry-guard"],
    60_000,
  );
  if (reloadStage === "home-screen") {
    await expectNoBrowserStorage(page);
    if (
      await page
        .getByTestId("continue-assessment-btn")
        .isVisible({ timeout: 1000 })
        .catch(() => false)
    ) {
      await waitForFirstVisibleEnabledAndClick(page, "continue-assessment-btn");
    } else if (
      await page
        .getByTestId("start-assessment-btn")
        .isVisible({ timeout: 1000 })
        .catch(() => false)
    ) {
      await waitForFirstVisibleEnabledAndClick(page, "start-assessment-btn");
    } else {
      const continueAssessment = page
        .getByRole("button", { name: /continue assessment/i })
        .first();
      await expect(continueAssessment).toBeEnabled({ timeout: 30_000 });
      await continueAssessment.click();
    }
  }

  await expect(page.getByTestId("screening-screen")).toBeVisible({
    timeout: 60_000,
  });
  await waitForScreeningNavIdle(page, 60_000);
  await expectNoBrowserStorage(page);

  const questionIdAfterReload = await currentVisibleScreeningQuestionId(page);
  expect(questionIdAfterReload).toBe(questionIdBeforeReload);
  await expectNoAssessmentBlockingState(page);
}

async function stressBacktrackOneScreeningQuestion(
  page: Page,
  previousQuestionId: string,
  expectedCurrentQuestionId: string,
) {
  logMilestone(
    `stress: backtracking from ${expectedCurrentQuestionId} to ${previousQuestionId}`,
  );

  await waitForEnabledAndClick(page, "screening-nav-back");
  await waitForScreeningAdvance(page, expectedCurrentQuestionId, 30_000);
  await waitForScreeningNavIdle(page);
  expect(await currentVisibleScreeningQuestionId(page)).toBe(
    previousQuestionId,
  );

  await clickScreeningNextAndWaitForAdvance(page, previousQuestionId);
  await waitForScreeningNavIdle(page);
  expect(await currentVisibleScreeningQuestionId(page)).toBe(
    expectedCurrentQuestionId,
  );
  await expectNoAssessmentBlockingState(page);
}

async function answerScreening(page: Page, profiler: TransitionProfiler) {
  await expect(page.getByTestId("screening-nav-next")).toBeVisible({
    timeout: 60_000,
  });
  const stressState: ScreeningStressState = {
    reloadedDuringScreening: false,
    backtrackedDuringScreening: false,
  };
  const observedQuestionIds: string[] = [];

  for (let questionIndex = 0; questionIndex < 80; questionIndex += 1) {
    const postScreeningStage = await waitForAnyVisibleTestId(
      page,
      POST_SCREENING_STAGE_TEST_IDS,
      250,
    ).catch(() => null);
    if (postScreeningStage != null) {
      expectCompletedScreeningGoalRoute(observedQuestionIds);
      return;
    }

    const screeningNavGone = !(await page
      .getByTestId("screening-nav-next")
      .isVisible({ timeout: 250 })
      .catch(() => false));
    if (screeningNavGone) {
      expectCompletedScreeningGoalRoute(observedQuestionIds);
      return;
    }

    const questionId = await currentVisibleScreeningQuestionId(page);
    observedQuestionIds.push(questionId);
    expectScreeningGoalRoutePrefix(observedQuestionIds);
    if (questionId === "A02") {
      const [painId, tinglingId, fullWidthReferenceId] =
        fullAssessmentScenario.uiContracts.a02OptionIds;
      const painOption = page.getByTestId(`question-A02-option-${painId}`);
      const tinglingOption = page.getByTestId(
        `question-A02-option-${tinglingId}`,
      );
      const fullWidthReference = page.getByTestId(
        `question-A02-option-${fullWidthReferenceId}`,
      );
      const [painBox, tinglingBox, fullWidthReferenceBox] = await Promise.all([
        painOption.boundingBox(),
        tinglingOption.boundingBox(),
        fullWidthReference.boundingBox(),
      ]);
      if (
        painBox == null ||
        tinglingBox == null ||
        fullWidthReferenceBox == null
      ) {
        throw new Error(
          "Expected the first three A02 options to have measurable layout boxes",
        );
      }
      expect(tinglingBox.x).toBeCloseTo(painBox.x, 1);
      expect(tinglingBox.width).toBeCloseTo(painBox.width, 1);
      expect(painBox.x).toBeCloseTo(fullWidthReferenceBox.x, 1);
      expect(painBox.width).toBeCloseTo(fullWidthReferenceBox.width, 1);
      expect(painBox.height).toBeCloseTo(52, 1);
      expect(tinglingBox.height).toBeCloseTo(52, 1);
      expect(tinglingBox.y - painBox.y).toBeCloseTo(60, 1);
      expect(tinglingBox.y - (painBox.y + painBox.height)).toBeCloseTo(8, 1);

      for (const option of [painOption, tinglingOption]) {
        await expect(option).toHaveCSS("box-sizing", "border-box");
        await expect(option).toHaveCSS("display", "flex");
        await expect(option).toHaveCSS("flex-direction", "column");
        await expect(option).toHaveCSS("min-height", "52px");
      }

      const optionLabelStyles = await Promise.all(
        fullAssessmentScenario.uiContracts.a02OptionIds.map((optionId) =>
          page
            .getByTestId(`question-A02-option-${optionId}-label`)
            .evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                fontFamily: style.fontFamily,
                fontSize: style.fontSize,
                fontWeight: style.fontWeight,
                lineHeight: style.lineHeight,
              };
            }),
        ),
      );
      expect(
        new Set(optionLabelStyles.map((style) => style.fontFamily)).size,
      ).toBe(1);
      expect(
        new Set(optionLabelStyles.map((style) => style.fontSize)).size,
      ).toBe(1);
      expect(
        new Set(optionLabelStyles.map((style) => style.lineHeight)).size,
      ).toBe(1);
      expect(
        optionLabelStyles.every((style) =>
          ["500", "600"].includes(style.fontWeight),
        ),
      ).toBe(true);
      expect(optionLabelStyles[0]?.fontFamily).toContain("BlinkMacSystemFont");
    }
    const textAnswer = SCREENING_TEXT_ANSWERS_BY_ID.get(questionId);
    if (
      textAnswer != null &&
      (await answerTextQuestion(page, "question", textAnswer))
    ) {
      // Text answer entered.
    } else {
      const answer = SCREENING_ANSWERS_BY_ID.get(questionId);
      if (answer == null) {
        throw new Error(
          `No screening fixture answer is defined for current question ${questionId}`,
        );
      }
      await answerQuestion(page, "question", answer);
    }

    await expect(
      page.getByTestId("screening-nav-next"),
      `Expected fixture answer ${questionId} to enable screening navigation`,
    ).toBeEnabled({ timeout: 30_000 });

    if (await isScreeningSubmitButton(page)) {
      expectCompletedScreeningGoalRoute(observedQuestionIds);
      return;
    }

    const screeningAnswerSaveResponse = page.waitForResponse(
      isScreeningAnswersResponse,
      {
        timeout: TRANSITION_BUDGETS_MS.sync,
      },
    );

    await profiler.measure(
      `screening.question.${questionId}.visual`,
      "question",
      () => clickScreeningNextAndWaitForAdvance(page, questionId),
    );
    await profiler.measure(
      `screening.question.${questionId}.sync`,
      "sync",
      async () => {
        await waitForScreeningAnswerSave(screeningAnswerSaveResponse);
        await waitForScreeningNavIdle(page);
      },
    );
    await expectNoAssessmentBlockingState(page);

    if (
      ENABLE_FULL_ASSESSMENT_STRESS &&
      !stressState.reloadedDuringScreening &&
      questionId === STRESS_RELOAD_AFTER_SCREENING_QUESTION_ID
    ) {
      await stressReloadCurrentScreeningQuestion(page);
      stressState.reloadedDuringScreening = true;
    }

    if (
      ENABLE_FULL_ASSESSMENT_STRESS &&
      !stressState.backtrackedDuringScreening &&
      questionId === STRESS_BACKTRACK_AFTER_SCREENING_QUESTION_ID
    ) {
      const expectedCurrentQuestionId =
        await currentVisibleScreeningQuestionId(page);
      await stressBacktrackOneScreeningQuestion(
        page,
        questionId,
        expectedCurrentQuestionId,
      );
      stressState.backtrackedDuringScreening = true;
    }
  }

  throw new Error(
    "Timed out answering screening questions before reaching submit",
  );
}

async function answerIssuedAdaptiveQuestion(
  page: Page,
  generatedAdaptiveAnswers: Map<string, unknown>,
): Promise<void> {
  const testId = await visibleDynamicQuestionTestId(page, "adaptive-question");
  const match = /^adaptive-question-([A-Za-z0-9_]+)$/.exec(testId ?? "");
  if (match?.[1] == null) {
    throw new Error(
      "Adaptive question is visible without an exact question ID selector",
    );
  }

  const questionId = match[1];
  if (SCREENING_GOAL_QUESTION_IDS.has(questionId)) {
    throw new Error(
      `Screening goal question ${questionId} was issued during adaptive follow-ups`,
    );
  }

  const answer = ADAPTIVE_ANSWERS_BY_ID.get(questionId);
  if (answer == null) {
    if (!/^gen_\d+$/.test(questionId)) {
      throw new Error(
        `No exact adaptive fixture answer is defined for issued question ${questionId}`,
      );
    }

    const question = page.getByTestId(`adaptive-question-${questionId}`);
    const radios = question.getByRole("radio");
    if ((await radios.count()) > 0) {
      const radio = radios.first();
      const testId = await radio.getAttribute("data-testid");
      const optionPrefix = `adaptive-question-${questionId}-option-`;
      const stopPrefix = `adaptive-question-${questionId}-stop-`;
      if (testId?.startsWith(optionPrefix)) {
        generatedAdaptiveAnswers.set(
          questionId,
          testId.slice(optionPrefix.length),
        );
      } else if (testId?.startsWith(stopPrefix)) {
        const value = Number(testId.slice(stopPrefix.length));
        if (!Number.isSafeInteger(value)) {
          throw new Error(
            `Generated adaptive pain scale ${questionId} has an invalid server-issued stop`,
          );
        }
        generatedAdaptiveAnswers.set(questionId, value);
      } else {
        throw new Error(
          `Generated adaptive radio ${questionId} has no exact server-issued value selector`,
        );
      }
      await radio.click();
      return;
    }

    const checkboxes = question.getByRole("checkbox");
    if ((await checkboxes.count()) > 0) {
      const checkbox = checkboxes.first();
      const testId = await checkbox.getAttribute("data-testid");
      const optionPrefix = `adaptive-question-${questionId}-option-`;
      if (!testId?.startsWith(optionPrefix)) {
        throw new Error(
          `Generated adaptive checkbox ${questionId} has no exact server-issued value selector`,
        );
      }
      generatedAdaptiveAnswers.set(questionId, [
        testId.slice(optionPrefix.length),
      ]);
      await checkbox.click();
      return;
    }

    const textInput = question.getByRole("textbox");
    if ((await textInput.count()) > 0) {
      const value = "No additional details for this synthetic test.";
      generatedAdaptiveAnswers.set(questionId, value);
      await textInput.fill(value);
      return;
    }

    throw new Error(
      `Generated adaptive question ${questionId} has no supported server-issued answer control`,
    );
  }

  for (const value of answerValues(answer.value)) {
    const selectors = answerCandidateTestIds(
      "adaptive-question",
      questionId,
      value,
    );
    const locator = await findVisibleCandidate(page, selectors);
    if (locator == null) {
      throw new Error(
        `No exact adaptive selector matched issued question ${questionId} (${selectors.length} checked)`,
      );
    }
    await locator.click();
  }
}

async function completeAdaptiveIfPresent(
  page: Page,
  generatedAdaptiveAnswers: Map<string, unknown>,
  profiler: TransitionProfiler,
): Promise<string | null> {
  const adaptiveScreen = page.getByTestId("adaptive-screen");
  let initialStage = await waitForAssessmentStage(page, [
    "adaptive-loading-state",
    "adaptive-loading-error-state",
    "adaptive-screen",
    "adaptive-error-state",
  ]);
  for (let retryAttempt = 0; retryAttempt < 3; retryAttempt += 1) {
    if (initialStage === "adaptive-loading-error-state") {
      initialStage = await profiler.measure(
        "adaptive.retry_loading",
        "stage",
        async () => {
          await waitForEnabledAndClick(page, "adaptive-loading-retry");
          return waitForRetryOutcome(page, "adaptive-loading-error-state", [
            "adaptive-loading-state",
            "adaptive-screen",
            "adaptive-error-state",
          ]);
        },
      );
    }

    if (initialStage === "adaptive-loading-state") {
      initialStage = await profiler.measure(
        "adaptive.loading_to_question",
        "stage",
        () =>
          waitForAssessmentStage(page, [
            "adaptive-loading-error-state",
            "adaptive-screen",
            "adaptive-error-state",
          ]),
      );
      continue;
    }

    break;
  }
  if (initialStage !== "adaptive-screen") return initialStage;

  await expect(page.getByTestId("adaptive-list")).toBeVisible({
    timeout: 30_000,
  });
  for (let index = 0; index < 20; index += 1) {
    if (
      !(await adaptiveScreen.isVisible({ timeout: 1000 }).catch(() => false))
    ) {
      return waitForAnyVisibleTestId(page, ["review-screen"], 60_000).catch(
        () => "left-adaptive-screen",
      );
    }
    await answerIssuedAdaptiveQuestion(page, generatedAdaptiveAnswers);
    const currentQuestionTestId = await visibleDynamicQuestionTestId(
      page,
      "adaptive-question",
    );
    if (currentQuestionTestId == null) {
      throw new Error(
        "Adaptive screen is visible without a current question test id",
      );
    }
    const questionLabel = currentQuestionTestId.replace(
      /^adaptive-question-/,
      "adaptive.question.",
    );
    const nextStage = await profiler.measure(
      questionLabel,
      "question",
      async () => {
        await waitForEnabledAndClick(page, "adaptive-submit");
        return waitForDynamicQuestionAdvance(
          page,
          "adaptive-screen",
          "adaptive-question",
          currentQuestionTestId,
          "adaptive-submit",
          ["adaptive-loading-state", "adaptive-error-state", "review-screen"],
        );
      },
    );
    if (nextStage === "adaptive-loading-state") {
      const resolvedStage = await profiler.measure(
        "adaptive.loading_to_next_stage",
        "stage",
        () =>
          waitForAssessmentStage(page, [
            "adaptive-screen",
            "adaptive-error-state",
            "review-screen",
          ]),
      );
      if (resolvedStage !== "adaptive-screen") return resolvedStage;
      continue;
    }
    if (nextStage !== "adaptive-screen") return nextStage;
  }

  throw new Error("Adaptive questionnaire did not exit after 20 questions");
}

async function waitForAnalysisReadyAndConfirm(
  page: Page,
  profiler: TransitionProfiler,
) {
  await profiler.measure(
    "processing.to_results_ready",
    "analysis",
    async () => {
      const analysisStage = await waitForAnyVisibleTestId(
        page,
        ["results-ready-confirm", "assessment-processing-failed"],
        480_000,
      );
      if (analysisStage === "assessment-processing-failed") {
        const failureReason = await page
          .getByTestId("processing-failure-reason")
          .textContent({ timeout: 1000 })
          .catch(() => null);
        throw new Error(
          `Assessment analysis failed during full E2E${failureReason ? `: ${sanitizeDiagnostic(failureReason)}` : ""}`,
        );
      }

      await waitForEnabledAndClick(page, "results-ready-confirm", 30_000);
    },
  );
}

async function completeProfileIfPresent(page: Page) {
  if (
    !(await page
      .getByTestId("step-profile")
      .isVisible({ timeout: 1000 })
      .catch(() => false))
  ) {
    return;
  }

  const { onboarding } = fullAssessmentScenario;
  await fillByTestId(page, "profile-dob", onboarding.dateOfBirthDisplay);
  await clickByTestId(page, `profile-sex-${onboarding.sexAtBirth}`);
  await fillByTestId(page, "profile-height-ft", onboarding.heightFeet);
  await fillByTestId(page, "profile-height-in", onboarding.heightInches);
  await fillByTestId(page, "profile-weight", onboarding.weightPounds);
  await fillByTestId(page, "profile-occupation", onboarding.occupation);
  await clickByTestId(page, `profile-activity-${onboarding.activityLevel}`);
  await waitForEnabledAndClick(page, "profile-continue-btn");
}

async function continueWelcomeIntroIfPresent(page: Page): Promise<boolean> {
  const stage = await waitForAnyVisibleTestId(
    page,
    ["welcome-intro-screen", "onboarding-layout"],
    10_000,
  ).catch(async () => {
    const welcomeCta = page.getByRole("button", { name: /let's begin/i });
    if (await welcomeCta.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return "welcome-intro-screen";
    }
    throw new Error(
      "Neither onboarding test IDs nor the visible welcome intro CTA became visible",
    );
  });
  if (stage !== "welcome-intro-screen") {
    return false;
  }

  const lockup = page.getByTestId("welcome-intro-lockup");
  const initialTransform = await lockup.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await expect
    .poll(
      () => lockup.evaluate((element) => getComputedStyle(element).transform),
      {
        message: "welcome lockup should animate into its docked position",
        timeout: 5_000,
      },
    )
    .not.toBe(initialTransform);

  const content = page.getByTestId("welcome-intro-content");
  await expect
    .poll(
      () =>
        content.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).opacity),
        ),
      {
        message: "welcome content should fade in after the logo animation",
        timeout: 6_000,
      },
    )
    .toBeGreaterThan(0.95);

  if (!(await clickIfPresent(page, "welcome-intro-begin"))) {
    await page.getByRole("button", { name: /let's begin/i }).click();
  }
  return true;
}

async function expectTreatmentHistoryAfterStorySave(page: Page) {
  await expect(page.getByTestId("medical-history-conditions-none")).toBeVisible(
    { timeout: 60_000 },
  );
}

async function expectChiefComplaintAfterProfileSave(page: Page) {
  await expect
    .poll(
      async () =>
        (await page
          .getByTestId("step-chief-complaint-select")
          .isVisible({ timeout: 1000 })
          .catch(() => false)) ||
        (await page
          .getByTestId("chief-complaint-text-option")
          .isVisible({ timeout: 1000 })
          .catch(() => false)) ||
        (await page
          .getByText(/Tell us what's/i)
          .isVisible({ timeout: 1000 })
          .catch(() => false)),
      {
        timeout: 60_000,
        message: "Expected chief complaint step after profile save",
      },
    )
    .toBe(true);
}

async function expectImagingRecordsAfterHistorySave(page: Page) {
  await expect
    .poll(
      async () =>
        (await page
          .getByTestId("records-continue-btn")
          .isVisible({ timeout: 1000 })
          .catch(() => false)) ||
        (await page
          .getByTestId("step-imaging-records")
          .isVisible({ timeout: 1000 })
          .catch(() => false)) ||
        (await page
          .getByRole("button", { name: /complete intake/i })
          .isVisible({ timeout: 1000 })
          .catch(() => false)) ||
        (await page
          .getByText(/Bring in your records/i)
          .isVisible({ timeout: 1000 })
          .catch(() => false)),
      {
        timeout: 60_000,
        message: "Expected imaging records step after treatment history save",
      },
    )
    .toBe(true);
}

async function clickRecordsContinue(page: Page) {
  if (
    await page
      .getByTestId("records-continue-btn")
      .isVisible({ timeout: 1000 })
      .catch(() => false)
  ) {
    await waitForEnabledAndClick(page, "records-continue-btn");
    return;
  }

  const skip = page.getByRole("button", { name: /skip for now/i });
  if (await skip.isVisible({ timeout: 1000 }).catch(() => false)) {
    await expect(skip).toBeEnabled({ timeout: 30_000 });
    await skip.click({ timeout: 10_000 });
    return;
  }

  const complete = page.getByRole("button", { name: /complete intake/i });
  await expect(complete).toBeVisible({ timeout: 30_000 });
  await expect(complete).toBeEnabled({ timeout: 30_000 });
  await complete.click({ timeout: 10_000 });
}

async function clickChiefComplaintSave(page: Page) {
  if (
    await page
      .getByTestId("text-save-btn")
      .isVisible({ timeout: 1000 })
      .catch(() => false)
  ) {
    await waitForEnabledAndClick(page, "text-save-btn");
    return;
  }

  const save = page.getByRole("button", { name: /save and continue/i });
  await expect(save).toBeVisible({ timeout: 30_000 });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click({ timeout: 10_000 });
}

async function recoverFromTransientNetworkShell(
  page: Page,
  profiler: TransitionProfiler,
  label: string,
): Promise<boolean> {
  if (!(await isOfflineBannerVisible(page))) {
    return false;
  }

  await profiler.measure(label, "recovery", async () => {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 });
    await expect
      .poll(() => isOfflineBannerVisible(page), {
        timeout: 30_000,
        message: "transient network shell should clear after reload",
      })
      .toBe(false);
  });
  return true;
}

async function waitForAssessmentEntry(
  page: Page,
  profiler: TransitionProfiler,
): Promise<string> {
  const assessmentEntryTestIds = [
    "home-screen",
    "assessment-entry-guard",
    "screening-screen",
    "story-capture",
    "story-screen",
  ] as const;

  let firstAssessmentScreen: string | null = null;
  for (
    let attempt = 1;
    attempt <= 3 && firstAssessmentScreen == null;
    attempt += 1
  ) {
    firstAssessmentScreen = await waitForAnyVisibleTestId(
      page,
      assessmentEntryTestIds,
      30_000,
    ).catch(() => null);

    if (firstAssessmentScreen != null) {
      break;
    }

    const recovered = await recoverFromTransientNetworkShell(
      page,
      profiler,
      `assessment_entry.network_recovery.attempt_${attempt}`,
    );
    if (!recovered && attempt >= 3) {
      firstAssessmentScreen = await waitForAnyVisibleTestId(
        page,
        assessmentEntryTestIds,
        30_000,
      );
    }
  }

  if (firstAssessmentScreen == null) {
    throw new Error(
      "Assessment entry did not render after transient recovery attempts",
    );
  }

  if (firstAssessmentScreen === "home-screen") {
    await expect(
      page.getByTestId("start-assessment-btn").first(),
    ).toBeVisible();
    await expectNoBrowserStorage(page);
    await waitForFirstVisibleEnabledAndClick(page, "start-assessment-btn");
    firstAssessmentScreen = await waitForAnyVisibleTestId(page, [
      "screening-screen",
      "story-capture",
      "story-screen",
    ]);
  }

  if (firstAssessmentScreen === "assessment-entry-guard") {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      firstAssessmentScreen = await waitForAnyVisibleTestId(
        page,
        ["screening-screen", "story-capture", "story-screen"],
        30_000,
      ).catch(() => null);
      if (firstAssessmentScreen != null) {
        break;
      }
      await recoverFromTransientNetworkShell(
        page,
        profiler,
        `assessment_entry.guard_network_recovery.attempt_${attempt}`,
      );
    }
    if (firstAssessmentScreen == null) {
      firstAssessmentScreen = await waitForAnyVisibleTestId(
        page,
        ["screening-screen", "story-capture", "story-screen"],
        30_000,
      );
    }
  }

  return firstAssessmentScreen;
}

test.describe("patient web full assessment flow", () => {
  test.beforeEach(async ({ request }) => {
    await cleanupE2eState(request);
  });

  test.beforeEach(async ({ page }) => {
    installPhiSafeDiagnostics(page);
  });

  test("registers a new patient and completes assessment to home @full-assessment", async ({
    page,
    request,
  }) => {
    test.setTimeout(FULL_FLOW_TIMEOUT_MS);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const questionnaireMutations = captureQuestionnaireMutations(page);
    const generatedAdaptiveAnswers = new Map<string, unknown>();
    const profiler = new TransitionProfiler();

    try {
      let email = uniqueSyntheticEmail();
      const { registration, onboarding } = fullAssessmentScenario;

      logMilestone("reset complete; warming csrf");
      await profiler.measure("session.csrf_warm", "stage", () =>
        warmCsrfSession(page),
      );
      logMilestone("csrf warm; opening welcome");
      await profiler.measure("launch.welcome", "page", () => gotoWelcome(page));
      logMilestone("welcome visible; opening registration");
      await profiler.measure("welcome.to_registration", "page", async () => {
        await clickWelcomeGetStarted(page);
        await expect(page.getByTestId("register-screen")).toBeVisible({
          timeout: 30_000,
        });
      });
      logMilestone("registration screen visible; submitting registration");
      const fillRegistrationForm = async () => {
        await fillByTestId(page, "register-first-name", registration.firstName);
        await fillByTestId(page, "register-last-name", registration.lastName);
        await fillByTestId(page, "register-email", email);
        await fillByTestId(page, "register-password", registration.password);
        await fillByTestId(
          page,
          "register-confirm-password",
          registration.password,
        );
        await clickIfPresent(page, "register-consent-storage");
      };
      await fillRegistrationForm();

      for (let attempt = 0; attempt < 3; attempt += 1) {
        let registerResponse: PlaywrightResponse | null;
        try {
          registerResponse = await profiler.measure(
            `registration.to_verify.attempt_${attempt + 1}`,
            "page",
            () =>
              clickAndWaitForResponseOrSuccess({
                page,
                testId: "register-submit",
                successTestId: "verify-screen",
                timeout: 30_000,
                matches: (response) =>
                  response.url().includes("/api/auth/register") &&
                  response.request().method() === "POST",
              }),
          );
        } catch (error) {
          if (attempt === 2) throw error;
          logMilestone(
            "registration submit did not reach verification; reloading and retrying with fresh email",
          );
          await page
            .reload({ waitUntil: "domcontentloaded", timeout: 45_000 })
            .catch(() => undefined);
          await expect(page.getByTestId("register-screen")).toBeVisible({
            timeout: 60_000,
          });
          email = uniqueSyntheticEmail();
          await fillRegistrationForm();
          continue;
        }
        if (registerResponse != null) {
          expect(registerResponse.ok()).toBeTruthy();
          await expectNoTokenLeak(await registerResponse.text());
        }
        expect(page.url()).not.toContain("verification");

        if (
          await page
            .getByTestId("verify-screen")
            .isVisible({ timeout: 10_000 })
            .catch(() => false)
        ) {
          break;
        }
        if (attempt === 2) {
          await expect(page.getByTestId("verify-screen")).toBeVisible({
            timeout: 60_000,
          });
          break;
        }

        logMilestone(
          "registration submitted without verification transition; retrying with fresh email",
        );
        email = uniqueSyntheticEmail();
        await fillRegistrationForm();
      }

      await expect(page.getByTestId("verify-screen")).toBeVisible({
        timeout: 60_000,
      });
      logMilestone("verification screen visible; checking browser storage");
      await expectNoBrowserStorage(page);

      const verificationCode = await getRegistrationVerificationCode(
        request,
        email,
      );
      await fillVerificationCode(page, verificationCode);
      logMilestone("verification code entered; submitting verification");
      const verifyResponse = await profiler.measure(
        "verification.to_authenticated_session",
        "page",
        () => submitVerificationWithTransientRetry(page, verificationCode),
      );
      expect(verifyResponse.ok()).toBeTruthy();
      await expectNoTokenLeak(await verifyResponse.text());
      expect(page.url()).not.toContain("verification");
      logMilestone(
        "verification accepted; checking authenticated cookie session",
      );
      await expectAuthenticatedCookieSession(page);

      logMilestone("authenticated cookies verified; waiting for consent");
      await profiler.measure("authenticated_session.to_consent", "page", () =>
        expectConsentScreenAfterVerification(page),
      );
      logMilestone("consent screen visible; accepting consent");

      await profiler.measure("consent.to_onboarding", "page", async () => {
        await acceptConsentIfPresent(page);
        logMilestone("consent accepted; continuing welcome intro");
        await continueWelcomeIntroIfPresent(page);
        await expect(page.getByTestId("onboarding-layout")).toBeVisible({
          timeout: 60_000,
        });
      });
      logMilestone("onboarding layout visible; filling onboarding");
      await profiler.measure(
        "onboarding.profile_to_chief_complaint",
        "page",
        async () => {
          await completeProfileIfPresent(page);
          await expectChiefComplaintAfterProfileSave(page);
        },
      );
      await clickByTestId(page, "chief-complaint-text-option");
      await expect(page.getByTestId("step-chief-complaint-text")).toBeVisible();
      await fillByTestId(page, "narrative-input", onboarding.chiefComplaint);
      await profiler.measure(
        "onboarding.chief_complaint_to_history",
        "page",
        async () => {
          await clickChiefComplaintSave(page);
          await expectTreatmentHistoryAfterStorySave(page);
        },
      );
      await clickByTestId(page, "medical-history-conditions-none");
      const negativeMedicalHistoryAnswers = page.getByRole("button", {
        name: "No",
        exact: true,
      });
      await expect(negativeMedicalHistoryAnswers).toHaveCount(4);
      for (let remaining = 4; remaining > 0; remaining -= 1) {
        await negativeMedicalHistoryAnswers
          .first()
          .click({ force: true, timeout: 10_000 });
        await expect(negativeMedicalHistoryAnswers).toHaveCount(remaining - 1);
        await page.waitForTimeout(500);
      }
      await clickByTestId(page, "medical-history-nicotine-no");
      await profiler.measure(
        "onboarding.history_to_records",
        "page",
        async () => {
          await waitForEnabledAndClick(page, "medical-history-continue-btn");
          await expectImagingRecordsAfterHistorySave(page);
        },
      );

      logMilestone(
        "imaging records visible; uploading synthetic assessment document",
      );
      await uploadSyntheticAssessmentDocumentFromRecordsStep(
        page,
        email,
        profiler,
      );

      const firstAssessmentScreen = await profiler.measure(
        "onboarding.records_to_assessment_entry",
        "stage",
        async () => {
          await clickRecordsContinue(page);
          return waitForAssessmentEntry(page, profiler);
        },
      );
      if (
        firstAssessmentScreen === "story-capture" ||
        firstAssessmentScreen === "story-screen"
      ) {
        await clickByTestId(page, "story-capture-text-tab");
        await fillByTestId(
          page,
          "story-capture-text-input",
          fullAssessmentScenario.assessmentStory,
        );
        await page.getByTestId("story-capture-text-input").blur();
        await profiler.measure(
          "assessment.story_to_documents",
          "page",
          async () => {
            await waitForEnabledAndClick(page, "story-capture-continue-btn");
            await expect(page.getByTestId("documents-screen")).toBeVisible({
              timeout: 60_000,
            });
          },
        );
        await profiler.measure(
          "assessment.documents_to_screening",
          "page",
          async () => {
            await clickByTestId(page, "documents-skip-btn");
            await expect(page.getByTestId("screening-screen")).toBeVisible({
              timeout: 60_000,
            });
          },
        );
      }

      await expect(page.getByTestId("screening-screen")).toBeVisible({
        timeout: 60_000,
      });
      await answerScreening(page, profiler);
      await submitScreening(page, profiler);

      const postAdaptiveStage = await completeAdaptiveIfPresent(
        page,
        generatedAdaptiveAnswers,
        profiler,
      );
      if (postAdaptiveStage !== "review-screen") {
        throw new Error(
          `Expected review-screen after adaptive flow, got ${postAdaptiveStage}`,
        );
      }
      expectQuestionnaireMutationContracts(
        questionnaireMutations,
        generatedAdaptiveAnswers,
      );
      await expect(page.getByTestId("review-screen")).toBeVisible({
        timeout: 120_000,
      });
      await expect(page.getByTestId("review-ready-icon")).toBeVisible();
      await expect(page.getByTestId("review-ready-title")).toBeVisible();
      await expect(page.getByText("ASSESSMENT COMPLETE")).toBeVisible();
      await expect(
        page.getByText(/build your personalized clinical picture/i),
      ).toBeVisible();
      await profiler.measure("review.to_processing", "page", async () => {
        await waitForEnabledAndClick(page, "review-submit");
        await expect(page.getByTestId("assessment-processing")).toBeVisible({
          timeout: 30_000,
        });
      });
      await waitForAnalysisReadyAndConfirm(page, profiler);
      await expect(page.getByTestId("results-screen")).toBeVisible({
        timeout: 480_000,
      });
      await expect(page.getByText("Assessment Results")).toBeVisible();
      await expect(page.getByTestId("results-disclaimer")).toBeVisible();
      await expect(page.getByTestId("results-diagnosis")).toBeVisible();
      await page.getByTestId("sticky-tab-wrapper").scrollIntoViewIfNeeded();
      await expect(page.getByText("Treatment Strategy")).toBeVisible();
      await expect(page.getByTestId("results-treatment")).toBeVisible();
      await expect(page.getByTestId("results-self-care")).toBeVisible();
      await expect(page.getByTestId("results-share")).toBeVisible();
      await expect(page.getByTestId("results-share")).toBeEnabled();
      await expect(page.getByTestId("results-share")).toHaveAttribute(
        "aria-label",
        "Open PDF report options",
      );

      logMilestone("results visible; generating and downloading PDF report");
      await page.getByTestId("results-share").click();
      await expect(page.getByTestId("results-report-options")).toBeVisible();
      const includeDocuments = page
        .getByTestId("results-report-options-include-documents")
        .getByRole("switch");
      const includeTrends = page
        .getByTestId("results-report-options-include-trends")
        .getByRole("switch");
      await expectOptionalReportSwitchCanOnlySubmitWhenAvailable(
        includeDocuments,
        "Document summaries",
      );
      await expectOptionalReportSwitchCanOnlySubmitWhenAvailable(
        includeTrends,
        "Symptom trends",
      );
      await expect(
        page.getByTestId("results-report-options-generate"),
      ).toHaveAttribute("aria-label", "Generate PDF");
      const reportResponse = await profiler.measure(
        "results.report_generation",
        "report",
        () =>
          clickAndWaitForResponse({
            page,
            testId: "results-report-options-generate",
            matches: isAssessmentReportGenerationResponse,
            retryErrorTestId: "results-report-error",
            timeout: TRANSITION_BUDGETS_MS.report,
            attempts: 2,
          }),
      );
      if (reportResponse.status() !== 201) {
        const reportError = await reportResponse
          .json()
          .then((payload) => sanitizeDiagnostic(JSON.stringify(payload)))
          .catch(() => "non-JSON response");
        throw new Error(
          `Assessment report generation failed status=${reportResponse.status()} body=${reportError}`,
        );
      }
      await expectRenderedAssessmentPdf(request, reportResponse);
      await expect(page.getByTestId("results-report-error")).toBeHidden();
      await expectNoBrowserStorage(page);
      await profiler.measure("results.to_home", "page", async () => {
        await waitForEnabledAndClick(page, "tab-home", 30_000);
        await expect(
          page.locator('[data-testid="home-screen"]:visible'),
        ).toBeVisible({ timeout: 60_000 });
      });
      await expect(page.getByTestId("assessment-entry-banner")).toBeHidden();
      await expect(
        page.locator('[data-testid="clinical-summary-card"]:visible'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="summary-headline"]:visible'),
      ).toBeVisible();
      await expect(
        page.locator('[data-testid="active-problems-card"]:visible'),
      ).toBeVisible();
      await expectNoBrowserStorage(page);
    } finally {
      await profiler.attach(test.info());
    }
  });
});
