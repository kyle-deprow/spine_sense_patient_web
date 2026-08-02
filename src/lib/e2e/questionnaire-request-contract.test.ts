import { describe, expect, it } from "vitest";

import { fullAssessmentScenario } from "../../../e2e/fixtures/fullAssessmentScenario";
import {
  expectClientRequestContracts,
  type QuestionnaireContractCheckpoint,
} from "../../../e2e/journey/contracts";
import type { QuestionnaireMutation } from "../../../e2e/journey/context";

const assessmentPath =
  "/api/proxy/api/v1/patients/me/assessments/assessment-123";

function screeningMutations(): QuestionnaireMutation[] {
  return [
    {
      method: "PATCH",
      path: `${assessmentPath}/screening/answers`,
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
        expected_revision: 0,
      },
    },
    {
      method: "POST",
      path: `${assessmentPath}/screening/complete`,
      payload: { expected_revision: 1 },
    },
  ];
}

function validate(
  mutations: readonly QuestionnaireMutation[],
  checkpoint: QuestionnaireContractCheckpoint,
) {
  expectClientRequestContracts(mutations, new Map(), checkpoint);
}

describe("questionnaire request contract checkpoints", () => {
  it("validates screening contracts before adaptive completion exists", () => {
    expect(() => validate(screeningMutations(), "screening")).not.toThrow();
  });

  it("requires adaptive completion at the adaptive checkpoint", () => {
    expect(() => validate(screeningMutations(), "adaptive")).toThrow();
  });

  it("requires adaptive completion while retaining exact raw answer checks", () => {
    const adaptiveCompletion: QuestionnaireMutation = {
      method: "POST",
      path: `${assessmentPath}/adaptive/complete-with-answers`,
      payload: {
        answers: { INF_STIFF_SPINE: "no" },
        expected_revision: 2,
      },
    };
    const mutations: QuestionnaireMutation[] = [
      ...screeningMutations(),
      adaptiveCompletion,
    ];

    expect(() => validate(mutations, "adaptive")).not.toThrow();
    expect(() =>
      validate(
        [
          {
            method: "POST",
            path: adaptiveCompletion.path,
            payload: {
              answers: { INF_STIFF_SPINE: "no" },
              expected_revision: 2,
              questionnaireOutput: "client-derived",
            },
          },
        ],
        "adaptive",
      ),
    ).toThrow();
  });
});
