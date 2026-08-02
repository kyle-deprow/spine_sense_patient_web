import {
  type APIRequestContext,
  type Page,
  type TestInfo,
} from "@playwright/test";

import { fullAssessmentScenario } from "./fixtures/fullAssessmentScenario";
import { runAccountVerificationStage } from "./stages/accountVerification";
import { AdaptivePrepareTracker, runAdaptiveStage } from "./stages/adaptive";
import { runConsentOnboardingStage } from "./stages/consentOnboarding";
import { runRecordsDocumentsStage } from "./stages/recordsDocuments";
import { runResultsReportStage } from "./stages/resultsReport";
import { runAnalysisStage, runReviewStage } from "./stages/reviewAnalysis";
import { runReturnHomeStage } from "./stages/returnHome";
import { runScreeningStage } from "./stages/screening";
import type { StageStep } from "./stages/stage";
import {
  captureQuestionnaireMutations,
  installPhiSafeDiagnostics,
  TransitionProfiler,
  type JourneyContext,
} from "./journey/context";
import type { E2ERunIdentity } from "./support/runIdentity";

export { FULL_FLOW_TIMEOUT_MS } from "./journey/context";

export type JourneyCheckpoint =
  | "fresh"
  | "verified_pending_consent"
  | "onboarding_ready"
  | "records_ready"
  | "screening_ready"
  | "adaptive_ready"
  | "review_ready"
  | "results_ready";

export function createJourneyContext(options: {
  page: Page;
  request: APIRequestContext;
  testInfo: TestInfo;
  identity: E2ERunIdentity;
  step: StageStep;
}): {
  context: JourneyContext;
  profiler: TransitionProfiler;
  adaptivePrepareTracker: AdaptivePrepareTracker;
} {
  const { page, request, testInfo, identity, step } = options;
  installPhiSafeDiagnostics(page);
  const profiler = new TransitionProfiler();
  const adaptivePrepareTracker = new AdaptivePrepareTracker();
  return {
    context: {
      page,
      request,
      testInfo,
      identity,
      email: identity.email,
      scenario: fullAssessmentScenario,
      profiler,
      step,
      questionnaireMutations: captureQuestionnaireMutations(page),
      generatedAdaptiveAnswers: new Map<string, unknown>(),
      adaptivePrepareTracker,
      uploadedAssessmentDocument: null,
    },
    profiler,
    adaptivePrepareTracker,
  };
}

export async function runJourneyToCheckpoint(
  context: JourneyContext,
  checkpoint: JourneyCheckpoint,
): Promise<void> {
  if (checkpoint === "fresh") return;
  if (checkpoint === "onboarding_ready") {
    throw new Error(
      "The canonical browser journey cannot stop at onboarding_ready; use the API-backed checkpoint builder",
    );
  }

  await runAccountVerificationStage(context);
  if (checkpoint === "verified_pending_consent") return;

  await runConsentOnboardingStage(context);
  if (checkpoint === "records_ready") return;

  await runRecordsDocumentsStage(context);
  if (checkpoint === "screening_ready") return;

  await runScreeningStage(context);
  if (checkpoint === "adaptive_ready") return;

  await runAdaptiveStage(context);
  if (checkpoint === "review_ready") return;

  await runReviewStage(context);

  await runAnalysisStage(context);
  await runResultsReportStage(context);
}

export async function runFullAssessmentJourney(options: {
  page: Page;
  request: APIRequestContext;
  testInfo: TestInfo;
  identity: E2ERunIdentity;
  step: StageStep;
}): Promise<void> {
  const { page, testInfo } = options;
  await page.emulateMedia({ reducedMotion: "no-preference" });

  const { context, profiler, adaptivePrepareTracker } =
    createJourneyContext(options);

  adaptivePrepareTracker.start(page);
  try {
    await runJourneyToCheckpoint(context, "results_ready");
    await runReturnHomeStage(context);
  } finally {
    adaptivePrepareTracker.stop();
    await profiler.attach(testInfo);
  }
}
