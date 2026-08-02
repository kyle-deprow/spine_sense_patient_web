import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FORCED_MID_FLOW_FAILURE_ENV,
  FORCED_MID_FLOW_FAILURE_MESSAGE,
  FORCED_MID_FLOW_FAILURE_STAGE,
  FORCED_MID_FLOW_FAILURE_UNAVAILABLE_MESSAGE,
  isForcedMidFlowFailureSelected,
  maybeThrowForcedMidFlowFailure,
  maybeThrowForcedMidFlowFailureUnavailable,
  readForcedMidFlowFailureStage,
} from "../../../e2e/support/forcedMidFlowFailure";
import {
  completeAdaptiveIfPresent,
  reachAdaptiveSavedAdvanceMilestone,
} from "../../../e2e/stages/adaptive";
import { waitForAnalysisReadyAndConfirm } from "../../../e2e/stages/reviewAnalysis";

describe("forced mid-flow E2E failure hook", () => {
  it("is disabled when the environment switch is unset or empty", () => {
    expect(readForcedMidFlowFailureStage(undefined)).toBeNull();
    expect(readForcedMidFlowFailureStage(" ")).toBeNull();

    vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, "");
    expect(() =>
      maybeThrowForcedMidFlowFailure(FORCED_MID_FLOW_FAILURE_STAGE),
    ).not.toThrow();
    vi.unstubAllEnvs();
  });

  it("accepts only allowlisted completed stages and scopes", () => {
    expect(readForcedMidFlowFailureStage(FORCED_MID_FLOW_FAILURE_STAGE)).toBe(
      FORCED_MID_FLOW_FAILURE_STAGE,
    );
    expect(readForcedMidFlowFailureStage(" RECORDS-DOCUMENTS ")).toBe(
      FORCED_MID_FLOW_FAILURE_STAGE,
    );
    expect(readForcedMidFlowFailureStage("screening")).toBe("screening");
    expect(() => readForcedMidFlowFailureStage("unknown")).toThrow(
      `${FORCED_MID_FLOW_FAILURE_ENV} must name an approved journey stage or scope`,
    );
  });

  it.each([
    "auth",
    "consent-onboarding",
    "documents",
    "screening",
    "adaptive",
    "analysis",
    "results-report",
  ] as const)(
    "supports deterministic cleanup evidence for the %s scope",
    (stage) => {
      vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, stage);
      expect(() => maybeThrowForcedMidFlowFailure(stage)).toThrow(
        FORCED_MID_FLOW_FAILURE_MESSAGE,
      );
      vi.unstubAllEnvs();
    },
  );

  it("throws once at the named milestone with a deterministic PHI-safe error", () => {
    vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, FORCED_MID_FLOW_FAILURE_STAGE);

    expect(() =>
      maybeThrowForcedMidFlowFailure("consent-onboarding"),
    ).not.toThrow();
    expect(() =>
      maybeThrowForcedMidFlowFailure(FORCED_MID_FLOW_FAILURE_STAGE),
    ).toThrow(FORCED_MID_FLOW_FAILURE_MESSAGE);

    expect(FORCED_MID_FLOW_FAILURE_MESSAGE).toBe(
      "Synthetic forced E2E failure at approved stage milestone",
    );
    expect(FORCED_MID_FLOW_FAILURE_MESSAGE).not.toMatch(
      /@|token|cookie|secret|patient|uuid|payload/i,
    );
    vi.unstubAllEnvs();
  });

  it("maps the legacy records-documents selector to the documents milestone", () => {
    vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, FORCED_MID_FLOW_FAILURE_STAGE);

    expect(() => maybeThrowForcedMidFlowFailure("documents")).toThrow(
      FORCED_MID_FLOW_FAILURE_MESSAGE,
    );
    vi.unstubAllEnvs();
  });

  it("exposes adaptive forced mode as an explicit opt-in capability", () => {
    vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, "");
    expect(isForcedMidFlowFailureSelected("adaptive")).toBe(false);
    vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, "adaptive");
    expect(isForcedMidFlowFailureSelected("adaptive")).toBe(true);
    vi.unstubAllEnvs();
  });

  it("reaches the adaptive milestone only after answer, submit, and saved advance", () => {
    const events = ["answer", "submit", "advance:adaptive-screen"];
    const capability = {
      onSavedAdvance: () => events.push("forced-milestone"),
      onTerminalBeforeSavedAdvance: vi.fn(),
    };
    let reached = reachAdaptiveSavedAdvanceMilestone(
      "normal",
      "adaptive-screen",
      false,
      capability,
      () => events.push("successful-save-proof"),
    );
    reached = reachAdaptiveSavedAdvanceMilestone(
      "normal",
      "adaptive-screen",
      reached,
      capability,
      () => events.push("duplicate-save-proof"),
    );

    expect(reached).toBe(true);
    expect(events).toEqual([
      "answer",
      "submit",
      "advance:adaptive-screen",
      "successful-save-proof",
      "forced-milestone",
    ]);
    expect(
      reachAdaptiveSavedAdvanceMilestone(
        "normal",
        "review-screen",
        false,
        capability,
        () => {
          throw new Error("terminal outcomes are not saved-advance milestones");
        },
      ),
    ).toBe(false);
  });

  it.each(["normal", "retry", "loading"] as const)(
    "keeps completeAdaptive %s saved-advance handling inert when forced mode is unset",
    (path) => {
      const assertSuccessfulSave = vi.fn();

      expect(
        reachAdaptiveSavedAdvanceMilestone(
          path,
          "adaptive-screen",
          false,
          null,
          assertSuccessfulSave,
        ),
      ).toBe(false);
      expect(assertSuccessfulSave).not.toHaveBeenCalled();
    },
  );

  it("keeps the production adaptive milestone after submit, advance, and successful-save proof", () => {
    const source = readFileSync(
      resolve(process.cwd(), "e2e/stages/adaptive.ts"),
      "utf8",
    );
    const loop = source.slice(source.indexOf("for (let index = 0;"));
    const answer = loop.indexOf("answerIssuedAdaptiveQuestion(");
    const submit = loop.indexOf(
      'waitForEnabledAndClick(page, "adaptive-submit")',
    );
    const advance = loop.indexOf("waitForDynamicQuestionAdvance(");
    const milestone = loop.indexOf('recordSavedAdvance("normal", nextStage');
    expect(answer).toBeGreaterThanOrEqual(0);
    expect(submit).toBeGreaterThan(answer);
    expect(advance).toBeGreaterThan(submit);
    expect(milestone).toBeGreaterThan(advance);
    expect(loop).toContain(
      'recordSavedAdvance("retry", recoveredStage, currentQuestionTestId)',
    );
    expect(
      loop.match(/recordSavedAdvance\("loading", resolvedStage/g),
    ).toHaveLength(2);
  });

  it("fails closed when adaptive is terminal before a saved advance milestone", async () => {
    const hiddenLocator = {
      isVisible: async () => false,
      first() {
        return this;
      },
    };
    const page = {
      getByTestId: (testId: string) => ({
        isVisible: async () => testId === "review-screen",
      }),
      getByText: () => hiddenLocator,
      getByRole: () => hiddenLocator,
    } as never;
    const savedAdvance = vi.fn();
    const terminalFirst = vi.fn(() => {
      throw new Error(FORCED_MID_FLOW_FAILURE_UNAVAILABLE_MESSAGE);
    });

    await expect(
      completeAdaptiveIfPresent(
        page,
        new Map(),
        {} as never,
        { assertRecoveryReceiptContinuity: vi.fn() } as never,
        {
          onSavedAdvance: savedAdvance,
          onTerminalBeforeSavedAdvance: terminalFirst,
        },
      ),
    ).rejects.toThrow(FORCED_MID_FLOW_FAILURE_UNAVAILABLE_MESSAGE);
    expect(savedAdvance).not.toHaveBeenCalled();
    expect(terminalFirst).toHaveBeenCalledOnce();
  });

  it("reports an unavailable forced adaptive milestone only when selected", () => {
    vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, "adaptive");
    expect(() => maybeThrowForcedMidFlowFailureUnavailable("adaptive")).toThrow(
      FORCED_MID_FLOW_FAILURE_UNAVAILABLE_MESSAGE,
    );
    vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, "screening");
    expect(() =>
      maybeThrowForcedMidFlowFailureUnavailable("adaptive"),
    ).not.toThrow();
    vi.unstubAllEnvs();
  });

  it("reaches the analysis milestone before waiting for authoritative completion", async () => {
    const measure = vi.fn();
    const milestoneFailure = new Error("internal analysis milestone");

    await expect(
      waitForAnalysisReadyAndConfirm({ profiler: { measure } } as never, () => {
        throw milestoneFailure;
      }),
    ).rejects.toBe(milestoneFailure);
    expect(measure).not.toHaveBeenCalled();
  });

  it.each([
    [
      "accountVerification.ts",
      "runAccountVerificationStage",
      "auth",
      '"verification.to_authenticated_session"',
    ],
    [
      "consentOnboarding.ts",
      "runConsentOnboardingStage",
      "consent-onboarding",
      '"onboarding.history_to_records"',
    ],
    [
      "recordsDocuments.ts",
      "runRecordsDocumentsStage",
      "documents",
      '"onboarding.records_to_assessment_entry"',
    ],
    ["screening.ts", "runScreeningStage", "screening", '"screening.submit"'],
    [
      "adaptive.ts",
      "runAdaptiveStage",
      "adaptive",
      'if (stage !== "review-screen")',
    ],
    [
      "reviewAnalysis.ts",
      "runAnalysisStage",
      "analysis",
      'page.getByTestId("results-screen")',
    ],
    [
      "resultsReport.ts",
      "runResultsReportStage",
      "results-report",
      '"results.report_generation"',
    ],
  ] as const)(
    "keeps the %s forced failure inside %s before its end transition",
    (fileName, exportedFunction, stage, endTransition) => {
      const source = readFileSync(
        resolve(process.cwd(), "e2e/stages", fileName),
        "utf8",
      );
      const stageSource = source.slice(
        source.indexOf(`export async function ${exportedFunction}`),
      );
      const milestone = `maybeThrowForcedMidFlowFailure("${stage}")`;

      expect(stageSource.indexOf(milestone)).toBeGreaterThanOrEqual(0);
      expect(stageSource.indexOf(endTransition)).toBeGreaterThan(
        stageSource.indexOf(milestone),
      );
    },
  );

  it("keeps forced failure injection out of the scoped and full runners", () => {
    for (const fileName of [
      "e2e/scopedAssessment.ts",
      "e2e/fullAssessmentJourney.ts",
    ]) {
      const source = readFileSync(resolve(process.cwd(), fileName), "utf8");
      expect(source).not.toContain("maybeThrowForcedMidFlowFailure");
    }

    const scopedRunner = readFileSync(
      resolve(process.cwd(), "e2e/scopedAssessment.ts"),
      "utf8",
    );
    expect(scopedRunner).toContain("withStackOwnedE2eLifecycle({");
    expect(scopedRunner).toContain("adaptivePrepareTracker.stop()");
    expect(scopedRunner).toContain("await profiler.attach(testInfo)");
  });
});
