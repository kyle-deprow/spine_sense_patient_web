export function readPositiveIntegerEnv(
  name: string,
  defaultValue: number,
): number {
  const raw = process.env[name];
  if (raw == null || raw.trim().length === 0) return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(
      `${name} must be a positive integer number of milliseconds`,
    );
  }
  return value;
}

// Azure's event-triggered OCR job is KEDA-scaled from zero, so readiness costs
// up to one 60-second polling interval before an execution even starts, plus
// however long that execution takes.
//
// The old 5-minute budget assumed one polling interval and a quick execution.
// That does not hold under the suite's own load: on 2026-08-20 a production
// run observed a single OCR execution take 5m42s -- longer than the entire
// budget before counting the polling wait -- and results-report failed at the
// 5-minute deadline while OCR was still actively processing. Every OCR
// execution in that window succeeded, so the document was never stuck; the
// wait was simply shorter than the pipeline it waits on.
//
// Overridable like the analysis budget below, so a slow environment can be
// given room without editing code.
export const DOCUMENT_OCR_READINESS_TIMEOUT_MS = readPositiveIntegerEnv(
  "PATIENT_WEB_E2E_OCR_BUDGET_MS",
  10 * 60 * 1000,
);
export const ASSESSMENT_ANALYSIS_READINESS_TIMEOUT_MS = readPositiveIntegerEnv(
  "PATIENT_WEB_E2E_ANALYSIS_BUDGET_MS",
  8 * 60 * 1000,
);
export const DOCUMENT_SUMMARY_READINESS_TIMEOUT_MS = 3 * 60 * 1000;
export const REPORT_GENERATION_TIMEOUT_MS = readPositiveIntegerEnv(
  "PATIENT_WEB_E2E_REPORT_BUDGET_MS",
  2 * 60 * 1000,
);

// Registration, consent, onboarding, questionnaires, navigation, assertions,
// and lifecycle cleanup took under six minutes in the slow deployed run. Keep
// their aggregate allowance explicit and bounded instead of hiding it in an
// unrelated worker timeout.
export const FULL_FLOW_INTERACTIVE_AND_LIFECYCLE_BUDGET_MS = 8 * 60 * 1000;
export const SCOPED_ASSESSMENT_OVERHEAD_MS = 4 * 60 * 1000;
export const SCOPED_ASSESSMENT_TIMEOUT_FLOOR_MS = 15 * 60 * 1000;

export function calculateScopedAssessmentTimeoutMs(options: {
  analysisMs: number;
  summaryMs: number;
  reportMs: number;
  overheadMs: number;
  floorMs: number;
}): number {
  return Math.max(
    options.floorMs,
    options.analysisMs + options.summaryMs + options.overheadMs,
    options.reportMs + options.overheadMs,
  );
}

export const SCOPED_ASSESSMENT_TIMEOUT_MS = calculateScopedAssessmentTimeoutMs({
  analysisMs: ASSESSMENT_ANALYSIS_READINESS_TIMEOUT_MS,
  summaryMs: DOCUMENT_SUMMARY_READINESS_TIMEOUT_MS,
  reportMs: REPORT_GENERATION_TIMEOUT_MS,
  overheadMs: SCOPED_ASSESSMENT_OVERHEAD_MS,
  floorMs: SCOPED_ASSESSMENT_TIMEOUT_FLOOR_MS,
});

export const FULL_FLOW_REQUIRED_TIMEOUT_MS =
  FULL_FLOW_INTERACTIVE_AND_LIFECYCLE_BUDGET_MS +
  DOCUMENT_OCR_READINESS_TIMEOUT_MS +
  ASSESSMENT_ANALYSIS_READINESS_TIMEOUT_MS +
  DOCUMENT_SUMMARY_READINESS_TIMEOUT_MS +
  REPORT_GENERATION_TIMEOUT_MS;

export function requireFullFlowTimeoutBudget(
  configuredMs: number,
  requiredMs: number = FULL_FLOW_REQUIRED_TIMEOUT_MS,
): number {
  if (configuredMs < requiredMs) {
    throw new Error(
      `PATIENT_WEB_E2E_FULL_FLOW_TIMEOUT_MS must be at least ${requiredMs}ms to cover the bounded full-flow critical path`,
    );
  }
  return configuredMs;
}

export const FULL_FLOW_TIMEOUT_MS = requireFullFlowTimeoutBudget(
  readPositiveIntegerEnv(
    "PATIENT_WEB_E2E_FULL_FLOW_TIMEOUT_MS",
    FULL_FLOW_REQUIRED_TIMEOUT_MS,
  ),
);
