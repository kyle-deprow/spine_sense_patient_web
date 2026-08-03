import { describe, expect, it } from "vitest";

import {
  ASSESSMENT_ANALYSIS_READINESS_TIMEOUT_MS,
  DOCUMENT_OCR_READINESS_TIMEOUT_MS,
  DOCUMENT_SUMMARY_READINESS_TIMEOUT_MS,
  FULL_FLOW_INTERACTIVE_AND_LIFECYCLE_BUDGET_MS,
  FULL_FLOW_REQUIRED_TIMEOUT_MS,
  FULL_FLOW_TIMEOUT_MS,
  REPORT_GENERATION_TIMEOUT_MS,
  SCOPED_ASSESSMENT_OVERHEAD_MS,
  SCOPED_ASSESSMENT_TIMEOUT_MS,
  calculateScopedAssessmentTimeoutMs,
  requireFullFlowTimeoutBudget,
} from "../../../e2e/journey/timeouts";

describe("full assessment timeout budget", () => {
  it("covers every bounded worker stage and interactive lifecycle overhead", () => {
    expect(FULL_FLOW_REQUIRED_TIMEOUT_MS).toBe(
      FULL_FLOW_INTERACTIVE_AND_LIFECYCLE_BUDGET_MS +
        DOCUMENT_OCR_READINESS_TIMEOUT_MS +
        ASSESSMENT_ANALYSIS_READINESS_TIMEOUT_MS +
        DOCUMENT_SUMMARY_READINESS_TIMEOUT_MS +
        REPORT_GENERATION_TIMEOUT_MS,
    );
    expect(FULL_FLOW_TIMEOUT_MS).toBeGreaterThanOrEqual(
      FULL_FLOW_REQUIRED_TIMEOUT_MS,
    );
    expect(SCOPED_ASSESSMENT_TIMEOUT_MS).toBeLessThan(FULL_FLOW_TIMEOUT_MS);
    expect(SCOPED_ASSESSMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(
      ASSESSMENT_ANALYSIS_READINESS_TIMEOUT_MS +
        DOCUMENT_SUMMARY_READINESS_TIMEOUT_MS +
        SCOPED_ASSESSMENT_OVERHEAD_MS,
    );
    expect(SCOPED_ASSESSMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(
      REPORT_GENERATION_TIMEOUT_MS + SCOPED_ASSESSMENT_OVERHEAD_MS,
    );
  });

  it("rejects a global timeout that would preempt a named stage", () => {
    expect(() =>
      requireFullFlowTimeoutBudget(FULL_FLOW_REQUIRED_TIMEOUT_MS - 1),
    ).toThrow("must be at least");
    expect(requireFullFlowTimeoutBudget(FULL_FLOW_REQUIRED_TIMEOUT_MS)).toBe(
      FULL_FLOW_REQUIRED_TIMEOUT_MS,
    );
  });

  it("expands a scoped timeout to cover a configured report deadline", () => {
    const reportOverrideMs = 20 * 60 * 1000;

    expect(
      calculateScopedAssessmentTimeoutMs({
        analysisMs: 8 * 60 * 1000,
        summaryMs: 3 * 60 * 1000,
        reportMs: reportOverrideMs,
        overheadMs: 4 * 60 * 1000,
        floorMs: 15 * 60 * 1000,
      }),
    ).toBe(24 * 60 * 1000);
  });
});
