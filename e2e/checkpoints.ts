import { createHash } from "node:crypto";

import { expect, type APIResponse } from "@playwright/test";

import {
  ADAPTIVE_ANSWERS_BY_ID,
  BACKEND_REGISTRATION_CODE_URL,
  assessmentDocumentConfirmationFromResponse,
  browserMutationHeaders,
  documentIdFromUploadResponse,
  EXPECTED_SCREENING_GOAL_QUESTION_IDS,
  expectNoTokenLeak,
  getRegistrationVerificationCode,
  isRecord,
  recordQuestionnaireMutation,
  SCREENING_ANSWERS_BY_ID,
  SCREENING_TEXT_ANSWERS_BY_ID,
  SYNTHETIC_ASSESSMENT_UPLOAD,
  TEST_SUPPORT_TOKEN,
  prepareResultsReportFixture,
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
import {
  completeSyntheticDocumentScan,
  verifySyntheticDocumentUploadPersistence,
  waitForAssessmentDocumentComplete,
} from "./stages/recordsUpload";
import { waitForAnyVisibleTestId } from "./journey/selectors";

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
  transitions: readonly CheckpointTransitionTiming[];
}>;

export type CheckpointPreparationMode = "api" | "named_fixture";

export type CheckpointTransitionTiming = Readonly<{
  from: PatientWebCheckpoint;
  to: PatientWebCheckpoint;
  durationMs: number;
}>;

type CheckpointContract = Readonly<{
  version: 1;
  invariants: readonly string[];
  nextAction: string;
  cleanupOwnership: string;
  fixture?: "results-report-v1";
}>;

const RUN_CLEANUP =
  "PATIENT_WEB_E2E_RUN_ID owns the disposable local stack; checkpoint scopes use deterministic child run_id identities, and deployed exact-run cleanup must enumerate those children before retained data can be deleted";

/** Versioned, PHI-safe boundary descriptions; clinical values remain server-owned. */
export const CHECKPOINT_CONTRACTS: Readonly<
  Record<PatientWebCheckpoint, CheckpointContract>
> = {
  fresh: {
    version: 1,
    invariants: ["no run-owned account exists"],
    nextAction: "register",
    cleanupOwnership: RUN_CLEANUP,
  },
  verified_pending_consent: {
    version: 1,
    invariants: ["verified cookie session", "onboarding incomplete"],
    nextAction: "accept required consents",
    cleanupOwnership: RUN_CLEANUP,
  },
  onboarding_ready: {
    version: 1,
    invariants: [
      "required consents active",
      "current informational acknowledgement active",
      "onboarding incomplete",
    ],
    nextAction: "submit intake steps",
    cleanupOwnership: RUN_CLEANUP,
  },
  records_ready: {
    version: 1,
    invariants: ["required intake steps server-owned", "intake not complete"],
    nextAction: "complete intake and add records",
    cleanupOwnership: RUN_CLEANUP,
  },
  screening_ready: {
    version: 1,
    invariants: ["draft assessment owns story and clean synthetic document"],
    nextAction: "answer server-issued screening questions",
    cleanupOwnership: RUN_CLEANUP,
  },
  adaptive_ready: {
    version: 1,
    invariants: ["screening complete", "interruptive route is none"],
    nextAction: "answer server-issued adaptive questions",
    cleanupOwnership: RUN_CLEANUP,
  },
  review_ready: {
    version: 1,
    invariants: [
      "adaptive answers complete",
      "analysis has not been replaced by a fixture",
    ],
    nextAction: "run real analysis or install named rendering fixture",
    cleanupOwnership: RUN_CLEANUP,
  },
  results_ready: {
    version: 1,
    invariants: ["named server-owned fixture installed", "assessment complete"],
    nextAction: "render results and generate report",
    cleanupOwnership: RUN_CLEANUP,
    fixture: "results-report-v1",
  },
};

/**
 * Product state uses normal APIs. The sole exception is `results_ready`, which
 * uses the strict, named, server-owned rendering fixture.
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
  results_ready: "named_fixture",
};

type InternalCheckpointState =
  | PatientWebCheckpoint
  | "informational_acknowledgement_pending";

type CheckpointBuildState = {
  state: InternalCheckpointState;
  assessment?: AssessmentState;
  intakeComplete?: boolean;
  resumedScreening?: boolean;
};

export function planCheckpointTransitions(
  current: PatientWebCheckpoint,
  target: PatientWebCheckpoint,
): readonly Readonly<{
  from: PatientWebCheckpoint;
  to: PatientWebCheckpoint;
}>[] {
  const currentIndex = PATIENT_WEB_CHECKPOINTS.indexOf(current);
  const targetIndex = PATIENT_WEB_CHECKPOINTS.indexOf(target);
  if (targetIndex < currentIndex) {
    throw checkpointFailure(
      target,
      `builder cannot move backward from ${current}`,
    );
  }
  const transitions: Array<{
    from: PatientWebCheckpoint;
    to: PatientWebCheckpoint;
  }> = [];
  let from = current;
  for (const to of PATIENT_WEB_CHECKPOINTS.slice(
    currentIndex + 1,
    targetIndex + 1,
  )) {
    transitions.push({ from, to });
    from = to;
  }
  return transitions;
}

export function checkpointForAssessmentStatus(
  status: string,
  hasReadyDocument: boolean,
): PatientWebCheckpoint {
  switch (status) {
    case "draft":
      return hasReadyDocument ? "screening_ready" : "records_ready";
    case "screening_in_progress":
      return hasReadyDocument ? "screening_ready" : "records_ready";
    case "screening_complete":
    case "adaptive_pending":
    case "adaptive_in_progress":
      return "adaptive_ready";
    case "adaptive_complete":
    case "analysis_pending":
      return "review_ready";
    case "complete":
      return "results_ready";
    case "abandoned":
      throw new Error(
        "Checkpoint reconciliation rejected abandoned assessment",
      );
    default:
      throw new Error(
        `Checkpoint reconciliation rejected unsupported assessment status ${status}`,
      );
  }
}

type JsonRecord = Record<string, unknown>;

type AssessmentState = Readonly<{
  id: string;
  revision: number;
  status: string;
  storyNarrative?: string | null;
  storyInputMethod?: string | null;
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
const INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT = {
  consent_type: "informational_only",
  consent_version: "1.0",
} as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function checkpointFailure(state: PatientWebCheckpoint, reason: string): Error {
  return new Error(
    `Checkpoint ${state} failed closed: ${reason}. UI replay is not an allowed fallback.`,
  );
}

class BffCheckpointApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly serverCode?: string,
  ) {
    super(message);
    this.name = "BffCheckpointApiError";
  }
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

function parseAssessmentState(
  value: JsonRecord,
  label: string,
): AssessmentState {
  const storyNarrative = Object.prototype.hasOwnProperty.call(
    value,
    "story_narrative",
  )
    ? value.story_narrative
    : value.storyNarrative;
  const storyInputMethod = Object.prototype.hasOwnProperty.call(
    value,
    "story_input_method",
  )
    ? value.story_input_method
    : value.storyInputMethod;
  if (
    storyNarrative !== undefined &&
    storyNarrative !== null &&
    typeof storyNarrative !== "string"
  ) {
    throw new Error(`${label} story narrative must be a string or null`);
  }
  if (
    storyInputMethod !== undefined &&
    storyInputMethod !== null &&
    typeof storyInputMethod !== "string"
  ) {
    throw new Error(`${label} story input method must be a string or null`);
  }
  return {
    id: requireUuid(value.id, `${label} id`),
    revision: requireRevision(value.revision, `${label} revision`),
    status: requireString(value.status, `${label} status`),
    ...(storyNarrative === undefined
      ? {}
      : { storyNarrative: storyNarrative as string | null }),
    ...(storyInputMethod === undefined
      ? {}
      : { storyInputMethod: storyInputMethod as string | null }),
  };
}

export async function waitForScreeningReadyUi(
  page: JourneyContext["page"],
): Promise<void> {
  const ready = page.getByTestId("screening-list");
  const retry = page.getByTestId("screening-retry");
  await ready.or(retry).waitFor({ state: "visible", timeout: 120_000 });
  if (await ready.isVisible()) return;
  if (!(await retry.isVisible())) {
    throw new Error("screening checkpoint did not render a recognized state");
  }
  await retry.click();
  try {
    await ready.waitFor({ state: "visible", timeout: 120_000 });
  } catch {
    throw new Error(
      "screening checkpoint remained in retry state without a ready question list",
    );
  }
}

function assertImportedIntakeStory(
  assessment: AssessmentState,
  label: string,
): void {
  if (
    assessment.storyNarrative?.trim() !==
      fullAssessmentScenario.onboarding.chiefComplaint ||
    assessment.storyInputMethod !== "text"
  ) {
    throw new Error(
      `${label} must own the exact server-imported reviewed intake story`,
    );
  }
}

function selectAssessmentListState(
  value: JsonRecord,
  label: string,
): Readonly<{
  active: AssessmentState | null;
  latestCompleted: AssessmentState | null;
}> {
  if (!Array.isArray(value.items)) {
    throw new Error(`${label} items must be an array`);
  }
  const assessments = value.items.map((item, index) => {
    const row = requireRecord(item, `${label} item ${index}`);
    return parseAssessmentState(row, `${label} item ${index}`);
  });
  const active = assessments.filter(
    ({ status }) => status !== "complete" && status !== "abandoned",
  );
  if (active.length > 1) {
    throw new Error(`${label} returned multiple nonterminal assessments`);
  }
  // The backend assessment repository orders this list by created_at DESC.
  // Preserve that authoritative ordering only when no active row exists.
  const latestCompleted = assessments.find(
    ({ status }) => status === "complete",
  );
  return {
    active: active[0] ?? null,
    latestCompleted: latestCompleted ?? null,
  };
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
    let serverCode: string | undefined;
    try {
      const errorBody: unknown = await response.json();
      serverCode = checkpointServerErrorCode(errorBody);
    } catch {
      // Status and route remain sufficient when an error body is unavailable.
    }
    throw new BffCheckpointApiError(
      `BFF checkpoint API ${method} ${path} failed status=${response.status()}${serverCode == null ? "" : ` code=${serverCode}`}`,
      response.status(),
      serverCode,
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

export async function tryBffJson(
  context: JourneyContext,
  path: string,
  expectedAbsenceStatuses: readonly number[] = [],
): Promise<JsonRecord | null> {
  const response = await context.page.request.get(path, {
    headers: {
      origin: new URL(
        process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101",
      ).origin,
    },
    timeout: 120_000,
  });
  if (!response.ok()) {
    if (expectedAbsenceStatuses.includes(response.status())) return null;
    throw new Error(
      `BFF checkpoint probe GET ${path} failed status=${response.status()}`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`BFF checkpoint probe GET ${path} returned malformed JSON`);
  }
  if (!isRecord(value)) {
    throw new Error(`BFF checkpoint probe GET ${path} must return an object`);
  }
  return value;
}

const PHI_SAFE_CHECKPOINT_ERROR_CODES = new Set([
  "documents_not_ready",
  "idempotency_key_payload_mismatch",
  "idempotency_outcome_unknown",
  "idempotency_result_unavailable",
  "patient_profile_incomplete",
  "revision_conflict",
  "screening_incomplete",
  "screening_phase_over",
  "story_generation_conflict",
  "story_not_ready",
]);

function checkpointServerErrorCode(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value.code;
  const nested = isRecord(value.error) ? value.error.code : undefined;
  const code = typeof direct === "string" ? direct : nested;
  return typeof code === "string" && PHI_SAFE_CHECKPOINT_ERROR_CODES.has(code)
    ? code
    : undefined;
}

async function readLatestIntakeProgress(
  context: JourneyContext,
): Promise<JsonRecord | null> {
  const path = "/api/proxy/api/v1/patients/me/intake/progress/latest";
  const response = await context.page.request.get(path, {
    headers: {
      origin: new URL(
        process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101",
      ).origin,
    },
    timeout: 120_000,
  });
  if (response.status() === 403) {
    const profile = await tryBffJson(context, "/api/proxy/api/v1/patients/me/");
    const hasSnakeCaseDob = Object.prototype.hasOwnProperty.call(
      profile,
      "date_of_birth",
    );
    const dateOfBirth = profile?.date_of_birth;
    if (hasSnakeCaseDob && dateOfBirth === null) return null;
    if (
      hasSnakeCaseDob &&
      typeof dateOfBirth === "string" &&
      dateOfBirth.length > 0
    ) {
      throw new Error(
        `BFF checkpoint probe GET ${path} failed status=403 with a persisted DOB`,
      );
    }
    throw new Error(
      `BFF checkpoint probe GET ${path} failed status=403 and profile date_of_birth was not explicitly null`,
    );
  }
  if (!response.ok()) {
    throw new Error(
      `BFF checkpoint probe GET ${path} failed status=${response.status()}`,
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`BFF checkpoint probe GET ${path} returned malformed JSON`);
  }
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error(
      `BFF checkpoint probe GET ${path} must return an object or null`,
    );
  }
  return value;
}

function activeConsentState(value: JsonRecord): Readonly<{
  requiredActive: boolean;
  informationalV1Active: boolean;
}> {
  const items = value.items;
  if (!Array.isArray(items)) {
    return { requiredActive: false, informationalV1Active: false };
  }
  const hasConsent = (expected: {
    consent_type: string;
    consent_version: string;
  }) =>
    items.some(
      (item) =>
        isRecord(item) &&
        (item.consent_type ?? item.consentType) === expected.consent_type &&
        (item.consent_version ?? item.consentVersion) ===
          expected.consent_version,
    );
  return {
    requiredActive: REQUIRED_ONBOARDING_CONSENTS.every(hasConsent),
    informationalV1Active: hasConsent(INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT),
  };
}

export async function reconcileAuthoritativeCheckpoint(
  context: JourneyContext,
  verificationCodeLookup: (
    request: JourneyContext["page"]["request"],
    email: string,
  ) => Promise<string | null> = tryRegistrationVerificationCode,
): Promise<CheckpointBuildState> {
  let session = await tryBffJson(context, "/api/auth/session", [401]);
  if (session == null) {
    const code = await verificationCodeLookup(
      context.page.request,
      context.email,
    );
    if (code == null) return { state: "fresh" };
    await warmCsrfSession(context.page);
    await bffResponse(
      context,
      "POST",
      "/api/auth/verify/registration/confirm",
      { code },
    );
    session = await tryBffJson(context, "/api/auth/session", [401]);
  }
  if (
    session == null ||
    (session.verification_status ?? session.verificationStatus) !== "verified"
  ) {
    return { state: "fresh" };
  }

  const consents = await tryBffJson(
    context,
    "/api/proxy/api/v1/patients/me/consents/active",
  );
  const consentState =
    consents == null
      ? { requiredActive: false, informationalV1Active: false }
      : activeConsentState(consents);
  if (!consentState.requiredActive) {
    return { state: "verified_pending_consent" };
  }
  if (!consentState.informationalV1Active) {
    return { state: "informational_acknowledgement_pending" };
  }

  const intake = await readLatestIntakeProgress(context);
  const completedSteps = intake?.completed_steps ?? intake?.completedSteps;
  if (
    !Array.isArray(completedSteps) ||
    !["profile", "chief-complaint", "treatment-history"].every((step) =>
      completedSteps.includes(step),
    )
  ) {
    return { state: "onboarding_ready" };
  }

  const assessments = await tryBffJson(
    context,
    "/api/proxy/api/v1/patients/me/assessments/?limit=20&offset=0",
  );
  if (assessments == null) {
    throw new Error("assessment reconciliation list must be present");
  }
  const selectedAssessments = selectAssessmentListState(
    assessments,
    "assessment reconciliation list",
  );
  const assessment =
    selectedAssessments.active ?? selectedAssessments.latestCompleted;
  if (assessment == null) {
    return {
      state: "records_ready",
      intakeComplete: (intake?.is_complete ?? intake?.isComplete) === true,
    };
  }
  if (
    assessment.status === "draft" ||
    assessment.status === "screening_in_progress"
  ) {
    assertImportedIntakeStory(
      assessment,
      "reconciled pre-screening assessment",
    );
  }
  let hasReadyDocument = false;
  if (
    assessment.status === "draft" ||
    assessment.status === "screening_in_progress"
  ) {
    const documents = await tryBffJson(
      context,
      `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/documents`,
    );
    hasReadyDocument =
      Array.isArray(documents?.items) &&
      documents.items.some(
        (item) =>
          isRecord(item) &&
          (item.processing_status ?? item.processingStatus) === "complete",
      );
  }
  return {
    state: checkpointForAssessmentStatus(assessment.status, hasReadyDocument),
    assessment,
    intakeComplete: (intake?.is_complete ?? intake?.isComplete) === true,
    resumedScreening:
      assessment.status === "screening_in_progress" && hasReadyDocument,
  };
}

async function tryRegistrationVerificationCode(
  request: JourneyContext["page"]["request"],
  email: string,
): Promise<string | null> {
  if (!BACKEND_REGISTRATION_CODE_URL || !TEST_SUPPORT_TOKEN) {
    throw new Error("Registration checkpoint support is not configured");
  }
  const response = await request.post(BACKEND_REGISTRATION_CODE_URL, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_SUPPORT_TOKEN}`,
    },
    data: { email },
    timeout: 30_000,
  });
  if (response.status() === 404) return null;
  if (!response.ok()) {
    throw new Error(
      `Registration checkpoint probe failed status=${response.status()}`,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Registration checkpoint probe returned malformed JSON");
  }
  if (!isRecord(payload) || typeof payload.code !== "string") {
    throw new Error(
      "Registration checkpoint probe returned an invalid response",
    );
  }
  return payload.code;
}

async function prepareAccount(context: JourneyContext): Promise<void> {
  await warmCsrfSession(context.page);
  try {
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
  } catch (error) {
    try {
      await getRegistrationVerificationCode(
        context.page.request,
        context.email,
      );
    } catch {
      throw error;
    }
  }

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

export async function prepareConsents(context: JourneyContext): Promise<void> {
  const existing = await tryBffJson(
    context,
    "/api/proxy/api/v1/patients/me/consents/active",
  );
  for (const consent of REQUIRED_ONBOARDING_CONSENTS) {
    if (
      existing != null &&
      Array.isArray(existing.items) &&
      existing.items.some(
        (item) =>
          isRecord(item) &&
          (item.consent_type ?? item.consentType) === consent.consent_type &&
          (item.consent_version ?? item.consentVersion) ===
            consent.consent_version,
      )
    ) {
      continue;
    }
    await bffJson(
      context,
      "POST",
      "/api/proxy/api/v1/patients/me/consents",
      consent,
      {
        "x-idempotency-key": consentMutationKey(
          context.identity.runId,
          consent.consent_type,
          consent.consent_version,
        ),
      },
    );
  }

  if (
    existing == null ||
    !Array.isArray(existing.items) ||
    !existing.items.some(
      (item) =>
        isRecord(item) &&
        (item.consent_type ?? item.consentType) ===
          INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT.consent_type &&
        (item.consent_version ?? item.consentVersion) ===
          INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT.consent_version,
    )
  ) {
    await bffJson(
      context,
      "POST",
      "/api/proxy/api/v1/patients/me/consents",
      INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT,
      {
        "x-idempotency-key": consentMutationKey(
          context.identity.runId,
          INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT.consent_type,
          INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT.consent_version,
        ),
      },
    );
  }

  const response = requireRecord(
    await bffJson<unknown>(
      context,
      "GET",
      "/api/proxy/api/v1/patients/me/consents/active",
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
            consent.consent_version,
      ),
      `active ${consent.consent_type} consent must be server-owned and current`,
    ).toBe(true);
  }
  expect(
    items.some(
      (item) =>
        isRecord(item) &&
        (item.consent_type ?? item.consentType) ===
          INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT.consent_type &&
        (item.consent_version ?? item.consentVersion) ===
          INFORMATIONAL_ONBOARDING_ACKNOWLEDGEMENT.consent_version,
    ),
    "current informational acknowledgement must be server-owned before onboarding",
  ).toBe(true);
}

function consentMutationKey(
  runId: string,
  consentType: string,
  consentVersion: string,
): string {
  return createHash("sha256")
    .update(
      [
        "patient-web-checkpoint-consent-v1",
        runId,
        consentType,
        consentVersion,
      ].join(":"),
    )
    .digest("hex");
}

function intakeStepPayloads(): Readonly<Record<string, JsonRecord>> {
  const onboarding = fullAssessmentScenario.onboarding;
  return {
    profile: {
      step_data: {
        date_of_birth: fullAssessmentScenario.registration.dateOfBirth,
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

function onboardingPatientProfilePayload(): JsonRecord {
  const onboarding = fullAssessmentScenario.onboarding;
  const heightInches =
    Number(onboarding.heightFeet) * 12 + Number(onboarding.heightInches);
  return {
    date_of_birth: fullAssessmentScenario.registration.dateOfBirth,
    sex_at_birth: onboarding.sexAtBirth,
    height_cm: Math.round(heightInches * 2.54),
    weight_kg: Math.round(Number(onboarding.weightPounds) * 0.453592),
  };
}

type IntakeStoryState = Readonly<{
  status: string | null;
  revision: number;
  narrative: string | null;
  inputMethod: string | null;
}>;

function parseIntakeStoryState(value: unknown): IntakeStoryState {
  const story = requireRecord(value, "intake story state");
  const status = story.status;
  const revision = story.revision;
  const narrative = story.narrative;
  const inputMethod =
    story.input_method !== undefined ? story.input_method : story.inputMethod;
  if (status !== null && typeof status !== "string") {
    throw new Error("intake story status must be a string or null");
  }
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
    throw new Error("intake story revision must be a non-negative integer");
  }
  if (narrative !== null && typeof narrative !== "string") {
    throw new Error("intake story narrative must be a string or null");
  }
  if (inputMethod !== null && typeof inputMethod !== "string") {
    throw new Error("intake story input method must be a string or null");
  }
  return {
    status: status as string | null,
    revision: revision as number,
    narrative: narrative as string | null,
    inputMethod: inputMethod as string | null,
  };
}

function assertExpectedIntakeStory(
  story: IntakeStoryState,
  narrative: string,
  revisionGreaterThan?: number,
): void {
  if (
    story.status !== "ready" ||
    story.narrative?.trim() !== narrative ||
    story.inputMethod !== "text"
  ) {
    throw new Error(
      "authoritative intake story does not match the synthetic raw narrative",
    );
  }
  if (story.revision < 1) {
    throw new Error(
      "ready authoritative intake story revision must be positive",
    );
  }
  if (
    revisionGreaterThan !== undefined &&
    story.revision <= revisionGreaterThan
  ) {
    throw new Error(
      "authoritative intake story revision did not advance after save",
    );
  }
}

async function prepareIntakeStory(
  context: JourneyContext,
  narrative: string,
): Promise<void> {
  const storyPath = "/api/proxy/api/v1/patients/me/intake/story";
  const observed = parseIntakeStoryState(
    await bffJson<unknown>(context, "GET", storyPath),
  );
  if (observed.status === "ready") {
    assertExpectedIntakeStory(observed, narrative);
    return;
  }
  const payload = {
    narrative,
    input_method: "text",
    expected_revision: observed.revision,
  };
  try {
    await bffJson(context, "PUT", storyPath, payload);
    recordQuestionnaireMutation(context, "PUT", storyPath, payload);
  } catch (error) {
    if (!(error instanceof BffCheckpointApiError) || error.status !== 409) {
      throw error;
    }
  }
  const authoritative = parseIntakeStoryState(
    await bffJson<unknown>(context, "GET", storyPath),
  );
  assertExpectedIntakeStory(authoritative, narrative, observed.revision);
}

export async function prepareOnboarding(
  context: JourneyContext,
): Promise<void> {
  // Intake endpoints require a persisted adult DOB. Match the product flow by
  // establishing its canonical profile fields before saving intake progress.
  await bffJson(
    context,
    "PATCH",
    "/api/proxy/api/v1/patients/me/",
    onboardingPatientProfilePayload(),
  );

  const progress = requireRecord(
    await bffJson<unknown>(
      context,
      "GET",
      "/api/proxy/api/v1/patients/me/intake/steps",
    ),
    "intake progress",
  );
  const rawCompletedSteps = progress.completed_steps ?? progress.completedSteps;
  if (!Array.isArray(rawCompletedSteps)) {
    throw new Error("intake progress completed_steps must be an array");
  }
  const completedSteps = new Set(
    rawCompletedSteps.filter(
      (step): step is string => typeof step === "string",
    ),
  );

  for (const [step, payload] of Object.entries(intakeStepPayloads())) {
    if (completedSteps.has(step)) continue;
    assertExactIntakeRequestContract(
      "PUT",
      `/api/proxy/api/v1/patients/me/intake/steps/${step}`,
      payload,
      fullAssessmentScenario,
    );
    if (step === "chief-complaint") {
      const stepData = requireRecord(
        payload.step_data,
        "chief complaint step data",
      );
      const narrative = requireString(
        stepData.narrative,
        "chief complaint raw narrative",
      );
      await prepareIntakeStory(context, narrative);
    }
    await bffJson(
      context,
      "PUT",
      `/api/proxy/api/v1/patients/me/intake/steps/${step}`,
      payload,
    );
    recordQuestionnaireMutation(
      context,
      "PUT",
      `/api/proxy/api/v1/patients/me/intake/steps/${step}`,
      payload,
    );
  }

  const narrative = requireString(
    fullAssessmentScenario.onboarding.chiefComplaint,
    "chief complaint narrative for pathway routing",
  );
  const routePayload = { narrative };
  const routePath = "/api/proxy/api/v1/patients/me/intake/route";
  assertExactIntakeRequestContract(
    "POST",
    routePath,
    routePayload,
    fullAssessmentScenario,
  );
  await bffJson(context, "POST", routePath, routePayload);
  recordQuestionnaireMutation(context, "POST", routePath, routePayload);
}

export async function completeIntake(context: JourneyContext): Promise<void> {
  const payload = {};
  const path = "/api/proxy/api/v1/patients/me/intake/progress/complete";
  const progress = requireRecord(
    await bffJson<unknown>(context, "POST", path, payload),
    "intake completion response",
  );
  recordQuestionnaireMutation(context, "POST", path, payload);
  if ((progress.is_complete ?? progress.isComplete) !== true) {
    throw new Error("intake completion response must report is_complete=true");
  }
  const completedSteps = progress.completed_steps ?? progress.completedSteps;
  if (!Array.isArray(completedSteps)) {
    throw new Error(
      "intake completion response completed_steps must be an array",
    );
  }
  const missingSteps = [
    "profile",
    "chief-complaint",
    "treatment-history",
  ].filter((step) => !completedSteps.includes(step));
  if (missingSteps.length > 0) {
    throw new Error(
      `intake completion response is missing required completed_steps: ${missingSteps.join(", ")}`,
    );
  }
}

const IDEMPOTENCY_RECONCILIATION_CODES = new Set([
  "idempotency_result_unavailable",
  "idempotency_outcome_unknown",
]);

export async function createAssessment(
  context: JourneyContext,
): Promise<AssessmentState> {
  const path = "/api/proxy/api/v1/patients/me/assessments/";
  let response: JsonRecord;
  try {
    response = requireRecord(
      await bffJson<unknown>(
        context,
        "POST",
        path,
        {},
        {
          "x-idempotency-key": `${context.identity.runId}:assessment-create-v1`,
        },
      ),
      "assessment creation response",
    );
  } catch (error) {
    if (
      !(error instanceof BffCheckpointApiError) ||
      error.status !== 409 ||
      error.serverCode == null ||
      !IDEMPOTENCY_RECONCILIATION_CODES.has(error.serverCode)
    ) {
      throw error;
    }
    const listed = requireRecord(
      await bffJson<unknown>(
        context,
        "GET",
        "/api/proxy/api/v1/patients/me/assessments/?limit=20&offset=0",
      ),
      "assessment creation reconciliation list",
    );
    const { active } = selectAssessmentListState(
      listed,
      "assessment creation reconciliation list",
    );
    if (active == null) throw error;
    if (active.status !== "draft") {
      throw new Error(
        `assessment creation reconciliation requires a draft, received ${active.status}`,
      );
    }
    assertImportedIntakeStory(
      active,
      "reconciled assessment creation response",
    );
    return active;
  }
  const assessment = parseAssessmentState(response, "assessment");
  expect(assessment.status).toBe("draft");
  assertImportedIntakeStory(assessment, "assessment creation response");
  return assessment;
}

async function prepareDocument(
  context: JourneyContext,
  assessmentId: string,
): Promise<void> {
  const idempotencyKey = context.identity.runId;
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
  const confirmed = assessmentDocumentConfirmationFromResponse(
    await bffJson<unknown>(
      context,
      "POST",
      confirmPath,
      {},
      {
        "x-idempotency-key": context.identity.runId,
      },
    ),
  );
  expect(
    confirmed.documentId,
    "assessment document confirm response must match the issued document",
  ).toBe(documentId);
  expect(["processing", "complete"]).toContain(confirmed.processingStatus);
  if (confirmed.processingStatus === "processing") {
    await completeSyntheticDocumentScan(
      context.request,
      documentId,
      context.email,
    );
  }

  const item = await waitForAssessmentDocumentComplete(
    context.page.request,
    assessmentId,
    documentId,
  );
  expect(item, "synthetic document must be server-owned and listed").toEqual(
    expect.objectContaining({
      id: documentId,
      state: "complete",
      label: "Uploaded document",
      fileSizeBytes: SYNTHETIC_ASSESSMENT_UPLOAD.buffer.length,
    }),
  );
  await verifySyntheticDocumentUploadPersistence(context.request, {
    assessmentId,
    documentId,
    email: context.email,
  });
  carryUploadedAssessmentDocument(context, { assessmentId, documentId });
}

export function carryUploadedAssessmentDocument(
  context: JourneyContext,
  uploaded: Readonly<{ assessmentId: string; documentId: string }>,
): void {
  if (uploaded.assessmentId.length === 0 || uploaded.documentId.length === 0) {
    throw new Error(
      "Analysis checkpoint requires exact uploaded assessment document IDs",
    );
  }
  context.uploadedAssessmentDocument = {
    assessmentId: uploaded.assessmentId,
    documentId: uploaded.documentId,
  };
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

function checkpointMutationKey(
  assessmentId: string,
  operation: string,
  revision: number,
  questionId?: string,
): string {
  return createHash("sha256")
    .update(
      [
        "patient-web-checkpoint-v1",
        assessmentId,
        operation,
        revision,
        questionId,
      ]
        .filter((part) => part !== undefined)
        .join(":"),
    )
    .digest("hex");
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

export function nextUnsavedScreeningQuestion(
  visible: readonly unknown[],
  satisfied: ReadonlySet<string>,
  submitted: ReadonlySet<string>,
): Readonly<{ question: unknown; id: string }> | null {
  const visibleById = visible.map((question) => ({
    question,
    id: questionId(question),
  }));
  const repeatedUnsaved = visibleById.find(
    ({ id }) => submitted.has(id) && !satisfied.has(id),
  );
  if (repeatedUnsaved != null) {
    throw new Error(
      `Screening checkpoint repeated unsaved server question ${repeatedUnsaved.id}`,
    );
  }
  return (
    visibleById.find(({ id }) => !satisfied.has(id) && !submitted.has(id)) ??
    null
  );
}

function screeningAnswerMutationError(
  questionId: string,
  error: unknown,
): Error {
  if (
    !SCREENING_ANSWERS_BY_ID.has(questionId) &&
    !SCREENING_TEXT_ANSWERS_BY_ID.has(questionId)
  ) {
    return new Error(
      "Screening checkpoint answer mutation failed for an unsupported question id",
    );
  }
  if (error instanceof BffCheckpointApiError) {
    return new Error(
      `Screening checkpoint answer mutation failed question_id=${questionId} status=${error.status}${error.serverCode == null ? "" : ` code=${error.serverCode}`}`,
    );
  }
  return new Error(
    `Screening checkpoint answer mutation failed question_id=${questionId}`,
  );
}

export async function prepareScreening(
  context: JourneyContext,
  assessment: AssessmentState,
  options: Readonly<{ authoritativeResume?: boolean }> = {},
): Promise<AssessmentState> {
  let revision = assessment.revision;
  const seen = new Set<string>();
  const submitted = new Set<string>();
  for (let index = 0; index < 80; index += 1) {
    const state = screeningState(
      await bffJson<unknown>(
        context,
        "GET",
        `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/screening/state`,
      ),
      "screening state response",
    );
    const savedAnswers = state.saved_answers ?? state.savedAnswers;
    const authoritativeSaved = new Set<string>();
    if (isRecord(savedAnswers)) {
      for (const id of Object.keys(savedAnswers)) {
        authoritativeSaved.add(id);
        seen.add(id);
      }
    }
    revision = requireRevision(state.revision, "screening state revision");
    const visible = (state.visible_questions ??
      state.visibleQuestions) as unknown[];
    const current = nextUnsavedScreeningQuestion(
      visible,
      authoritativeSaved,
      submitted,
    );
    if (current == null) break;
    const id = current.id;
    seen.add(id);
    const payload = {
      answers: { [id]: screeningAnswer(id) },
      expected_revision: revision,
    } as const;
    const path = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/screening/answers`;
    let response: unknown;
    try {
      response = await bffJson<unknown>(context, "PATCH", path, payload, {
        "x-idempotency-key": checkpointMutationKey(
          assessment.id,
          "screening-answer",
          revision,
          id,
        ),
      });
    } catch (error) {
      throw screeningAnswerMutationError(id, error);
    }
    const next = screeningState(response, `screening answer ${id} response`);
    recordQuestionnaireMutation(context, "PATCH", path, payload);
    submitted.add(id);
    revision = requireRevision(
      next.revision,
      `screening answer ${id} revision`,
    );
  }

  if (options.authoritativeResume !== true) {
    expect(
      [...EXPECTED_SCREENING_GOAL_QUESTION_IDS].every((id) => seen.has(id)),
      "fresh screening checkpoint must observe every server-owned screening goal",
    ).toBe(true);
  }
  const completePayload = { expected_revision: revision } as const;
  const completePath = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/screening/complete`;
  const completed = requireRecord(
    await bffJson<unknown>(context, "POST", completePath, completePayload, {
      "x-idempotency-key": checkpointMutationKey(
        assessment.id,
        "screening-complete",
        revision,
      ),
    }),
    "screening completion response",
  );
  recordQuestionnaireMutation(context, "POST", completePath, completePayload);
  const status = requireString(completed.status, "screening completion status");
  expect([
    "screening_complete",
    "adaptive_pending",
    "adaptive_in_progress",
  ]).toContain(status);
  return {
    id: assessment.id,
    revision: requireRevision(
      completed.revision,
      "screening completion revision",
    ),
    status,
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

const GENERATED_ADAPTIVE_TEXT_ANSWER =
  "No additional details for this synthetic test.";

function exactAdaptiveOptionIds(question: AdaptiveQuestion): readonly string[] {
  const ids = question.options.map((option) =>
    requireString(option.id, `adaptive option id for ${question.id}`),
  );
  if (ids.length === 0 || new Set(ids).size !== ids.length) {
    throw new Error(
      `Generated adaptive question ${question.id} requires nonempty unique server option IDs`,
    );
  }
  return ids;
}

export function resolveSyntheticAdaptiveAnswer(
  question: AdaptiveQuestion,
): unknown {
  const pinned = ADAPTIVE_ANSWERS_BY_ID.get(question.id);
  if (pinned != null) return pinned.value;
  if (!/^gen_\d+$/.test(question.id)) {
    throw new Error(
      `No exact synthetic adaptive answer exists for server-issued question ${question.id}; refusing to invent a clinical value`,
    );
  }
  if (question.type === "single_select") {
    return exactAdaptiveOptionIds(question)[0];
  }
  if (
    question.type === "multi_select" ||
    question.type === "multi_select_limit"
  ) {
    return [exactAdaptiveOptionIds(question)[0]];
  }
  if (question.type === "pain_scale") {
    if (
      !Number.isSafeInteger(question.min) ||
      !Number.isSafeInteger(question.max) ||
      (question.min as number) > (question.max as number)
    ) {
      throw new Error(
        `Generated adaptive scale ${question.id} requires exact in-range integer server stops`,
      );
    }
    return question.min;
  }
  if (question.type === "free_text") {
    return GENERATED_ADAPTIVE_TEXT_ANSWER;
  }
  throw new Error(
    `Generated adaptive question ${question.id} has unsupported server type ${question.type}`,
  );
}

export async function prepareAdaptive(
  context: JourneyContext,
  assessment: AssessmentState,
): Promise<AssessmentState> {
  const preparePath = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/adaptive/prepare`;
  const prepared = requireRecord(
    await bffJson<unknown>(
      context,
      "POST",
      preparePath,
      {
        expected_revision: assessment.revision,
      },
      {
        "x-idempotency-key": checkpointMutationKey(
          assessment.id,
          "adaptive-prepare",
          assessment.revision,
        ),
      },
    ),
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
  const savedAnswers = isRecord(prepared.saved_answers ?? prepared.savedAnswers)
    ? ((prepared.saved_answers ?? prepared.savedAnswers) as JsonRecord)
    : {};
  const answers: JsonRecord = {};
  for (const rawQuestion of questions) {
    const question = adaptiveQuestion(rawQuestion);
    if (question.id.startsWith("G")) {
      throw new Error(
        `Adaptive checkpoint received screening goal ${question.id}; refusing cross-phase clinical submission`,
      );
    }
    if (Object.hasOwn(savedAnswers, question.id)) {
      answers[question.id] = savedAnswers[question.id];
      if (/^gen_\d+$/.test(question.id)) {
        context.generatedAdaptiveAnswers.set(
          question.id,
          savedAnswers[question.id],
        );
      }
      continue;
    }
    const value = resolveSyntheticAdaptiveAnswer(question);
    answers[question.id] = value;
    if (/^gen_\d+$/.test(question.id)) {
      context.generatedAdaptiveAnswers.set(question.id, value);
    }
    const payload = {
      answers: { [question.id]: value },
      expected_revision: revision,
    };
    const answerPath = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/adaptive/answers`;
    const saved = requireRecord(
      await bffJson<unknown>(context, "PATCH", answerPath, payload, {
        "x-idempotency-key": checkpointMutationKey(
          assessment.id,
          "adaptive-answer",
          revision,
          question.id,
        ),
      }),
      `adaptive answer ${question.id} response`,
    );
    recordQuestionnaireMutation(context, "PATCH", answerPath, payload);
    revision = requireRevision(
      saved.revision,
      `adaptive answer ${question.id} revision`,
    );
  }
  const completePayload = { answers, expected_revision: revision } as const;
  const completePath = `/api/proxy/api/v1/patients/me/assessments/${assessment.id}/adaptive/complete-with-answers`;
  const completed = requireRecord(
    await bffJson<unknown>(context, "POST", completePath, completePayload, {
      "x-idempotency-key": checkpointMutationKey(
        assessment.id,
        "adaptive-complete",
        revision,
      ),
    }),
    "adaptive completion response",
  );
  recordQuestionnaireMutation(context, "POST", completePath, completePayload);
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

/** Establish a same-origin document before any browser cookie or CSRF probe. */
export async function ensureCheckpointBrowserOrigin(
  context: JourneyContext,
  state: PatientWebCheckpoint,
): Promise<void> {
  if (state === "fresh") return;
  const expectedOrigin = new URL(
    process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101",
  ).origin;
  let currentOrigin: string | null = null;
  try {
    currentOrigin = new URL(context.page.url()).origin;
  } catch {
    currentOrigin = null;
  }
  if (currentOrigin === expectedOrigin) return;

  const response = await context.page.goto("/api/health", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (response == null || !response.ok()) {
    throw checkpointFailure(
      state,
      `same-origin BFF bootstrap returned status=${response?.status() ?? "none"}`,
    );
  }
  let resolvedOrigin: string | null = null;
  try {
    resolvedOrigin = new URL(context.page.url()).origin;
  } catch {
    resolvedOrigin = null;
  }
  if (resolvedOrigin !== expectedOrigin) {
    throw checkpointFailure(state, "same-origin BFF bootstrap origin mismatch");
  }
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
    await waitForScreeningReadyUi(context.page);
  } else if (state === "adaptive_ready") {
    await waitForAdaptiveReadyUi(context.page);
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

export async function waitForAdaptiveReadyUi(
  page: JourneyContext["page"],
  timeout = 120_000,
): Promise<void> {
  await waitForAnyVisibleTestId(
    page,
    ["adaptive-loading-state", "adaptive-screen"],
    timeout,
  );
}

async function prepareCheckpointTransition(
  context: JourneyContext,
  buildState: CheckpointBuildState,
  target: PatientWebCheckpoint,
): Promise<void> {
  switch (target) {
    case "verified_pending_consent":
      await prepareAccount(context);
      break;
    case "onboarding_ready":
      await prepareConsents(context);
      break;
    case "records_ready":
      await prepareOnboarding(context);
      break;
    case "screening_ready": {
      let assessment = buildState.assessment;
      if (assessment == null) {
        if (buildState.intakeComplete !== true) {
          await completeIntake(context);
        }
        assessment = await createAssessment(context);
      }
      if (assessment.status === "draft") {
        assertImportedIntakeStory(
          assessment,
          "screening-ready draft assessment",
        );
      }
      await prepareDocument(context, assessment.id);
      buildState.assessment = assessment;
      break;
    }
    case "adaptive_ready": {
      if (buildState.assessment == null) {
        throw new Error("screening-ready assessment metadata is missing");
      }
      buildState.assessment = await prepareScreening(
        context,
        buildState.assessment,
        { authoritativeResume: buildState.resumedScreening === true },
      );
      break;
    }
    case "review_ready": {
      if (buildState.assessment == null) {
        throw new Error("adaptive-ready assessment metadata is missing");
      }
      buildState.assessment = await prepareAdaptive(
        context,
        buildState.assessment,
      );
      break;
    }
    case "results_ready":
      await prepareResultsReportFixture(context.request, context.identity);
      break;
    case "fresh":
      return;
  }
}

export async function executeCheckpointTransitionPlan(
  plannedTransitions: readonly Readonly<{
    from: PatientWebCheckpoint;
    to: PatientWebCheckpoint;
  }>[],
  applyTransition: (
    transition: Readonly<{
      from: PatientWebCheckpoint;
      to: PatientWebCheckpoint;
    }>,
  ) => Promise<void>,
  finalize: () => Promise<void>,
): Promise<readonly CheckpointTransitionTiming[]> {
  const timings: CheckpointTransitionTiming[] = [];
  for (const transition of plannedTransitions) {
    const startedAt = performance.now();
    await applyTransition(transition);
    timings.push({
      ...transition,
      durationMs: Math.max(0, performance.now() - startedAt),
    });
  }
  await finalize();
  return timings;
}

/** Prepare a named state through ordered, idempotent BFF/product transitions. */
export async function buildPatientWebCheckpoint(
  context: JourneyContext,
  state: PatientWebCheckpoint,
): Promise<BuiltPatientWebCheckpoint> {
  await ensureCheckpointBrowserOrigin(context, state);
  const current = await reconcileAuthoritativeCheckpoint(context);
  const transitions: CheckpointTransitionTiming[] = [];
  try {
    if (current.state === "informational_acknowledgement_pending") {
      if (
        PATIENT_WEB_CHECKPOINTS.indexOf(state) <
        PATIENT_WEB_CHECKPOINTS.indexOf("onboarding_ready")
      ) {
        throw new Error(
          `builder cannot move backward from informational acknowledgement pending to ${state}`,
        );
      }
      const startedAt = performance.now();
      await prepareConsents(context);
      transitions.push({
        from: "verified_pending_consent",
        to: "onboarding_ready",
        durationMs: Math.max(0, performance.now() - startedAt),
      });
      current.state = "onboarding_ready";
    }
    const plannedTransitions = planCheckpointTransitions(current.state, state);
    transitions.push(
      ...(await executeCheckpointTransitionPlan(
        plannedTransitions,
        async ({ to }) => {
          await prepareCheckpointTransition(context, current, to);
          current.state = to;
        },
        async () => navigateToCheckpoint(context, state),
      )),
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("failed closed:")) {
      throw error;
    }
    throw checkpointFailure(
      state,
      error instanceof Error ? error.message : "normal API preparation failed",
    );
  }
  return { state, context, transitions };
}
