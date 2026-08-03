import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_CONTRACTS,
  CHECKPOINT_PREPARATION_MODE,
  PATIENT_WEB_CHECKPOINTS,
  carryUploadedAssessmentDocument,
  checkpointForAssessmentStatus,
  completeIntake,
  createAssessment,
  ensureCheckpointBrowserOrigin,
  executeCheckpointTransitionPlan,
  nextUnsavedScreeningQuestion,
  planCheckpointTransitions,
  prepareAdaptive,
  prepareConsents,
  prepareOnboarding,
  prepareScreening,
  reconcileAuthoritativeCheckpoint,
  resolveSyntheticAdaptiveAnswer,
  tryBffJson,
  waitForAdaptiveReadyUi,
  waitForScreeningReadyUi,
} from "../../../e2e/checkpoints";
import { fullAssessmentScenario } from "../../../e2e/fixtures/fullAssessmentScenario";
import { EXPECTED_SCREENING_GOAL_QUESTION_IDS } from "../../../e2e/journey/context";

const apiResponse = (status: number, body: unknown, malformed = false) => ({
  ok: () => status >= 200 && status < 300,
  status: () => status,
  json: async () => {
    if (malformed) throw new SyntaxError("malformed");
    return body;
  },
});

const allActiveOnboardingConsents = {
  items: [
    { consent_type: "hipaa_privacy", consent_version: "2.0" },
    { consent_type: "terms_of_service", consent_version: "2.0" },
    { consent_type: "ai_analysis", consent_version: "2.0" },
    { consent_type: "informational_only", consent_version: "1.0" },
  ],
};
const importedIntakeStory = {
  story_narrative: fullAssessmentScenario.onboarding.chiefComplaint,
  story_input_method: "text",
};

describe("patient-web checkpoint contract", () => {
  it("carries the exact uploaded PDF document IDs into the analysis checkpoint context", () => {
    const context = {} as Parameters<typeof carryUploadedAssessmentDocument>[0];
    const uploaded = {
      assessmentId: "assessment-from-pdf-upload",
      documentId: "document-from-pdf-upload",
    };

    carryUploadedAssessmentDocument(context, uploaded);

    expect(context.uploadedAssessmentDocument).toEqual(uploaded);
    expect(context.uploadedAssessmentDocument).not.toBe(uploaded);
  });

  it("declares a preparation mode for every named checkpoint", () => {
    expect(Object.keys(CHECKPOINT_PREPARATION_MODE).sort()).toEqual(
      [...PATIENT_WEB_CHECKPOINTS].sort(),
    );
  });

  it("uses only the named server-owned fixture for results readiness", () => {
    expect(CHECKPOINT_PREPARATION_MODE.results_ready).toBe("named_fixture");
    expect(CHECKPOINT_PREPARATION_MODE.review_ready).toBe("api");
    expect(CHECKPOINT_CONTRACTS.results_ready.fixture).toBe(
      "results-report-v1",
    );
  });

  it.each([
    [
      { id: "gen_0", type: "single_select", options: [{ id: "option_a" }] },
      "option_a",
    ],
    [
      {
        id: "gen_1",
        type: "multi_select",
        options: [{ id: "option_a" }, { id: "option_b" }],
      },
      ["option_a"],
    ],
    [{ id: "gen_2", type: "pain_scale", options: [], min: 2, max: 8 }, 2],
    [
      { id: "gen_3", type: "free_text", options: [] },
      "No additional details for this synthetic test.",
    ],
  ])("resolves exact generated adaptive schema %#", (question, expected) => {
    expect(resolveSyntheticAdaptiveAnswer(question)).toEqual(expected);
  });

  it("keeps known adaptive-bank answers pinned ahead of generated schema handling", () => {
    expect(
      resolveSyntheticAdaptiveAnswer({
        id: "INF_STIFF_SPINE",
        type: "unsupported_by_generated_resolver",
        options: [],
      }),
    ).toBe("no");
  });

  it.each([
    { id: "unexpected", type: "single_select", options: [{ id: "a" }] },
    { id: "gen_4", type: "single_select", options: [] },
    {
      id: "gen_5",
      type: "multi_select_limit",
      options: [{ id: "duplicate" }, { id: "duplicate" }],
    },
    { id: "gen_6", type: "pain_scale", options: [], min: 9, max: 2 },
    { id: "gen_7", type: "body_map", options: [] },
  ])(
    "fails closed for unsupported generated adaptive schema %#",
    (question) => {
      expect(() => resolveSyntheticAdaptiveAnswer(question)).toThrow();
    },
  );

  it("requires a server-owned informational acknowledgement before onboarding", () => {
    expect(CHECKPOINT_CONTRACTS.onboarding_ready.invariants).toContain(
      "current informational acknowledgement active",
    );
    expect(
      CHECKPOINT_CONTRACTS.verified_pending_consent.invariants,
    ).not.toContain("current informational acknowledgement active");
  });

  it("documents every versioned checkpoint boundary", () => {
    expect(Object.keys(CHECKPOINT_CONTRACTS).sort()).toEqual(
      [...PATIENT_WEB_CHECKPOINTS].sort(),
    );
    for (const checkpoint of PATIENT_WEB_CHECKPOINTS) {
      const contract = CHECKPOINT_CONTRACTS[checkpoint];
      expect(contract.version).toBe(1);
      expect(contract.invariants.length).toBeGreaterThan(0);
      expect(contract.nextAction.length).toBeGreaterThan(0);
      expect(contract.cleanupOwnership).toContain("run_id");
    }
  });

  it("bootstraps a non-fresh checkpoint from about:blank through the BFF origin", async () => {
    let currentUrl = "about:blank";
    const navigations: string[] = [];
    const context = {
      page: {
        url: () => currentUrl,
        goto: async (path: string) => {
          navigations.push(path);
          currentUrl = "http://127.0.0.1:43101/api/health";
          return apiResponse(200, { status: "ok" });
        },
      },
    } as unknown as Parameters<typeof ensureCheckpointBrowserOrigin>[0];

    await ensureCheckpointBrowserOrigin(context, "verified_pending_consent");

    expect(navigations).toEqual(["/api/health"]);
    expect(new URL(currentUrl).origin).toBe("http://127.0.0.1:43101");
  });

  it("does not navigate a fresh checkpoint or replay checkpoint UI", async () => {
    const context = {
      page: {
        url: () => "about:blank",
        goto: async () => {
          throw new Error("fresh must not bootstrap");
        },
      },
    } as unknown as Parameters<typeof ensureCheckpointBrowserOrigin>[0];

    await expect(
      ensureCheckpointBrowserOrigin(context, "fresh"),
    ).resolves.toBeUndefined();
  });

  const screeningUiPage = (
    initial: "ready" | "retry",
    retrySucceeds: boolean,
  ) => {
    let state = initial;
    let retryClicks = 0;
    const locator = (testId: string) => ({
      or: () => ({
        waitFor: async () => undefined,
      }),
      waitFor: async () => {
        if (testId !== "screening-list" || state !== "ready") {
          throw new Error("not visible");
        }
      },
      isVisible: async () =>
        testId === "screening-list" ? state === "ready" : state === "retry",
      click: async () => {
        retryClicks += 1;
        if (retrySucceeds) state = "ready";
      },
    });
    return {
      page: { getByTestId: locator },
      retryClicks: () => retryClicks,
    };
  };

  it("requires the ready screening question list instead of the screen shell", async () => {
    const ui = screeningUiPage("ready", false);

    await expect(
      waitForScreeningReadyUi(
        ui.page as unknown as Parameters<typeof waitForScreeningReadyUi>[0],
      ),
    ).resolves.toBeUndefined();
    expect(ui.retryClicks()).toBe(0);
  });

  it("accepts the dedicated adaptive preparation route as adaptive-ready", async () => {
    const visibleTestIds = new Set(["adaptive-loading"]);
    const locator = (testId: string) => ({
      isVisible: async () => visibleTestIds.has(testId),
      or: (other: { isVisible: () => Promise<boolean> }) => ({
        isVisible: async () =>
          visibleTestIds.has(testId) || (await other.isVisible()),
      }),
    });
    const page = {
      getByTestId: locator,
      getByText: () => ({
        first: () => ({ isVisible: async () => false }),
      }),
    };

    await expect(
      waitForAdaptiveReadyUi(
        page as unknown as Parameters<typeof waitForAdaptiveReadyUi>[0],
      ),
    ).resolves.toBeUndefined();
  });

  it("does not treat adaptive preparation recovery UI as adaptive-ready", async () => {
    const visibleTestIds = new Set(["adaptive-loading-timeout"]);
    const page = {
      getByTestId: (testId: string) => ({
        isVisible: async () => visibleTestIds.has(testId),
      }),
      getByText: () => ({
        first: () => ({ isVisible: async () => false }),
      }),
    };

    await expect(
      waitForAdaptiveReadyUi(
        page as unknown as Parameters<typeof waitForAdaptiveReadyUi>[0],
        1,
      ),
    ).rejects.toThrow("None of these test IDs became visible");
  });

  it.each(["pre-commit failure", "commit with lost response"])(
    "retries screening state after %s and requires the ready question list",
    async () => {
      const ui = screeningUiPage("retry", true);

      await expect(
        waitForScreeningReadyUi(
          ui.page as unknown as Parameters<typeof waitForScreeningReadyUi>[0],
        ),
      ).resolves.toBeUndefined();
      expect(ui.retryClicks()).toBe(1);
    },
  );

  it("fails descriptively when screening retry does not produce a ready list", async () => {
    const ui = screeningUiPage("retry", false);

    await expect(
      waitForScreeningReadyUi(
        ui.page as unknown as Parameters<typeof waitForScreeningReadyUi>[0],
      ),
    ).rejects.toThrow("remained in retry state without a ready question list");
    expect(ui.retryClicks()).toBe(1);
  });

  it("plans only unsatisfied ordered transitions", () => {
    expect(
      planCheckpointTransitions("records_ready", "adaptive_ready"),
    ).toEqual([
      { from: "records_ready", to: "screening_ready" },
      { from: "screening_ready", to: "adaptive_ready" },
    ]);
    expect(
      planCheckpointTransitions("adaptive_ready", "adaptive_ready"),
    ).toEqual([]);
    expect(() =>
      planCheckpointTransitions("adaptive_ready", "records_ready"),
    ).toThrow("builder cannot move backward");
  });

  it("applies a multi-transition build before one final navigation", async () => {
    const events: string[] = [];
    const transitions = planCheckpointTransitions(
      "onboarding_ready",
      "screening_ready",
    );

    const timings = await executeCheckpointTransitionPlan(
      transitions,
      async ({ from, to }) => {
        events.push(`server:${from}->${to}`);
      },
      async () => {
        events.push("navigate:screening_ready");
      },
    );

    expect(events).toEqual([
      "server:onboarding_ready->records_ready",
      "server:records_ready->screening_ready",
      "navigate:screening_ready",
    ]);
    expect(events).not.toContain("navigate:records_ready");
    expect(timings.map(({ from, to }) => ({ from, to }))).toEqual(transitions);
    expect(timings.every(({ durationMs }) => durationMs >= 0)).toBe(true);
  });

  it("navigates directly when the requested checkpoint is already current", async () => {
    let finalizations = 0;

    await executeCheckpointTransitionPlan(
      planCheckpointTransitions("screening_ready", "screening_ready"),
      async () => {
        throw new Error("no server transition expected");
      },
      async () => {
        finalizations += 1;
      },
    );

    expect(finalizations).toBe(1);
  });

  it("does not navigate after a failed transition and finalizes once after reconciliation retry", async () => {
    let finalizations = 0;
    const transition = planCheckpointTransitions(
      "records_ready",
      "screening_ready",
    );

    await expect(
      executeCheckpointTransitionPlan(
        transition,
        async () => {
          throw new Error("response lost after server commit");
        },
        async () => {
          finalizations += 1;
        },
      ),
    ).rejects.toThrow("response lost after server commit");
    expect(finalizations).toBe(0);

    await executeCheckpointTransitionPlan(
      [],
      async () => undefined,
      async () => {
        finalizations += 1;
      },
    );
    expect(finalizations).toBe(1);
  });

  it("recovers registration that committed before its response failed", async () => {
    let verified = false;
    const request = {
      get: async (path: string) => {
        if (path === "/api/auth/session") {
          return verified
            ? apiResponse(200, { verification_status: "verified" })
            : apiResponse(401, {});
        }
        if (path.includes("/consents")) return apiResponse(200, { items: [] });
        throw new Error(`unexpected GET ${path}`);
      },
      fetch: async () => {
        verified = true;
        return apiResponse(200, {});
      },
    };
    const context = {
      email:
        "casey.assessment.123e4567-e89b-42d3-a456-426614174000@e2e.example.com",
      page: {
        request,
        context: () => ({
          cookies: async () => [
            {
              name: "spine_patient_csrf",
              value: "csrf",
            },
          ],
        }),
        url: () => "http://127.0.0.1:43101/welcome",
      },
    } as unknown as Parameters<typeof reconcileAuthoritativeCheckpoint>[0];

    const reconciled = await reconcileAuthoritativeCheckpoint(
      context,
      async () => "123456",
    );

    expect(reconciled.state).toBe("verified_pending_consent");
    expect(verified).toBe(true);
  });

  it("repairs only a missing informational acknowledgement after required consents committed", async () => {
    const activeConsents: Array<{
      consent_type: string;
      consent_version: string;
    }> = [];
    const postedTypes: string[] = [];

    const makeContext = (failInformational: boolean) => {
      const request = {
        get: async (path: string) => {
          if (path === "/api/auth/session") {
            return apiResponse(200, { verification_status: "verified" });
          }
          if (path.endsWith("/consents/active")) {
            return apiResponse(200, { items: [...activeConsents] });
          }
          if (path.endsWith("/intake/progress/latest")) {
            return apiResponse(200, { completed_steps: [] });
          }
          throw new Error(`unexpected GET ${path}`);
        },
        fetch: async (
          path: string,
          options: { method: string; data?: unknown },
        ) => {
          if (options.method === "GET" && path.endsWith("/consents/active")) {
            return apiResponse(200, { items: [...activeConsents] });
          }
          if (options.method === "POST" && path.endsWith("/consents")) {
            const consent = options.data as {
              consent_type: string;
              consent_version: string;
            };
            postedTypes.push(consent.consent_type);
            if (
              failInformational &&
              consent.consent_type === "informational_only"
            ) {
              return apiResponse(503, {});
            }
            activeConsents.push(consent);
            return apiResponse(201, consent);
          }
          throw new Error(`unexpected ${options.method} ${path}`);
        },
      };
      return {
        page: {
          request,
          context: () => ({
            cookies: async () => [
              { name: "spine_patient_csrf", value: "csrf" },
            ],
          }),
          url: () => "http://127.0.0.1:43101/welcome",
        },
      } as unknown as Parameters<typeof prepareConsents>[0];
    };

    await expect(prepareConsents(makeContext(true))).rejects.toThrow(
      "failed status=503",
    );
    expect(activeConsents.map((consent) => consent.consent_type)).toEqual([
      "hipaa_privacy",
      "terms_of_service",
      "ai_analysis",
    ]);
    expect(postedTypes).toEqual([
      "hipaa_privacy",
      "terms_of_service",
      "ai_analysis",
      "informational_only",
    ]);

    postedTypes.length = 0;
    const retryContext = makeContext(false);
    const partial = await reconcileAuthoritativeCheckpoint(retryContext);
    expect(partial.state).toBe("informational_acknowledgement_pending");

    await prepareConsents(retryContext);

    expect(postedTypes).toEqual(["informational_only"]);
    await expect(
      reconcileAuthoritativeCheckpoint(retryContext),
    ).resolves.toMatchObject({ state: "onboarding_ready" });
  });

  it("validates intake completion from the mutation response without creating new progress", async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const context = {
      questionnaireMutations: [],
      page: {
        url: () => "http://127.0.0.1:43101/onboarding/review",
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        request: {
          fetch: async (path: string, options: { method: string }) => {
            calls.push({ method: options.method, path });
            if (
              options.method === "POST" &&
              path.endsWith("/intake/progress/complete")
            ) {
              return apiResponse(200, {
                is_complete: true,
                completed_steps: [
                  "profile",
                  "chief-complaint",
                  "treatment-history",
                ],
              });
            }
            throw new Error(`unexpected ${options.method} ${path}`);
          },
        },
      },
    } as unknown as Parameters<typeof completeIntake>[0];

    await completeIntake(context);

    expect(calls).toEqual([
      {
        method: "POST",
        path: "/api/proxy/api/v1/patients/me/intake/progress/complete",
      },
    ]);
    expect(context.questionnaireMutations).toEqual([
      {
        method: "POST",
        path: "/api/proxy/api/v1/patients/me/intake/progress/complete",
        payload: {},
      },
    ]);
  });

  it("rejects an incomplete intake completion response descriptively", async () => {
    const context = {
      questionnaireMutations: [],
      page: {
        url: () => "http://127.0.0.1:43101/onboarding/review",
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        request: {
          fetch: async () =>
            apiResponse(200, {
              is_complete: false,
              completed_steps: [
                "profile",
                "chief-complaint",
                "treatment-history",
              ],
            }),
        },
      },
    } as unknown as Parameters<typeof completeIntake>[0];

    await expect(completeIntake(context)).rejects.toThrow(
      "intake completion response must report is_complete=true",
    );
  });

  it("creates an assessment with a stable operation-scoped idempotency key", async () => {
    let observedKey: string | undefined;
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const context = {
      identity: { runId },
      page: {
        url: () => "http://127.0.0.1:43101/assessment",
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        request: {
          fetch: async (
            path: string,
            options: { method: string; headers: Record<string, string> },
          ) => {
            expect(path).toBe("/api/proxy/api/v1/patients/me/assessments/");
            expect(options.method).toBe("POST");
            observedKey = options.headers["x-idempotency-key"];
            return apiResponse(201, {
              id: "123e4567-e89b-42d3-a456-426614174010",
              revision: 0,
              status: "draft",
              ...importedIntakeStory,
              storyNarrative: "conflicting camel narrative",
              storyInputMethod: "voice",
            });
          },
        },
      },
    } as unknown as Parameters<typeof createAssessment>[0];

    await expect(createAssessment(context)).resolves.toMatchObject({
      status: "draft",
    });
    expect(observedKey).toBe(`${runId}:assessment-create-v1`);
  });

  it.each([
    [{ story_narrative: "different narrative", story_input_method: "text" }],
    [
      {
        story_narrative: fullAssessmentScenario.onboarding.chiefComplaint,
        story_input_method: "voice",
      },
    ],
    [{ story_narrative: null, story_input_method: null }],
    [
      {
        story_narrative: null,
        storyNarrative: fullAssessmentScenario.onboarding.chiefComplaint,
        story_input_method: "text",
      },
    ],
    [
      {
        story_narrative: fullAssessmentScenario.onboarding.chiefComplaint,
        story_input_method: null,
        storyInputMethod: "text",
      },
    ],
  ])(
    "rejects assessment creation without the exact server-imported intake story",
    async (story) => {
      const context = {
        identity: { runId: "123e4567-e89b-42d3-a456-426614174000" },
        page: {
          url: () => "http://127.0.0.1:43101/assessment",
          context: () => ({
            cookies: async () => [
              { name: "spine_patient_csrf", value: "csrf" },
            ],
          }),
          request: {
            fetch: async () =>
              apiResponse(201, {
                id: "123e4567-e89b-42d3-a456-426614174010",
                revision: 0,
                status: "draft",
                ...story,
              }),
          },
        },
      } as unknown as Parameters<typeof createAssessment>[0];

      await expect(createAssessment(context)).rejects.toThrow(
        "must own the exact server-imported reviewed intake story",
      );
    },
  );

  it.each(["idempotency_result_unavailable", "idempotency_outcome_unknown"])(
    "reconciles lost assessment creation response for %s through the authoritative list",
    async (serverCode) => {
      const calls: string[] = [];
      const context = {
        identity: { runId: "123e4567-e89b-42d3-a456-426614174000" },
        page: {
          url: () => "http://127.0.0.1:43101/assessment",
          context: () => ({
            cookies: async () => [
              { name: "spine_patient_csrf", value: "csrf" },
            ],
          }),
          request: {
            fetch: async (path: string, options: { method: string }) => {
              calls.push(`${options.method} ${path}`);
              if (options.method === "POST") {
                return apiResponse(409, { code: serverCode });
              }
              if (options.method === "GET" && path.includes("/assessments/?")) {
                const draft = {
                  id: "123e4567-e89b-42d3-a456-426614174010",
                  revision: 0,
                  status: "draft",
                  ...importedIntakeStory,
                };
                const completedHistory = {
                  id: "123e4567-e89b-42d3-a456-426614174011",
                  revision: 8,
                  status: "complete",
                };
                return apiResponse(200, {
                  items:
                    serverCode === "idempotency_result_unavailable"
                      ? [completedHistory, draft]
                      : [draft, completedHistory],
                });
              }
              throw new Error(`unexpected ${options.method} ${path}`);
            },
          },
        },
      } as unknown as Parameters<typeof createAssessment>[0];

      await expect(createAssessment(context)).resolves.toMatchObject({
        id: "123e4567-e89b-42d3-a456-426614174010",
        status: "draft",
      });
      expect(calls).toEqual([
        "POST /api/proxy/api/v1/patients/me/assessments/",
        "GET /api/proxy/api/v1/patients/me/assessments/?limit=20&offset=0",
      ]);
    },
  );

  it("rejects 409 creation reconciliation when the draft does not own the imported story", async () => {
    const context = {
      identity: { runId: "123e4567-e89b-42d3-a456-426614174000" },
      page: {
        url: () => "http://127.0.0.1:43101/assessment",
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        request: {
          fetch: async (_path: string, options: { method: string }) =>
            options.method === "POST"
              ? apiResponse(409, { code: "idempotency_outcome_unknown" })
              : apiResponse(200, {
                  items: [
                    {
                      id: "123e4567-e89b-42d3-a456-426614174010",
                      revision: 0,
                      status: "draft",
                      story_narrative: null,
                      storyNarrative:
                        fullAssessmentScenario.onboarding.chiefComplaint,
                      story_input_method: "text",
                    },
                  ],
                }),
        },
      },
    } as unknown as Parameters<typeof createAssessment>[0];

    await expect(createAssessment(context)).rejects.toThrow(
      "must own the exact server-imported reviewed intake story",
    );
  });

  it("does not reconcile a non-ambiguous idempotency conflict", async () => {
    let calls = 0;
    const context = {
      identity: { runId: "123e4567-e89b-42d3-a456-426614174000" },
      page: {
        url: () => "http://127.0.0.1:43101/assessment",
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        request: {
          fetch: async () => {
            calls += 1;
            return apiResponse(409, {
              code: "idempotency_key_payload_mismatch",
            });
          },
        },
      },
    } as unknown as Parameters<typeof createAssessment>[0];

    await expect(createAssessment(context)).rejects.toThrow(
      "status=409 code=idempotency_key_payload_mismatch",
    );
    expect(calls).toBe(1);
  });

  it.each([
    [
      "multiple drafts",
      [
        {
          id: "123e4567-e89b-42d3-a456-426614174010",
          revision: 0,
          status: "draft",
        },
        {
          id: "123e4567-e89b-42d3-a456-426614174011",
          revision: 0,
          status: "draft",
        },
      ],
      "multiple nonterminal assessments",
    ],
    [
      "one non-draft active assessment",
      [
        {
          id: "123e4567-e89b-42d3-a456-426614174010",
          revision: 2,
          status: "screening_in_progress",
        },
      ],
      "requires a draft, received screening_in_progress",
    ],
    [
      "mixed active assessments",
      [
        {
          id: "123e4567-e89b-42d3-a456-426614174010",
          revision: 0,
          status: "draft",
        },
        {
          id: "123e4567-e89b-42d3-a456-426614174011",
          revision: 2,
          status: "screening_in_progress",
        },
      ],
      "multiple nonterminal assessments",
    ],
  ])(
    "rejects ambiguous assessment creation reconciliation: %s",
    async (_label, items, expectedError) => {
      const context = {
        identity: { runId: "123e4567-e89b-42d3-a456-426614174000" },
        page: {
          url: () => "http://127.0.0.1:43101/assessment",
          context: () => ({
            cookies: async () => [
              { name: "spine_patient_csrf", value: "csrf" },
            ],
          }),
          request: {
            fetch: async (_path: string, options: { method: string }) =>
              options.method === "POST"
                ? apiResponse(409, { code: "idempotency_outcome_unknown" })
                : apiResponse(200, { items }),
          },
        },
      } as unknown as Parameters<typeof createAssessment>[0];

      await expect(createAssessment(context)).rejects.toThrow(expectedError);
    },
  );

  it.each([true, false])(
    "recovers assessment creation with terminal history in either order (historyFirst=%s)",
    async (historyFirst) => {
      const assessment = {
        id: "123e4567-e89b-42d3-a456-426614174010",
        revision: 0,
        status: "draft",
        abandoned_at: null,
        ...importedIntakeStory,
      };
      const completedHistory = {
        id: "123e4567-e89b-42d3-a456-426614174011",
        revision: 8,
        status: "complete",
        abandoned_at: null,
      };
      const context = {
        email: "checkpoint-create-retry@e2e.example.com",
        page: {
          request: {
            get: async (path: string) => {
              if (path === "/api/auth/session") {
                return apiResponse(200, { verification_status: "verified" });
              }
              if (path.endsWith("/consents/active")) {
                return apiResponse(200, allActiveOnboardingConsents);
              }
              if (path.endsWith("/intake/progress/latest")) {
                return apiResponse(200, {
                  is_complete: true,
                  completed_steps: [
                    "profile",
                    "chief-complaint",
                    "treatment-history",
                  ],
                });
              }
              if (path.includes("/assessments/?")) {
                return apiResponse(200, {
                  items: historyFirst
                    ? [completedHistory, assessment]
                    : [assessment, completedHistory],
                });
              }
              if (path.endsWith(`/assessments/${assessment.id}/documents`)) {
                return apiResponse(200, { items: [] });
              }
              throw new Error(`unexpected GET ${path}`);
            },
          },
        },
      } as unknown as Parameters<typeof reconcileAuthoritativeCheckpoint>[0];

      await expect(reconcileAuthoritativeCheckpoint(context)).resolves.toEqual({
        state: "records_ready",
        assessment: {
          id: assessment.id,
          revision: 0,
          status: "draft",
          storyNarrative: fullAssessmentScenario.onboarding.chiefComplaint,
          storyInputMethod: "text",
        },
        intakeComplete: true,
        resumedScreening: false,
      });
    },
  );

  it("rejects multiple nonterminal assessments during main checkpoint reconciliation", async () => {
    const context = {
      email: "checkpoint-ambiguous@e2e.example.com",
      page: {
        request: {
          get: async (path: string) => {
            if (path === "/api/auth/session") {
              return apiResponse(200, { verification_status: "verified" });
            }
            if (path.endsWith("/consents/active")) {
              return apiResponse(200, allActiveOnboardingConsents);
            }
            if (path.endsWith("/intake/progress/latest")) {
              return apiResponse(200, {
                is_complete: true,
                completed_steps: [
                  "profile",
                  "chief-complaint",
                  "treatment-history",
                ],
              });
            }
            if (path.includes("/assessments/?")) {
              return apiResponse(200, {
                items: [
                  {
                    id: "123e4567-e89b-42d3-a456-426614174010",
                    revision: 0,
                    status: "draft",
                  },
                  {
                    id: "123e4567-e89b-42d3-a456-426614174011",
                    revision: 2,
                    status: "screening_in_progress",
                  },
                ],
              });
            }
            throw new Error(`unexpected GET ${path}`);
          },
        },
      },
    } as unknown as Parameters<typeof reconcileAuthoritativeCheckpoint>[0];

    await expect(reconcileAuthoritativeCheckpoint(context)).rejects.toThrow(
      "assessment reconciliation list returned multiple nonterminal assessments",
    );
  });

  it.each([
    ["draft", false],
    ["screening_in_progress", true],
  ])(
    "recovers ready documents across final UI screening transition status=%s",
    async (status, resumedScreening) => {
      const assessment = {
        id: "123e4567-e89b-42d3-a456-426614174010",
        revision: status === "draft" ? 0 : 1,
        status,
        ...importedIntakeStory,
      };
      const context = {
        email: "checkpoint-draft-document@e2e.example.com",
        page: {
          request: {
            get: async (path: string) => {
              if (path === "/api/auth/session") {
                return apiResponse(200, { verification_status: "verified" });
              }
              if (path.endsWith("/consents/active")) {
                return apiResponse(200, allActiveOnboardingConsents);
              }
              if (path.endsWith("/intake/progress/latest")) {
                return apiResponse(200, {
                  is_complete: true,
                  completed_steps: [
                    "profile",
                    "chief-complaint",
                    "treatment-history",
                  ],
                });
              }
              if (path.includes("/assessments/?")) {
                return apiResponse(200, { items: [assessment] });
              }
              if (path.endsWith(`/assessments/${assessment.id}/documents`)) {
                return apiResponse(200, {
                  items: [{ processing_status: "complete" }],
                });
              }
              throw new Error(`unexpected GET ${path}`);
            },
          },
        },
      } as unknown as Parameters<typeof reconcileAuthoritativeCheckpoint>[0];

      await expect(reconcileAuthoritativeCheckpoint(context)).resolves.toEqual({
        state: "screening_ready",
        assessment: {
          id: assessment.id,
          revision: assessment.revision,
          status,
          storyNarrative: fullAssessmentScenario.onboarding.chiefComplaint,
          storyInputMethod: "text",
        },
        intakeComplete: true,
        resumedScreening,
      });
    },
  );

  const completedAssessmentContext = (
    items: readonly Record<string, unknown>[],
  ) =>
    ({
      email: "checkpoint-completed@e2e.example.com",
      page: {
        request: {
          get: async (path: string) => {
            if (path === "/api/auth/session") {
              return apiResponse(200, { verification_status: "verified" });
            }
            if (path.endsWith("/consents/active")) {
              return apiResponse(200, allActiveOnboardingConsents);
            }
            if (path.endsWith("/intake/progress/latest")) {
              return apiResponse(200, {
                is_complete: true,
                completed_steps: [
                  "profile",
                  "chief-complaint",
                  "treatment-history",
                ],
              });
            }
            if (path.includes("/assessments/?")) {
              return apiResponse(200, { items });
            }
            throw new Error(`unexpected GET ${path}`);
          },
        },
      },
    }) as unknown as Parameters<typeof reconcileAuthoritativeCheckpoint>[0];

  it("preserves completed-only checkpoint reconciliation", async () => {
    const completed = {
      id: "123e4567-e89b-42d3-a456-426614174020",
      revision: 12,
      status: "complete",
    };

    await expect(
      reconcileAuthoritativeCheckpoint(completedAssessmentContext([completed])),
    ).resolves.toMatchObject({
      state: "results_ready",
      assessment: completed,
      intakeComplete: true,
    });
  });

  it.each([
    [
      "newest first",
      "123e4567-e89b-42d3-a456-426614174020",
      "123e4567-e89b-42d3-a456-426614174021",
    ],
    [
      "reversed server order",
      "123e4567-e89b-42d3-a456-426614174021",
      "123e4567-e89b-42d3-a456-426614174020",
    ],
  ])(
    "uses the first completed assessment from backend created_at-desc order: %s",
    async (_label, firstId, secondId) => {
      const first = { id: firstId, revision: 12, status: "complete" };
      const second = { id: secondId, revision: 8, status: "complete" };

      await expect(
        reconcileAuthoritativeCheckpoint(
          completedAssessmentContext([first, second]),
        ),
      ).resolves.toMatchObject({
        state: "results_ready",
        assessment: first,
      });
    },
  );

  it("reconciles a completed intake in a new browser context without creating progress", async () => {
    const paths: string[] = [];
    const context = {
      email: "checkpoint-retry@e2e.example.com",
      page: {
        request: {
          get: async (path: string) => {
            paths.push(path);
            if (path === "/api/auth/session") {
              return apiResponse(200, { verification_status: "verified" });
            }
            if (path.endsWith("/consents/active")) {
              return apiResponse(200, allActiveOnboardingConsents);
            }
            if (path.endsWith("/intake/progress/latest")) {
              return apiResponse(200, {
                is_complete: true,
                completed_steps: [
                  "profile",
                  "chief-complaint",
                  "treatment-history",
                ],
              });
            }
            if (path.includes("/assessments/?")) {
              return apiResponse(200, { items: [] });
            }
            throw new Error(`unexpected GET ${path}`);
          },
        },
      },
    } as unknown as Parameters<typeof reconcileAuthoritativeCheckpoint>[0];

    await expect(reconcileAuthoritativeCheckpoint(context)).resolves.toEqual({
      state: "records_ready",
      intakeComplete: true,
    });
    expect(paths).toContain(
      "/api/proxy/api/v1/patients/me/intake/progress/latest",
    );
    expect(paths.some((path) => path.endsWith("/intake/steps"))).toBe(false);
  });

  it("treats latest-intake 403 as pre-onboarding only when profile DOB is explicitly null", async () => {
    const contextForProfile = (profile: Record<string, unknown>) =>
      ({
        email: "checkpoint-predob@e2e.example.com",
        page: {
          request: {
            get: async (path: string) => {
              if (path === "/api/auth/session") {
                return apiResponse(200, { verification_status: "verified" });
              }
              if (path.endsWith("/consents/active")) {
                return apiResponse(200, allActiveOnboardingConsents);
              }
              if (path.endsWith("/intake/progress/latest")) {
                return apiResponse(403, {});
              }
              if (path.endsWith("/patients/me/")) {
                return apiResponse(200, profile);
              }
              throw new Error(`unexpected GET ${path}`);
            },
          },
        },
      }) as unknown as Parameters<typeof reconcileAuthoritativeCheckpoint>[0];

    await expect(
      reconcileAuthoritativeCheckpoint(
        contextForProfile({ date_of_birth: null }),
      ),
    ).resolves.toMatchObject({ state: "onboarding_ready" });
    await expect(
      reconcileAuthoritativeCheckpoint(
        contextForProfile({ date_of_birth: "1988-04-22" }),
      ),
    ).rejects.toThrow("failed status=403 with a persisted DOB");

    for (const malformedProfile of [
      {},
      { dateOfBirth: null },
      { date_of_birth: "" },
      { date_of_birth: 19880422 },
    ]) {
      await expect(
        reconcileAuthoritativeCheckpoint(contextForProfile(malformedProfile)),
      ).rejects.toThrow("profile date_of_birth was not explicitly null");
    }
  });

  it("persists the adult profile before writing DOB-gated intake steps", async () => {
    let profilePersisted = false;
    const completedSteps: string[] = [];
    let story = {
      status: null as string | null,
      revision: 0,
      narrative: null as string | null,
      input_method: null as string | null,
    };
    const calls: Array<{ method: string; path: string; data: unknown }> = [];
    const context = {
      questionnaireMutations: [],
      page: {
        url: () => "http://127.0.0.1:43101/onboarding/profile",
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        request: {
          fetch: async (
            path: string,
            options: { method: string; data?: unknown },
          ) => {
            calls.push({ method: options.method, path, data: options.data });
            if (
              options.method === "PATCH" &&
              path === "/api/proxy/api/v1/patients/me/"
            ) {
              profilePersisted = true;
              return apiResponse(200, {});
            }
            if (options.method === "GET" && path.endsWith("/intake/steps")) {
              return apiResponse(200, { completed_steps: [...completedSteps] });
            }
            if (options.method === "GET" && path.endsWith("/intake/story")) {
              return apiResponse(200, story);
            }
            if (options.method === "PUT" && path.endsWith("/intake/story")) {
              const body = options.data as {
                narrative: string;
                input_method: string;
                expected_revision: number;
              };
              expect(body.expected_revision).toBe(story.revision);
              story = {
                status: "ready",
                revision: story.revision + 1,
                narrative: body.narrative,
                input_method: body.input_method,
              };
              // Simulate a concurrent identical commit: the checkpoint must
              // re-read and accept only the exact authoritative story.
              return apiResponse(409, {});
            }
            if (options.method === "PUT" && path.includes("/intake/steps/")) {
              if (!profilePersisted) return apiResponse(403, {});
              completedSteps.push(path.split("/").at(-1) ?? "");
              return apiResponse(200, {});
            }
            throw new Error(`unexpected ${options.method} ${path}`);
          },
        },
      },
    } as unknown as Parameters<typeof prepareOnboarding>[0];

    await prepareOnboarding(context);

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PATCH /api/proxy/api/v1/patients/me/",
      "GET /api/proxy/api/v1/patients/me/intake/steps",
      "PUT /api/proxy/api/v1/patients/me/intake/steps/profile",
      "GET /api/proxy/api/v1/patients/me/intake/story",
      "PUT /api/proxy/api/v1/patients/me/intake/story",
      "GET /api/proxy/api/v1/patients/me/intake/story",
      "PUT /api/proxy/api/v1/patients/me/intake/steps/chief-complaint",
      "PUT /api/proxy/api/v1/patients/me/intake/steps/treatment-history",
    ]);
    expect(calls[0]?.data).toEqual({
      date_of_birth: "1988-04-22",
      sex_at_birth: "female",
      height_cm: 168,
      weight_kg: 66,
    });
  });

  it("resumes after the reviewed story commits but its response fails", async () => {
    const completedSteps = new Set<string>();
    let story = {
      status: null as string | null,
      revision: 0,
      narrative: null as string | null,
      input_method: null as string | null,
    };
    const makeContext = (failStoryResponse: boolean) => {
      const calls: Array<{ method: string; path: string; data: unknown }> = [];
      const context = {
        questionnaireMutations: [],
        page: {
          url: () => "http://127.0.0.1:43101/onboarding/profile",
          context: () => ({
            cookies: async () => [
              { name: "spine_patient_csrf", value: "csrf" },
            ],
          }),
          request: {
            fetch: async (
              path: string,
              options: { method: string; data?: unknown },
            ) => {
              calls.push({ method: options.method, path, data: options.data });
              if (options.method === "PATCH") return apiResponse(200, {});
              if (options.method === "GET" && path.endsWith("/intake/steps")) {
                return apiResponse(200, {
                  completed_steps: [...completedSteps],
                });
              }
              if (options.method === "GET" && path.endsWith("/intake/story")) {
                return apiResponse(200, story);
              }
              if (options.method === "PUT" && path.endsWith("/intake/story")) {
                const body = options.data as {
                  narrative: string;
                  input_method: string;
                  expected_revision: number;
                };
                expect(body.expected_revision).toBe(story.revision);
                story = {
                  status: "ready",
                  revision: story.revision + 1,
                  narrative: body.narrative,
                  input_method: body.input_method,
                };
                return apiResponse(failStoryResponse ? 503 : 200, {});
              }
              if (options.method === "PUT" && path.includes("/intake/steps/")) {
                completedSteps.add(path.split("/").at(-1) ?? "");
                return apiResponse(200, {});
              }
              throw new Error(`unexpected ${options.method} ${path}`);
            },
          },
        },
      } as unknown as Parameters<typeof prepareOnboarding>[0];
      return { calls, context };
    };

    const first = makeContext(true);
    await expect(prepareOnboarding(first.context)).rejects.toThrow(
      "failed status=503",
    );
    expect([...completedSteps]).toEqual(["profile"]);
    expect(story).toMatchObject({ status: "ready", revision: 1 });

    const retry = makeContext(false);
    await prepareOnboarding(retry.context);

    expect(
      retry.calls
        .filter(({ method }) => method === "PUT")
        .map(({ path }) => path),
    ).toEqual([
      "/api/proxy/api/v1/patients/me/intake/steps/chief-complaint",
      "/api/proxy/api/v1/patients/me/intake/steps/treatment-history",
    ]);
    expect([...completedSteps]).toEqual([
      "profile",
      "chief-complaint",
      "treatment-history",
    ]);
  });

  const storyInvariantContext = (
    initialStory: Record<string, unknown>,
    reconciledStory: Record<string, unknown>,
  ) => {
    let storyReads = 0;
    return {
      questionnaireMutations: [],
      page: {
        url: () => "http://127.0.0.1:43101/onboarding/profile",
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        request: {
          fetch: async (path: string, options: { method: string }) => {
            if (options.method === "PATCH") return apiResponse(200, {});
            if (options.method === "GET" && path.endsWith("/intake/steps")) {
              return apiResponse(200, { completed_steps: ["profile"] });
            }
            if (options.method === "GET" && path.endsWith("/intake/story")) {
              storyReads += 1;
              return apiResponse(
                200,
                storyReads === 1 ? initialStory : reconciledStory,
              );
            }
            if (options.method === "PUT" && path.endsWith("/intake/story")) {
              return apiResponse(409, {});
            }
            throw new Error(`unexpected ${options.method} ${path}`);
          },
        },
      },
    } as unknown as Parameters<typeof prepareOnboarding>[0];
  };

  it("rejects a ready authoritative story with revision zero", async () => {
    const readyAtZero = {
      status: "ready",
      revision: 0,
      narrative: fullAssessmentScenario.onboarding.chiefComplaint,
      input_method: "text",
    };

    await expect(
      prepareOnboarding(storyInvariantContext(readyAtZero, readyAtZero)),
    ).rejects.toThrow("revision must be positive");
  });

  it("rejects a 409 reconciliation whose authoritative revision did not advance", async () => {
    const observed = {
      status: "failed",
      revision: 3,
      narrative: null,
      input_method: null,
    };
    const unchanged = {
      status: "ready",
      revision: 3,
      narrative: fullAssessmentScenario.onboarding.chiefComplaint,
      input_method: "text",
    };

    await expect(
      prepareOnboarding(storyInvariantContext(observed, unchanged)),
    ).rejects.toThrow("revision did not advance");
  });

  it.each([
    ["narrative", "Different server-owned narrative", "text"],
    ["input method", fullAssessmentScenario.onboarding.chiefComplaint, "voice"],
  ])(
    "rejects a 409 reconciliation with mismatched %s",
    async (_label, narrative, inputMethod) => {
      const observed = {
        status: null,
        revision: 0,
        narrative: null,
        input_method: null,
      };
      const mismatch = {
        status: "ready",
        revision: 1,
        narrative,
        input_method: inputMethod,
      };

      await expect(
        prepareOnboarding(storyInvariantContext(observed, mismatch)),
      ).rejects.toThrow("does not match the synthetic raw narrative");
    },
  );

  it.each([
    ["draft", false, "records_ready", "create"],
    ["draft", true, "screening_ready", "final UI screening transition"],
    ["screening_in_progress", false, "records_ready", "upload"],
    ["screening_in_progress", true, "screening_ready", "screening answers"],
    ["adaptive_in_progress", true, "adaptive_ready", "adaptive answers"],
    ["analysis_pending", true, "review_ready", "adaptive completion"],
    ["screening_complete", true, "adaptive_ready", "screening completion"],
    ["adaptive_pending", true, "adaptive_ready", "adaptive preparation"],
  ])(
    "reconciles failure after %s server mutation before retrying %s",
    (status, hasReadyDocument, expected) => {
      expect(checkpointForAssessmentStatus(status, hasReadyDocument)).toBe(
        expected,
      );
    },
  );

  it.each([429, 404, 500, 503])(
    "fails closed on unexpected checkpoint probe status %s",
    async (status) => {
      const context = {
        page: { request: { get: async () => apiResponse(status, {}) } },
      } as unknown as Parameters<typeof tryBffJson>[0];

      await expect(tryBffJson(context, "/probe")).rejects.toThrow(
        `failed status=${status}`,
      );
    },
  );

  it("allows only explicitly expected absence and rejects malformed responses", async () => {
    const absent = {
      page: { request: { get: async () => apiResponse(401, {}) } },
    } as unknown as Parameters<typeof tryBffJson>[0];
    const malformed = {
      page: {
        request: { get: async () => apiResponse(200, undefined, true) },
      },
    } as unknown as Parameters<typeof tryBffJson>[0];

    await expect(tryBffJson(absent, "/session", [401])).resolves.toBeNull();
    await expect(tryBffJson(malformed, "/probe")).rejects.toThrow(
      "malformed JSON",
    );
  });

  it("propagates checkpoint probe transport failures", async () => {
    const context = {
      page: {
        request: {
          get: async () => {
            throw new Error("transport down");
          },
        },
      },
    } as unknown as Parameters<typeof tryBffJson>[0];

    await expect(tryBffJson(context, "/probe")).rejects.toThrow(
      "transport down",
    );
  });

  it("resumes partial screening when hidden committed goals are absent from saved_answers", async () => {
    const visibleIds = EXPECTED_SCREENING_GOAL_QUESTION_IDS.slice(0, 3);
    const [alreadySavedId, firstRemainingId, secondRemainingId] = visibleIds;
    if (
      alreadySavedId == null ||
      firstRemainingId == null ||
      secondRemainingId == null
    ) {
      throw new Error("screening goal fixture needs three questions");
    }
    let stateReads = 0;
    const submittedIds: string[] = [];
    const request = {
      fetch: async (
        path: string,
        options: { method: string; data?: unknown },
      ) => {
        if (path.endsWith("/screening/state")) {
          stateReads += 1;
          const savedAnswers =
            stateReads === 1
              ? { [alreadySavedId]: "saved" }
              : stateReads === 2
                ? {
                    [alreadySavedId]: "saved",
                    [firstRemainingId]: "saved",
                  }
                : {
                    [alreadySavedId]: "saved",
                    [firstRemainingId]: "saved",
                    [secondRemainingId]: "saved",
                  };
          return apiResponse(200, {
            revision: 9 + stateReads,
            interruptive_route: "none",
            // Answered questions remain visible in the real state response.
            visible_questions: visibleIds.map((id) => ({ id })),
            // The real API only exposes saved answers for currently visible
            // IDs; previously committed hidden goals are intentionally absent.
            saved_answers: savedAnswers,
          });
        }
        if (path.endsWith("/screening/answers")) {
          const answers = (options.data as { answers: Record<string, unknown> })
            .answers;
          submittedIds.push(...Object.keys(answers));
          return apiResponse(200, {
            revision: 10 + submittedIds.length,
            interruptive_route: "none",
            visible_questions: visibleIds.map((id) => ({ id })),
            saved_answers: Object.fromEntries(
              [alreadySavedId, ...submittedIds].map((id) => [id, "saved"]),
            ),
          });
        }
        if (path.endsWith("/screening/complete")) {
          return apiResponse(200, { revision: 13, status: "adaptive_pending" });
        }
        throw new Error(`unexpected ${options.method} ${path}`);
      },
    };
    const context = {
      page: {
        request,
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        url: () => "http://127.0.0.1:43101/assessment",
      },
      questionnaireMutations: [],
    } as unknown as Parameters<typeof prepareScreening>[0];

    const result = await prepareScreening(
      context,
      {
        id: "123e4567-e89b-42d3-a456-426614174010",
        revision: 9,
        status: "screening_in_progress",
      },
      { authoritativeResume: true },
    );

    expect(result.status).toBe("adaptive_pending");
    expect(submittedIds).toEqual([firstRemainingId, secondRemainingId]);
  });

  it("sends the browser-equivalent A00 array with idempotency on protected screening mutations", async () => {
    const mutations: Array<{
      path: string;
      data: unknown;
      headers: Record<string, string>;
    }> = [];
    let stateReads = 0;
    const request = {
      fetch: async (
        path: string,
        options: {
          method: string;
          data?: unknown;
          headers: Record<string, string>;
        },
      ) => {
        if (path.endsWith("/screening/state")) {
          stateReads += 1;
          return apiResponse(200, {
            revision: stateReads === 1 ? 10 : 11,
            interruptive_route: "none",
            visible_questions:
              stateReads === 1
                ? [{ id: "A00", type: "body_map", required: true }]
                : [],
            saved_answers: stateReads === 1 ? {} : { A00: ["low_back"] },
          });
        }
        if (
          path.endsWith("/screening/answers") ||
          path.endsWith("/screening/complete")
        ) {
          mutations.push({
            path,
            data: options.data,
            headers: options.headers,
          });
          return path.endsWith("/screening/answers")
            ? apiResponse(200, {
                revision: 11,
                interruptive_route: "none",
                visible_questions: [],
                saved_answers: { A00: ["low_back"] },
              })
            : apiResponse(200, {
                revision: 12,
                status: "adaptive_pending",
              });
        }
        throw new Error(`unexpected ${options.method} ${path}`);
      },
    };
    const context = {
      page: {
        request,
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        url: () => "http://127.0.0.1:43101/assessment",
      },
      questionnaireMutations: [],
    } as unknown as Parameters<typeof prepareScreening>[0];

    await prepareScreening(
      context,
      {
        id: "123e4567-e89b-42d3-a456-426614174010",
        revision: 9,
        status: "screening_in_progress",
      },
      { authoritativeResume: true },
    );

    expect(mutations).toHaveLength(2);
    expect(mutations[0]?.data).toEqual({
      answers: { A00: ["low_back"] },
      expected_revision: 10,
    });
    const a00 = (mutations[0]?.data as { answers: { A00: unknown } }).answers
      .A00;
    expect(Array.isArray(a00)).toBe(true);
    expect(a00).toHaveLength(1);
    const keys = mutations.map(({ headers }) => headers["x-idempotency-key"]);
    expect(keys).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(new Set(keys).size).toBe(2);
  });

  it("reports only the static issued question id and safe server code on screening PATCH failure", async () => {
    const questionId = EXPECTED_SCREENING_GOAL_QUESTION_IDS.find(
      (id) => id !== "G04",
    );
    if (questionId == null)
      throw new Error("screening fixture needs a required goal");
    const context = {
      page: {
        request: {
          fetch: async (path: string) =>
            path.endsWith("/screening/state")
              ? apiResponse(200, {
                  revision: 10,
                  interruptive_route: "none",
                  visible_questions: [
                    { id: questionId, type: "multi_select", required: true },
                  ],
                  saved_answers: {},
                })
              : apiResponse(400, {
                  detail: "patient supplied sensitive narrative",
                  error: { code: "revision_conflict" },
                  submitted_answer: "must never appear",
                }),
        },
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        url: () => "http://127.0.0.1:43101/assessment",
      },
      questionnaireMutations: [],
    } as unknown as Parameters<typeof prepareScreening>[0];

    let failure: Error | undefined;
    try {
      await prepareScreening(
        context,
        {
          id: "123e4567-e89b-42d3-a456-426614174010",
          revision: 9,
          status: "screening_in_progress",
        },
        { authoritativeResume: true },
      );
    } catch (error) {
      failure = error as Error;
    }
    expect(failure?.message).toBe(
      `Screening checkpoint answer mutation failed question_id=${questionId} status=400 code=revision_conflict`,
    );
    expect(failure?.message).not.toContain("sensitive narrative");
    expect(failure?.message).not.toContain("must never appear");
    expect(failure?.message).not.toContain("123e4567");
  });

  it("resumes partial adaptive from server saved answers without resubmission", async () => {
    let answerWrites = 0;
    const request = {
      fetch: async (path: string) => {
        if (path.endsWith("/adaptive/prepare")) {
          return apiResponse(200, {
            questions: [{ id: "INF_STIFF_SPINE", type: "single_select" }],
            revision: 20,
            saved_answers: { INF_STIFF_SPINE: "no" },
          });
        }
        if (path.endsWith("/adaptive/answers")) {
          answerWrites += 1;
          return apiResponse(200, { revision: 21 });
        }
        if (path.endsWith("/adaptive/complete-with-answers")) {
          return apiResponse(200, {
            revision: 21,
            status: "adaptive_complete",
          });
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    const context = {
      page: {
        request,
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        url: () => "http://127.0.0.1:43101/assessment",
      },
      questionnaireMutations: [],
    } as unknown as Parameters<typeof prepareAdaptive>[0];

    const result = await prepareAdaptive(context, {
      id: "123e4567-e89b-42d3-a456-426614174010",
      revision: 19,
      status: "adaptive_in_progress",
    });

    expect(result.status).toBe("adaptive_complete");
    expect(answerWrites).toBe(0);
  });

  it("adds distinct idempotency keys to every protected adaptive mutation", async () => {
    const mutations: Array<{
      path: string;
      data: unknown;
      headers: Record<string, string>;
    }> = [];
    const request = {
      fetch: async (
        path: string,
        options: {
          data?: unknown;
          headers: Record<string, string>;
        },
      ) => {
        mutations.push({
          path,
          data: options.data,
          headers: options.headers,
        });
        if (path.endsWith("/adaptive/prepare")) {
          return apiResponse(200, {
            questions: [
              {
                id: "gen_0",
                type: "single_select",
                options: [{ id: "synthetic_option" }],
              },
            ],
            revision: 20,
            saved_answers: {},
          });
        }
        if (path.endsWith("/adaptive/answers")) {
          return apiResponse(200, { revision: 21 });
        }
        if (path.endsWith("/adaptive/complete-with-answers")) {
          return apiResponse(200, {
            revision: 22,
            status: "adaptive_complete",
          });
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    const context = {
      page: {
        request,
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        url: () => "http://127.0.0.1:43101/assessment",
      },
      questionnaireMutations: [],
      generatedAdaptiveAnswers: new Map<string, unknown>(),
    } as unknown as Parameters<typeof prepareAdaptive>[0];

    await prepareAdaptive(context, {
      id: "123e4567-e89b-42d3-a456-426614174010",
      revision: 19,
      status: "adaptive_in_progress",
    });

    expect(
      mutations.map(({ path }) => path.split("/").slice(-2).join("/")),
    ).toEqual([
      "adaptive/prepare",
      "adaptive/answers",
      "adaptive/complete-with-answers",
    ]);
    expect(mutations[1]?.data).toEqual({
      answers: { gen_0: "synthetic_option" },
      expected_revision: 20,
    });
    expect(context.generatedAdaptiveAnswers).toEqual(
      new Map([["gen_0", "synthetic_option"]]),
    );
    const keys = mutations.map(({ headers }) => headers["x-idempotency-key"]);
    expect(keys).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(new Set(keys).size).toBe(3);
  });

  it("rejects a genuinely unsaved repeated visible screening question", () => {
    expect(() =>
      nextUnsavedScreeningQuestion(
        [{ id: "G01" }],
        new Set(),
        new Set(["G01"]),
      ),
    ).toThrow("repeated unsaved server question G01");
  });

  it("fails when a successful screening PATCH is not authoritative on the next GET", async () => {
    const questionId = EXPECTED_SCREENING_GOAL_QUESTION_IDS[0];
    if (questionId == null) throw new Error("screening goal fixture is empty");
    let stateReads = 0;
    const request = {
      fetch: async (path: string) => {
        if (path.endsWith("/screening/state")) {
          stateReads += 1;
          return apiResponse(200, {
            revision: 10 + stateReads,
            interruptive_route: "none",
            visible_questions: [{ id: questionId }],
            saved_answers: {},
          });
        }
        if (path.endsWith("/screening/answers")) {
          return apiResponse(200, {
            revision: 11,
            interruptive_route: "none",
            visible_questions: [{ id: questionId }],
            saved_answers: {},
          });
        }
        throw new Error(`unexpected ${path}`);
      },
    };
    const context = {
      page: {
        request,
        context: () => ({
          cookies: async () => [{ name: "spine_patient_csrf", value: "csrf" }],
        }),
        url: () => "http://127.0.0.1:43101/assessment",
      },
      questionnaireMutations: [],
    } as unknown as Parameters<typeof prepareScreening>[0];

    await expect(
      prepareScreening(
        context,
        {
          id: "123e4567-e89b-42d3-a456-426614174010",
          revision: 9,
          status: "screening_in_progress",
        },
        { authoritativeResume: true },
      ),
    ).rejects.toThrow("repeated unsaved server question");
  });

  it("rejects unsupported assessment states instead of moving backward", () => {
    expect(() => checkpointForAssessmentStatus("abandoned", false)).toThrow(
      "abandoned assessment",
    );
    expect(() => checkpointForAssessmentStatus("future_state", false)).toThrow(
      "unsupported assessment status future_state",
    );
  });
});
