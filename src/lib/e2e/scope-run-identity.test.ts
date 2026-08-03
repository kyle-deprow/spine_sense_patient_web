import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createE2ERunIdentity,
  createScopedE2ERunIdentity,
  isExactSyntheticIdentity,
} from "../../../e2e/support/runIdentity";

const ROOT_RUN_ID = "123e4567-e89b-42d3-a456-426614174000";
const SCOPES = [
  "auth",
  "consent-onboarding",
  "documents",
  "screening",
  "adaptive",
  "analysis",
  "results-report",
] as const;

describe("checkpoint scope run identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("derives one stable exact synthetic identity per scope and root run", () => {
    vi.stubEnv("PATIENT_WEB_E2E_RUN_ID", ROOT_RUN_ID);

    const firstPass = SCOPES.map(createScopedE2ERunIdentity);
    const secondPass = SCOPES.map(createScopedE2ERunIdentity);

    expect(secondPass).toEqual(firstPass);
    expect(new Set(firstPass.map((identity) => identity.runId)).size).toBe(
      SCOPES.length,
    );
    for (const identity of firstPass) {
      expect(identity.runId).not.toBe(ROOT_RUN_ID);
      expect(identity.runId[14]).toBe("5");
      expect(isExactSyntheticIdentity(identity)).toBe(true);
    }
  });

  it("changes the scoped identity when the owning root run changes", () => {
    vi.stubEnv("PATIENT_WEB_E2E_RUN_ID", ROOT_RUN_ID);
    const firstRun = createScopedE2ERunIdentity("analysis");
    vi.stubEnv(
      "PATIENT_WEB_E2E_RUN_ID",
      "987e6543-e21b-42d3-a456-426614174999",
    );

    expect(createScopedE2ERunIdentity("analysis")).not.toEqual(firstRun);
  });

  it("matches the independently calculated analysis UUIDv5 vector", () => {
    vi.stubEnv("PATIENT_WEB_E2E_RUN_ID", ROOT_RUN_ID);

    expect(createScopedE2ERunIdentity("analysis").runId).toBe(
      "a5c567b0-4b96-54a9-a01d-02115cb831ce",
    );
  });

  it("keeps the unscoped legacy journey bound to the root run identity", () => {
    vi.stubEnv("PATIENT_WEB_E2E_RUN_ID", ROOT_RUN_ID);

    expect(createE2ERunIdentity()).toEqual({
      runId: ROOT_RUN_ID,
      email: `casey.assessment.${ROOT_RUN_ID}@e2e.example.com`,
    });
  });

  it.each(["", "Auth", "../auth", "auth_scope", "a".repeat(65)])(
    "rejects invalid scope discriminator %j",
    (scope) => {
      vi.stubEnv("PATIENT_WEB_E2E_RUN_ID", ROOT_RUN_ID);

      expect(() => createScopedE2ERunIdentity(scope)).toThrow(
        "requires an approved scope name",
      );
    },
  );
});
