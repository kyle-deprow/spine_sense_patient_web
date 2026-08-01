export type RecoveryClass =
  | "transient-network"
  | "transient-gateway"
  | "eventual-consistency"
  | "application"
  | "schema"
  | "authorization"
  | "clinical"
  | "assertion";

export type RecoveryDecision = Readonly<{
  retry: boolean;
  reason: RecoveryClass;
}>;

export type RecoveryObservation = Readonly<{
  status?: number;
  failureText?: string;
  errorCode?: string;
  documentedEventualConsistency?: boolean;
}>;

const TRANSIENT_GATEWAY_STATUSES = new Set([502, 503, 504]);

export function classifyRecovery(
  observation: RecoveryObservation,
): RecoveryDecision {
  if (observation.failureText?.includes("ERR_NETWORK_CHANGED")) {
    return { retry: true, reason: "transient-network" };
  }
  if (
    observation.status != null &&
    TRANSIENT_GATEWAY_STATUSES.has(observation.status)
  ) {
    return { retry: true, reason: "transient-gateway" };
  }
  if (observation.documentedEventualConsistency) {
    return { retry: true, reason: "eventual-consistency" };
  }
  if (observation.status === 401 || observation.status === 403) {
    return { retry: false, reason: "authorization" };
  }
  if (observation.status === 400 || observation.status === 422) {
    return { retry: false, reason: "schema" };
  }
  if (observation.errorCode === "clinical_failure") {
    return { retry: false, reason: "clinical" };
  }
  if (observation.status != null && observation.status >= 400) {
    return { retry: false, reason: "application" };
  }
  return { retry: false, reason: "assertion" };
}

export function assertRecoveryAttempt(
  decision: RecoveryDecision,
  attempt: number,
  maxAttempts: number,
): void {
  if (attempt >= maxAttempts && decision.retry) {
    throw new Error(
      `Transient recovery exhausted after ${maxAttempts} attempts (${decision.reason})`,
    );
  }
  if (!decision.retry && decision.reason !== "assertion") {
    throw new Error(
      `Deterministic ${decision.reason} failure; recovery is not allowed`,
    );
  }
}
