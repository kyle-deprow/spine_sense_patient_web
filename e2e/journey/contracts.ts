import { expect } from "@playwright/test";

import { fullAssessmentScenario } from "../fixtures/fullAssessmentScenario";
import {
  EXPECTED_SCREENING_GOAL_QUESTION_IDS,
  SCREENING_GOAL_QUESTION_IDS,
  expectRawAnswerValue,
  isRecord,
  type QuestionnaireMutation,
} from "./context";
import { assertExactIntakeRequestContract } from "../../src/lib/e2e/intake-request-contract";

export type QuestionnaireContractCheckpoint = "screening" | "adaptive";

export function expectQuestionnaireMutationContracts(
  mutations: readonly QuestionnaireMutation[],
  generatedAdaptiveAnswers: ReadonlyMap<string, unknown>,
  checkpoint: QuestionnaireContractCheckpoint,
) {
  const questionnaireMutations = mutations.filter(({ path }) =>
    /(screening|adaptive)\/(answers|complete|complete-with-answers)$/.test(
      path,
    ),
  );
  const screeningAnswers = new Map<string, unknown>([
    ...fullAssessmentScenario.screening.map(
      ({ id, value }) => [id, value] as const,
    ),
    ...fullAssessmentScenario.screeningText.map(
      ({ id, text }) => [id, text] as const,
    ),
  ]);
  const adaptiveAnswers = new Map<string, unknown>([
    ...fullAssessmentScenario.adaptive.map(
      ({ id, value }) => [id, value] as const,
    ),
    ...generatedAdaptiveAnswers,
  ]);
  const screeningGoalSubmissionCounts = new Map(
    EXPECTED_SCREENING_GOAL_QUESTION_IDS.map((id) => [id, 0]),
  );
  const adaptiveGoalSubmissionIds = new Set<string>();
  const contracts = {
    "/screening/answers": {
      allowedKeys: ["answers", "expected_revision", "question_notes"],
      requiredKeys: ["answers", "expected_revision"],
      fixtureAnswers: screeningAnswers,
    },
    "/screening/complete": {
      allowedKeys: ["answers", "expected_revision", "question_notes"],
      requiredKeys: ["expected_revision"],
      fixtureAnswers: screeningAnswers,
    },
    "/adaptive/answers": {
      allowedKeys: ["answers", "expected_revision", "question_notes"],
      requiredKeys: ["answers", "expected_revision"],
      fixtureAnswers: adaptiveAnswers,
    },
    "/adaptive/complete-with-answers": {
      allowedKeys: ["answers", "expected_revision", "question_notes"],
      requiredKeys: ["answers", "expected_revision"],
      fixtureAnswers: adaptiveAnswers,
    },
  } as const;

  const requiredMutationSuffixes: readonly (keyof typeof contracts)[] =
    checkpoint === "screening"
      ? ["/screening/answers", "/screening/complete"]
      : [
          "/screening/answers",
          "/screening/complete",
          "/adaptive/complete-with-answers",
        ];
  for (const suffix of requiredMutationSuffixes) {
    expect(
      mutations.some(({ path }) => path.endsWith(suffix)),
      `${suffix} must be exercised`,
    ).toBe(true);
  }

  for (const { path, payload } of questionnaireMutations) {
    const suffix = (
      Object.keys(contracts) as Array<keyof typeof contracts>
    ).find((candidate) => path.endsWith(candidate));
    expect(
      suffix,
      `${path} must have an endpoint-specific request contract`,
    ).toBeDefined();
    if (suffix == null) continue;

    expect(isRecord(payload), `${path} must send a plain JSON object`).toBe(
      true,
    );
    if (!isRecord(payload)) continue;

    const contract = contracts[suffix];
    expect(
      Object.keys(payload).filter(
        (key) => !(contract.allowedKeys as readonly string[]).includes(key),
      ),
      `${path} must not send aliases, derived fields, or arbitrary extras`,
    ).toEqual([]);
    for (const requiredKey of contract.requiredKeys) {
      expect(payload, `${path} must send ${requiredKey}`).toHaveProperty(
        requiredKey,
      );
    }
    expect(
      Number.isSafeInteger(payload.expected_revision) &&
        (payload.expected_revision as number) >= 0,
      `${path} expected_revision must be a non-negative integer`,
    ).toBe(true);

    if ("answers" in payload) {
      expect(
        isRecord(payload.answers),
        `${path} answers must be a raw answer map`,
      ).toBe(true);
      if (isRecord(payload.answers) && contract.fixtureAnswers != null) {
        for (const [questionId, value] of Object.entries(payload.answers)) {
          expect(
            !(
              (path.endsWith("/adaptive/answers") ||
                path.endsWith("/adaptive/complete-with-answers")) &&
              SCREENING_GOAL_QUESTION_IDS.has(questionId)
            ),
            `${path} must not submit screening goal ${questionId} as an adaptive follow-up`,
          ).toBe(true);
          if (
            path.endsWith("/screening/answers") &&
            screeningGoalSubmissionCounts.has(questionId)
          ) {
            screeningGoalSubmissionCounts.set(
              questionId,
              (screeningGoalSubmissionCounts.get(questionId) ?? 0) + 1,
            );
          }
          if (
            (path.endsWith("/adaptive/answers") ||
              path.endsWith("/adaptive/complete-with-answers")) &&
            SCREENING_GOAL_QUESTION_IDS.has(questionId)
          ) {
            adaptiveGoalSubmissionIds.add(questionId);
          }
          expect(
            contract.fixtureAnswers.has(questionId),
            `${path} answer ${questionId} must be an exact scenario fixture ID`,
          ).toBe(true);
          expectRawAnswerValue(path, questionId, value);
          expect(
            value,
            `${path} answer ${questionId} must equal its exact fixture value`,
          ).toEqual(contract.fixtureAnswers.get(questionId));
        }
      }
    }

    if ("question_notes" in payload) {
      expect(
        isRecord(payload.question_notes),
        `${path} question_notes must be a keyed map`,
      ).toBe(true);
      if (isRecord(payload.question_notes) && contract.fixtureAnswers != null) {
        for (const [questionId, note] of Object.entries(
          payload.question_notes,
        )) {
          expect(contract.fixtureAnswers.has(questionId)).toBe(true);
          expect(typeof note === "string" && note.trim().length > 0).toBe(true);
        }
      }
    }
  }

  const missingScreeningGoals = [...screeningGoalSubmissionCounts.entries()]
    .filter(([, count]) => count < 1)
    .map(([id]) => id);
  expect(
    missingScreeningGoals,
    "Each screening goal must be PATCHed as a screening answer",
  ).toEqual([]);
  expect(
    [...adaptiveGoalSubmissionIds],
    "Adaptive answers must never include screening goals",
  ).toEqual([]);
}

export const FORBIDDEN_DERIVED_CLINICAL_KEYS = new Set([
  "questionnaireOutput",
  "questionnaire_output",
  "phase1Qa",
  "phase1_qa",
  "urgency",
  "redFlags",
  "red_flags",
  "clinicalSummary",
  "clinical_summary",
  "clinicalOutput",
  "clinical_output",
  "diagnosis",
  "recommendation",
  "escalation",
]);

export function forbiddenDerivedClinicalKeys(
  value: unknown,
  path = "payload",
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) =>
      forbiddenDerivedClinicalKeys(entry, path + "[" + index + "]"),
    );
  }
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const currentPath = path + "." + key;
    return FORBIDDEN_DERIVED_CLINICAL_KEYS.has(key)
      ? [currentPath]
      : forbiddenDerivedClinicalKeys(nested, currentPath);
  });
}

function analysisRunMutations(
  mutations: readonly QuestionnaireMutation[],
): readonly QuestionnaireMutation[] {
  return mutations.filter(({ path }) => path.endsWith("/analysis/run"));
}

export function expectAnalysisRequestContracts(
  mutations: readonly QuestionnaireMutation[],
): void {
  const analysisMutations = analysisRunMutations(mutations);
  expect(
    analysisMutations.length,
    "The analysis request must be captured after review submission",
  ).toBeGreaterThan(0);

  for (const { path, payload } of analysisMutations) {
    expect(
      forbiddenDerivedClinicalKeys(payload),
      path + " must not contain client-derived clinical fields",
    ).toEqual([]);
    expect(isRecord(payload), path + " must send a JSON object").toBe(true);
    if (!isRecord(payload)) continue;
    expect(Object.keys(payload)).toEqual(["expected_revision"]);
    expect(Number.isSafeInteger(payload.expected_revision)).toBe(true);
  }
}

export function expectClientRequestContracts(
  mutations: readonly QuestionnaireMutation[],
  generatedAdaptiveAnswers: ReadonlyMap<string, unknown>,
  checkpoint: QuestionnaireContractCheckpoint,
): void {
  const intakeMutations = mutations.filter(({ path }) =>
    path.includes("/intake/"),
  );
  for (const { method, path, payload } of intakeMutations) {
    expect(
      forbiddenDerivedClinicalKeys(payload),
      path + " must not contain client-derived clinical fields",
    ).toEqual([]);
    expect(isRecord(payload), path + " must send a JSON object").toBe(true);
    if (!isRecord(payload)) continue;
    expect(() =>
      assertExactIntakeRequestContract(
        method,
        path,
        payload,
        fullAssessmentScenario,
      ),
    ).not.toThrow();
  }

  const assessmentMutations = mutations.filter(({ path }) =>
    path.includes("/assessments/"),
  );
  for (const { path, payload } of assessmentMutations) {
    expect(
      forbiddenDerivedClinicalKeys(payload),
      path + " must not contain client-derived clinical fields",
    ).toEqual([]);
  }
  if (analysisRunMutations(mutations).length > 0) {
    expectAnalysisRequestContracts(mutations);
  }
  expectQuestionnaireMutationContracts(
    mutations,
    generatedAdaptiveAnswers,
    checkpoint,
  );
}
