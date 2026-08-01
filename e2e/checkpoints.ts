import { expect, type APIResponse } from "@playwright/test";
import { randomUUID } from "node:crypto";

import {
  ADAPTIVE_ANSWERS_BY_ID,
  BACKEND_DOCUMENT_SCAN_RESULT_URL,
  browserMutationHeaders,
  documentIdFromUploadResponse,
  EXPECTED_SCREENING_GOAL_QUESTION_IDS,
  expectNoTokenLeak,
  getRegistrationVerificationCode,
  isRecord,
  normalizeAssessmentDocument,
  recordQuestionnaireMutation,
  SCREENING_ANSWERS_BY_ID,
  SCREENING_TEXT_ANSWERS_BY_ID,
  SYNTHETIC_ASSESSMENT_UPLOAD,
  TEST_SUPPORT_TOKEN,
  type AssessmentDocumentRecord,
  type JourneyContext,
} from "./journey/context";
import { fullAssessmentScenario } from "./fixtures/fullAssessmentScenario";
import { assertExactIntakeRequestContract } from "../src/lib/e2e/intake-request-contract";
import type { JourneyCheckpoint } from "./fullAssessmentJourney";
import {
  expectAuthenticatedCookieSession,
  expectConsentScreenAfterVerification,
  warmCsrfSession,
} from "./stages/accountVerification";
import { recordsStepLocator } from "./stages/recordsDocuments";

export const PATIENT_WEB_CHECKPOINTS = [
  "fresh",
  "verified_pending_consent",
  "onboarding_ready",
  "records_ready",
  "screening_ready",
  "adaptive_ready",
  "review_ready",
  "results_ready",
] as const satisfies readonly JourneyCheckpoint[];

export type PatientWebCheckpoint = (typeof PATIENT_WEB_CHECKPOINTS)[number];

export type BuiltPatientWebCheckpoint = Readonly<{
  state: PatientWebCheckpoint;
  context: JourneyContext;
}>;

export type CheckpointPreparationMode = "api" | "unsupported";

/**
 * Every named checkpoint is explicit. `results_ready` remains present in the
 * manifest for documentation, but cannot be created by a checkpoint: a
 * results response is server-authored analysis output and must never be
 * fabricated in a browser test.
 */
export const CHECKPOINT_PREPARATION_MODE: Readonly<
  Record<PatientWebCheckpoint, CheckpointPreparationMode>
> = {
  fresh: "api",
  verified_pending_consent: "api",
  onboarding_ready: "api",
  records_ready: "api",
  screening_ready: "api",
  adaptive_ready: "api",
  review_ready: "api",
  results_ready: "unsupported",
};

type JsonRecord = Record<string, unknown>;

type AssessmentState = Readonly<{
  id: string;
  revision: number;
  status: string;
}>;

type AdaptiveQuestion = Readonly<{
  id: string;
  type: string;
  options: readonly JsonRecord[];
  min?: number;
  max?: number;
}>;

const REQUIRED_ONBOARDING_CONSENTS = [
  { consent_type: "hipaa_privacy", consent_version: "2.0" },
  { consent_type: "terms_of_service", consent_version: "2.0" },
  { consent_type: "ai_analysis", consent_version: "2.0" },
] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function checkpointFailure(state: PatientWebCheckpoint, reason: string): Error {
  return new Error(
    `Checkpoint ${state} failed closed: ${reason}. UI replay is not an allowed fallback.`,
  );
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value as number;
}

function requireUuid(value: unknown, label: string): string {
  const id = requireString(value, label);
  if (!UUID_RE.test(id)) throw new Error(`${label} must be a UUID`);
  return id;
}

async function bffJson<T>(
  context: JourneyContext,
  method: "GET" | "POST" | "PATCH" | "PUT",
  path: string,
  data?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<T> {
  const headers =
    method === "GET"
      ? {
          origin: new URL(
            process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101",
          ).origin,
        }
      : await browserMutationHeaders(context.page);
  const response = await context.page.request.fetch(path, {
    method,
    headers: { ...headers, ...extraHeaders },
    ...(data === undefined ? {} : { data }),
    timeout: 120_000,
  });
  if (!response.ok()) {
    throw new Error(
      `BFF checkpoint API ${method} ${path} failed status=${response.status()}`,
    );
  }
  if (response.status() === 204) return undefined as T;
  return (await response.json()) as T;
}

async function bffResponse(
  context: JourneyContext,
  method: "POST" | "PATCH" | "PUT",
  path: string,
  data: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<APIResponse> {
  const headers = await browserMutationHeaders(context.page);
  const response = await context.page.request.fetch(path, {
    method,
    headers: { ...headers, ...extraHeaders },
    data,
    timeout: 120_000,
  });
  if (!response.ok()) {
    throw new Error(
      `BFF checkpoint API ${method} ${path} failed status=${response.status()}`,
    );
  }
  return response;
}

async function prepareAccount(context: JourneyContext): Promise<void> {
  await warmCsrfSession(context.page);
  const registrationResponse = await bffResponse(
    context,
    "POST",
    "/api/auth/register",
    {
      email: context.email,
      password: fullAssessmentScenario.registration.password,
      first_name: fullAssessmentScenario.registration.firstName,
      last_name: fullAssessmentScenario.registration.lastName,
    },
  );
  await expectNoTokenLeak(registrationResponse);
  const registration = requireRecord(
    await registrationResponse.json(),
    "registration response",
  );
  expect(registration.registration_verification_pending).toBe(true);

  const code = await getRegistrationVerificationCode(
    context.page.request,
    context.email,
  );
  const verificationResponse = await bffResponse(
    context,
    "POST",
    "/api/auth/verify/registration/confirm",
    { code },
  );
  await expectNoTokenLeak(verificationResponse);
  await expectAuthenticatedCookieSession(context.page);

  const session = requireRecord(
    await bffJson<unknown>(context, "GET", "/api/auth/session"),
    "authenticated session response",
  );
  expect(session.verification_status ?? session.verificationStatus).toBe(
    "verified",
  );
  expect(
    session.has_completed_onboarding ?? session.hasCompletedOnboarding,
  ).toBe(false);
}

async function prepareConsents(context: JourneyContext): Promise<void> {
  for (const consent of REQUIRED_ONBOARDING_CONSENTS) {
    await bffJson(
      context,
      "POST",
      "/api/proxy/api/v1/patients/me/consents",
      consent,
    );
  }

  const response = requireRecord(
    await bffJson<unknown>(
      context,
      "GET",
      "/api/proxy/api/v1/patients/me/consents",
    ),
    "consent list response",
  );
  const items = response.items;
  if (!Array.isArray(items)) throw new Error("consent list must contain items");
  for (const consent of REQUIRED_ONBOARDING_CONSENTS) {
    expect(
      items.some(
        (item) =>
          isRecord(item) &&
          (item.consent_type ?? item.consentType) === consent.consent_type &&
          (item.consent_version ?? item.consentVersion) ===
            consent.consent_version &&
          (item.revoked_at ?? item.revokedAt) == null,
      ),
      `active ${consent.consent_type} consent must be server-owned and current`,
    ).toBe(true);
  }
}

function intakeStepPayloads(): Readonly<Record<string, JsonRecord>> {
  const onboarding = fullAssessmentScenario.onboarding;
  return {
    profile: {
      step_data: {
        date_of_birth: "1988-04-22",
        sex_at_birth: onboarding.sexAtBirth,
        height_ft: onboarding.heightFeet,
        height_in: onboarding.heightInches,
        weight: onboarding.weightPounds,
        occupation: onboarding.occupation,
        activity_level: onboarding.activityLevel,
      },
    },
    "chief-complaint": {
      step_data: {
        narrative: onboarding.chiefComplaint,
        input_method: "text",
      },
    },
    "treatment-history": {
      step_data: onboarding.intakeWireStepData["treatment-history"],
    },
  };
}

async function prepareAccountAndConsents(
  context: JourneyContext,
): Promise<void> {
  await prepareAccount(context);
  await prepareConsents(context);
}

async function prepareOnboarding(context: JourneyContext): Promise<void> {
  await prepareAccountAndConsents(context);
  for (const [step, payload] of Object.entries(intakeStepPayloads())) {
    assertExactIntakeRequestContract(
      `/api/proxy/api/v1/patients/me/intake/steps/${step}`,
      payload,
      fullAssessmentScenario,
    );
    await bffJson(
      context,
      "PUT",
      `/api/proxy/api/v1/patients/me/intake/steps/${step}`,
      payload,
    );
    recordQuestionnaireMutation(
      context,
      `/api/proxy/api/v1/patients/me/intake/steps/${step}`,
      payload,
    );
  }
}

async function completeIntake(context: JourneyContext): Promise<void> {
  const payload = {};
  await bffJson(
    context,
    "POST",
    "/api/proxy/api/v1/patients/me/intake/progress/complete",
    payload,
  );
  recordQuestionnaireMutation(
    context,
    "/api/proxy/api/v1/patients/me/intake/progress/complete",
    payload,
  );
  const progress = requireRecord(
    await bffJson<unknown>(
      context,
      "GET",
      "/api/proxy/api/v1/patients/me/intake/steps",
    ),
    "completed intake response",
  );
  expect(progress.is_complete ?? progress.isComplete).toBe(true);
  expect(progress.completed_steps ?? progress.completedSteps).toEqual(
    expect.arrayContaining(["profile", "chief-complaint", "treatment-history"]),
  );
}

async function createAssessment(
  context: JourneyContext,
): Promise<AssessmentState> {
  const response = requireRecord(
    await bffJson<unknown>(
      context,
      "POST",
      "/api/proxy/api/v1/patients/me/assessments/",
      {},
    ),
    "assessment creation response",
  );
  const assessment = {
    id: requireUuid(response.id, "assessment id"),
    revision: requireRevision(response.revision, "assessment revision"),
    status: requireString(response.status, "assessment status"),
  } as const;
  expect(assessment.status).toBe("draft");
  return assessment;
}

async function submitStory(
  context: JourneyContext,
  assessment: AssessmentState,
): Promise<AssessmentState> {
  const payload = {
    expected_revision: assessment.revision,
    narrative: fullAssessmentScenario.assessmentStory,
    input_method: "text",
  } as const;
  const response = requireRecord(
    await bffJson<unknown>(
      context,
      "POST",
      `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/story`,
      payload,
    ),
    "assessment story response",
  );
  const next = {
    id: assessment.id,
    revision: requireRevision(response.revision, "story response revision"),
    status: requireString(response.status, "story response status"),
  } as const;
  expect(next.revision).toBeGreaterThan(assessment.revision);
  expect(next.status).toBe("screening_in_progress");
  return next;
}

async function completeSyntheticDocumentScan(
  context: JourneyContext,
  documentId: string,
): Promise<void> {
  if (!BACKEND_DOCUMENT_SCAN_RESULT_URL || !TEST_SUPPORT_TOKEN) {
    throw new Error(
      "Checkpoint records_ready requires the existing exact synthetic document-scan support route; refusing to assume a clean scan",
    );
  }
  const response = await context.request.post(
    BACKEND_DOCUMENT_SCAN_RESULT_URL,
    {
      headers: {
        authorization: `Bearer ${TEST_SUPPORT_TOKEN}`,
        "content-type": "application/json",
      },
      data: {
        document_id: documentId,
        email: context.email,
        verdict: "clean",
      },
      timeout: 90_000,
    },
  );
  if (!response.ok()) {
    throw new Error(
      `Checkpoint document scan support failed status=${response.status()}`,
    );
  }
  const payload = requireRecord(
    await response.json(),
    "document scan response",
  );
  expect(payload.processing_status ?? payload.processingStatus).toBe(
    "complete",
  );
  expect(payload.scan_status ?? payload.scanStatus).toBe("clean");
}

async function prepareDocument(
  context: JourneyContext,
  assessmentId: string,
): Promise<void> {
  const idempotencyKey = randomUUID();
  const uploadResponse = requireRecord(
    await bffJson<unknown>(
      context,
      "POST",
      `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/documents/upload-url`,
      {
        file_name: SYNTHETIC_ASSESSMENT_UPLOAD.name,
        content_type: SYNTHETIC_ASSESSMENT_UPLOAD.mimeType,
        file_size_bytes: SYNTHETIC_ASSESSMENT_UPLOAD.buffer.length,
      },
      { "x-idempotency-key": idempotencyKey },
    ),
    "assessment document upload-url response",
  );
  const documentId = documentIdFromUploadResponse(uploadResponse);
  const uploadUrl = requireString(
    uploadResponse.upload_url ?? uploadResponse.uploadUrl,
    "assessment document upload URL",
  );
  const policy = isRecord(uploadResponse.policy)
    ? uploadResponse.policy
    : undefined;
  const uploadHeaders: Record<string, string> = {
    "content-type": SYNTHETIC_ASSESSMENT_UPLOAD.mimeType,
  };
  if (policy != null && isRecord(policy.required_headers)) {
    for (const [key, value] of Object.entries(policy.required_headers)) {
      if (typeof value !== "string") {
        throw new Error(`document upload policy header ${key} is not a string`);
      }
      uploadHeaders[key] = value;
    }
  }
  const upload = await context.page.request.put(uploadUrl, {
    headers: uploadHeaders,
    data: SYNTHETIC_ASSESSMENT_UPLOAD.buffer,
    timeout: 120_000,
  });
  if (!upload.ok()) {
    throw new Error(
      `synthetic assessment upload failed status=${upload.status()}`,
    );
  }

  const confirmPath = `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/documents/${documentId}/confirm`;
  const confirmed = requireRecord(
    await bffJson<unknown>(
      context,
      "POST",
      confirmPath,
      {},
      {
        "x-idempotency-key": randomUUID(),
      },
    ),
    "assessment document confirmation response",
  );
  const processingStatus =
    confirmed.processing_status ?? confirmed.processingStatus;
  expect(["processing", "complete"]).toContain(processingStatus);
  if (processingStatus === "processing") {
    await completeSyntheticDocumentScan(context, documentId);
  }

  const listed = requireRecord(
    await bffJson<unknown>(
      context,
      "GET",
      `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/documents`,
    ),
    "assessment documents response",
  );
  const item = Array.isArray(listed.items)
    ? listed.items
        .map((entry) =>
          isRecord(entry)
            ? normalizeAssessmentDocument(entry as AssessmentDocumentRecord)
            : null,
        )
        .find((entry) => entry?.id === documentId)
    : undefined;
  expect(item, "synthetic document must be server-owned and listed").toEqual(
    expect.objectContaining({
      id: documentId,
      state: "complete",
      label: "Uploaded document",
      fileSizeBytes: SYNTHETIC_ASSESSMENT_UPLOAD.buffer.length,
    }),
  );
}

async function prepareRecords(
  context: JourneyContext,
): Promise<AssessmentState> {
  await prepareOnboarding(context);
  await completeIntake(context);
  let assessment = await createAssessment(context);
  assessment = await submitStory(context, assessment);
  await prepareDocument(context, assessment.id);
  return assessment;
}

function screeningAnswer(questionId: string): unknown {
  const answer = SCREENING_ANSWERS_BY_ID.get(questionId);
  if (answer != null) return answer.value;
  const text = SCREENING_TEXT_ANSWERS_BY_ID.get(questionId);
  if (text != null) return text.text;
  throw new Error(
    `No exact synthetic screening answer exists for server-issued question ${questionId}`,
  );
}

function questionId(value: unknown): string {
  const record = requireRecord(value, "server-issued question");
  return requireString(
    record.id ?? record.question_id ?? record.questionId,
    "question id",
  );
}

function screeningState(value: unknown, label: string): JsonRecord {
  const state = requireRecord(value, label);
  requireRevision(state.revision, `${label} revision`);
  expect(state.interruptive_route ?? state.interruptiveRoute).toBe("none");
  if (!Array.isArray(state.visible_questions ?? state.visibleQuestions)) {
    throw new Error(`${label} must contain server-issued visible questions`);
  }
  return state;
}

async function prepareScreening(
  context: JourneyContext,
  assessment: AssessmentState,
): Promise<AssessmentState> {
  let revision = assessment.revision;
  const seen = new Set<string>();
  for (let index = 0; index < 80; index += 1) {
    const state = screeningState(
      await bffJson<unknown>(
        context,
        "GET",
        `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/screening/state`,
      ),
      "screening state response",
    );
    const visible = (state.visible_questions ??
      state.visibleQuestions) as unknown[];
    const current = visible[0];
    if (current == null) break;
    const id = questionId(current);
    if (seen.has(id)) {
      throw new Error(`Screening checkpoint repeated server question ${id}`);
    }
    seen.add(id);
    const payload = {
      answers: { [id]: screeningAnswer(id) },
      expected_revision: revision,
    } as const;
    const path = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/screening/answers`;
    const next = screeningState(
      await bffJson<unknown>(context, "PATCH", path, payload),
      `screening answer ${id} response`,
    );
    recordQuestionnaireMutation(context, path, payload);
    revision = requireRevision(
      next.revision,
      `screening answer ${id} revision`,
    );
  }

  expect(
    [...EXPECTED_SCREENING_GOAL_QUESTION_IDS].every((id) => seen.has(id)),
    "screening checkpoint must reach every server-owned screening goal",
  ).toBe(true);
  const completePayload = { expected_revision: revision } as const;
  const completePath = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/screening/complete`;
  const completed = requireRecord(
    await bffJson<unknown>(context, "POST", completePath, completePayload),
    "screening completion response",
  );
  recordQuestionnaireMutation(context, completePath, completePayload);
  return {
    id: assessment.id,
    revision: requireRevision(
      completed.revision,
      "screening completion revision",
    ),
    status: requireString(completed.status, "screening completion status"),
  };
}

function adaptiveQuestion(value: unknown): AdaptiveQuestion {
  const record = requireRecord(value, "adaptive question");
  const options = record.options;
  if (options !== undefined && !Array.isArray(options)) {
    throw new Error("server-issued adaptive options must be an array");
  }
  return {
    id: questionId(record),
    type: requireString(record.type, "adaptive question type"),
    options: (options ?? []).map((option) =>
      requireRecord(option, "adaptive option"),
    ),
    ...(typeof record.min === "number" ? { min: record.min } : {}),
    ...(typeof record.max === "number" ? { max: record.max } : {}),
  };
}

function adaptiveAnswer(question: AdaptiveQuestion): unknown {
  if (question.id === "INF_STIFF_SPINE") {
    return ADAPTIVE_ANSWERS_BY_ID.get(question.id)?.value;
  }
  throw new Error(
    `No exact synthetic adaptive answer exists for server-issued question ${question.id}; refusing to invent a clinical value`,
  );
}

async function prepareAdaptive(
  context: JourneyContext,
  assessment: AssessmentState,
): Promise<AssessmentState> {
  const preparePath = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/adaptive/prepare`;
  const prepared = requireRecord(
    await bffJson<unknown>(context, "POST", preparePath, {
      expected_revision: assessment.revision,
    }),
    "adaptive preparation response",
  );
  const questions = prepared.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(
      "Adaptive checkpoint requires non-empty server-issued questions",
    );
  }
  let revision = requireRevision(
    prepared.revision,
    "adaptive preparation revision",
  );
  const answers: JsonRecord = {};
  for (const rawQuestion of questions) {
    const question = adaptiveQuestion(rawQuestion);
    if (question.id.startsWith("G")) {
      throw new Error(
        `Adaptive checkpoint received screening goal ${question.id}; refusing cross-phase clinical submission`,
      );
    }
    const value = adaptiveAnswer(question);
    answers[question.id] = value;
    const payload = {
      answers: { [question.id]: value },
      expected_revision: revision,
    };
    const answerPath = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/adaptive/answers`;
    const saved = requireRecord(
      await bffJson<unknown>(context, "PATCH", answerPath, payload),
      `adaptive answer ${question.id} response`,
    );
    recordQuestionnaireMutation(context, answerPath, payload);
    revision = requireRevision(
      saved.revision,
      `adaptive answer ${question.id} revision`,
    );
  }
  const completePayload = { answers, expected_revision: revision } as const;
  const completePath = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/adaptive/complete-with-answers`;
  const completed = requireRecord(
    await bffJson<unknown>(context, "POST", completePath, completePayload),
    "adaptive completion response",
  );
  recordQuestionnaireMutation(context, completePath, completePayload);
  const status = requireString(completed.status, "adaptive completion status");
  expect(["adaptive_complete", "analysis_pending"]).toContain(status);
  return {
    id: assessment.id,
    revision: requireRevision(
      completed.revision,
      "adaptive completion revision",
    ),
    status,
  };
}

async function navigateToCheckpoint(
  context: JourneyContext,
  state: PatientWebCheckpoint,
): Promise<void> {
  if (state === "fresh") return;
  const path =
    state === "verified_pending_consent"
      ? "/welcome"
      : state === "onboarding_ready"
        ? "/onboarding/profile"
        : state === "records_ready"
          ? "/onboarding/imaging-records"
          : "/assessment";
  const response = await context.page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  if (response == null || !response.ok()) {
    throw checkpointFailure(
      state,
      `checkpoint navigation ${path} returned status=${response?.status() ?? "none"}`,
    );
  }
  await expectPatientWebCheckpointReady(context, state);
}

/** Assert the server-backed UI state at a scope's declared boundary. */
export async function expectPatientWebCheckpointReady(
  context: JourneyContext,
  state: PatientWebCheckpoint,
): Promise<void> {
  if (state === "fresh") {
    return;
  }
  if (state === "verified_pending_consent") {
    await expectConsentScreenAfterVerification(context.page);
  } else if (state === "onboarding_ready") {
    await expect(context.page.getByTestId("onboarding-layout")).toBeVisible({
      timeout: 60_000,
    });
    await expect(context.page.getByTestId("step-profile")).toBeVisible({
      timeout: 60_000,
    });
  } else if (state === "records_ready") {
    await expect(recordsStepLocator(context.page)).toBeVisible({
      timeout: 60_000,
    });
  } else if (state === "screening_ready") {
    await expect(context.page.getByTestId("screening-screen")).toBeVisible({
      timeout: 120_000,
    });
  } else if (state === "adaptive_ready") {
    await expect(
      context.page
        .getByTestId("adaptive-loading-state")
        .or(context.page.getByTestId("adaptive-screen")),
    ).toBeVisible({ timeout: 120_000 });
  } else if (state === "review_ready") {
    await expect(context.page.getByTestId("review-screen")).toBeVisible({
      timeout: 120_000,
    });
  } else {
    await expect(context.page.getByTestId("results-screen")).toBeVisible({
      timeout: 480_000,
    });
  }
}

async function prepareNamedCheckpoint(
  context: JourneyContext,
  state: PatientWebCheckpoint,
): Promise<void> {
  switch (state) {
    case "fresh":
      return;
    case "verified_pending_consent":
      await prepareAccount(context);
      return navigateToCheckpoint(context, state);
    case "onboarding_ready":
      await prepareAccountAndConsents(context);
      return navigateToCheckpoint(context, state);
    case "records_ready":
      await prepareOnboarding(context);
      return navigateToCheckpoint(context, state);
    case "screening_ready": {
      await prepareRecords(context);
      return navigateToCheckpoint(context, state);
    }
    case "adaptive_ready": {
      const assessment = await prepareRecords(context);
      await prepareScreening(context, assessment);
      return navigateToCheckpoint(context, state);
    }
    case "review_ready": {
      let assessment = await prepareRecords(context);
      assessment = await prepareScreening(context, assessment);
      await prepareAdaptive(context, assessment);
      return navigateToCheckpoint(context, state);
    }
    case "results_ready":
      throw checkpointFailure(
        state,
        "normal product APIs do not provide a safe server-authored analysis/results checkpoint",
      );
  }
}

/** Prepare a named state through same-origin BFF/product APIs only. */
export async function buildPatientWebCheckpoint(
  context: JourneyContext,
  state: PatientWebCheckpoint,
): Promise<BuiltPatientWebCheckpoint> {
  if (CHECKPOINT_PREPARATION_MODE[state] === "unsupported") {
    throw checkpointFailure(
      state,
      "the state would require fabricated server-owned clinical output",
    );
  }
  try {
    await prepareNamedCheckpoint(context, state);
  } catch (error) {
    if (error instanceof Error && error.message.includes("failed closed:")) {
      throw error;
    }
    throw checkpointFailure(
      state,
      error instanceof Error ? error.message : "normal API preparation failed",
    );
  }
  return { state, context };
}
