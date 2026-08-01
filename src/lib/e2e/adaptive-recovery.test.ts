import { EventEmitter } from "node:events";
import type {
  Page,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from "@playwright/test";
import { describe, expect, it } from "vitest";

import { AdaptivePrepareTracker } from "../../../e2e/stages/adaptive";
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
});
