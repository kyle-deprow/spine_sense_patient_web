import { describe, expect, it, vi } from "vitest";

import {
  FORCED_MID_FLOW_FAILURE_ENV,
  FORCED_MID_FLOW_FAILURE_MESSAGE,
  FORCED_MID_FLOW_FAILURE_STAGE,
  maybeThrowForcedMidFlowFailure,
  readForcedMidFlowFailureStage,
} from "../../../e2e/support/forcedMidFlowFailure";

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

  it("accepts only the allowlisted completed stage", () => {
    expect(readForcedMidFlowFailureStage(FORCED_MID_FLOW_FAILURE_STAGE)).toBe(
      FORCED_MID_FLOW_FAILURE_STAGE,
    );
    expect(readForcedMidFlowFailureStage(" RECORDS-DOCUMENTS ")).toBe(
      FORCED_MID_FLOW_FAILURE_STAGE,
    );
    expect(() => readForcedMidFlowFailureStage("screening")).toThrow(
      `${FORCED_MID_FLOW_FAILURE_ENV} must be unset or records-documents`,
    );
  });

  it("throws once after the named stage with a deterministic PHI-safe error", () => {
    vi.stubEnv(FORCED_MID_FLOW_FAILURE_ENV, FORCED_MID_FLOW_FAILURE_STAGE);

    expect(() =>
      maybeThrowForcedMidFlowFailure("consent-onboarding"),
    ).not.toThrow();
    expect(() =>
      maybeThrowForcedMidFlowFailure(FORCED_MID_FLOW_FAILURE_STAGE),
    ).toThrow(FORCED_MID_FLOW_FAILURE_MESSAGE);

    expect(FORCED_MID_FLOW_FAILURE_MESSAGE).toBe(
      "Synthetic forced E2E failure after records/documents stage",
    );
    expect(FORCED_MID_FLOW_FAILURE_MESSAGE).not.toMatch(
      /@|token|cookie|secret|patient|uuid|payload/i,
    );
    vi.unstubAllEnvs();
  });
});
