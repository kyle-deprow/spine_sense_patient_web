import { createHash, randomUUID } from "node:crypto";

const RUN_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type E2ERunIdentity = Readonly<{
  runId: string;
  email: string;
}>;

export function createE2ERunIdentity(): E2ERunIdentity {
  const runId = configuredOrRandomRunId();
  return identityForRunId(runId);
}

export function createScopedE2ERunIdentity(scope: string): E2ERunIdentity {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(scope)) {
    throw new Error(
      "Patient web E2E scope identity requires an approved scope name",
    );
  }
  const parentRunId = configuredOrRandomRunId();
  const namespace = Buffer.from(parentRunId.replaceAll("-", ""), "hex");
  const bytes = createHash("sha1")
    .update(namespace)
    .update(`spinesense-patient-web-scope-v1:${scope}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  const runId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return identityForRunId(runId);
}

function configuredOrRandomRunId(): string {
  const configuredRunId = process.env.PATIENT_WEB_E2E_RUN_ID?.trim();
  if (configuredRunId != null && !isE2ERunId(configuredRunId)) {
    throw new Error("PATIENT_WEB_E2E_RUN_ID must be a UUID when provided");
  }
  return configuredRunId ?? randomUUID();
}

function identityForRunId(runId: string): E2ERunIdentity {
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
