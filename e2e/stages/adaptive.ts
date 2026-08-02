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
  isVisibleByTestIdOrSemantic,
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
import {
  isForcedMidFlowFailureSelected,
  maybeThrowForcedMidFlowFailure,
  maybeThrowForcedMidFlowFailureUnavailable,
} from "../support/forcedMidFlowFailure";

const MAX_ADAPTIVE_PENDING_SAVE_ATTEMPTS = 3;
const ADAPTIVE_PENDING_SAVE_TIMEOUT_MS = 120_000;
const MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS = 3;
const MAX_ADAPTIVE_PREPARE_RELOAD_RECOVERIES = 2;
export const MAX_ADAPTIVE_PREPARE_RECOVERY_ACTIONS =
  MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS + MAX_ADAPTIVE_PREPARE_RELOAD_RECOVERIES;
export const ADAPTIVE_PREPARE_RECOVERY_TIMEOUT_MS = 180_000;
// Product timeout is 45s; allow 1s for the request event to follow timer setup.
export const ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS = 44_000;
export const ADAPTIVE_PREPARE_RECOVERED_UI_EXIT_TIMEOUT_MS = 30_000;
const ADAPTIVE_PREPARE_CANCELLATION_GRACE_MS = 250;

export function decideAdaptivePrepareRecovery(
  decision: ReturnType<typeof classifyRecovery>,
  failureAttempt: number,
  elapsedMs: number,
): "retry" | "reload" {
  if (!decision.retry) {
    throw new Error(
      `Adaptive prepare failed without retryable evidence (${decision.reason})`,
    );
  }
  if (elapsedMs >= ADAPTIVE_PREPARE_RECOVERY_TIMEOUT_MS) {
    throw new Error(
      `Adaptive prepare recovery exceeded its bounded time limit (${decision.reason})`,
    );
  }
  assertRecoveryAttempt(
    decision,
    failureAttempt,
    MAX_ADAPTIVE_PREPARE_RECOVERY_ACTIONS + 1,
  );
  return failureAttempt <= MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS
    ? "retry"
    : "reload";
}

export async function runAdaptivePrepareRecoveryBeforeDeadline<T>(
  remainingMs: number,
  reason: ReturnType<typeof classifyRecovery>["reason"],
  operation: () => Promise<T>,
  cancel: () => Promise<void>,
  cancellationGraceMs = ADAPTIVE_PREPARE_CANCELLATION_GRACE_MS,
): Promise<T> {
  if (remainingMs <= 0) {
    throw new Error(
      `Adaptive prepare recovery exceeded its bounded time limit (${reason})`,
    );
  }

  const deadlineError = new Error("adaptive-prepare-recovery-deadline");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const operationPromise = Promise.resolve().then(operation);
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(deadlineError), remainingMs);
  });

  try {
    return await Promise.race([operationPromise, deadlinePromise]);
  } catch (error) {
    if (error !== deadlineError) throw error;
    const observedOperation = operationPromise.then(
      () => undefined,
      () => undefined,
    );
    const observedCancellation = Promise.resolve()
      .then(cancel)
      .then(
        () => undefined,
        () => undefined,
      );
    let graceTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([observedOperation, observedCancellation]),
        new Promise<void>((resolve) => {
          graceTimeout = setTimeout(resolve, Math.max(0, cancellationGraceMs));
        }),
      ]);
    } finally {
      if (graceTimeout != null) clearTimeout(graceTimeout);
    }
    throw new Error(
      `Adaptive prepare recovery exceeded its bounded time limit (${reason})`,
    );
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

export function adaptivePrepareLoadingOutcomeTimeout(
  recoveredPrepareCompleted: boolean,
  recoveryStarted: boolean,
  remainingRecoveryMs: number,
): number {
  if (recoveredPrepareCompleted) {
    return Math.min(
      ADAPTIVE_PREPARE_RECOVERED_UI_EXIT_TIMEOUT_MS,
      remainingRecoveryMs,
    );
  }
  return recoveryStarted ? remainingRecoveryMs : 360_000;
}

export async function waitForAdaptiveLoadingRecoveryOutcome<T>(
  recoveredPrepareCompleted: boolean,
  recoveryStarted: boolean,
  remainingRecoveryTime: () => number,
  waitForOutcome: (timeoutMs: number, signal?: AbortSignal) => Promise<T>,
  waitForRecoveredPrepareCompletion: () => Promise<void>,
): Promise<T> {
  if (!recoveryStarted) return waitForOutcome(360_000);
  if (recoveredPrepareCompleted) {
    return waitForOutcome(
      adaptivePrepareLoadingOutcomeTimeout(true, true, remainingRecoveryTime()),
    );
  }

  const firstWaitController = new AbortController();
  const firstOutcome = waitForOutcome(
    remainingRecoveryTime(),
    firstWaitController.signal,
  ).then(
    (outcome) => ({ kind: "outcome", outcome }) as const,
    (error: unknown) => ({ kind: "error", error }) as const,
  );
  const first = await Promise.race([
    firstOutcome,
    waitForRecoveredPrepareCompletion().then(
      () => ({ kind: "recovered-completion" }) as const,
    ),
  ]);
  if (first.kind === "outcome") return first.outcome;
  if (first.kind === "error") throw first.error;
  firstWaitController.abort();
  const canceledWait = await firstOutcome;
  if (canceledWait.kind === "outcome") return canceledWait.outcome;
  return waitForOutcome(
    adaptivePrepareLoadingOutcomeTimeout(true, true, remainingRecoveryTime()),
  );
}

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
  idempotencyKey?: string | undefined;
  sequence: number;
  startedAt: number;
  settled: Promise<void>;
  markSettled: () => void;
  responseStatus?: number | undefined;
  requestFailure?: string | undefined;
  transportSettled: boolean;
};

export class AdaptivePrepareTracker {
  private attempts: AdaptivePrepareAttempt[] = [];
  private attemptsByRequest = new Map<
    PlaywrightRequest,
    AdaptivePrepareAttempt
  >();
  private consumedSequence = 0;
  private consumedAttempt: AdaptivePrepareAttempt | null = null;
  private expectedRecoveryIdempotencyKey: string | null = null;
  private recoveryReceiptContinuityError: string | null = null;
  private recoveryStarted = false;
  private recoveredPrepareCompleted = false;
  private readonly recoveredPrepareCompletion: Promise<void>;
  private markRecoveredPrepareCompletion: () => void = () => {};
  private page: Page | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.recoveredPrepareCompletion = new Promise<void>((resolve) => {
      this.markRecoveredPrepareCompletion = resolve;
    });
  }

  private recordRecoveredPrepareCompletion(): void {
    this.recoveredPrepareCompleted = true;
    this.markRecoveredPrepareCompletion();
  }

  private readonly onRequest = (request: PlaywrightRequest) => {
    if (
      request.method() !== "POST" ||
      !ADAPTIVE_PREPARE_PROXY_PATH_RE.test(new URL(request.url()).pathname)
    ) {
      return;
    }
    let markSettled: () => void = () => {};
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const attempt: AdaptivePrepareAttempt = {
      idempotencyKey: request.headers()["x-idempotency-key"],
      sequence: this.attempts.length + 1,
      startedAt: this.now(),
      settled,
      markSettled,
      transportSettled: false,
    };
    if (this.expectedRecoveryIdempotencyKey != null) {
      if (attempt.idempotencyKey !== this.expectedRecoveryIdempotencyKey) {
        this.recoveryReceiptContinuityError =
          "Adaptive prepare recovery changed its idempotency key before authoritative reconciliation";
      }
      this.expectedRecoveryIdempotencyKey = null;
    }
    this.attempts.push(attempt);
    this.attemptsByRequest.set(request, attempt);
  };

  private readonly onResponse = (response: PlaywrightResponse) => {
    const attempt = this.attemptsByRequest.get(response.request());
    if (attempt != null) {
      attempt.responseStatus = response.status();
    }
  };

  private readonly onRequestFinished = (request: PlaywrightRequest) => {
    const attempt = this.attemptsByRequest.get(request);
    if (attempt == null) return;
    attempt.transportSettled = true;
    if (
      this.recoveryStarted &&
      attempt.responseStatus != null &&
      attempt.responseStatus >= 200 &&
      attempt.responseStatus < 300
    ) {
      this.recordRecoveredPrepareCompletion();
    }
    attempt.markSettled();
  };

  private readonly onRequestFailed = (request: PlaywrightRequest) => {
    const attempt = this.attemptsByRequest.get(request);
    if (attempt == null) return;
    attempt.requestFailure = request.failure()?.errorText ?? "requestfailed";
    attempt.transportSettled = true;
    attempt.markSettled();
  };

  start(page: Page): void {
    if (this.page != null) {
      throw new Error("Adaptive prepare tracker is already active");
    }
    this.page = page;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
    page.on("requestfinished", this.onRequestFinished);
    page.on("requestfailed", this.onRequestFailed);
  }

  stop(): void {
    if (this.page == null) return;
    this.page.off("request", this.onRequest);
    this.page.off("response", this.onResponse);
    this.page.off("requestfinished", this.onRequestFinished);
    this.page.off("requestfailed", this.onRequestFailed);
    this.page = null;
  }

  consumeRetryableFailure(
    attempt: number,
    maxAttempts: number,
    evidence: Readonly<{ productTimeoutVisible?: boolean }> = {},
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
    this.consumedAttempt = observedAttempt;
    this.recoveryStarted = true;
    if (
      observedAttempt.transportSettled &&
      observedAttempt.responseStatus != null &&
      observedAttempt.responseStatus >= 200 &&
      observedAttempt.responseStatus < 300
    ) {
      this.recordRecoveredPrepareCompletion();
    }

    const observation: RecoveryObservation = {
      ...(observedAttempt.responseStatus == null
        ? {}
        : { status: observedAttempt.responseStatus }),
      ...(observedAttempt.requestFailure == null
        ? {}
        : { failureText: observedAttempt.requestFailure }),
    };
    const pendingAgeMs = this.now() - observedAttempt.startedAt;
    const clientAborted =
      observedAttempt.requestFailure?.includes("ERR_ABORTED") === true;
    const exactAgedProductTimeout =
      evidence.productTimeoutVisible === true &&
      pendingAgeMs >= ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    if (exactAgedProductTimeout && observedAttempt.idempotencyKey == null) {
      throw new Error(
        "Timed-out adaptive prepare request had no idempotency key",
      );
    }
    if (Object.keys(observation).length === 0 && !exactAgedProductTimeout) {
      throw new Error(
        evidence.productTimeoutVisible === true
          ? "Adaptive loading timeout had no sufficiently aged outstanding prepare request"
          : "Adaptive loading error appeared before the correlated prepare attempt completed",
      );
    }

    const exactTimeoutReachedServer =
      exactAgedProductTimeout &&
      observedAttempt.responseStatus != null &&
      observedAttempt.responseStatus >= 200 &&
      observedAttempt.responseStatus < 300;
    const exactTimeoutHasRetryableClientOutcome =
      exactAgedProductTimeout &&
      observedAttempt.responseStatus == null &&
      (observedAttempt.requestFailure == null || clientAborted);
    const decision = exactTimeoutReachedServer
      ? ({ retry: true, reason: "eventual-consistency" } as const)
      : exactTimeoutHasRetryableClientOutcome
        ? ({ retry: true, reason: "transient-network" } as const)
        : classifyRecovery(observation);
    assertRecoveryAttempt(decision, attempt, maxAttempts);
    if (!decision.retry) {
      throw new Error(
        `Adaptive prepare failed without retryable evidence (${decision.reason})`,
      );
    }
    if (exactAgedProductTimeout) {
      this.expectedRecoveryIdempotencyKey =
        observedAttempt.idempotencyKey ?? null;
    }
    return decision;
  }

  assertRecoveryReceiptContinuity(requireRecoveryRequest = false): void {
    if (this.recoveryReceiptContinuityError != null) {
      throw new Error(this.recoveryReceiptContinuityError);
    }
    if (requireRecoveryRequest && this.expectedRecoveryIdempotencyKey != null) {
      throw new Error(
        "Adaptive prepare recovery reached a terminal state without a correlated request",
      );
    }
  }

  async waitForConsumedPrepareClientOutcome(
    timeoutMs: number,
  ): Promise<ReturnType<typeof classifyRecovery>> {
    const attempt = this.consumedAttempt;
    if (attempt == null) {
      throw new Error("No consumed adaptive prepare attempt is available");
    }
    if (!attempt.transportSettled && timeoutMs <= 0) {
      throw new Error(
        "Timed-out adaptive prepare did not settle before the recovery deadline",
      );
    }
    if (!attempt.transportSettled) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          attempt.settled,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () =>
                reject(
                  new Error(
                    "Timed-out adaptive prepare did not settle before the recovery deadline",
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timeout != null) clearTimeout(timeout);
      }
    }
    if (
      attempt.responseStatus != null &&
      attempt.responseStatus >= 200 &&
      attempt.responseStatus < 300
    ) {
      return { retry: true, reason: "eventual-consistency" };
    }
    if (attempt.requestFailure?.includes("ERR_ABORTED")) {
      return { retry: true, reason: "transient-network" };
    }
    return classifyRecovery({
      ...(attempt.responseStatus == null
        ? {}
        : { status: attempt.responseStatus }),
      ...(attempt.requestFailure == null
        ? {}
        : { failureText: attempt.requestFailure }),
    });
  }

  hasRecoveredPrepareCompletion(): boolean {
    return this.recoveredPrepareCompleted;
  }

  waitForRecoveredPrepareCompletion(): Promise<void> {
    return this.recoveredPrepareCompletion;
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

  assertSuccessfulSave(questionId: string): void {
    const observedAttempt = this.attempts
      .filter((candidate) => candidate.questionIds.has(questionId))
      .at(-1);
    if (
      observedAttempt == null ||
      observedAttempt.responseStatus == null ||
      observedAttempt.responseStatus < 200 ||
      observedAttempt.responseStatus >= 300
    ) {
      throw new Error(
        `Adaptive saved advance for ${questionId} did not have a correlated successful response`,
      );
    }
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

export type AdaptiveForcedFailureCapability = Readonly<{
  onSavedAdvance: () => void;
  onTerminalBeforeSavedAdvance: () => void;
}>;

export type AdaptiveSavedAdvancePath = "normal" | "retry" | "loading";

export function reachAdaptiveSavedAdvanceMilestone(
  _path: AdaptiveSavedAdvancePath,
  stage: string,
  milestoneReached: boolean,
  capability: AdaptiveForcedFailureCapability | null,
  assertSuccessfulSave: () => void,
): boolean {
  if (capability == null || milestoneReached || stage !== "adaptive-screen") {
    return milestoneReached;
  }
  assertSuccessfulSave();
  capability.onSavedAdvance();
  return true;
}

export async function completeAdaptiveIfPresent(
  page: Page,
  generatedAdaptiveAnswers: Map<string, unknown>,
  profiler: TransitionProfiler,
  prepareTracker: AdaptivePrepareTrackerContract,
  forcedFailureCapability: AdaptiveForcedFailureCapability | null = null,
): Promise<string | null> {
  const adaptiveScreen = page.getByTestId("adaptive-screen");
  let savedAdvanceMilestoneReached = false;
  const returnTerminalStage = (stage: string | null): string | null => {
    if (
      forcedFailureCapability != null &&
      !savedAdvanceMilestoneReached &&
      stage === "review-screen"
    ) {
      forcedFailureCapability.onTerminalBeforeSavedAdvance();
    }
    return stage;
  };
  let initialStage = await waitForAssessmentStage(page, [
    "adaptive-loading-state",
    "adaptive-loading-error-state",
    "adaptive-screen",
    "adaptive-error-state",
    "review-screen",
  ]);
  let recoveryFailureAttempts = 0;
  let recoveryStartedAt: number | null = null;
  let lastRecoveryReason: ReturnType<typeof classifyRecovery>["reason"] =
    "assertion";
  const remainingRecoveryTime = (): number => {
    if (recoveryStartedAt == null) {
      return ADAPTIVE_PREPARE_RECOVERY_TIMEOUT_MS;
    }
    const remaining = Math.floor(
      ADAPTIVE_PREPARE_RECOVERY_TIMEOUT_MS -
        (performance.now() - recoveryStartedAt),
    );
    if (remaining <= 0) {
      throw new Error(
        `Adaptive prepare recovery exceeded its bounded time limit (${lastRecoveryReason})`,
      );
    }
    return remaining;
  };
  const runRecoveryAction = <T>(operation: () => Promise<T>): Promise<T> =>
    runAdaptivePrepareRecoveryBeforeDeadline(
      remainingRecoveryTime(),
      lastRecoveryReason,
      operation,
      () => page.close({ runBeforeUnload: false }),
    );
  while (
    initialStage === "adaptive-loading-state" ||
    initialStage === "adaptive-loading-error-state"
  ) {
    prepareTracker.assertRecoveryReceiptContinuity();
    if (initialStage === "adaptive-loading-error-state") {
      recoveryStartedAt ??= performance.now();
      recoveryFailureAttempts += 1;
      const productTimeoutVisible = await isVisibleByTestIdOrSemantic(
        page,
        "adaptive-loading-timeout",
        500,
      );
      let decision = prepareTracker.consumeRetryableFailure(
        recoveryFailureAttempts,
        MAX_ADAPTIVE_PREPARE_RECOVERY_ACTIONS + 1,
        { productTimeoutVisible },
      );
      lastRecoveryReason = decision.reason;
      if (productTimeoutVisible) {
        // Prefer an observable server response before retrying. A browser-side
        // abort does not prove server settlement; the app's deterministic
        // assessment/revision key lets middleware coordinate that retry instead.
        decision = await runRecoveryAction(() =>
          prepareTracker.waitForConsumedPrepareClientOutcome(
            remainingRecoveryTime(),
          ),
        );
      }
      lastRecoveryReason = decision.reason;
      const recoveryAction = decideAdaptivePrepareRecovery(
        decision,
        recoveryFailureAttempts,
        performance.now() - recoveryStartedAt,
      );
      logMilestone(
        `transport: adaptive prepare recovery ${recoveryFailureAttempts}/${MAX_ADAPTIVE_PREPARE_RECOVERY_ACTIONS} (${decision.reason}, ${recoveryAction})`,
      );
      if (recoveryAction === "reload") {
        const reloadRecovery =
          recoveryFailureAttempts - MAX_ADAPTIVE_PREPARE_RETRY_ATTEMPTS;
        initialStage = await runRecoveryAction(() =>
          profiler.measure(
            `adaptive.reload_recovery.${reloadRecovery}`,
            "recovery",
            async () => {
              await waitForBrowserNetworkReady(
                page,
                Math.min(15_000, remainingRecoveryTime()),
              );
              const reloadResponse = await page.reload({
                waitUntil: "domcontentloaded",
                timeout: Math.min(45_000, remainingRecoveryTime()),
              });
              expect(reloadResponse?.ok()).toBeTruthy();
              await waitForBrowserNetworkReady(
                page,
                Math.min(15_000, remainingRecoveryTime()),
              );
              return waitForAssessmentStage(
                page,
                [
                  "adaptive-loading-state",
                  "adaptive-loading-error-state",
                  "adaptive-screen",
                  "adaptive-error-state",
                  "review-screen",
                ],
                remainingRecoveryTime(),
              );
            },
          ),
        );
        continue;
      }
      initialStage = await runRecoveryAction(() =>
        profiler.measure("adaptive.retry_loading", "stage", async () => {
          await waitForEnabledAndClick(
            page,
            "adaptive-loading-retry",
            Math.min(30_000, remainingRecoveryTime()),
          );
          return waitForRetryOutcome(
            page,
            "adaptive-loading-error-state",
            [
              "adaptive-loading-state",
              "adaptive-screen",
              "adaptive-error-state",
              "review-screen",
            ],
            Math.min(30_000, remainingRecoveryTime()),
          );
        }),
      );
      continue;
    }

    if (initialStage === "adaptive-loading-state") {
      const waitForLoadingOutcome = (timeoutMs: number, signal?: AbortSignal) =>
        profiler.measure("adaptive.loading_to_question", "stage", () =>
          waitForAssessmentStage(
            page,
            [
              "adaptive-loading-error-state",
              "adaptive-screen",
              "adaptive-error-state",
              "review-screen",
            ],
            timeoutMs,
            signal,
          ),
        );
      initialStage =
        recoveryStartedAt == null
          ? await waitForLoadingOutcome(360_000)
          : await runRecoveryAction(() =>
              waitForAdaptiveLoadingRecoveryOutcome(
                prepareTracker.hasRecoveredPrepareCompletion(),
                true,
                remainingRecoveryTime,
                waitForLoadingOutcome,
                () => prepareTracker.waitForRecoveredPrepareCompletion(),
              ),
            );
      continue;
    }
  }
  prepareTracker.assertRecoveryReceiptContinuity(true);
  if (initialStage !== "adaptive-screen") {
    return returnTerminalStage(initialStage);
  }

  await expect(page.getByTestId("adaptive-list")).toBeVisible({
    timeout: 30_000,
  });
  const answerSaveTracker = new AdaptiveAnswerSaveTracker();
  answerSaveTracker.start(page);
  const recordSavedAdvance = (
    path: AdaptiveSavedAdvancePath,
    stage: string,
    questionTestId: string,
  ): void => {
    savedAdvanceMilestoneReached = reachAdaptiveSavedAdvanceMilestone(
      path,
      stage,
      savedAdvanceMilestoneReached,
      forcedFailureCapability,
      () =>
        answerSaveTracker.assertSuccessfulSave(
          questionTestId.replace(/^adaptive-question-/, ""),
        ),
    );
  };
  try {
    for (let index = 0; index < 20; index += 1) {
      if (
        !(await adaptiveScreen.isVisible({ timeout: 1000 }).catch(() => false))
      ) {
        return returnTerminalStage(
          await waitForAnyVisibleTestId(page, ["review-screen"], 60_000),
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
      recordSavedAdvance("normal", nextStage, currentQuestionTestId);
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
        recordSavedAdvance("retry", recoveredStage, currentQuestionTestId);
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
          recordSavedAdvance("loading", resolvedStage, currentQuestionTestId);
          if (resolvedStage !== "adaptive-screen") {
            return returnTerminalStage(resolvedStage);
          }
          continue;
        }
        if (recoveredStage !== "adaptive-screen") {
          return returnTerminalStage(recoveredStage);
        }
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
        recordSavedAdvance("loading", resolvedStage, currentQuestionTestId);
        if (resolvedStage !== "adaptive-screen") {
          return returnTerminalStage(resolvedStage);
        }
        continue;
      }
      if (nextStage !== "adaptive-screen") {
        return returnTerminalStage(nextStage);
      }
    }

    throw new Error("Adaptive questionnaire did not exit after 20 questions");
  } finally {
    answerSaveTracker.stop();
  }
}

export async function runAdaptiveStage(context: JourneyContext): Promise<void> {
  const { page, profiler, adaptivePrepareTracker } = context;
  await context.step("adaptive assessment", async () => {
    const forcedFailureCapability: AdaptiveForcedFailureCapability | null =
      isForcedMidFlowFailureSelected("adaptive")
        ? {
            onSavedAdvance: () => maybeThrowForcedMidFlowFailure("adaptive"),
            onTerminalBeforeSavedAdvance: () =>
              maybeThrowForcedMidFlowFailureUnavailable("adaptive"),
          }
        : null;
    const stage = await profiler.measure(
      "screening.to_adaptive_complete",
      "stage",
      () =>
        completeAdaptiveIfPresent(
          page,
          context.generatedAdaptiveAnswers,
          profiler,
          adaptivePrepareTracker,
          forcedFailureCapability,
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
