import { describe, expect, it } from "vitest";

import {
  buildPatientWebCheckpoint,
  CHECKPOINT_PREPARATION_MODE,
  PATIENT_WEB_CHECKPOINTS,
} from "../../../e2e/checkpoints";

describe("patient-web checkpoint contract", () => {
  it("declares a preparation mode for every named checkpoint", () => {
    expect(Object.keys(CHECKPOINT_PREPARATION_MODE).sort()).toEqual(
      [...PATIENT_WEB_CHECKPOINTS].sort(),
    );
  });

  it("keeps server-authored results explicitly unsupported", () => {
    expect(CHECKPOINT_PREPARATION_MODE.results_ready).toBe("unsupported");
    expect(CHECKPOINT_PREPARATION_MODE.review_ready).toBe("api");
  });

  it("fails closed before touching browser state for unsupported results", async () => {
    const context = {} as Parameters<typeof buildPatientWebCheckpoint>[0];

    await expect(
      buildPatientWebCheckpoint(context, "results_ready"),
    ).rejects.toThrow(
      "Checkpoint results_ready failed closed: the state would require fabricated server-owned clinical output",
    );
  });
});
