import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { recordsStepLocator } from "../../../e2e/stages/recordsDocuments";

describe("records documents readiness", () => {
  it("resolves readiness from the stable records container only", () => {
    const recordsContainer = {};
    const getByTestId = vi.fn(() => recordsContainer);
    const page = { getByTestId } as unknown as Page;

    expect(recordsStepLocator(page)).toBe(recordsContainer);
    expect(getByTestId).toHaveBeenCalledTimes(1);
    expect(getByTestId).toHaveBeenCalledWith("step-imaging-records");
  });
});
