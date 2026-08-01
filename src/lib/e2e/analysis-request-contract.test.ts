import { describe, expect, it } from "vitest";

import { expectAnalysisRequestContracts } from "../../../e2e/journey/contracts";

const analysisPath =
  "/api/proxy/api/v1/patients/me/assessments/assessment-123/analysis/run";

describe("analysis request contract", () => {
  it("accepts the raw server-authority analysis request", () => {
    expect(() =>
      expectAnalysisRequestContracts([
        { path: analysisPath, payload: { expected_revision: 3 } },
      ]),
    ).not.toThrow();
  });

  it.each([
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
  ])("rejects client-derived analysis field %s", (field) => {
    expect(() =>
      expectAnalysisRequestContracts([
        {
          path: analysisPath,
          payload: { expected_revision: 3, [field]: "client-derived" },
        },
      ]),
    ).toThrow();
  });
});
