import { test } from "@playwright/test";

import {
  buildPatientWebCheckpoint,
  CHECKPOINT_PREPARATION_MODE,
  expectPatientWebCheckpointReady,
  type PatientWebCheckpoint,
} from "./checkpoints";
import {
  createJourneyContext,
  FULL_FLOW_TIMEOUT_MS,
} from "./fullAssessmentJourney";
import { prepareResultsReportFixture } from "./journey/context";
import scopeManifest from "./scopes.json";
import { runAccountVerificationStage } from "./stages/accountVerification";
import { runAdaptiveStage } from "./stages/adaptive";
import { runConsentOnboardingStage } from "./stages/consentOnboarding";
import { runRecordsDocumentsStage } from "./stages/recordsDocuments";
import { runResultsReportStage } from "./stages/resultsReport";
import { runAnalysisStage } from "./stages/reviewAnalysis";
import { runScreeningStage } from "./stages/screening";
import { maybeThrowForcedMidFlowFailure } from "./support/forcedMidFlowFailure";
import { withStackOwnedE2eLifecycle } from "./support/lifecycle";
import { createE2ERunIdentity } from "./support/runIdentity";
import type { JourneyContext } from "./journey/context";

type ScopedJourney = Readonly<{
  name: string;
  startCheckpoint: PatientWebCheckpoint;
  endCheckpoint: PatientWebCheckpoint;
  tag: string;
  runStage: (context: JourneyContext) => Promise<void>;
}>;

const SCOPED_JOURNEYS = [
  {
    name: "auth",
    startCheckpoint: "fresh",
    endCheckpoint: "verified_pending_consent",
    tag: "@scope-auth",
    runStage: runAccountVerificationStage,
  },
  {
    name: "consent-onboarding",
    startCheckpoint: "verified_pending_consent",
    endCheckpoint: "records_ready",
    tag: "@scope-consent-onboarding",
    runStage: runConsentOnboardingStage,
  },
  {
    name: "documents",
    startCheckpoint: "records_ready",
    endCheckpoint: "screening_ready",
    tag: "@scope-documents",
    runStage: async (context) => {
      await runRecordsDocumentsStage(context);
      maybeThrowForcedMidFlowFailure("records-documents");
    },
  },
  {
    name: "screening",
    startCheckpoint: "screening_ready",
    endCheckpoint: "adaptive_ready",
    tag: "@scope-screening",
    runStage: runScreeningStage,
  },
  {
    name: "adaptive",
    startCheckpoint: "adaptive_ready",
    endCheckpoint: "review_ready",
    tag: "@scope-adaptive",
    runStage: runAdaptiveStage,
  },
  {
    name: "analysis",
    startCheckpoint: "review_ready",
    endCheckpoint: "results_ready",
    tag: "@scope-analysis",
    runStage: runAnalysisStage,
  },
  {
    name: "results-report",
    startCheckpoint: "review_ready",
    endCheckpoint: "results_ready",
    tag: "@scope-results-report",
    runStage: async (context) => {
      await prepareResultsReportFixture(context.request, context.identity);
      await context.page.reload();
      await runResultsReportStage(context);
    },
  },
] as const satisfies readonly ScopedJourney[];

function assertScopeManifestAlignment(): void {
  for (const journey of SCOPED_JOURNEYS) {
    const definition =
      scopeManifest.scopes[journey.name as keyof typeof scopeManifest.scopes];
    if (definition == null) {
      throw new Error(`Scope ${journey.name} is missing from e2e/scopes.json`);
    }

    if (
      definition.spec !== "e2e/scoped-assessment.spec.ts" ||
      definition.tag !== journey.tag ||
      definition.start_checkpoint !== journey.startCheckpoint ||
      definition.end_checkpoint !== journey.endCheckpoint ||
      definition.checkpoint !== journey.endCheckpoint
    ) {
      throw new Error(
        `Scope ${journey.name} does not match its named checkpoint boundary in e2e/scopes.json`,
      );
    }
  }
}

assertScopeManifestAlignment();

for (const journey of SCOPED_JOURNEYS) {
  if (CHECKPOINT_PREPARATION_MODE[journey.startCheckpoint] !== "api") {
    throw new Error(
      `Scope ${journey.name} declares unsupported start checkpoint ${journey.startCheckpoint}`,
    );
  }
}

for (const journey of SCOPED_JOURNEYS) {
  test(`${journey.name} checkpoint ${journey.tag}`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(FULL_FLOW_TIMEOUT_MS);
    const identity = createE2ERunIdentity();

    await withStackOwnedE2eLifecycle({
      identity,
      action: async () => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        const { context, profiler, adaptivePrepareTracker } =
          createJourneyContext({
            page,
            request,
            testInfo,
            identity,
            step: (name, body) => test.step(name, body),
          });
        adaptivePrepareTracker.start(page);
        try {
          const checkpoint = await buildPatientWebCheckpoint(
            context,
            journey.startCheckpoint,
          );
          await journey.runStage(checkpoint.context);
          await expectPatientWebCheckpointReady(
            checkpoint.context,
            journey.endCheckpoint,
          );
        } finally {
          adaptivePrepareTracker.stop();
          await profiler.attach(testInfo);
        }
      },
    });
  });
}
