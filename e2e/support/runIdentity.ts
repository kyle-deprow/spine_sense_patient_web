import { randomUUID } from "node:crypto";

const RUN_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type E2ERunIdentity = Readonly<{
  runId: string;
  email: string;
}>;

export function createE2ERunIdentity(): E2ERunIdentity {
  const configuredRunId = process.env.PATIENT_WEB_E2E_RUN_ID?.trim();
  if (configuredRunId != null && !isE2ERunId(configuredRunId)) {
    throw new Error("PATIENT_WEB_E2E_RUN_ID must be a UUID when provided");
  }
  const runId = configuredRunId ?? randomUUID();
  return {
    runId,
    email: `casey.assessment.${runId}@e2e.example.com`,
  };
}

export function isE2ERunId(value: string): boolean {
  return RUN_ID_RE.test(value);
}

export function isExactSyntheticIdentity(identity: E2ERunIdentity): boolean {
  return (
    isE2ERunId(identity.runId) &&
    identity.email === `casey.assessment.${identity.runId}@e2e.example.com`
  );
}
