import type { Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { recordsStepLocator } from "../../../e2e/stages/recordsDocuments";
import { waitForDocumentConfirmOrUploadError } from "../../../e2e/stages/recordsUpload";

describe("records documents readiness", () => {
  it("resolves readiness from the stable records container only", () => {
    const recordsContainer = {};
    const getByTestId = vi.fn(() => recordsContainer);
    const page = { getByTestId } as unknown as Page;

    expect(recordsStepLocator(page)).toBe(recordsContainer);
    expect(getByTestId).toHaveBeenCalledTimes(1);
    expect(getByTestId).toHaveBeenCalledWith("step-imaging-records");
  });

  it("fails immediately when upload UI errors before any confirm response", async () => {
    const neverConfirms = new Promise<never>(() => undefined);

    await expect(
      waitForDocumentConfirmOrUploadError(
        neverConfirms,
        Promise.resolve("upload_error"),
      ),
    ).rejects.toThrow("byte upload failed before confirmation");
  });

  it("returns the correlated confirm response when it arrives first", async () => {
    const response = { status: () => 200 };

    await expect(
      waitForDocumentConfirmOrUploadError(
        Promise.resolve(response as never),
        new Promise<never>(() => undefined),
      ),
    ).resolves.toBe(response);
  });
});
