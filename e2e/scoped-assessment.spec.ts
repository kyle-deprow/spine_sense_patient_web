import { test } from "@playwright/test";
import { performance } from "node:perf_hooks";

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
import scopeManifest from "./scopes.json";
import {
  assertScopeBoundaryManifest,
  SCOPE_BOUNDARY_CONTRACTS,
  type ScopeEndState,
  type ScopeName,
} from "./scopeContracts";
import { runAccountVerificationStage } from "./stages/accountVerification";
import { runAdaptiveStage } from "./stages/adaptive";
import { runConsentOnboardingStage } from "./stages/consentOnboarding";
import { runRecordsDocumentsStage } from "./stages/recordsDocuments";
import { runResultsReportStage } from "./stages/resultsReport";
import { runAnalysisStage } from "./stages/reviewAnalysis";
import { runReturnHomeStage } from "./stages/returnHome";
import { runScreeningStage } from "./stages/screening";
import { withStackOwnedE2eLifecycle } from "./support/lifecycle";
import { createE2ERunIdentity } from "./support/runIdentity";
import type { JourneyContext } from "./journey/context";

type ScopedJourney = Readonly<{
  name: Exclude<ScopeName, "full">;
  startCheckpoint: PatientWebCheckpoint;
  endState: ScopeEndState;
  tag: string;
  runStage: (context: JourneyContext) => Promise<void>;
}>;

const SCOPED_JOURNEYS = [
  {
    name: "auth",
    startCheckpoint: "fresh",
    endState: "verified_pending_consent",
    tag: "@scope-auth",
    runStage: runAccountVerificationStage,
  },
  {
    name: "consent-onboarding",
    startCheckpoint: "verified_pending_consent",
    endState: "records_ready",
    tag: "@scope-consent-onboarding",
    runStage: runConsentOnboardingStage,
  },
  {
    name: "documents",
    startCheckpoint: "records_ready",
    endState: "screening_ready",
    tag: "@scope-documents",
    runStage: runRecordsDocumentsStage,
  },
  {
    name: "screening",
    startCheckpoint: "screening_ready",
    endState: "adaptive_ready",
    tag: "@scope-screening",
    runStage: runScreeningStage,
  },
  {
    name: "adaptive",
    startCheckpoint: "adaptive_ready",
    endState: "review_ready",
    tag: "@scope-adaptive",
    runStage: runAdaptiveStage,
  },
  {
    name: "analysis",
    startCheckpoint: "review_ready",
    endState: "results_ready",
    tag: "@scope-analysis",
    runStage: runAnalysisStage,
  },
  {
    name: "results-report",
    startCheckpoint: "results_ready",
    endState: "home_complete",
    tag: "@scope-results-report",
    runStage: async (context) => {
      await runResultsReportStage(context);
      await runReturnHomeStage(context);
    },
  },
] as const satisfies readonly ScopedJourney[];

function assertScopeManifestAlignment(): void {
  assertScopeBoundaryManifest(scopeManifest.scopes);
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
      definition.end_checkpoint !== journey.endState
    ) {
      throw new Error(
        `Scope ${journey.name} does not match its named checkpoint boundary in e2e/scopes.json`,
      );
    }
  }
}

assertScopeManifestAlignment();

for (const journey of SCOPED_JOURNEYS) {
  const contract = SCOPE_BOUNDARY_CONTRACTS[journey.name];
  if (
    contract.startCheckpoint !== journey.startCheckpoint ||
    contract.endState !== journey.endState
  ) {
    throw new Error(`Scope ${journey.name} implementation boundary drifted`);
  }
  if (
    !["api", "named_fixture"].includes(
      CHECKPOINT_PREPARATION_MODE[journey.startCheckpoint],
    )
  ) {
    throw new Error(
      `Scope ${journey.name} declares unsupported start checkpoint ${journey.startCheckpoint}`,
    );
  }
}

async function expectScopeEndState(
  context: JourneyContext,
  endState: ScopeEndState,
): Promise<void> {
  if (endState === "home_complete") {
    await context.page
      .locator('[data-testid="home-screen"]:visible')
      .waitFor({ state: "visible", timeout: 60_000 });
    return;
  }
  await expectPatientWebCheckpointReady(context, endState);
}

function logScopeTiming(
  scope: Exclude<ScopeName, "full">,
  phase: "setup" | "action" | "browser_finalize",
  startedAt: number,
): void {
  const durationMs = Math.max(0, performance.now() - startedAt);
  console.log(
    `[scope-timing] scope=${scope} phase=${phase} duration_ms=${durationMs.toFixed(1)}`,
  );
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
          const setupStartedAt = performance.now();
          const checkpoint = await buildPatientWebCheckpoint(
            context,
            journey.startCheckpoint,
          );
          logScopeTiming(journey.name, "setup", setupStartedAt);
          const actionStartedAt = performance.now();
          try {
            await journey.runStage(checkpoint.context);
            await expectScopeEndState(checkpoint.context, journey.endState);
          } finally {
            logScopeTiming(journey.name, "action", actionStartedAt);
          }
        } finally {
          const finalizeStartedAt = performance.now();
          adaptivePrepareTracker.stop();
          await profiler.attach(testInfo);
          logScopeTiming(journey.name, "browser_finalize", finalizeStartedAt);
        }
      },
    });
  });
}
