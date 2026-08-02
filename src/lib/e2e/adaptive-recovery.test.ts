import { EventEmitter } from "node:events";
import type {
  Page,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from "@playwright/test";
import { describe, expect, it } from "vitest";

import {
  ADAPTIVE_PREPARE_RECOVERY_TIMEOUT_MS,
  AdaptivePrepareTracker,
  decideAdaptivePrepareRecovery,
  MAX_ADAPTIVE_PREPARE_RECOVERY_ACTIONS,
  runAdaptivePrepareRecoveryBeforeDeadline,
} from "../../../e2e/stages/adaptive";
import {
  assertRecoveryAttempt,
  classifyRecovery,
} from "../../../e2e/support/recoveryPolicy";

const prepareUrl =
  "https://patient.example.test/api/proxy/api/v1/patients/me/assessments/10000000-0000-4000-8000-000000000001/adaptive/prepare";

function requestWithFailure(errorText?: string): PlaywrightRequest {
  return {
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

function trackerWithEvents() {
  const page = new EventEmitter() as unknown as Page & EventEmitter;
  const tracker = new AdaptivePrepareTracker();
  tracker.start(page);
  return { page, tracker };
}

describe("AdaptivePrepareTracker recovery classification", () => {
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
