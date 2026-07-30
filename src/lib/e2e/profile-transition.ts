export const PROFILE_SUBMISSION_MAX_ATTEMPTS = 3;

const RETRYABLE_PROFILE_SAVE_ERRORS = new Set([
  "We could not save your profile details. Please try again.",
  "We could not save your intake. Please try again.",
]);

export type ProfileTransitionSnapshot = {
  chiefComplaintVisible: boolean;
  continueEnabled: boolean;
  errorText: string | null;
  profileVisible: boolean;
};

export type ProfileTransitionDecision =
  | { status: "complete" }
  | { status: "pending" }
  | { reason: "acknowledged-error" | "ambiguous"; status: "retry" };

export function decideProfileTransition(
  attempt: number,
  snapshot: ProfileTransitionSnapshot,
): ProfileTransitionDecision {
  if (
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > PROFILE_SUBMISSION_MAX_ATTEMPTS
  ) {
    throw new Error(`Invalid profile submission attempt: ${attempt}`);
  }

  if (snapshot.chiefComplaintVisible) {
    return { status: "complete" };
  }

  if (!snapshot.profileVisible) {
    throw new Error(
      "Profile save entered an unknown state before chief complaint became visible",
    );
  }

  if (!snapshot.continueEnabled) {
    return { status: "pending" };
  }

  if (attempt === PROFILE_SUBMISSION_MAX_ATTEMPTS) {
    throw new Error(
      `Profile save did not reach chief complaint after ${PROFILE_SUBMISSION_MAX_ATTEMPTS} submissions`,
    );
  }

  const normalizedError = snapshot.errorText?.trim() ?? "";
  if (
    normalizedError.length > 0 &&
    !RETRYABLE_PROFILE_SAVE_ERRORS.has(normalizedError)
  ) {
    throw new Error("Profile save returned an unrecognized error state");
  }

  return {
    reason: normalizedError.length > 0 ? "acknowledged-error" : "ambiguous",
    status: "retry",
  };
}
