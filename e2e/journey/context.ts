import {
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Response as PlaywrightResponse,
  type TestInfo,
} from "@playwright/test";
import { performance } from "node:perf_hooks";

import { SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT } from "../../src/lib/e2e/document-upload-fixture";
import { fullAssessmentScenario } from "../fixtures/fullAssessmentScenario";
import { safeRequestId, sanitizeDiagnostic } from "../support/diagnostics";
import {
  isPerformanceProfilingEnabled,
  readPerformanceMode,
  shouldEnforcePerformanceBudgets,
} from "../support/performanceMode";
import type { StageStep } from "../stages/stage";
import type { E2ERunIdentity } from "../support/runIdentity";
import type { RecoveryDecision } from "../support/recoveryPolicy";
import {
  ASSESSMENT_ANALYSIS_READINESS_TIMEOUT_MS,
  FULL_FLOW_TIMEOUT_MS,
  REPORT_GENERATION_TIMEOUT_MS,
  readPositiveIntegerEnv,
} from "./timeouts";

export { FULL_FLOW_TIMEOUT_MS } from "./timeouts";

export const PATIENT_WEB_BASE_URL =
  process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101";
export const BACKEND_REGISTRATION_CODE_URL = validateBffHelperUrl(
  process.env.PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL,
  "PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL",
  "/api/test/registration-verification-code",
);
export const BACKEND_DOCUMENT_SCAN_RESULT_URL = validateBffHelperUrl(
  process.env.PATIENT_WEB_BACKEND_DOCUMENT_SCAN_RESULT_URL,
  "PATIENT_WEB_BACKEND_DOCUMENT_SCAN_RESULT_URL",
  "/api/test/document-scan-result",
);
export const BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL = validateBffHelperUrl(
  process.env.PATIENT_WEB_BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL,
  "PATIENT_WEB_BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL",
  "/api/test/document-upload-persistence",
);
export const BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL = validateBffHelperUrl(
  process.env.PATIENT_WEB_BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL,
  "PATIENT_WEB_BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL",
  "/api/test/document-analysis-persistence",
);
export const BACKEND_RESULTS_FIXTURE_URL = validateBffHelperUrl(
  process.env.PATIENT_WEB_BACKEND_RESULTS_FIXTURE_URL,
  "PATIENT_WEB_BACKEND_RESULTS_FIXTURE_URL",
  "/api/test/results-fixture",
);
export const TEST_SUPPORT_TOKEN = process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN;
export const EXPECT_SECURE_COOKIES =
  process.env.PATIENT_WEB_EXPECT_SECURE_COOKIES === "true";
export const ENABLE_FULL_ASSESSMENT_STRESS =
  process.env.PATIENT_WEB_FULL_ASSESSMENT_STRESS !== "false";
export const PERFORMANCE_MODE = readPerformanceMode();
export const ENABLE_TRANSITION_PROFILING =
  isPerformanceProfilingEnabled(PERFORMANCE_MODE);
export const ATTACH_PERFORMANCE_ARTIFACTS =
  process.env.PATIENT_WEB_E2E_PERFORMANCE_ARTIFACTS === "true";
export const ASSESSMENT_REPORT_PROXY_PATH_RE =
  /^\/api\/proxy\/api\/v1\/patients\/me\/assessments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/reports$/i;
export const ADAPTIVE_PREPARE_PROXY_PATH_RE =
  /^\/api\/proxy\/api\/v1\/patients\/me\/assessments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/adaptive\/prepare$/i;
export const STRESS_RELOAD_AFTER_SCREENING_QUESTION_ID =
  fullAssessmentScenario.stress.reloadAfterScreeningQuestionId;
export const STRESS_BACKTRACK_AFTER_SCREENING_QUESTION_ID =
  fullAssessmentScenario.stress.backtrackAfterScreeningQuestionId;
export const SYNTHETIC_ASSESSMENT_UPLOAD = {
  name: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.name,
  mimeType: SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.mimeType,
  buffer: Buffer.from(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.base64, "base64"),
} as const;

/**
 * Test-support helpers are reached through the patient-web BFF. The old
 * environment variable names are retained for the orchestration contract,
 * but a direct backend or arbitrary external URL is never accepted here.
 */
export function validateBffHelperUrl(
  value: string | undefined,
  environmentVariable: string,
  expectedPath: string,
  baseUrl: string = PATIENT_WEB_BASE_URL,
): string | undefined {
  if (value == null || value.trim().length === 0) return undefined;

  let bffUrl: URL;
  let helperUrl: URL;
  try {
    bffUrl = new URL(baseUrl);
    helperUrl = new URL(value);
  } catch {
    throw new Error(
      `${environmentVariable} must be an absolute same-origin BFF URL`,
    );
  }

  if (
    !["http:", "https:"].includes(bffUrl.protocol) ||
    helperUrl.origin !== bffUrl.origin ||
    helperUrl.pathname !== expectedPath ||
    helperUrl.search.length > 0 ||
    helperUrl.hash.length > 0 ||
    helperUrl.username.length > 0 ||
    helperUrl.password.length > 0
  ) {
    throw new Error(
      `${environmentVariable} must be the same-origin BFF route ${expectedPath}`,
    );
  }

  return helperUrl.toString();
}

export type BrowserCookie = {
  name: string;
  httpOnly: boolean;
  path: string;
  sameSite: "Lax" | "None" | "Strict";
  secure: boolean;
};

export type AssessmentAnswer = {
  readonly id: string;
  readonly value: string | number | readonly (string | number)[];
};

export type TextAnswer = {
  readonly id: string;
  readonly text: string;
};

export type ScreeningStressState = {
  reloadedDuringScreening: boolean;
  backtrackedDuringScreening: boolean;
};

export type QuestionnaireMutation = {
  method: "POST" | "PUT" | "PATCH";
  path: string;
  payload: unknown;
};

/**
 * Return the same-origin request headers used by the web client for a direct
 * BFF call. Checkpoint preparation must still cross the browser CSRF boundary;
 * it must never use backend bearer tokens or a separate authenticated client.
 */
export async function browserMutationHeaders(
  page: Page,
): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find(
    (cookie) => cookie.name === "spine_patient_csrf",
  )?.value;
  if (csrf == null || csrf.length === 0) {
    throw new Error(
      "Checkpoint preparation failed closed: the BFF CSRF cookie was not issued",
    );
  }

  const currentUrl = page.url();
  const origin = currentUrl.startsWith("http")
    ? new URL(currentUrl).origin
    : new URL(PATIENT_WEB_BASE_URL).origin;
  return {
    "content-type": "application/json",
    "x-csrf-token": csrf,
    origin,
  };
}

/** Add a direct BFF mutation to the same contract ledger as browser actions. */
export function recordQuestionnaireMutation(
  context: Pick<JourneyContext, "questionnaireMutations">,
  method: QuestionnaireMutation["method"],
  path: string,
  payload: unknown,
): void {
  context.questionnaireMutations.push({ method, path, payload });
}

export type AssessmentUploadUrlResponse = {
  document_id?: string;
  documentId?: string;
};

export type AssessmentDocumentRecord = {
  id?: string;
  state?: "pending" | "processing" | "complete" | "failed";
  label?: "Uploaded document" | "Pasted text" | "Unavailable document";
  file_name?: string | null;
  fileName?: string | null;
  file_type?: string | null;
  fileType?: string | null;
  file_size_bytes?: number | null;
  fileSizeBytes?: number | null;
  processing_status?: string;
  processingStatus?: string;
};

export type UploadedAssessmentDocument = Readonly<{
  assessmentId: string;
  documentId: string;
}>;

export type AssessmentReportGenerationPayload = {
  id?: unknown;
  format?: unknown;
  file_name?: unknown;
  content_type?: unknown;
  byte_size?: unknown;
  sha256?: unknown;
  download_url?: unknown;
  expires_in_seconds?: unknown;
};

export type AssessmentReportRequestPayload = {
  format?: unknown;
  variant?: unknown;
  include_documents?: unknown;
  include_trends?: unknown;
  delivery?: unknown;
};

export type TransitionProfileKind =
  | "page"
  | "question"
  | "sync"
  | "recovery"
  | "stage"
  | "analysis"
  | "report";

export type TransitionProfileSample = {
  label: string;
  kind: TransitionProfileKind;
  durationMs: number;
  wallDurationMs?: number | undefined;
  excludedScreeningSyncMs?: number | undefined;
  budgetMs: number;
  status: "ok" | "slow";
};

export type TransitionProfileSummary = {
  kind: TransitionProfileKind;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  slowCount: number;
};

export const SCREENING_ANSWERS_BY_ID = new Map(
  fullAssessmentScenario.screening.map((answer) => [answer.id, answer]),
);
export const SCREENING_TEXT_ANSWERS_BY_ID = new Map(
  fullAssessmentScenario.screeningText.map((answer) => [answer.id, answer]),
);
export const ADAPTIVE_ANSWERS_BY_ID = new Map(
  fullAssessmentScenario.adaptive.map((answer) => [answer.id, answer]),
);
export const FINAL_SCREENING_QUESTION_ID =
  fullAssessmentScenario.finalScreeningQuestionId;
export const EXPECTED_SCREENING_GOAL_QUESTION_IDS: readonly string[] =
  fullAssessmentScenario.screeningGoalQuestionOrder.filter(
    (id) =>
      SCREENING_ANSWERS_BY_ID.has(id) || SCREENING_TEXT_ANSWERS_BY_ID.has(id),
  );
export const SCREENING_GOAL_QUESTION_IDS: ReadonlySet<string> = new Set([
  ...fullAssessmentScenario.requiredScreeningGoalQuestionIds,
  ...fullAssessmentScenario.optionalScreeningGoalQuestionIds,
]);

export const TRANSITION_BUDGETS_MS: Record<TransitionProfileKind, number> = {
  page: readPositiveIntegerEnv("PATIENT_WEB_E2E_PAGE_BUDGET_MS", 90_000),
  // Normal question advances are ~350ms in prod, with section/conditional
  // transitions around 1.5s. Allow 2.5s to avoid failing on minor Azure/browser
  // jitter after network recovery while still catching real visible stalls.
  question: readPositiveIntegerEnv("PATIENT_WEB_E2E_QUESTION_BUDGET_MS", 2_500),
  // Background persistence is profiled separately from the user-visible
  // question transition. Prod browser network changes have produced 17s+ save
  // responses while the next question rendered in <500ms; keep the visible
  // question budget strict and give sync enough room to measure the actual
  // save path instead of timing out the listener.
  sync: readPositiveIntegerEnv("PATIENT_WEB_E2E_SYNC_BUDGET_MS", 30_000),
  recovery: readPositiveIntegerEnv(
    "PATIENT_WEB_E2E_RECOVERY_BUDGET_MS",
    30_000,
  ),
  stage: readPositiveIntegerEnv("PATIENT_WEB_E2E_STAGE_BUDGET_MS", 180_000),
  analysis: ASSESSMENT_ANALYSIS_READINESS_TIMEOUT_MS,
  report: REPORT_GENERATION_TIMEOUT_MS,
};

export class TransitionProfiler {
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
      this.recordElapsed(label, kind, startedAt, {
        assertBudget: !actionFailed,
      });
    }
  }

  recordElapsed(
    label: string,
    kind: TransitionProfileKind,
    startedAt: number,
    options: { assertBudget?: boolean } = {},
  ) {
    if (!ENABLE_TRANSITION_PROFILING) return;

    this.recordDuration(label, kind, performance.now() - startedAt, options);
  }

  recordDuration(
    label: string,
    kind: TransitionProfileKind,
    rawDurationMs: number,
    options: {
      assertBudget?: boolean;
      wallDurationMs?: number;
      excludedScreeningSyncMs?: number;
    } = {},
  ) {
    if (!ENABLE_TRANSITION_PROFILING) return;

    const durationMs = Math.round(rawDurationMs * 10) / 10;
    const wallDurationMs =
      options.wallDurationMs == null
        ? undefined
        : Math.round(options.wallDurationMs * 10) / 10;
    const excludedScreeningSyncMs =
      options.excludedScreeningSyncMs == null
        ? undefined
        : Math.round(options.excludedScreeningSyncMs * 10) / 10;
    const budgetMs = TRANSITION_BUDGETS_MS[kind];
    const status = durationMs > budgetMs ? "slow" : "ok";
    this.samples.push({
      label,
      kind,
      durationMs,
      wallDurationMs,
      excludedScreeningSyncMs,
      budgetMs,
      status,
    });
    const transportEvidence =
      wallDurationMs == null || excludedScreeningSyncMs == null
        ? ""
        : ` wall_duration_ms=${wallDurationMs.toFixed(1)} excluded_screening_sync_ms=${excludedScreeningSyncMs.toFixed(1)}`;
    console.log(
      `[perf] label=${label} kind=${kind} duration_ms=${durationMs.toFixed(1)}${transportEvidence} budget_ms=${budgetMs} status=${status}`,
    );
    if (
      (options.assertBudget ?? true) &&
      shouldEnforcePerformanceBudgets(PERFORMANCE_MODE)
    ) {
      expect(
        durationMs,
        `${label} exceeded ${budgetMs}ms budget (${durationMs.toFixed(1)}ms)`,
      ).toBeLessThanOrEqual(budgetMs);
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
    if (!ATTACH_PERFORMANCE_ARTIFACTS) return;
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

export function percentile(
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

export function logMilestone(message: string): void {
  console.log(`[milestone] ${message}`);
}

export function installPhiSafeDiagnostics(page: Page) {
  const storageOrigins = new Set(
    (process.env.NEXT_PUBLIC_STORAGE_DOMAINS ?? "")
      .split(",")
      .map((origin) => origin.trim().replace(/\/$/, ""))
      .filter((origin) => origin.length > 0),
  );
  const isConfiguredStorageOrigin = (url: URL): boolean =>
    storageOrigins.has(url.origin);

  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    console.log("[browser-console] error_code=browser_console_error");
  });
  page.on("pageerror", () =>
    console.log("[browser-page] error_code=browser_page_error"),
  );
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (isConfiguredStorageOrigin(url)) {
      console.log(
        `[storage-response] method=${response.request().method()} status=${response.status()} route=${sanitizeDiagnostic(url.pathname)}`,
      );
      return;
    }
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
    const requestId = safeRequestId(
      response.headers()["x-request-id"] ?? response.headers()["request-id"],
    );
    console.log(
      `[response] route=${sanitizeDiagnostic(url.pathname)} status=${response.status()}` +
        (requestId == null ? "" : ` request_id=${requestId}`),
    );
  });
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (!isConfiguredStorageOrigin(url)) return;
    console.log(
      `[storage-request-failed] method=${request.method()} route=${sanitizeDiagnostic(url.pathname)} failure_code=browser_request_failed`,
    );
  });
}

export function captureQuestionnaireMutations(
  page: Page,
): QuestionnaireMutation[] {
  const mutations: QuestionnaireMutation[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET") return;
    if (
      !/(?:\/intake\/(?:story$|route|steps\/[^/]+|progress(?:\/complete)?$)|\/assessments(?:\/[^/]+)?\/(?:screening|adaptive)\/(?:answers|complete|complete-with-answers)$|\/assessments\/[^/]+\/analysis\/run$)/.test(
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
    const method = request.method();
    if (method !== "POST" && method !== "PUT" && method !== "PATCH") return;
    mutations.push({ method, path, payload });
  });
  return mutations;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function expectRawAnswerValue(
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

export function assessmentIdFromDocumentsUrl(url: string): string {
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

export function documentIdFromUploadResponse(
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

export function assessmentDocumentConfirmationFromResponse(payload: unknown) {
  if (!isRecord(payload)) {
    throw new Error(
      "Assessment document confirmation response was not an object",
    );
  }
  const documentId = payload.document_id;
  if (typeof documentId !== "string" || documentId.length === 0) {
    throw new Error(
      "Assessment document confirmation response did not include document_id",
    );
  }
  const processingStatus = payload.processing_status;
  if (typeof processingStatus !== "string" || processingStatus.length === 0) {
    throw new Error(
      "Assessment document confirmation response did not include processing_status",
    );
  }
  return { documentId, processingStatus };
}

export function normalizeAssessmentDocument(record: AssessmentDocumentRecord) {
  return {
    id: record.id,
    state: record.state,
    label: record.label,
    fileName: record.file_name ?? record.fileName ?? null,
    fileType: record.file_type ?? record.fileType ?? null,
    fileSizeBytes: record.file_size_bytes ?? record.fileSizeBytes ?? null,
    processingStatus:
      record.processing_status ?? record.processingStatus ?? record.state,
  };
}

async function postTestSupport(
  request: APIRequestContext,
  url: string,
  token: string | undefined,
  label: string,
  data?: unknown,
): Promise<APIResponse> {
  const options: Parameters<APIRequestContext["post"]>[1] = {
    timeout: 90_000,
  };
  if (token) {
    options.headers = {
      authorization: `Bearer ${token}`,
      ...(data == null ? {} : { "content-type": "application/json" }),
    };
  }
  if (data != null) options.data = data;
  const response = await request.post(url, options);
  expect(response.status(), `${label} failed status=${response.status()}`).toBe(
    200,
  );
  return response;
}

export async function prepareResultsReportFixture(
  request: APIRequestContext,
  identity: E2ERunIdentity,
): Promise<void> {
  if (!BACKEND_RESULTS_FIXTURE_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_RESULTS_FIXTURE_URL is required for the results-report scope",
    );
  }
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for the results-report fixture",
    );
  }
  const response = await postTestSupport(
    request,
    BACKEND_RESULTS_FIXTURE_URL,
    TEST_SUPPORT_TOKEN,
    "server-owned results-report fixture",
    {
      run_id: identity.runId,
      email: identity.email,
      fixture: "results-report-v1",
    },
  );
  const payload = await response.json();
  if (
    !isRecord(payload) ||
    payload.status !== "fixture_ready" ||
    payload.fixture !== "results-report-v1"
  ) {
    throw new Error("Results-report fixture returned an unsupported response");
  }
}

export async function getRegistrationVerificationCode(
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

export async function expectNoTokenLeak(
  response: Pick<PlaywrightResponse, "text">,
) {
  const responseText = await response.text();
  expect(responseText.includes("access_token")).toBe(false);
  expect(responseText.includes("refresh_token")).toBe(false);
  expect(responseText.includes("accessToken")).toBe(false);
  expect(responseText.includes("refreshToken")).toBe(false);
  expect(responseText.includes("mfa_token")).toBe(false);
  expect(responseText.includes("mfaToken")).toBe(false);
}

export async function expectNoBrowserStorage(page: Page) {
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

export function hasCookie(cookies: BrowserCookie[], name: string): boolean {
  return cookies.some((entry) => entry.name === name);
}

export function cookieHasExpectedShape(
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

export type AdaptivePrepareTrackerContract = {
  start(page: Page): void;
  stop(): void;
  consumeRetryableFailure(
    attempt: number,
    maxAttempts: number,
    evidence?: Readonly<{ productTimeoutVisible?: boolean }>,
  ): RecoveryDecision;
  assertRecoveryReceiptContinuity(requireRecoveryRequest?: boolean): void;
  waitForConsumedPrepareClientOutcome(
    timeoutMs: number,
  ): Promise<RecoveryDecision>;
  hasRecoveredPrepareCompletion(): boolean;
  waitForRecoveredPrepareCompletion(): Promise<void>;
};

export type JourneyContext = {
  page: Page;
  request: APIRequestContext;
  testInfo: TestInfo;
  identity: E2ERunIdentity;
  email: string;
  scenario: typeof fullAssessmentScenario;
  profiler: TransitionProfiler;
  step: StageStep;
  questionnaireMutations: QuestionnaireMutation[];
  generatedAdaptiveAnswers: Map<string, unknown>;
  adaptivePrepareTracker: AdaptivePrepareTrackerContract;
  uploadedAssessmentDocument: UploadedAssessmentDocument | null;
};
