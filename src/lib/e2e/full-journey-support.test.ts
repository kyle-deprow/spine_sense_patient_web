import { afterEach, describe, expect, it, vi } from "vitest";

import { withAuthorizedE2eLifecycle } from "../../../e2e/support/lifecycle";
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
import { expectClientRequestContracts } from "../../../e2e/journey/contracts";
import {
  captureQuestionnaireMutations,
  type QuestionnaireMutation,
} from "../../../e2e/journey/context";
import { assertExactIntakeRequestContract } from "./intake-request-contract";
import {
  createE2ERunIdentity,
  isExactSyntheticIdentity,
} from "../../../e2e/support/runIdentity";

describe("canonical full journey support", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
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

  it("captures the exact browser reviewed-story PUT and validates it in the full ledger", () => {
    let requestListener:
      | ((request: {
          url(): string;
          method(): string;
          postDataJSON(): unknown;
        }) => void)
      | undefined;
    const page = {
      on: (event: string, listener: typeof requestListener) => {
        if (event === "request") requestListener = listener;
      },
    } as unknown as Parameters<typeof captureQuestionnaireMutations>[0];
    const mutations = captureQuestionnaireMutations(page);
    const emitRequest = (path: string) => {
      requestListener?.({
        url: () => `http://127.0.0.1:43101${path}`,
        method: () => "PUT",
        postDataJSON: () => ({
          narrative: fullAssessmentScenario.onboarding.chiefComplaint,
          input_method: "text",
          expected_revision: 0,
        }),
      });
    };

    emitRequest("/api/proxy/api/v1/patients/me/intake/story");
    emitRequest("/api/proxy/api/v1/patients/me/intake/story/derived");

    expect(mutations).toEqual([
      {
        method: "PUT",
        path: "/api/proxy/api/v1/patients/me/intake/story",
        payload: {
          narrative: fullAssessmentScenario.onboarding.chiefComplaint,
          input_method: "text",
          expected_revision: 0,
        },
      },
    ]);

    const screeningPath =
      "/api/proxy/api/v1/patients/me/assessments/assessment-123/screening";
    const fullLedger: QuestionnaireMutation[] = [
      ...mutations,
      {
        method: "PATCH",
        path: `${screeningPath}/answers`,
        payload: {
          answers: Object.fromEntries([
            ...fullAssessmentScenario.screening.map(({ id, value }) => [
              id,
              value,
            ]),
            ...fullAssessmentScenario.screeningText.map(({ id, text }) => [
              id,
              text,
            ]),
          ]),
          expected_revision: 1,
        },
      },
      {
        method: "POST",
        path: `${screeningPath}/complete`,
        payload: { expected_revision: 2 },
      },
    ];
    expect(() =>
      expectClientRequestContracts(fullLedger, new Map(), "screening"),
    ).not.toThrow();
  });

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
        "PUT",
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
        "PUT",
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
        "PUT",
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
        "POST",
        "/api/proxy/api/v1/patients/me/intake/progress/complete",
        {},
        fullAssessmentScenario,
      ),
    ).not.toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "PUT",
        "/api/proxy/api/v1/patients/me/intake/story",
        {
          narrative: fullAssessmentScenario.onboarding.chiefComplaint,
          input_method: "text",
          expected_revision: 0,
        },
        fullAssessmentScenario,
      ),
    ).not.toThrow();
  });

  it.each([
    ["POST", "/api/proxy/api/v1/patients/me/intake/story", 0, "method"],
    ["PUT", "/api/v1/patients/me/intake/story", 0, "path"],
    ["PUT", "/api/proxy/api/v1/patients/me/intake/story", -1, "revision"],
    ["PUT", "/api/proxy/api/v1/patients/me/intake/story", 1.5, "revision"],
  ] as const)(
    "rejects reviewed intake story contract drift: %s %s %s",
    (method, path, expectedRevision, _reason) => {
      expect(() =>
        assertExactIntakeRequestContract(
          method,
          path,
          {
            narrative: fullAssessmentScenario.onboarding.chiefComplaint,
            input_method: "text",
            expected_revision: expectedRevision,
          },
          fullAssessmentScenario,
        ),
      ).toThrow();
    },
  );

  it.each([
    {
      narrative: "different raw narrative",
      input_method: "text",
      expected_revision: 0,
    },
    {
      narrative: fullAssessmentScenario.onboarding.chiefComplaint,
      input_method: "voice",
      expected_revision: 0,
    },
    {
      narrative: fullAssessmentScenario.onboarding.chiefComplaint,
      input_method: "text",
      expected_revision: 0,
      urgency: "routine",
    },
    {
      narrative: fullAssessmentScenario.onboarding.chiefComplaint,
      input_method: "text",
      expected_revision: 0,
      questionnaireOutput: {},
    },
  ])(
    "rejects mismatched or derived reviewed intake story payload %#",
    (payload) => {
      expect(() =>
        assertExactIntakeRequestContract(
          "PUT",
          "/api/proxy/api/v1/patients/me/intake/story",
          payload,
          fullAssessmentScenario,
        ),
      ).toThrow();
    },
  );

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
        "PUT",
        profilePath,
        { step_data: { ...validProfile.step_data, urgency: "routine" } },
        fullAssessmentScenario,
      ),
    ).toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "PUT",
        profilePath,
        { step_data: { ...validProfile.step_data, activity_level: undefined } },
        fullAssessmentScenario,
      ),
    ).toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "PUT",
        "/api/proxy/api/v1/patients/me/intake/progress",
        { step_key: "profile", step_data: validProfile.step_data },
        fullAssessmentScenario,
      ),
    ).toThrow();
    expect(() =>
      assertExactIntakeRequestContract(
        "PUT",
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
        "PUT",
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

  it("refuses to mutate without an authorized lifecycle", async () => {
    const identity = createE2ERunIdentity();
    const action = vi.fn(async () => "complete");

    await expect(
      withAuthorizedE2eLifecycle({ identity, action }),
    ).rejects.toThrow(
      "requires a disposable local stack or an explicitly retained Azure dev run",
    );
    expect(action).not.toHaveBeenCalled();

    vi.stubEnv("PATIENT_WEB_E2E_STACK_DISPOSABLE", "false");
    await expect(
      withAuthorizedE2eLifecycle({ identity, action }),
    ).rejects.toThrow(
      "requires a disposable local stack or an explicitly retained Azure dev run",
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("runs inside a disposable stack and preserves the action failure", async () => {
    const identity = createE2ERunIdentity();
    vi.stubEnv("PATIENT_WEB_E2E_STACK_DISPOSABLE", "true");

    await expect(
      withAuthorizedE2eLifecycle({
        identity,
        action: async () => "complete",
      }),
    ).resolves.toBe("complete");

    const actionFailure = new Error("action failed");
    const rejection = withAuthorizedE2eLifecycle({
      identity,
      action: async () => {
        throw actionFailure;
      },
    });

    await expect(rejection).rejects.toBe(actionFailure);
  });

  it("runs against Azure dev only with explicit synthetic-data retention", async () => {
    const identity = createE2ERunIdentity();
    const action = vi.fn(async () => "complete");
    vi.stubEnv("PATIENT_WEB_E2E_DEPLOYED_DEV", "true");
    vi.stubEnv("PATIENT_WEB_E2E_RETAIN_SYNTHETIC_RUN", "true");
    vi.stubEnv(
      "PATIENT_WEB_BASE_URL",
      "https://fde-patient-ssai-spine-dev-eastus-a1b2c3.z01.azurefd.net",
    );

    await expect(
      withAuthorizedE2eLifecycle({ identity, action }),
    ).resolves.toBe("complete");
    expect(action).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "http://fde-patient-ssai-spine-dev-eastus-a1b2c3.z01.azurefd.net",
      "Front Door origin",
    ],
    [
      "https://fde-patient-ssai-spine-dev-eastus-a1b2c3.z01.azurefd.net:8443",
      "Front Door origin",
    ],
    ["https://app.spinesense.ai", "Front Door origin"],
    [
      "https://fde-patient-ssai-spine-dev-eastus-a1b2c3.z01.azurefd.net/path",
      "Front Door origin",
    ],
    [
      "https://fde-patient-ssai-spine-prod-eastus-standard-a1b2c3.z01.azurefd.net",
      "Front Door origin",
    ],
    ["https://unrelated-dev.azurefd.net", "Front Door origin"],
  ])("rejects retained Azure dev target %s", async (baseUrl, message) => {
    const identity = createE2ERunIdentity();
    const action = vi.fn(async () => undefined);
    vi.stubEnv("PATIENT_WEB_E2E_DEPLOYED_DEV", "true");
    vi.stubEnv("PATIENT_WEB_E2E_RETAIN_SYNTHETIC_RUN", "true");
    vi.stubEnv("PATIENT_WEB_BASE_URL", baseUrl);

    await expect(
      withAuthorizedE2eLifecycle({ identity, action }),
    ).rejects.toThrow(message);
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects ambiguous local and Azure dev lifecycle ownership", async () => {
    const identity = createE2ERunIdentity();
    const action = vi.fn(async () => undefined);
    vi.stubEnv("PATIENT_WEB_E2E_STACK_DISPOSABLE", "true");
    vi.stubEnv("PATIENT_WEB_E2E_DEPLOYED_DEV", "true");

    await expect(
      withAuthorizedE2eLifecycle({ identity, action }),
    ).rejects.toThrow(
      "either disposable local or retained Azure dev, not both",
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects Azure dev without the retention acknowledgement", async () => {
    const identity = createE2ERunIdentity();
    const action = vi.fn(async () => undefined);
    vi.stubEnv("PATIENT_WEB_E2E_DEPLOYED_DEV", "true");
    vi.stubEnv(
      "PATIENT_WEB_BASE_URL",
      "https://fde-patient-ssai-spine-dev-eastus-a1b2c3.z01.azurefd.net",
    );

    await expect(
      withAuthorizedE2eLifecycle({ identity, action }),
    ).rejects.toThrow("explicitly retained Azure dev run");
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects a non-exact identity before mutation", async () => {
    vi.stubEnv("PATIENT_WEB_E2E_STACK_DISPOSABLE", "true");
    const action = vi.fn(async () => undefined);
    await expect(
      withAuthorizedE2eLifecycle({
        identity: {
          runId: "not-a-uuid",
          email: "patient+not-a-uuid@e2e.example.com",
        },
        action,
      }),
    ).rejects.toThrow("requires an exact synthetic run identity");
    expect(action).not.toHaveBeenCalled();
  });
});
