import { describe, expect, it } from "vitest";

import {
  CHECKPOINT_CONTRACTS,
  CHECKPOINT_PREPARATION_MODE,
  PATIENT_WEB_CHECKPOINTS,
  checkpointForAssessmentStatus,
  nextUnsavedScreeningQuestion,
  planCheckpointTransitions,
  prepareAdaptive,
  prepareScreening,
  reconcileAuthoritativeCheckpoint,
  tryBffJson,
} from "../../../e2e/checkpoints";
import { EXPECTED_SCREENING_GOAL_QUESTION_IDS } from "../../../e2e/journey/context";

const apiResponse = (status: number, body: unknown, malformed = false) => ({
  ok: () => status >= 200 && status < 300,
  status: () => status,
  json: async () => {
    if (malformed) throw new SyntaxError("malformed");
    return body;
  },
});

describe("patient-web checkpoint contract", () => {
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

  it.each([
    ["draft", false, "records_ready", "create"],
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
