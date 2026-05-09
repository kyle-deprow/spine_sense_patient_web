// SYNTHETIC DATA ONLY.
//
// Patient-web Playwright fixtures derived from the archived app fixture
// for the L4-L5 / right L5 radiculopathy mock scenario. Keep this file
// test-only; do not import it from app runtime code.

export type PatientWebSeededPatient = {
  readonly email: string;
  readonly password: string;
  readonly firstName: string;
  readonly lastName: string;
};

export type PatientWebClinicalAnalysisFixture = {
  readonly id: string;
  readonly assessmentId: string;
  readonly patientId: string;
  readonly resultsSchemaVersion: "2.0.0-app";
  readonly generatedAt: string;
  readonly diagnosis: {
    readonly headline: string;
    readonly subheadline: string;
    readonly primary: {
      readonly clinicalLabel: string;
      readonly patientFriendlyLabel: string;
      readonly spinalLevels: readonly string[];
      readonly involvedDisc: string;
      readonly bodyStructure: string;
    };
    readonly differentialLabels: readonly string[];
  };
  readonly urgency: {
    readonly displayLabel: string;
    readonly recommendedTimeframe: string;
  };
  readonly symptoms: readonly {
    readonly name: string;
    readonly clinicalLabel: string;
    readonly laterality: "midline" | "right";
    readonly severity: "moderate";
    readonly duration: string;
    readonly trend: "stable" | "worsening";
    readonly functionalImpactSummary: string;
    readonly isPrimary: boolean;
  }[];
  readonly treatmentSteps: readonly string[];
  readonly activityGuidance: {
    readonly generallyOkay: readonly string[];
    readonly limitForNow: readonly string[];
    readonly modifications: readonly string[];
  };
  readonly visitHandoff: {
    readonly topSuspectedDiagnosis: string;
    readonly summary: string;
    readonly patientGoals: readonly string[];
  };
  readonly disclaimer: string;
};

export type PatientWebClinicalScenarioFixture = {
  readonly seedKey: "archived-l4-l5-right-l5-radiculopathy";
  readonly patient: PatientWebSeededPatient;
  readonly assessmentStory: string;
  readonly analysis: PatientWebClinicalAnalysisFixture;
  readonly dashboardAssertions: {
    readonly clinicalSummaryHeadline: string;
    readonly clinicalSummarySubheadline: string;
    readonly activeProblemCondition: string;
    readonly activeProblemClinicalLabel: string;
    readonly activeProblemLevels: readonly string[];
    readonly activeProblemSummary: string;
  };
  readonly resultsAssertions: {
    readonly diagnosisLabel: string;
    readonly spinalLevel: string;
    readonly symptomNames: readonly string[];
    readonly symptomClinicalLabels: readonly string[];
    readonly treatmentLabels: readonly string[];
    readonly activityLabels: readonly string[];
  };
};

export const patientClinicalScenario = {
  seedKey: "archived-l4-l5-right-l5-radiculopathy",
  patient: {
    email: "patient@e2e.example.com",
    password: "E2eTest123!!",
    firstName: "John",
    lastName: "Doe",
  },
  assessmentStory:
    "Synthetic 35-year-old with 6 weeks of right-sided low back pain radiating past the knee. Sitting and forward bending worsen the pain; short walks and position changes help. No bowel or bladder symptoms, saddle anesthesia, fever, or progressive weakness.",
  analysis: {
    id: "00000000-0000-4000-cd00-000000000002",
    assessmentId: "00000000-0000-4000-cd00-000000000001",
    patientId: "00000000-0000-4000-f000-000000000001",
    resultsSchemaVersion: "2.0.0-app",
    generatedAt: "2026-01-01T12:00:00.000Z",
    diagnosis: {
      headline: "Likely lumbar disc-related nerve irritation",
      subheadline: "Pattern fits L5 nerve root involvement on the right",
      primary: {
        clinicalLabel: "Right L5 radiculopathy",
        patientFriendlyLabel: "Pinched nerve in your lower back (right side)",
        spinalLevels: ["L4-L5"],
        involvedDisc: "L4-L5",
        bodyStructure: "L5 nerve root",
      },
      differentialLabels: ["Lumbar facet-mediated pain"],
    },
    urgency: {
      displayLabel: "Routine specialist evaluation",
      recommendedTimeframe: "Within 2-4 weeks",
    },
    symptoms: [
      {
        name: "Lower back pain",
        clinicalLabel: "Lumbar axial pain",
        laterality: "midline",
        severity: "moderate",
        duration: "6 weeks",
        trend: "stable",
        functionalImpactSummary: "Worse with prolonged sitting.",
        isPrimary: true,
      },
      {
        name: "Right leg pain",
        clinicalLabel: "Right L5 radicular pain",
        laterality: "right",
        severity: "moderate",
        duration: "4 weeks",
        trend: "worsening",
        functionalImpactSummary: "Past the knee, worse with bending forward.",
        isPrimary: false,
      },
    ],
    treatmentSteps: [
      "Activity modification + over-the-counter pain control",
      "Physical therapy",
    ],
    activityGuidance: {
      generallyOkay: ["Short walks", "Gentle stretching"],
      limitForNow: ["Heavy lifting", "Long unbroken sitting"],
      modifications: ["Use a lumbar support when driving"],
    },
    visitHandoff: {
      topSuspectedDiagnosis: "Right L5 radiculopathy",
      summary:
        "Synthetic 35-year-old with 6 weeks of right-sided low back and leg pain consistent with radiculopathy.",
      patientGoals: ["Return to running", "Sleep through the night"],
    },
    disclaimer:
      "SYNTHETIC FIXTURE - not medical advice and not real patient data.",
  },
  dashboardAssertions: {
    clinicalSummaryHeadline: "Likely lumbar disc-related nerve irritation",
    clinicalSummarySubheadline:
      "Pattern fits L5 nerve root involvement on the right",
    activeProblemCondition: "Pinched nerve in your lower back (right side)",
    activeProblemClinicalLabel: "Right L5 radiculopathy",
    activeProblemLevels: ["L4-L5"],
    activeProblemSummary:
      "Synthetic 35-year-old with 6 weeks of right-sided low back and leg pain consistent with radiculopathy.",
  },
  resultsAssertions: {
    diagnosisLabel: "Right L5 radiculopathy",
    spinalLevel: "L4-L5",
    symptomNames: ["Lower back pain", "Right leg pain"],
    symptomClinicalLabels: ["Lumbar axial pain", "Right L5 radicular pain"],
    treatmentLabels: [
      "Activity modification + over-the-counter pain control",
      "Physical therapy",
    ],
    activityLabels: [
      "Short walks",
      "Heavy lifting",
      "Use a lumbar support when driving",
    ],
  },
} as const satisfies PatientWebClinicalScenarioFixture;
