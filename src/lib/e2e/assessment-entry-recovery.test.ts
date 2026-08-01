import { EventEmitter } from "node:events";
import type {
  Page,
  Request as PlaywrightRequest,
  Response as PlaywrightResponse,
} from "@playwright/test";
import { describe, expect, it } from "vitest";

import {
  ASSESSMENT_ENTRY_COMPLETION_PATH,
  AssessmentEntryNavigationTracker,
  isAssessmentEntryCompletionRequest,
} from "../../../e2e/support/assessmentEntryRecovery";

const completeIntakeUrl = `https://patient.example.test${ASSESSMENT_ENTRY_COMPLETION_PATH}`;
const unrelatedAssessmentUrl =
  "https://patient.example.test/api/proxy/api/v1/patients/me/assessments";

function requestFor(
  url: string,
  method = "POST",
  errorText?: string,
): PlaywrightRequest {
  return {
    method: () => method,
    url: () => url,
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

function trackerWithPage() {
  const page = new EventEmitter() as unknown as Page & EventEmitter;
  const tracker = new AssessmentEntryNavigationTracker();
  tracker.start(page);
  return { page, tracker };
}

describe("assessment entry navigation recovery", () => {
  it("matches only the exact Complete Intake mutation", () => {
    expect(
      isAssessmentEntryCompletionRequest(requestFor(completeIntakeUrl)),
    ).toBe(true);
    expect(
      isAssessmentEntryCompletionRequest(
        requestFor(`${completeIntakeUrl}/`, "POST"),
      ),
    ).toBe(true);
    expect(
      isAssessmentEntryCompletionRequest(requestFor(unrelatedAssessmentUrl)),
    ).toBe(false);
    expect(
      isAssessmentEntryCompletionRequest(requestFor(completeIntakeUrl, "GET")),
    ).toBe(false);
  });

  it("uses the correlated completion response instead of the last broad response", () => {
    const { page, tracker } = trackerWithPage();
    const completionRequest = requestFor(completeIntakeUrl);
    const unrelatedRequest = requestFor(unrelatedAssessmentUrl);

    page.emit("request", completionRequest);
    page.emit("response", responseFor(completionRequest, 502));
    page.emit("response", responseFor(unrelatedRequest, 200));

    expect(tracker.consumeRetryableFailure(1, 2)).toEqual({
      retry: true,
      reason: "transient-gateway",
    });
    tracker.stop();
  });

  it("does not authorize recovery from an unrelated response", () => {
    const { page, tracker } = trackerWithPage();
    const unrelatedRequest = requestFor(unrelatedAssessmentUrl);
    page.emit("response", responseFor(unrelatedRequest, 502));

    expect(() => tracker.consumeRetryableFailure(1, 2)).toThrow(
      "without a new correlated completion request",
    );
    tracker.stop();
  });

  it.each([400, 401, 422])(
    "fails fast for a deterministic correlated completion status %s",
    (status) => {
      const { page, tracker } = trackerWithPage();
      const completionRequest = requestFor(completeIntakeUrl);
      page.emit("request", completionRequest);
      page.emit("response", responseFor(completionRequest, status));

      expect(() => tracker.consumeRetryableFailure(1, 2)).toThrow(
        /Deterministic (schema|authorization) failure/,
      );
      tracker.stop();
    },
  );

  it("uses only correlated request failure evidence for network recovery", () => {
    const { page, tracker } = trackerWithPage();
    const completionRequest = requestFor(
      completeIntakeUrl,
      "POST",
      "net::ERR_NETWORK_CHANGED",
    );
    const unrelatedRequest = requestFor(unrelatedAssessmentUrl);

    page.emit("request", completionRequest);
    page.emit("requestfailed", completionRequest);
    page.emit("requestfailed", unrelatedRequest);

    expect(tracker.consumeRetryableFailure(1, 2)).toEqual({
      retry: true,
      reason: "transient-network",
    });
    tracker.stop();
  });
});
