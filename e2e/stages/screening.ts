import {
  expect,
  type Locator,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from "@playwright/test";
import { performance } from "node:perf_hooks";

import { fullAssessmentScenario } from "../fixtures/fullAssessmentScenario";
import {
  ENABLE_FULL_ASSESSMENT_STRESS,
  STRESS_BACKTRACK_AFTER_SCREENING_QUESTION_ID,
  STRESS_RELOAD_AFTER_SCREENING_QUESTION_ID,
  EXPECTED_SCREENING_GOAL_QUESTION_IDS,
  FINAL_SCREENING_QUESTION_ID,
  SCREENING_ANSWERS_BY_ID,
  SCREENING_GOAL_QUESTION_IDS,
  SCREENING_TEXT_ANSWERS_BY_ID,
  isRecord,
  TRANSITION_BUDGETS_MS,
  expectNoBrowserStorage,
  logMilestone,
  type AssessmentAnswer,
  type ScreeningStressState,
  type TextAnswer,
  type TransitionProfiler,
} from "../journey/context";
import {
  waitForAnyVisibleTestId,
  waitForBrowserNetworkReady,
  waitForEnabledAndClick,
  maybeContinueSectionTransition,
} from "../journey/selectors";
import {
  waitForFirstVisibleEnabledAndClick,
  waitForScreeningNavReady,
} from "./consentOnboarding";
import { answerControlIsSelected } from "../../src/lib/e2e/answer-control";
import { ScreeningRouteTracker } from "../../src/lib/e2e/screening-route";
import { splitScreeningVisualTiming } from "../../src/lib/e2e/screening-timing";
import {
  assertRecoveryAttempt,
  classifyRecovery,
} from "../support/recoveryPolicy";
import { maybeThrowForcedMidFlowFailure } from "../support/forcedMidFlowFailure";
import type { JourneyContext } from "../journey/context";
import { expectClientRequestContracts } from "../journey/contracts";

export function answerValues(
  value: AssessmentAnswer["value"],
): readonly (string | number)[] {
  return typeof value === "string" || typeof value === "number"
    ? [value]
    : value;
}

export function expectScreeningGoalRoutePrefix(
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

export function expectCompletedScreeningGoalRoute(
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

export async function findVisibleCandidate(
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

export async function clickScreeningSubmitIfPresent(
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

export const SCREENING_POST_SUBMIT_READINESS_TEST_IDS = [
  "adaptive-loading-state",
  "adaptive-screen",
  "review-screen",
] as const;

export const SCREENING_POST_SUBMIT_FAILURE_TEST_IDS = [
  "adaptive-loading-error-state",
  "adaptive-error-state",
  "emergency-screen",
  "assessment-processing-failed",
] as const;

type ScreeningPostSubmitReadiness =
  (typeof SCREENING_POST_SUBMIT_READINESS_TEST_IDS)[number];

async function observeScreeningPostSubmitReadiness(
  page: Page,
  timeout: number,
): Promise<ScreeningPostSubmitReadiness | null> {
  let outcome: string;
  try {
    outcome = await waitForAnyVisibleTestId(
      page,
      [
        ...SCREENING_POST_SUBMIT_FAILURE_TEST_IDS,
        ...SCREENING_POST_SUBMIT_READINESS_TEST_IDS,
      ],
      timeout,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("None of these test IDs became visible:")
    ) {
      return null;
    }
    throw error;
  }

  if (
    SCREENING_POST_SUBMIT_FAILURE_TEST_IDS.includes(
      outcome as (typeof SCREENING_POST_SUBMIT_FAILURE_TEST_IDS)[number],
    )
  ) {
    throw new Error(`Screening submit reached failure state: ${outcome}`);
  }

  return outcome as ScreeningPostSubmitReadiness;
}

export async function waitForScreeningPostSubmitReadiness(
  page: Page,
  timeout = 120_000,
): Promise<ScreeningPostSubmitReadiness> {
  // The submit transition can briefly leave more than one stage container
  // visible during route changes. Classify failures first, then resolve valid
  // handoffs in a fixed order so transient DOM overlap stays deterministic.
  const readiness = await observeScreeningPostSubmitReadiness(page, timeout);
  if (readiness == null) {
    throw new Error(
      `No screening post-submit outcome became visible within ${timeout}ms`,
    );
  }
  return readiness;
}

export async function submitScreening(
  page: Page,
  profiler: TransitionProfiler,
): Promise<ScreeningPostSubmitReadiness> {
  const existingStage = await observeScreeningPostSubmitReadiness(page, 1000);
  if (existingStage != null) return existingStage;

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

  return profiler.measure(
    "screening.submit_to_post_screening",
    "stage",
    async () => {
      const clickedSubmit = await clickScreeningSubmitIfPresent(page);
      expect(clickedSubmit).toBe(true);
      return waitForScreeningPostSubmitReadiness(page, 120_000);
    },
  );
}

export function answerCandidateTestIds(
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function answerLabelCandidates(value: string | number): string[] {
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

export async function answerOneValue(
  page: Page,
  prefix: string,
  id: string,
  value: string | number,
) {
  const clickIfNotSelected = async (control: Locator): Promise<void> => {
    const [ariaChecked, ariaPressed, ariaSelected] = await Promise.all([
      control.getAttribute("aria-checked"),
      control.getAttribute("aria-pressed"),
      control.getAttribute("aria-selected"),
    ]);
    if (
      answerControlIsSelected({
        ariaChecked,
        ariaPressed,
        ariaSelected,
      })
    ) {
      return;
    }
    await control.click();
  };

  const normalized = String(value);
  const locator = await findVisibleCandidate(
    page,
    answerCandidateTestIds(prefix, id, value),
  );
  if (locator != null) {
    await clickIfNotSelected(locator);
    return;
  }

  if (typeof value === "number") {
    const painLevel = page
      .getByRole("radio", {
        name: new RegExp(`^Pain level ${normalized}\\b`, "i"),
      })
      .first();
    if (await painLevel.isVisible({ timeout: 1000 }).catch(() => false)) {
      await clickIfNotSelected(painLevel);
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
          await clickIfNotSelected(control);
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

export async function answerQuestion(
  page: Page,
  prefix: string,
  answer: AssessmentAnswer,
) {
  for (const value of answerValues(answer.value)) {
    await answerOneValue(page, prefix, answer.id, value);
  }
}

export async function answerTextQuestion(
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

export async function currentVisibleScreeningQuestionId(
  page: Page,
): Promise<string> {
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

export async function waitForScreeningNavIdle(page: Page, timeout = 30_000) {
  const next = page.getByTestId("screening-nav-next");
  await expect(next).toBeVisible({ timeout });
  await expect(next).not.toHaveAttribute("aria-busy", "true", { timeout });
  await expect(next).not.toContainText(/Saving/i, { timeout });
}

export function isScreeningAnswersResponse(
  response: PlaywrightResponse,
): boolean {
  const url = new URL(response.url());
  return (
    url.pathname.endsWith("/screening/answers") &&
    response.request().method() === "PATCH"
  );
}

export function isScreeningAnswersResponseForQuestion(
  response: PlaywrightResponse,
  questionId: string,
): boolean {
  return (
    isScreeningAnswersResponse(response) &&
    isScreeningAnswersRequestForQuestion(response.request(), questionId)
  );
}

export function isScreeningAnswersRequestForQuestion(
  request: PlaywrightRequest,
  questionId: string,
): boolean {
  const url = new URL(request.url());
  if (
    !url.pathname.endsWith("/screening/answers") ||
    request.method() !== "PATCH"
  ) {
    return false;
  }
  try {
    const payload = request.postDataJSON();
    return (
      isRecord(payload) &&
      isRecord(payload.answers) &&
      Object.prototype.hasOwnProperty.call(payload.answers, questionId)
    );
  } catch {
    return false;
  }
}

export type ScreeningAnswerSaveEvidence = {
  status?: number;
  failureText?: string;
  errorCode?: string;
  documentedEventualConsistency?: boolean;
};

export function trackScreeningAnswerSync(
  profiler: TransitionProfiler,
  questionId: string,
  responsePromise: Promise<PlaywrightResponse>,
  startedAt: number,
  evidence: ScreeningAnswerSaveEvidence,
  requestFailurePromise: Promise<never>,
  attempt: number,
  maxAttempts: number,
): Promise<{
  confirmed: boolean;
}> {
  return (async () => {
    let response: PlaywrightResponse | undefined;
    try {
      response = await Promise.race([responsePromise, requestFailurePromise]);
      evidence.status = response.status();
    } catch {
      // The correlated request/requestfailed listeners provide the evidence.
    } finally {
      profiler.recordElapsed(
        `screening.question.${questionId}.sync`,
        "sync",
        startedAt,
        { assertBudget: false },
      );
    }

    if (response?.ok()) return { confirmed: true };

    const observation = {
      ...(evidence.status == null ? {} : { status: evidence.status }),
      ...(evidence.failureText == null
        ? {}
        : { failureText: evidence.failureText }),
      ...(evidence.errorCode == null ? {} : { errorCode: evidence.errorCode }),
      ...(evidence.documentedEventualConsistency == null
        ? {}
        : {
            documentedEventualConsistency:
              evidence.documentedEventualConsistency,
          }),
    };
    const decision = classifyRecovery(observation);
    assertRecoveryAttempt(decision, attempt, maxAttempts);
    if (!decision.retry) {
      throw new Error(
        `Screening answer save ${questionId} failed without retryable evidence (${decision.reason})`,
      );
    }

    const status = evidence.status == null ? "none" : evidence.status;
    console.log(
      `[perf-warning] label=screening.question.${questionId}.sync recovery=${decision.reason} status=${status}`,
    );
    return { confirmed: false };
  })();
}

export async function settlePendingScreeningSyncProfiles(
  pendingProfiles: Promise<{
    confirmed: boolean;
  }>[],
): Promise<boolean> {
  if (pendingProfiles.length === 0) return true;
  const results = await Promise.allSettled(pendingProfiles.splice(0));
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") {
    throw rejected.reason instanceof Error
      ? rejected.reason
      : new Error(String(rejected.reason));
  }
  return results.every(
    (result) => result.status === "fulfilled" && result.value.confirmed,
  );
}

export async function isScreeningSubmitButton(page: Page): Promise<boolean> {
  const next = page.getByTestId("screening-nav-next");
  if (!(await next.isVisible({ timeout: 500 }).catch(() => false)))
    return false;

  const [ariaLabel, text] = await Promise.all([
    next.getAttribute("aria-label").catch(() => null),
    next.innerText().catch(() => ""),
  ]);

  const currentQuestionId = await currentVisibleScreeningQuestionId(page).catch(
    () => null,
  );
  if (currentQuestionId !== FINAL_SCREENING_QUESTION_ID) return false;
  if (await next.isEnabled({ timeout: 500 }).catch(() => false)) return true;
  return /submit answers/i.test(`${ariaLabel ?? ""} ${text}`);
}

export async function waitForScreeningAdvance(
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
  }

  throw new Error(
    `Timed out waiting for screening question ${previousQuestionId} to advance`,
  );
}

export async function clickScreeningNextAndWaitForAdvance(
  page: Page,
  previousQuestionId: string,
) {
  await waitForEnabledAndClick(page, "screening-nav-next", 30_000, 1);
  await waitForScreeningAdvance(page, previousQuestionId, 60_000);
}

export async function expectNoAssessmentBlockingState(page: Page) {
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

export async function stressReloadCurrentScreeningQuestion(page: Page) {
  const questionIdBeforeReload = await currentVisibleScreeningQuestionId(page);
  logMilestone(
    "stress: reloading during screening at " + questionIdBeforeReload,
  );

  let reloadStage: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForBrowserNetworkReady(page);
      const reloadResponse = await page.reload({
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      if (reloadResponse == null) {
        throw new Error("Stress reload did not return a response");
      }
      if (!reloadResponse.ok()) {
        const decision = classifyRecovery({ status: reloadResponse.status() });
        if (!decision.retry || attempt >= 3) {
          throw new Error(
            `Stress reload failed with non-retryable status=${reloadResponse?.status()}`,
          );
        }
        assertRecoveryAttempt(decision, attempt, 3);
        continue;
      }
      await waitForBrowserNetworkReady(page);
      reloadStage = await waitForAnyVisibleTestId(
        page,
        ["screening-screen", "home-screen"],
        60_000,
      );
      break;
    } catch (error) {
      const decision = classifyRecovery({
        failureText: error instanceof Error ? error.message : String(error),
      });
      if (!decision.retry || attempt >= 3) throw error;
      assertRecoveryAttempt(decision, attempt, 3);
    }
  }
  if (reloadStage == null) {
    throw new Error(
      "Stress reload did not restore an assessment screen after bounded transport recovery",
    );
  }
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

export async function stressBacktrackOneScreeningQuestion(
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

export async function answerScreening(
  page: Page,
  profiler: TransitionProfiler,
) {
  await waitForScreeningNavReady(page);
  const stressState: ScreeningStressState = {
    reloadedDuringScreening: false,
    backtrackedDuringScreening: false,
  };
  const routeTracker = new ScreeningRouteTracker();
  const screeningSaveAttempts = new Map<string, number>();
  const pendingSyncProfiles: Promise<{
    confirmed: boolean;
  }>[] = [];
  for (let questionIndex = 0; questionIndex < 80; questionIndex += 1) {
    const postScreeningStage = await waitForAnyVisibleTestId(
      page,
      POST_SCREENING_STAGE_TEST_IDS,
      250,
    ).catch(() => null);
    if (postScreeningStage != null) {
      await settlePendingScreeningSyncProfiles(pendingSyncProfiles);
      expectCompletedScreeningGoalRoute(routeTracker.observedQuestionIds);
      return;
    }

    const screeningNavGone = !(await page
      .getByTestId("screening-nav-next")
      .isVisible({ timeout: 250 })
      .catch(() => false));
    if (screeningNavGone) {
      const recoveredStage = await waitForAnyVisibleTestId(
        page,
        [...POST_SCREENING_STAGE_TEST_IDS, "screening-nav-next"],
        30_000,
      );
      if (recoveredStage !== "screening-nav-next") {
        await settlePendingScreeningSyncProfiles(pendingSyncProfiles);
        expectCompletedScreeningGoalRoute(routeTracker.observedQuestionIds);
        return;
      }
      await waitForScreeningNavIdle(page);
    }

    const questionId = await currentVisibleScreeningQuestionId(page);
    const observation = routeTracker.observe(questionId);
    if (observation === "new") {
      expectScreeningGoalRoutePrefix(routeTracker.observedQuestionIds);
    } else {
      await waitForBrowserNetworkReady(page);
      logMilestone(
        `transport: replaying ${questionId} after its prior save could not be confirmed`,
      );
    }
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
      await settlePendingScreeningSyncProfiles(pendingSyncProfiles);
      expectCompletedScreeningGoalRoute(routeTracker.observedQuestionIds);
      return;
    }

    const syncStartedAt = performance.now();
    const saveAttempt = (screeningSaveAttempts.get(questionId) ?? 0) + 1;
    screeningSaveAttempts.set(questionId, saveAttempt);
    const screeningAnswerSaveResponse = page.waitForResponse(
      (response) => isScreeningAnswersResponseForQuestion(response, questionId),
      {
        timeout: TRANSITION_BUDGETS_MS.sync,
      },
    );
    const saveEvidence: ScreeningAnswerSaveEvidence = {};
    let rejectRequestFailure: (reason: Error) => void = () => undefined;
    const requestFailurePromise = new Promise<never>((_, reject) => {
      rejectRequestFailure = reject;
    });
    const currentSyncProfile = trackScreeningAnswerSync(
      profiler,
      questionId,
      screeningAnswerSaveResponse,
      syncStartedAt,
      saveEvidence,
      requestFailurePromise,
      saveAttempt,
      3,
    );
    pendingSyncProfiles.push(currentSyncProfile);

    const visualStartedAt = performance.now();
    const observedRequests = new Map<PlaywrightRequest, number>();
    const recoverableTransportFailures = new Map<PlaywrightRequest, number>();
    const successfulResponseHeaders = new Set<PlaywrightRequest>();
    const completedSuccesses: {
      request: PlaywrightRequest;
      requestObservedAt: number;
      responseFinishedAt: number;
    }[] = [];
    const observeExactScreeningRequest = (request: PlaywrightRequest) => {
      if (!isScreeningAnswersRequestForQuestion(request, questionId)) return;
      observedRequests.set(request, performance.now());
    };
    const observeExactScreeningRequestFailure = (
      request: PlaywrightRequest,
    ) => {
      const requestObservedAt = observedRequests.get(request);
      if (requestObservedAt == null) return;
      const failureText = request.failure()?.errorText ?? "requestfailed";
      saveEvidence.failureText = failureText;
      rejectRequestFailure(
        new Error("correlated screening save request failed"),
      );
      if (failureText.includes("ERR_NETWORK_CHANGED")) {
        recoverableTransportFailures.set(request, requestObservedAt);
      }
    };
    const observeExactScreeningResponse = (response: PlaywrightResponse) => {
      if (!observedRequests.has(response.request())) return;
      saveEvidence.status = response.status();
      if (!response.ok()) return;
      successfulResponseHeaders.add(response.request());
    };
    const observeExactScreeningRequestFinished = (
      request: PlaywrightRequest,
    ) => {
      const requestObservedAt = observedRequests.get(request);
      if (
        requestObservedAt == null ||
        !successfulResponseHeaders.has(request)
      ) {
        return;
      }
      completedSuccesses.push({
        request,
        requestObservedAt,
        responseFinishedAt: performance.now(),
      });
    };
    page.on("request", observeExactScreeningRequest);
    page.on("requestfailed", observeExactScreeningRequestFailure);
    page.on("response", observeExactScreeningResponse);
    page.on("requestfinished", observeExactScreeningRequestFinished);
    let visualError: unknown;
    try {
      await clickScreeningNextAndWaitForAdvance(page, questionId);
    } catch (error) {
      profiler.recordElapsed(
        `screening.question.${questionId}.visual`,
        "question",
        visualStartedAt,
        { assertBudget: false },
      );
      visualError = error;
    }
    const visualEndedAt = performance.now();
    let syncError: unknown;
    try {
      await currentSyncProfile;
    } catch (error) {
      syncError = error;
    } finally {
      page.off("request", observeExactScreeningRequest);
      page.off("requestfailed", observeExactScreeningRequestFailure);
      page.off("response", observeExactScreeningResponse);
      page.off("requestfinished", observeExactScreeningRequestFinished);
    }
    if (syncError != null) throw syncError;
    if (visualError != null) throw visualError;
    const successfulCompletion = completedSuccesses
      .filter(
        (candidate) =>
          !recoverableTransportFailures.has(candidate.request) &&
          candidate.requestObservedAt >= visualStartedAt &&
          candidate.responseFinishedAt <= visualEndedAt,
      )
      .sort(
        (left, right) => left.responseFinishedAt - right.responseFinishedAt,
      )[0];
    const recoverableTransportStartedAt =
      successfulCompletion == null
        ? undefined
        : [...recoverableTransportFailures.entries()]
            .filter(
              ([request, startedAt]) =>
                request !== successfulCompletion.request &&
                startedAt >= visualStartedAt &&
                startedAt <= successfulCompletion.requestObservedAt,
            )
            .map(([, startedAt]) => startedAt)
            .sort((left, right) => left - right)[0];
    const successfulRequestObservedAt =
      recoverableTransportStartedAt ?? successfulCompletion?.requestObservedAt;
    const successfulResponseObservedAt =
      successfulCompletion?.responseFinishedAt;
    const adjustedVisualTiming = splitScreeningVisualTiming({
      visualStartedAt,
      visualEndedAt,
      requestObservedAt: successfulRequestObservedAt,
      responseObservedAt: successfulResponseObservedAt,
      responseOk:
        successfulRequestObservedAt != null &&
        successfulResponseObservedAt != null,
    });
    profiler.recordDuration(
      `screening.question.${questionId}.visual`,
      "question",
      adjustedVisualTiming.durationMs,
      {
        wallDurationMs: adjustedVisualTiming.wallDurationMs,
        excludedScreeningSyncMs: adjustedVisualTiming.excludedScreeningSyncMs,
      },
    );
    const syncConfirmed =
      await settlePendingScreeningSyncProfiles(pendingSyncProfiles);
    routeTracker.recordSaveResult(questionId, syncConfirmed);
    await waitForScreeningNavIdle(page);
    await expectNoAssessmentBlockingState(page);

    if (
      ENABLE_FULL_ASSESSMENT_STRESS &&
      !stressState.reloadedDuringScreening &&
      questionId === STRESS_RELOAD_AFTER_SCREENING_QUESTION_ID
    ) {
      if (syncConfirmed) {
        await stressReloadCurrentScreeningQuestion(page);
      } else {
        logMilestone(
          `stress: skipping reload at ${questionId} because the preceding sync recovered after a transient failure`,
        );
      }
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

export async function runScreeningStage(
  context: JourneyContext,
): Promise<void> {
  const { page, profiler } = context;
  await context.step("screening", async () => {
    await expect(page.getByTestId("screening-screen")).toBeVisible({
      timeout: 60_000,
    });
    await profiler.measure("screening.answer_questions", "stage", () =>
      answerScreening(page, profiler),
    );
    maybeThrowForcedMidFlowFailure("screening");
    const postSubmitStage = await profiler.measure(
      "screening.submit",
      "stage",
      () => submitScreening(page, profiler),
    );
    expect(SCREENING_POST_SUBMIT_READINESS_TEST_IDS).toContain(postSubmitStage);
    expectClientRequestContracts(
      context.questionnaireMutations,
      context.generatedAdaptiveAnswers,
      "screening",
    );
  });
}
