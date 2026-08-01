import { describe, expect, it } from "vitest";

import { withStackOwnedE2eLifecycle } from "../../../e2e/support/lifecycle";
import {
  isPerformanceProfilingEnabled,
  readPerformanceMode,
  shouldEnforcePerformanceBudgets,
} from "../../../e2e/support/performanceMode";
import {
  assertRecoveryAttempt,
  classifyRecovery,
} from "../../../e2e/support/recoveryPolicy";
import { fullAssessmentScenario } from "../../../e2e/fixtures/fullAssessmentScenario";
import { assertExactIntakeRequestContract } from "./intake-request-contract";
import {
  createE2ERunIdentity,
  isExactSyntheticIdentity,
} from "../../../e2e/support/runIdentity";

describe("canonical full journey support", () => {
  it("creates an exact UUID-backed synthetic identity", () => {
    const identity = createE2ERunIdentity();

    expect(isExactSyntheticIdentity(identity)).toBe(true);
    expect(identity.email).toContain(identity.runId);
  });

  it.each(["enforce", "observe", "off"] as const)(
    "accepts explicit performance mode %s",
    (mode) => {
      expect(readPerformanceMode(mode)).toBe(mode);
    },
  );

  it("wires observe and enforce through the profiler policy while off disables it", () => {
    expect(isPerformanceProfilingEnabled("observe")).toBe(true);
    expect(isPerformanceProfilingEnabled("enforce")).toBe(true);
    expect(isPerformanceProfilingEnabled("off")).toBe(false);
    expect(shouldEnforcePerformanceBudgets("observe")).toBe(false);
    expect(shouldEnforcePerformanceBudgets("enforce")).toBe(true);
    expect(shouldEnforcePerformanceBudgets("off")).toBe(false);
  });

  it("defaults performance measurement to observe and rejects unknown modes", () => {
    expect(readPerformanceMode(undefined)).toBe("observe");
    expect(() => readPerformanceMode("retry" as never)).toThrow(
      "PATIENT_WEB_E2E_PERFORMANCE_MODE",
    );
  });

  it("only classifies network and 502/503/504 gateway failures as recoverable", () => {
    expect(
      classifyRecovery({ failureText: "net::ERR_NETWORK_CHANGED" }),
    ).toEqual({
      retry: true,
      reason: "transient-network",
    });
    for (const status of [502, 503, 504]) {
      expect(classifyRecovery({ status })).toEqual({
        retry: true,
        reason: "transient-gateway",
      });
    }
    expect(classifyRecovery({ status: 422 })).toEqual({
      retry: false,
      reason: "schema",
    });
    expect(classifyRecovery({ status: 401 })).toEqual({
      retry: false,
      reason: "authorization",
    });
  });

  it.each([
    [{ status: 400 }, "schema"],
    [{ status: 422 }, "schema"],
    [{ status: 401 }, "authorization"],
    [{ status: 409 }, "application"],
    [{ errorCode: "clinical_failure" }, "clinical"],
  ] as const)(
    "rejects deterministic recovery evidence for %j",
    (observation, reason) => {
      const decision = classifyRecovery(observation);
      expect(decision).toEqual({ retry: false, reason });
      expect(() => assertRecoveryAttempt(decision, 1, 3)).toThrow(
        `Deterministic ${reason} failure`,
      );
    },
  );

  it("accepts only the exact synthetic intake wire contracts", () => {
    expect(() =>
      assertExactIntakeRequestContract(
        "/api/proxy/api/v1/patients/me/intake/steps/profile",
        {
          step_data: {
            date_of_birth: "1988-04-22",
            sex_at_birth: "female",
            height_ft: "5",
            height_in: "6",
            weight: "145",
            occupation: "Synthetic desk worker",
            activity_level: "Lightly Active",
          },
        },
        fullAssessmentScenario,
      ),
    ).not.toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "/api/proxy/api/v1/patients/me/intake/steps/chief-complaint",
        {
          step_data: {
            narrative: fullAssessmentScenario.onboarding.chiefComplaint,
            input_method: "text",
          },
        },
        fullAssessmentScenario,
      ),
    ).not.toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "/api/proxy/api/v1/patients/me/intake/steps/treatment-history",
        {
          step_data: {
            conditions: { none: true, items: [] },
            surgery: { has: false, items: [] },
            bone: { has: false, type: "", treatment: "", fracture: null },
            trauma: { has: false, items: [] },
            meds: { has: false, text: "" },
            nicotine: { use: "no" },
          },
        },
        fullAssessmentScenario,
      ),
    ).not.toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "/api/proxy/api/v1/patients/me/intake/progress/complete",
        {},
        fullAssessmentScenario,
      ),
    ).not.toThrow();
  });

  it("fails closed for malformed intake step and progress payloads", () => {
    const profilePath = "/api/proxy/api/v1/patients/me/intake/steps/profile";
    const validProfile = {
      step_data: {
        date_of_birth: "1988-04-22",
        sex_at_birth: "female",
        height_ft: "5",
        height_in: "6",
        weight: "145",
        occupation: "Synthetic desk worker",
        activity_level: "Lightly Active",
      },
    };

    expect(() =>
      assertExactIntakeRequestContract(
        profilePath,
        { step_data: { ...validProfile.step_data, urgency: "routine" } },
        fullAssessmentScenario,
      ),
    ).toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        profilePath,
        { step_data: { ...validProfile.step_data, activity_level: undefined } },
        fullAssessmentScenario,
      ),
    ).toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "/api/proxy/api/v1/patients/me/intake/progress",
        { step_key: "profile", step_data: validProfile.step_data },
        fullAssessmentScenario,
      ),
    ).toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "/api/proxy/api/v1/patients/me/intake/steps/chief-complaint",
        {
          step_data: {
            narrative: fullAssessmentScenario.onboarding.chiefComplaint,
            input_method: "text",
            phase1_qa: {},
          },
        },
        fullAssessmentScenario,
      ),
    ).toThrow();
  });

  it("does not treat the clinical overlay fixture as the browser wire fixture", () => {
    const path = "/api/proxy/api/v1/patients/me/intake/steps/treatment-history";
    expect(() =>
      assertExactIntakeRequestContract(
        path,
        {
          step_data:
            fullAssessmentScenario.onboarding.intakeStepData[
              "treatment-history"
            ],
        },
        fullAssessmentScenario,
      ),
    ).toThrow(`${path}.step_data keys must be exactly`);
  });

  it("leaves disposal to the isolated stack when mutations fail", async () => {
    const identity = createE2ERunIdentity();
    const events: string[] = [];

    await expect(
      withStackOwnedE2eLifecycle({
        identity,
        action: async () => {
          events.push("mutation");
          throw new Error("synthetic failure");
        },
      }),
    ).rejects.toThrow("synthetic failure");

    expect(events).toEqual(["mutation"]);
  });
});
