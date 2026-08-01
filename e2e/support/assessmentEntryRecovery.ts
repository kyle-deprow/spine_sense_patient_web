import {
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from "@playwright/test";

import {
  assertRecoveryAttempt,
  classifyRecovery,
  type RecoveryObservation,
} from "./recoveryPolicy";

export const ASSESSMENT_ENTRY_COMPLETION_PATH =
  "/api/proxy/api/v1/patients/me/intake/progress/complete";

export function isAssessmentEntryCompletionRequest(
  request: PlaywrightRequest,
): boolean {
  const pathname = new URL(request.url()).pathname.replace(/\/$/, "");
  return (
    request.method() === "POST" && pathname === ASSESSMENT_ENTRY_COMPLETION_PATH
  );
}

type AssessmentEntryAttempt = {
  sequence: number;
  responseStatus?: number;
  requestFailure?: string;
};

/**
 * Keep recovery evidence tied to the Complete Intake request that the
 * records-step navigation action initiates. Other intake/assessment traffic
 * may be in flight at the same time and must not authorize a reload.
 */
export class AssessmentEntryNavigationTracker {
  private attempts: AssessmentEntryAttempt[] = [];
  private attemptsByRequest = new Map<
    PlaywrightRequest,
    AssessmentEntryAttempt
  >();
  private consumedSequence = 0;
  private page: Page | null = null;

  private readonly onRequest = (request: PlaywrightRequest) => {
    if (!isAssessmentEntryCompletionRequest(request)) return;

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
      throw new Error("Assessment entry tracker is already active");
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
        "Assessment entry navigation failed without a new correlated completion request",
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
    if (Object.keys(observation).length === 0) {
      throw new Error(
        "Assessment entry navigation failed before the correlated completion request completed",
      );
    }

    const decision = classifyRecovery(observation);
    assertRecoveryAttempt(decision, attempt, maxAttempts);
    if (!decision.retry) {
      throw new Error(
        `Assessment entry navigation failed without retryable evidence (${decision.reason})`,
      );
    }
    return decision;
  }
}
