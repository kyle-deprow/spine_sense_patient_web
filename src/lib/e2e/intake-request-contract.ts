type IntakeScenario = {
  onboarding: {
    dateOfBirthDisplay: string;
    sexAtBirth: string;
    heightFeet: string;
    heightInches: string;
    weightPounds: string;
    occupation: string;
    activityLevel: string;
    chiefComplaint: string;
    intakeStepData: {
      "treatment-history": {
        conditions: { items: readonly string[]; none: boolean };
        nicotine: { use: "no" | "yes" | "former" };
      };
    };
    intakeWireStepData: {
      "treatment-history": Record<string, unknown>;
    };
  };
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function assertKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `${label} keys must be exactly [${expected.join(", ")}], received [${actual.join(", ")}]`,
    );
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} must equal the synthetic scenario value`);
  }
}

function expectedStepData(step: string, scenario: IntakeScenario): JsonRecord {
  switch (step) {
    case "profile": {
      const [month, day, year] =
        scenario.onboarding.dateOfBirthDisplay.split("/");
      return {
        date_of_birth: `${year}-${month}-${day}`,
        sex_at_birth: scenario.onboarding.sexAtBirth,
        height_ft: scenario.onboarding.heightFeet,
        height_in: scenario.onboarding.heightInches,
        weight: scenario.onboarding.weightPounds,
        occupation: scenario.onboarding.occupation,
        activity_level: scenario.onboarding.activityLevel,
      };
    }
    case "chief-complaint":
      return {
        narrative: scenario.onboarding.chiefComplaint,
        input_method: "text",
      };
    case "treatment-history":
      return scenario.onboarding.intakeWireStepData["treatment-history"];
    case "imaging-records":
      return {};
    default:
      throw new Error(`Unsupported intake step: ${step}`);
  }
}

/** Validate one captured browser-wire intake mutation; fail closed on drift. */
export function assertExactIntakeRequestContract(
  path: string,
  payload: unknown,
  scenario: IntakeScenario,
): void {
  if (!isRecord(payload)) throw new Error(`${path} must send a JSON object`);

  if (path.endsWith("/intake/route")) {
    assertKeys(payload, ["narrative"], path);
    assertEqual(
      payload.narrative,
      scenario.onboarding.chiefComplaint,
      `${path}.narrative`,
    );
    return;
  }

  const stepMatch = path.match(/\/intake\/steps\/([^/]+)$/);
  if (stepMatch?.[1] != null) {
    assertKeys(payload, ["step_data"], path);
    if (!isRecord(payload.step_data))
      throw new Error(`${path}.step_data must be an object`);
    const expected = expectedStepData(stepMatch[1], scenario);
    assertKeys(payload.step_data, Object.keys(expected), `${path}.step_data`);
    assertEqual(payload.step_data, expected, `${path}.step_data`);
    return;
  }

  if (path.endsWith("/intake/progress/complete")) {
    assertKeys(payload, [], path);
    return;
  }

  throw new Error(
    `${path} is not an allowlisted intake mutation for this scenario`,
  );
}
