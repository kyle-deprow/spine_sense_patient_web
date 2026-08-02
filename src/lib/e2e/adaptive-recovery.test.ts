import { EventEmitter } from "node:events";
import type {
  Page,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADAPTIVE_PREPARE_RECOVERED_UI_EXIT_TIMEOUT_MS,
  ADAPTIVE_PREPARE_RECOVERY_TIMEOUT_MS,
  ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS,
  AdaptiveAnswerSaveTracker,
  AdaptivePrepareTracker,
  decideAdaptivePrepareRecovery,
  MAX_ADAPTIVE_PREPARE_RECOVERY_ACTIONS,
  runAdaptivePrepareRecoveryBeforeDeadline,
  waitForAdaptiveLoadingRecoveryOutcome,
} from "../../../e2e/stages/adaptive";
import {
  assertRecoveryAttempt,
  classifyRecovery,
} from "../../../e2e/support/recoveryPolicy";

const prepareUrl =
  "https://patient.example.test/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/adaptive/prepare";

afterEach(() => {
  vi.useRealTimers();
});

function requestWithFailure(
  errorText?: string,
  idempotencyKey = "10000000-0000-4000-8000-000000000001:7",
): PlaywrightRequest {
  return {
    headers: () => ({ "x-idempotency-key": idempotencyKey }),
    method: () => "POST",
    url: () => prepareUrl,
    failure: () => (errorText == null ? null : { errorText }),
  } as unknown as PlaywrightRequest;
}

function responseFor(
  request: PlaywrightRequest,
  status: number,
): PlaywrightResponse {
  return {
    request: () => request,
    status: () => status,
  } as unknown as PlaywrightResponse;
}

function trackerWithEvents(now: () => number = () => performance.now()) {
  const page = new EventEmitter() as unknown as Page & EventEmitter;
  const tracker = new AdaptivePrepareTracker(now);
  tracker.start(page);
  return { page, tracker };
}

function adaptiveAnswerRequest(questionId: string): PlaywrightRequest {
  return {
    method: () => "PATCH",
    url: () =>
      "https://patient.example.test/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/adaptive/answers",
    postDataJSON: () => ({ answers: { [questionId]: "synthetic-answer" } }),
  } as unknown as PlaywrightRequest;
}

describe("AdaptiveAnswerSaveTracker saved-advance evidence", () => {
  it("accepts only a correlated successful answer response", () => {
    const page = new EventEmitter() as unknown as Page & EventEmitter;
    const tracker = new AdaptiveAnswerSaveTracker();
    const request = adaptiveAnswerRequest("gen_1");
    tracker.start(page);
    page.emit("request", request);
    page.emit("response", responseFor(request, 200));

    expect(() => tracker.assertSuccessfulSave("gen_1")).not.toThrow();
    expect(() => tracker.assertSuccessfulSave("gen_2")).toThrow(
      /did not have a correlated successful response/,
    );
    tracker.stop();
  });

  it("rejects a correlated non-success response", () => {
    const page = new EventEmitter() as unknown as Page & EventEmitter;
    const tracker = new AdaptiveAnswerSaveTracker();
    const request = adaptiveAnswerRequest("gen_1");
    tracker.start(page);
    page.emit("request", request);
    page.emit("response", responseFor(request, 503));

    expect(() => tracker.assertSuccessfulSave("gen_1")).toThrow(
      /did not have a correlated successful response/,
    );
    tracker.stop();
  });
});

describe("AdaptivePrepareTracker recovery classification", () => {
  it("classifies only an exact, sufficiently aged outstanding product timeout as transient", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure();
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;

    expect(
      tracker.consumeRetryableFailure(1, 4, {
        productTimeoutVisible: true,
      }),
    ).toEqual({ retry: true, reason: "transient-network" });
    tracker.stop();
  });

  it("rejects a product timeout without a correlated prepare request", () => {
    const { tracker } = trackerWithEvents();

    expect(() =>
      tracker.consumeRetryableFailure(1, 4, {
        productTimeoutVisible: true,
      }),
    ).toThrow(/no new correlated prepare attempt/);
    tracker.stop();
  });

  it("rejects a product timeout correlated only to a young pending request", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure();
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS - 1;

    expect(() =>
      tracker.consumeRetryableFailure(1, 4, {
        productTimeoutVisible: true,
      }),
    ).toThrow(/no sufficiently aged outstanding prepare request/);
    tracker.stop();
  });

  it("rejects a product timeout correlated only to the wrong request route", () => {
    const { page, tracker } = trackerWithEvents();
    const request = {
      ...requestWithFailure(),
      url: () => `${prepareUrl}/unexpected`,
    } as unknown as PlaywrightRequest;
    page.emit("request", request);

    expect(() =>
      tracker.consumeRetryableFailure(1, 4, {
        productTimeoutVisible: true,
      }),
    ).toThrow(/no new correlated prepare attempt/);
    tracker.stop();
  });

  it("classifies an aged exact timeout with an already observed 2xx as eventual consistency", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const key = "10000000-0000-4000-8000-000000000001:7";
    const request = requestWithFailure(undefined, key);
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    page.emit("response", responseFor(request, 200));

    expect(
      tracker.consumeRetryableFailure(1, 4, {
        productTimeoutVisible: true,
      }),
    ).toEqual({ retry: true, reason: "eventual-consistency" });
    page.emit("request", requestWithFailure(undefined, key));
    expect(() => tracker.assertRecoveryReceiptContinuity()).not.toThrow();
    tracker.stop();
  });

  it("does not recover an aged 2xx without the exact product timeout", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure();
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    page.emit("response", responseFor(request, 200));

    expect(() => tracker.consumeRetryableFailure(1, 4)).toThrow(
      /without retryable evidence \(assertion\)/,
    );
    tracker.stop();
  });

  it("does not recover a young 2xx even with exact product timeout UI", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure();
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS - 1;
    page.emit("response", responseFor(request, 200));

    expect(() =>
      tracker.consumeRetryableFailure(1, 4, {
        productTimeoutVisible: true,
      }),
    ).toThrow(/without retryable evidence \(assertion\)/);
    tracker.stop();
  });

  it.each([
    [401, "authorization"],
    [422, "schema"],
  ] as const)(
    "fails closed when an aged exact timeout already has deterministic HTTP %s evidence",
    (status, reason) => {
      let now = 1_000;
      const { page, tracker } = trackerWithEvents(() => now);
      const request = requestWithFailure();
      page.emit("request", request);
      now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
      page.emit("response", responseFor(request, status));

      expect(() =>
        tracker.consumeRetryableFailure(1, 4, {
          productTimeoutVisible: true,
        }),
      ).toThrow(`Deterministic ${reason} failure`);
      tracker.stop();
    },
  );

  it("waits for an outstanding timed-out prepare to succeed before retrying", async () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure();
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    tracker.consumeRetryableFailure(1, 4, {
      productTimeoutVisible: true,
    });

    const settled = tracker.waitForConsumedPrepareClientOutcome(100);
    let outcomeResolved = false;
    void settled.then(() => {
      outcomeResolved = true;
    });
    page.emit("response", responseFor(request, 200));
    await Promise.resolve();

    expect(outcomeResolved).toBe(false);
    page.emit("requestfinished", request);

    await expect(settled).resolves.toEqual({
      retry: true,
      reason: "eventual-consistency",
    });
    tracker.stop();
  });

  it("fails closed when an outstanding timeout later settles as a schema error", async () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure();
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    tracker.consumeRetryableFailure(1, 4, {
      productTimeoutVisible: true,
    });

    const settled = tracker.waitForConsumedPrepareClientOutcome(100);
    page.emit("response", responseFor(request, 422));
    page.emit("requestfinished", request);

    const decision = await settled;
    expect(decision).toEqual({ retry: false, reason: "schema" });
    expect(() => decideAdaptivePrepareRecovery(decision, 1, 0)).toThrow(
      /without retryable evidence \(schema\)/,
    );
    tracker.stop();
  });

  it("arms the short UI exit bound from a later recovered POST completion", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const originalKey = "10000000-0000-4000-8000-000000000001:7";
    const original = requestWithFailure("net::ERR_ABORTED", originalKey);
    page.emit("request", original);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    page.emit("requestfailed", original);
    tracker.consumeRetryableFailure(1, 4, { productTimeoutVisible: true });

    const waitTimeouts: number[] = [];
    let activeWaitTimers = 0;
    let firstWaitCanceled = false;
    const loadingOutcome = waitForAdaptiveLoadingRecoveryOutcome(
      tracker.hasRecoveredPrepareCompletion(),
      true,
      () => 120_000,
      (timeoutMs, signal) => {
        waitTimeouts.push(timeoutMs);
        return new Promise<string>((_resolve, reject) => {
          activeWaitTimers += 1;
          const timer = setTimeout(() => {
            activeWaitTimers -= 1;
            reject(new Error("adaptive UI remained loading"));
          }, timeoutMs);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              activeWaitTimers -= 1;
              firstWaitCanceled = true;
              reject(new Error("assessment stage wait canceled"));
            },
            { once: true },
          );
        });
      },
      () => tracker.waitForRecoveredPrepareCompletion(),
    );
    let loadingError: unknown;
    let loadingSettled = false;
    const observedLoadingOutcome = loadingOutcome
      .catch((error: unknown) => {
        loadingError = error;
      })
      .finally(() => {
        loadingSettled = true;
      });

    const inProgress = requestWithFailure(undefined, originalKey);
    page.emit("request", inProgress);
    page.emit("response", responseFor(inProgress, 503));
    page.emit("requestfinished", inProgress);
    expect(tracker.hasRecoveredPrepareCompletion()).toBe(false);

    const reconciled = requestWithFailure(
      undefined,
      "10000000-0000-4000-8000-000000000001:8",
    );
    page.emit("request", reconciled);
    page.emit("response", responseFor(reconciled, 200));
    expect(tracker.hasRecoveredPrepareCompletion()).toBe(false);
    page.emit("requestfinished", reconciled);
    await vi.advanceTimersByTimeAsync(0);

    expect(tracker.hasRecoveredPrepareCompletion()).toBe(true);
    expect(waitTimeouts).toEqual([
      120_000,
      ADAPTIVE_PREPARE_RECOVERED_UI_EXIT_TIMEOUT_MS,
    ]);
    expect(firstWaitCanceled).toBe(true);
    expect(activeWaitTimers).toBe(1);
    await vi.advanceTimersByTimeAsync(
      ADAPTIVE_PREPARE_RECOVERED_UI_EXIT_TIMEOUT_MS - 1,
    );
    expect(loadingSettled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await observedLoadingOutcome;
    expect(activeWaitTimers).toBe(0);
    expect(loadingError).toEqual(
      expect.objectContaining({ message: "adaptive UI remained loading" }),
    );
    tracker.stop();
  });

  it("treats ERR_ABORTED as a client outcome without claiming server settlement", async () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure("net::ERR_ABORTED");
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    tracker.consumeRetryableFailure(1, 4, {
      productTimeoutVisible: true,
    });

    const outcome = tracker.waitForConsumedPrepareClientOutcome(100);
    page.emit("requestfailed", request);

    await expect(outcome).resolves.toEqual({
      retry: true,
      reason: "transient-network",
    });
    tracker.stop();
  });

  it("correlates the exact aged product timeout when ERR_ABORTED arrives first", async () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure("net::ERR_ABORTED");
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    page.emit("requestfailed", request);

    expect(
      tracker.consumeRetryableFailure(1, 4, {
        productTimeoutVisible: true,
      }),
    ).toEqual({ retry: true, reason: "transient-network" });
    await expect(
      tracker.waitForConsumedPrepareClientOutcome(100),
    ).resolves.toEqual({ retry: true, reason: "transient-network" });
    tracker.stop();
  });

  it("does not recover an aged ERR_ABORTED request without the exact product timeout", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure("net::ERR_ABORTED");
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    page.emit("requestfailed", request);

    expect(() => tracker.consumeRetryableFailure(1, 4)).toThrow(
      /without retryable evidence \(assertion\)/,
    );
    tracker.stop();
  });

  it("does not recover a young ERR_ABORTED request even with product timeout UI", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const request = requestWithFailure("net::ERR_ABORTED");
    page.emit("request", request);
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS - 1;
    page.emit("requestfailed", request);

    expect(() =>
      tracker.consumeRetryableFailure(1, 4, {
        productTimeoutVisible: true,
      }),
    ).toThrow(/without retryable evidence \(assertion\)/);
    tracker.stop();
  });

  it("accepts the same receipt key on the first request after timeout recovery", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    const key = "10000000-0000-4000-8000-000000000001:7";
    page.emit("request", requestWithFailure(undefined, key));
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    tracker.consumeRetryableFailure(1, 4, {
      productTimeoutVisible: true,
    });

    page.emit("request", requestWithFailure(undefined, key));

    expect(() => tracker.assertRecoveryReceiptContinuity()).not.toThrow();
    tracker.stop();
  });

  it("fails closed when timeout recovery changes the receipt key", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    page.emit("request", requestWithFailure(undefined, "assessment:7"));
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    tracker.consumeRetryableFailure(1, 4, {
      productTimeoutVisible: true,
    });

    page.emit("request", requestWithFailure(undefined, "assessment:8"));

    expect(() => tracker.assertRecoveryReceiptContinuity()).toThrow(
      /changed its idempotency key before authoritative reconciliation/,
    );
    tracker.stop();
  });

  it("fails closed when timeout recovery reaches a terminal state without a new request", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    page.emit("request", requestWithFailure());
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    tracker.consumeRetryableFailure(1, 4, {
      productTimeoutVisible: true,
    });

    expect(() => tracker.assertRecoveryReceiptContinuity(true)).toThrow(
      /terminal state without a correlated request/,
    );
    tracker.stop();
  });

  it("does not launch timeout recovery while the correlated request remains outstanding", async () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    page.emit("request", requestWithFailure());
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;
    tracker.consumeRetryableFailure(1, 4, {
      productTimeoutVisible: true,
    });

    await expect(
      tracker.waitForConsumedPrepareClientOutcome(5),
    ).rejects.toThrow(/did not settle before the recovery deadline/);
    tracker.stop();
  });

  it("does not recover an aged pending request without the exact product timeout", () => {
    let now = 1_000;
    const { page, tracker } = trackerWithEvents(() => now);
    page.emit("request", requestWithFailure());
    now += ADAPTIVE_PREPARE_PENDING_TIMEOUT_MIN_AGE_MS;

    expect(() => tracker.consumeRetryableFailure(1, 4)).toThrow(
      /before the correlated prepare attempt completed/,
    );
    tracker.stop();
  });

  it.each([
    [400, "schema"],
    [401, "authorization"],
    [403, "authorization"],
    [422, "schema"],
  ] as const)(
    "fails fast for deterministic HTTP status %s (%s)",
    (status, reason) => {
      const { page, tracker } = trackerWithEvents();
      const request = requestWithFailure();
      page.emit("request", request);
      page.emit("response", responseFor(request, status));

      expect(() => tracker.consumeRetryableFailure(1, 4)).toThrow(
        `Deterministic ${reason} failure`,
      );
      tracker.stop();
    },
  );

  it("fails fast for an explicitly classified clinical failure", () => {
    const decision = classifyRecovery({ errorCode: "clinical_failure" });

    expect(() => assertRecoveryAttempt(decision, 1, 4)).toThrow(
      "Deterministic clinical failure",
    );
  });

  it.each([
    [502, undefined, "transient-gateway"],
    [undefined, "net::ERR_NETWORK_CHANGED", "transient-network"],
  ] as const)(
    "classifies correlated transport evidence (%s, %s) as %s",
    (status, failureText, reason) => {
      const { page, tracker } = trackerWithEvents();
      const request = requestWithFailure(failureText);
      page.emit("request", request);
      if (status != null) {
        page.emit("response", responseFor(request, status));
      } else {
        page.emit("requestfailed", request);
      }

      expect(tracker.consumeRetryableFailure(1, 4)).toEqual({
        retry: true,
        reason,
      });
      tracker.stop();
    },
  );

  it("does not recover an unclassified request failure or an uncorrelated UI error", () => {
    const { page, tracker } = trackerWithEvents();
    const request = requestWithFailure("net::ERR_CONNECTION_RESET");
    page.emit("request", request);
    page.emit("requestfailed", request);

    expect(() => tracker.consumeRetryableFailure(1, 4)).toThrow(
      /without retryable evidence \(assertion\)/,
    );
    expect(() => tracker.consumeRetryableFailure(2, 4)).toThrow(
      /no new correlated prepare attempt/,
    );
    tracker.stop();
  });

  it("enforces the shared recovery attempt budget for transient evidence", () => {
    const { page, tracker } = trackerWithEvents();
    const request = requestWithFailure();
    page.emit("request", request);
    page.emit("response", responseFor(request, 502));

    expect(() => tracker.consumeRetryableFailure(3, 3)).toThrow(
      /Transient recovery exhausted after 3 attempts \(transient-gateway\)/,
    );
    tracker.stop();
  });

  it("uses one global recovery budget across retries and reloads", () => {
    const decision = classifyRecovery({ status: 502 });

    expect(decideAdaptivePrepareRecovery(decision, 1, 0)).toBe("retry");
    expect(decideAdaptivePrepareRecovery(decision, 3, 0)).toBe("retry");
    expect(decideAdaptivePrepareRecovery(decision, 4, 0)).toBe("reload");
    expect(
      decideAdaptivePrepareRecovery(
        decision,
        MAX_ADAPTIVE_PREPARE_RECOVERY_ACTIONS,
        0,
      ),
    ).toBe("reload");
    expect(() =>
      decideAdaptivePrepareRecovery(
        decision,
        MAX_ADAPTIVE_PREPARE_RECOVERY_ACTIONS + 1,
        0,
      ),
    ).toThrow(
      /Transient recovery exhausted after 6 attempts \(transient-gateway\)/,
    );
  });

  it("fails at the aggregate time bound with a sanitized classification", () => {
    const decision = classifyRecovery({ status: 502 });

    expect(() =>
      decideAdaptivePrepareRecovery(
        decision,
        1,
        ADAPTIVE_PREPARE_RECOVERY_TIMEOUT_MS,
      ),
    ).toThrow(
      "Adaptive prepare recovery exceeded its bounded time limit (transient-gateway)",
    );
  });

  it("rejects a non-retryable recovery decision", () => {
    const decision = classifyRecovery({ status: 403 });

    expect(() => decideAdaptivePrepareRecovery(decision, 1, 0)).toThrow(
      "Adaptive prepare failed without retryable evidence (authorization)",
    );
  });

  it("cancels and settles a delayed operation at the aggregate deadline", async () => {
    let cancelOperation: (() => void) | undefined;
    let operationSettled = false;
    const operation = new Promise<never>((_resolve, reject) => {
      cancelOperation = () => reject(new Error("cancelled"));
    }).finally(() => {
      operationSettled = true;
    });
    const startedAt = performance.now();

    await expect(
      runAdaptivePrepareRecoveryBeforeDeadline(
        20,
        "transient-gateway",
        () => operation,
        async () => cancelOperation?.(),
        20,
      ),
    ).rejects.toThrow(
      "Adaptive prepare recovery exceeded its bounded time limit (transient-gateway)",
    );

    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(operationSettled).toBe(true);
  });

  it("bounds cleanup when cancellation rejects", async () => {
    const operation = new Promise<never>(() => undefined);
    const startedAt = performance.now();

    await expect(
      runAdaptivePrepareRecoveryBeforeDeadline(
        10,
        "transient-gateway",
        () => operation,
        async () => {
          throw new Error("close failed");
        },
        20,
      ),
    ).rejects.toThrow(
      "Adaptive prepare recovery exceeded its bounded time limit (transient-gateway)",
    );

    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  it("bounds cleanup when cancellation and the operation never settle", async () => {
    const operation = new Promise<never>(() => undefined);
    const cancellation = new Promise<void>(() => undefined);
    const startedAt = performance.now();

    await expect(
      runAdaptivePrepareRecoveryBeforeDeadline(
        10,
        "transient-network",
        () => operation,
        () => cancellation,
        20,
      ),
    ).rejects.toThrow(
      "Adaptive prepare recovery exceeded its bounded time limit (transient-network)",
    );

    expect(performance.now() - startedAt).toBeLessThan(200);
  });

  it("observes operation and cancellation rejections that arrive after the grace period", async () => {
    let rejectOperation: ((reason: Error) => void) | undefined;
    let rejectCancellation: ((reason: Error) => void) | undefined;
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const cancellation = new Promise<void>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", recordUnhandledRejection);

    try {
      await expect(
        runAdaptivePrepareRecoveryBeforeDeadline(
          5,
          "transient-gateway",
          () => operation,
          () => cancellation,
          5,
        ),
      ).rejects.toThrow(
        "Adaptive prepare recovery exceeded its bounded time limit (transient-gateway)",
      );

      rejectOperation?.(new Error("late operation rejection"));
      rejectCancellation?.(new Error("late cancellation rejection"));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", recordUnhandledRejection);
    }
  });
});
