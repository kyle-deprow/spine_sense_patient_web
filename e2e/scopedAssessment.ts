import { test } from "@playwright/test";
import { performance } from "node:perf_hooks";

import {
  buildPatientWebCheckpoint,
  CHECKPOINT_PREPARATION_MODE,
  expectPatientWebCheckpointReady,
  type PatientWebCheckpoint,
} from "./checkpoints";
import { createJourneyContext } from "./fullAssessmentJourney";
import { SCOPED_ASSESSMENT_TIMEOUT_MS } from "./journey/timeouts";
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
import { withAuthorizedE2eLifecycle } from "./support/lifecycle";
import { createE2ERunIdentity } from "./support/runIdentity";
import type { JourneyContext } from "./journey/context";

type ScopedJourney = Readonly<{
  name: Exclude<ScopeName, "legacy-journey">;
  spec: string;
  startCheckpoint: PatientWebCheckpoint;
  endState: ScopeEndState;
  tag: string;
  runStage: (context: JourneyContext) => Promise<void>;
}>;

const SCOPED_JOURNEYS = {
  auth: {
    name: "auth",
    spec: "e2e/scopes/auth.spec.ts",
    startCheckpoint: "fresh",
    endState: "verified_pending_consent",
    tag: "@scope-auth",
    runStage: runAccountVerificationStage,
  },
  "consent-onboarding": {
    name: "consent-onboarding",
    spec: "e2e/scopes/consent-onboarding.spec.ts",
    startCheckpoint: "verified_pending_consent",
    endState: "records_ready",
    tag: "@scope-consent-onboarding",
    runStage: runConsentOnboardingStage,
  },
  documents: {
    name: "documents",
    spec: "e2e/scopes/documents.spec.ts",
    startCheckpoint: "records_ready",
    endState: "screening_ready",
    tag: "@scope-documents",
    runStage: runRecordsDocumentsStage,
  },
  screening: {
    name: "screening",
    spec: "e2e/scopes/screening.spec.ts",
    startCheckpoint: "screening_ready",
    endState: "adaptive_ready",
    tag: "@scope-screening",
    runStage: runScreeningStage,
  },
  adaptive: {
    name: "adaptive",
    spec: "e2e/scopes/adaptive.spec.ts",
    startCheckpoint: "adaptive_ready",
    endState: "review_ready",
    tag: "@scope-adaptive",
    runStage: runAdaptiveStage,
  },
  analysis: {
    name: "analysis",
    spec: "e2e/scopes/analysis.spec.ts",
    startCheckpoint: "review_ready",
    endState: "results_ready",
    tag: "@scope-analysis",
    runStage: runAnalysisStage,
  },
  "results-report": {
    name: "results-report",
    spec: "e2e/scopes/results-report.spec.ts",
    startCheckpoint: "results_ready",
    endState: "home_complete",
    tag: "@scope-results-report",
    runStage: async (context) => {
      await runResultsReportStage(context);
      await runReturnHomeStage(context);
    },
  },
} as const satisfies Readonly<
  Record<Exclude<ScopeName, "legacy-journey">, ScopedJourney>
>;

function assertScopeManifestAlignment(): void {
  assertScopeBoundaryManifest(scopeManifest.scopes);
  for (const journey of Object.values(SCOPED_JOURNEYS)) {
    const definition =
      scopeManifest.scopes[journey.name as keyof typeof scopeManifest.scopes];
    if (definition == null) {
      throw new Error(`Scope ${journey.name} is missing from e2e/scopes.json`);
    }

    if (
      definition.spec !== journey.spec ||
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

for (const journey of Object.values(SCOPED_JOURNEYS)) {
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
  scope: Exclude<ScopeName, "legacy-journey">,
  phase: "setup" | "action" | "browser_finalize",
  startedAt: number,
): void {
  const durationMs = Math.max(0, performance.now() - startedAt);
  console.log(
    `[scope-timing] scope=${scope} phase=${phase} duration_ms=${durationMs.toFixed(1)}`,
  );
}

export function defineScopedAssessment(
  scope: Exclude<ScopeName, "legacy-journey">,
): void {
  const journey = SCOPED_JOURNEYS[scope];
  test(`${journey.name} checkpoint ${journey.tag}`, async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(SCOPED_ASSESSMENT_TIMEOUT_MS);
    const identity = createE2ERunIdentity();

    await withAuthorizedE2eLifecycle({
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
