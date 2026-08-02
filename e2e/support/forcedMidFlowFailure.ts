export const FORCED_MID_FLOW_FAILURE_ENV =
  "PATIENT_WEB_E2E_FORCE_FAILURE_AFTER_STAGE";

export const FORCED_MID_FLOW_FAILURE_STAGE = "records-documents" as const;

const ALLOWED_FORCED_FAILURE_STAGES = [
  FORCED_MID_FLOW_FAILURE_STAGE,
  "auth",
  "consent-onboarding",
  "documents",
  "screening",
  "adaptive",
  "analysis",
  "results-report",
] as const;

export const FORCED_MID_FLOW_FAILURE_MESSAGE =
  "Synthetic forced E2E failure at approved stage milestone";
export const FORCED_MID_FLOW_FAILURE_UNAVAILABLE_MESSAGE =
  "Synthetic forced E2E failure milestone unavailable before terminal stage completion";

export type ForcedMidFlowFailureStage =
  (typeof ALLOWED_FORCED_FAILURE_STAGES)[number];

export function isForcedMidFlowFailureSelected(
  stage: ForcedMidFlowFailureStage,
): boolean {
  const configuredStage = readForcedMidFlowFailureStage();
  return (
    configuredStage === stage ||
    (stage === "documents" && configuredStage === FORCED_MID_FLOW_FAILURE_STAGE)
  );
}

/**
 * Read the E2E-only failure switch without carrying run, browser, or patient
 * state into the hook. An unset or empty value keeps the hook disabled.
 */
export function readForcedMidFlowFailureStage(
  value = process.env[FORCED_MID_FLOW_FAILURE_ENV],
): ForcedMidFlowFailureStage | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (normalized.length === 0) return null;
  if (
    !(ALLOWED_FORCED_FAILURE_STAGES as readonly string[]).includes(normalized)
  ) {
    throw new Error(
      `${FORCED_MID_FLOW_FAILURE_ENV} must name an approved journey stage or scope`,
    );
  }
  return normalized as ForcedMidFlowFailureStage;
}

/**
 * Intentionally fail at a milestone owned by the active stage. The legacy
 * records-documents value and the documents scope name select the same hook.
 * This is deterministic test behavior, not application recovery evidence.
 */
export function maybeThrowForcedMidFlowFailure(
  stage: ForcedMidFlowFailureStage,
): void {
  if (!isForcedMidFlowFailureSelected(stage)) return;
  throw new Error(FORCED_MID_FLOW_FAILURE_MESSAGE);
}

export function maybeThrowForcedMidFlowFailureUnavailable(
  stage: ForcedMidFlowFailureStage,
): void {
  if (!isForcedMidFlowFailureSelected(stage)) return;
  throw new Error(FORCED_MID_FLOW_FAILURE_UNAVAILABLE_MESSAGE);
}
