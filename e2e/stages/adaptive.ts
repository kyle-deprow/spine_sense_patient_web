import {
  expect,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from "@playwright/test";
import { performance } from "node:perf_hooks";

import {
  ADAPTIVE_PREPARE_PROXY_PATH_RE,
  ADAPTIVE_ANSWERS_BY_ID,
  isRecord,
  SCREENING_GOAL_QUESTION_IDS,
  logMilestone,
  type TransitionProfiler,
} from "../journey/context";
import {
  answerValues,
  answerCandidateTestIds,
  findVisibleCandidate,
} from "./screening";
import {
  waitForAssessmentStage,
  waitForAnyVisibleTestId,
  waitForDynamicQuestionAdvance,
  waitForEnabledAndClick,
  waitForRetryOutcome,
  visibleDynamicQuestionTestId,
  waitForBrowserNetworkReady,
} from "../journey/selectors";
import { expectClientRequestContracts } from "../journey/contracts";
import type {
  JourneyContext,
  AdaptivePrepareTrackerContract,
} from "../journey/context";
import {
  assertRecoveryAttempt,
  classifyRecovery,
  type RecoveryObservation,
} from "../support/recoveryPolicy";

const MAX_ADAPTIVE_PENDING_SAVE_ATTEMPTS = 3;
const ADAPTIVE_PENDING_SAVE_TIMEOUT_MS = 120_000;
const MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS = 3;
const MAX_ADAPTIVE_PREPARE_RELOAD_RECOVERIES = 2;

export async function answerIssuedAdaptiveQuestion(
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

type AdaptivePrepareAttempt = {
  sequence: number;
  responseStatus?: number | undefined;
  requestFailure?: string | undefined;
};

export class AdaptivePrepareTracker {
  private attempts: AdaptivePrepareAttempt[] = [];
  private attemptsByRequest = new Map<
    PlaywrightRequest,
    AdaptivePrepareAttempt
  >();
  private consumedSequence = 0;
  private page: Page | null = null;

  private readonly onRequest = (request: PlaywrightRequest) => {
    if (
      request.method() !== "POST" ||
      !ADAPTIVE_PREPARE_PROXY_PATH_RE.test(new URL(request.url()).pathname)
    ) {
      return;
    }
    const attempt = { sequence: this.attempts.length + 1 };
    this.attempts.push(attempt);
    this.attemptsByRequest.set(request, attempt);
  };

  private readonly onResponse = (response: PlaywrightResponse) => {
    const attempt = this.attemptsByRequest.get(response.request());
    if (attempt != null) attempt.responseStatus = response.status();
  };

  private readonly onRequestFailed = (request: PlaywrightRequest) => {
    const attempt = this.attemptsByRequest.get(request);
    if (attempt == null) return;
    attempt.requestFailure = request.failure()?.errorText ?? "requestfailed";
  };

  start(page: Page): void {
    if (this.page != null) {
      throw new Error("Adaptive prepare tracker is already active");
    }
    this.page = page;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
  }

  stop(): void {
    if (this.page == null) return;
    this.page.off("request", this.onRequest);
    this.page.off("response", this.onResponse);
    this.page.off("requestfailed", this.onRequestFailed);
    this.page = null;
  }

  consumeRetryableFailure(
    attempt: number,
    maxAttempts: number,
  ): ReturnType<typeof classifyRecovery> {
    const observedAttempt = this.attempts.at(-1);
    if (
      observedAttempt == null ||
      observedAttempt.sequence <= this.consumedSequence
    ) {
      throw new Error(
        "Adaptive loading error had no new correlated prepare attempt",
      );
    }
    this.consumedSequence = observedAttempt.sequence;

    const observation: RecoveryObservation = {
      ...(observedAttempt.responseStatus == null
        ? {}
        : { status: observedAttempt.responseStatus }),
      ...(observedAttempt.requestFailure == null
        ? {}
        : { failureText: observedAttempt.requestFailure }),
    };
    // Adaptive prepare has no explicit eventual-consistency contract. Keep
    // that classifier input absent unless the server exposes one explicitly.
    if (Object.keys(observation).length === 0) {
      throw new Error(
        "Adaptive loading error appeared before the correlated prepare attempt completed",
      );
    }

    const decision = classifyRecovery(observation);
    assertRecoveryAttempt(decision, attempt, maxAttempts);
    if (!decision.retry) {
      throw new Error(
        `Adaptive prepare failed without retryable evidence (${decision.reason})`,
      );
    }
    return decision;
  }
}

type AdaptiveAnswerSaveAttempt = {
  sequence: number;
  questionIds: ReadonlySet<string>;
  responseStatus?: number;
  requestFailure?: string;
};

export class AdaptiveAnswerSaveTracker {
  private attempts: AdaptiveAnswerSaveAttempt[] = [];
  private attemptsByRequest = new Map<
    PlaywrightRequest,
    AdaptiveAnswerSaveAttempt
  >();
  private consumedSequenceByQuestion = new Map<string, number>();
  private page: Page | null = null;

  private readonly onRequest = (request: PlaywrightRequest) => {
    const questionIds = this.questionIdsForRequest(request);
    if (questionIds.size === 0) return;
    const attempt: AdaptiveAnswerSaveAttempt = {
      sequence: this.attempts.length + 1,
      questionIds,
    };
    this.attempts.push(attempt);
    this.attemptsByRequest.set(request, attempt);
  };

  private readonly onResponse = (response: PlaywrightResponse) => {
    const attempt = this.attemptsByRequest.get(response.request());
    if (attempt != null) attempt.responseStatus = response.status();
  };

  private readonly onRequestFailed = (request: PlaywrightRequest) => {
    const attempt = this.attemptsByRequest.get(request);
    if (attempt == null) return;
    attempt.requestFailure = request.failure()?.errorText ?? "requestfailed";
  };

  private questionIdsForRequest(
    request: PlaywrightRequest,
  ): ReadonlySet<string> {
    const url = new URL(request.url());
    if (
      !(
        (request.method() === "PATCH" &&
          url.pathname.endsWith("/adaptive/answers")) ||
        (request.method() === "POST" &&
          url.pathname.endsWith("/adaptive/complete-with-answers"))
      )
    ) {
      return new Set();
    }
    try {
      const payload = request.postDataJSON();
      if (!isRecord(payload) || !isRecord(payload.answers)) return new Set();
      return new Set(Object.keys(payload.answers));
    } catch {
      return new Set();
    }
  }

  start(page: Page): void {
    if (this.page != null) {
      throw new Error("Adaptive answer save tracker is already active");
    }
    this.page = page;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfailed", this.onRequestFailed);
  }

  stop(): void {
    if (this.page == null) return;
    this.page.off("request", this.onRequest);
    this.page.off("response", this.onResponse);
    this.page.off("requestfailed", this.onRequestFailed);
    this.page = null;
  }

  consumeRetryablePendingSave(
    questionId: string,
    attempt: number,
    maxAttempts: number,
  ): ReturnType<typeof classifyRecovery> {
    const lastConsumed = this.consumedSequenceByQuestion.get(questionId) ?? 0;
    const observedAttempt = this.attempts
      .filter(
        (candidate) =>
          candidate.questionIds.has(questionId) &&
          candidate.sequence > lastConsumed,
      )
      .at(-1);
    if (observedAttempt == null) {
      throw new Error(
        `Adaptive pending save for ${questionId} had no correlated response or request failure`,
      );
    }
    this.consumedSequenceByQuestion.set(questionId, observedAttempt.sequence);

    const observation: RecoveryObservation = {
      ...(observedAttempt.responseStatus == null
        ? {}
        : { status: observedAttempt.responseStatus }),
      ...(observedAttempt.requestFailure == null
        ? {}
        : { failureText: observedAttempt.requestFailure }),
    };
    if (Object.keys(observation).length === 0) {
      throw new Error(
        `Adaptive pending save for ${questionId} had no completed correlated response or request failure`,
      );
    }

    const decision = classifyRecovery(observation);
    assertRecoveryAttempt(decision, attempt, maxAttempts);
    if (!decision.retry) {
      throw new Error(
        `Adaptive pending save for ${questionId} had non-retryable evidence (${decision.reason})`,
      );
    }
    return decision;
  }
}

export async function completeAdaptiveIfPresent(
  page: Page,
  generatedAdaptiveAnswers: Map<string, unknown>,
  profiler: TransitionProfiler,
  prepareTracker: AdaptivePrepareTrackerContract,
): Promise<string | null> {
  const adaptiveScreen = page.getByTestId("adaptive-screen");
  let initialStage = await waitForAssessmentStage(page, [
    "adaptive-loading-state",
    "adaptive-loading-error-state",
    "adaptive-screen",
    "adaptive-error-state",
    "review-screen",
  ]);
  let retryAttempts = 0;
  let reloadRecoveries = 0;
  while (
    initialStage === "adaptive-loading-state" ||
    initialStage === "adaptive-loading-error-state"
  ) {
    if (initialStage === "adaptive-loading-error-state") {
      if (
        retryAttempts >= MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS &&
        reloadRecoveries >= MAX_ADAPTIVE_PREPARE_RELOAD_RECOVERIES
      ) {
        throw new Error(
          "Adaptive loading recovery exhausted after bounded retries",
        );
      }
      const recoveryAttempt =
        retryAttempts >= MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS
          ? reloadRecoveries + 1
          : retryAttempts + 1;
      const maxRecoveryAttempts =
        retryAttempts >= MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS
          ? MAX_ADAPTIVE_PREPARE_RELOAD_RECOVERIES + 1
          : MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS + 1;
      const decision = prepareTracker.consumeRetryableFailure(
        recoveryAttempt,
        maxRecoveryAttempts,
      );
      logMilestone(
        `transport: adaptive prepare ${decision.reason} failure is eligible for bounded recovery`,
      );
      if (retryAttempts >= MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS) {
        reloadRecoveries += 1;
        initialStage = await profiler.measure(
          `adaptive.reload_recovery.${reloadRecoveries}`,
          "recovery",
          async () => {
            await waitForBrowserNetworkReady(page, 15_000);
            const reloadResponse = await page.reload({
              waitUntil: "domcontentloaded",
              timeout: 45_000,
            });
            expect(reloadResponse?.ok()).toBeTruthy();
            await waitForBrowserNetworkReady(page, 15_000);
            return waitForAssessmentStage(page, [
              "adaptive-loading-state",
              "adaptive-loading-error-state",
              "adaptive-screen",
              "adaptive-error-state",
              "review-screen",
            ]);
          },
        );
        retryAttempts = 0;
        continue;
      }
      retryAttempts += 1;
      initialStage = await profiler.measure(
        "adaptive.retry_loading",
        "stage",
        async () => {
          await waitForEnabledAndClick(page, "adaptive-loading-retry");
          return waitForRetryOutcome(page, "adaptive-loading-error-state", [
            "adaptive-loading-state",
            "adaptive-screen",
            "adaptive-error-state",
            "review-screen",
          ]);
        },
      );
      continue;
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
            "review-screen",
          ]),
      );
      continue;
    }
  }
  if (initialStage !== "adaptive-screen") return initialStage;

  await expect(page.getByTestId("adaptive-list")).toBeVisible({
    timeout: 30_000,
  });
  const answerSaveTracker = new AdaptiveAnswerSaveTracker();
  answerSaveTracker.start(page);
  try {
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
      const transitionStartedAt = performance.now();
      await waitForEnabledAndClick(page, "adaptive-submit");
      const nextStage = await waitForDynamicQuestionAdvance(
        page,
        "adaptive-screen",
        "adaptive-question",
        currentQuestionTestId,
        "adaptive-submit",
        [
          "adaptive-loading-state",
          "adaptive-error-state",
          "adaptive-sync-retry",
          "review-screen",
        ],
      );
      profiler.recordElapsed(
        nextStage === "adaptive-screen"
          ? questionLabel
          : nextStage === "adaptive-sync-retry"
            ? "adaptive.pending_save_retry_prompt"
            : "adaptive.submit_to_next_stage",
        nextStage === "adaptive-screen"
          ? "question"
          : nextStage === "adaptive-sync-retry"
            ? "recovery"
            : "stage",
        transitionStartedAt,
      );
      if (nextStage === "adaptive-sync-retry") {
        const recoveryDeadline =
          performance.now() + ADAPTIVE_PENDING_SAVE_TIMEOUT_MS;
        let recoveredStage = nextStage;
        for (
          let attempt = 1;
          recoveredStage === "adaptive-sync-retry";
          attempt += 1
        ) {
          const remainingMs = recoveryDeadline - performance.now();
          if (remainingMs <= 0) {
            throw new Error(
              "Adaptive pending-save recovery exceeded its bounded time limit",
            );
          }
          const decision = answerSaveTracker.consumeRetryablePendingSave(
            currentQuestionTestId.replace(/^adaptive-question-/, ""),
            attempt,
            MAX_ADAPTIVE_PENDING_SAVE_ATTEMPTS,
          );
          logMilestone(
            `transport: adaptive pending save recovery ${attempt}/${MAX_ADAPTIVE_PENDING_SAVE_ATTEMPTS} (${decision.reason})`,
          );
          const retryStartedAt = performance.now();
          await waitForEnabledAndClick(
            page,
            "adaptive-sync-retry",
            Math.min(30_000, Math.max(1, remainingMs)),
          );
          const outcomeTimeout = Math.min(
            120_000,
            Math.max(1, recoveryDeadline - performance.now()),
          );
          recoveredStage = await waitForDynamicQuestionAdvance(
            page,
            "adaptive-screen",
            "adaptive-question",
            currentQuestionTestId,
            "adaptive-submit",
            [
              "adaptive-loading-state",
              "adaptive-error-state",
              "adaptive-sync-retry",
              "review-screen",
            ],
            outcomeTimeout,
          );
          profiler.recordElapsed(
            recoveredStage === "adaptive-screen"
              ? `${questionLabel}.retry`
              : "adaptive.pending_save_retry_to_next_stage",
            recoveredStage === "adaptive-screen" ? "question" : "recovery",
            retryStartedAt,
          );
          if (performance.now() > recoveryDeadline) {
            throw new Error(
              "Adaptive pending-save recovery exceeded its bounded time limit",
            );
          }
        }
        if (recoveredStage === "adaptive-loading-state") {
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
        if (recoveredStage !== "adaptive-screen") return recoveredStage;
        continue;
      }
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
  } finally {
    answerSaveTracker.stop();
  }
}

export async function runAdaptiveStage(context: JourneyContext): Promise<void> {
  const { page, profiler, adaptivePrepareTracker } = context;
  await context.step("adaptive assessment", async () => {
    const stage = await profiler.measure(
      "screening.to_adaptive_complete",
      "stage",
      () =>
        completeAdaptiveIfPresent(
          page,
          context.generatedAdaptiveAnswers,
          profiler,
          adaptivePrepareTracker,
        ),
    );
    if (stage !== "review-screen") {
      throw new Error(
        "Expected review-screen after adaptive flow, got " +
          (stage ?? "no-stage"),
      );
    }
    expectClientRequestContracts(
      context.questionnaireMutations,
      context.generatedAdaptiveAnswers,
      "adaptive",
    );
    await expect(page.getByTestId("review-screen")).toBeVisible({
      timeout: 120_000,
    });
  });
}
