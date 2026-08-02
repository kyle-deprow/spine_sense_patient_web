import { describe, expect, it } from "vitest";

import { expectAnalysisRequestContracts } from "../../../e2e/journey/contracts";
import { expectCompletedAnalysisResponse } from "../../../e2e/stages/reviewAnalysis";

const analysisPath =
  "/api/proxy/api/v1/patients/me/assessments/assessment-123/analysis/run";

describe("analysis request contract", () => {
  it("accepts the raw server-authority analysis request", () => {
    expect(() =>
      expectAnalysisRequestContracts([
        {
          method: "POST",
          path: analysisPath,
          payload: { expected_revision: 3 },
        },
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
          method: "POST",
          path: analysisPath,
          payload: { expected_revision: 3, [field]: "client-derived" },
        },
      ]),
    ).toThrow();
  });
});

describe("completed analysis response contract", () => {
  const responseUrl =
    "http://127.0.0.1:43101/api/proxy/api/v1/patients/me/assessments/assessment-123/analysis";

  it("requires a same-origin structured result correlated to the route", () => {
    expect(() =>
      expectCompletedAnalysisResponse(
        responseUrl,
        "http://127.0.0.1:43101/assessment",
        {
          status: "complete",
          assessment_id: "assessment-123",
          results_schema_version: "2.2.0-app",
        },
      ),
    ).not.toThrow();
  });

  it.each([
    [
      "wrong origin",
      "https://backend.example.com/assessments/assessment-123/analysis",
      {
        status: "complete",
        assessment_id: "assessment-123",
        results_schema_version: "2.2.0-app",
      },
    ],
    [
      "wrong assessment",
      responseUrl,
      {
        status: "complete",
        assessment_id: "assessment-456",
        results_schema_version: "2.2.0-app",
      },
    ],
    [
      "missing schema",
      responseUrl,
      { status: "complete", assessment_id: "assessment-123" },
    ],
  ])("rejects %s", (_label, url, payload) => {
    expect(() =>
      expectCompletedAnalysisResponse(
        url,
        "http://127.0.0.1:43101/assessment",
        payload,
      ),
    ).toThrow();
  });
});
