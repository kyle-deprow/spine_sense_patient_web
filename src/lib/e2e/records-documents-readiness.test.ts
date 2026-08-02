import type { APIRequestContext, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { recordsStepLocator } from "../../../e2e/stages/recordsDocuments";
import {
  waitForAssessmentDocumentComplete,
  waitForDocumentConfirmationOrPersistence,
} from "../../../e2e/stages/recordsUpload";

describe("records documents readiness", () => {
  it("resolves readiness from the stable records container only", () => {
    const recordsContainer = {};
    const getByTestId = vi.fn(() => recordsContainer);
    const page = { getByTestId } as unknown as Page;

    expect(recordsStepLocator(page)).toBe(recordsContainer);
    expect(getByTestId).toHaveBeenCalledTimes(1);
    expect(getByTestId).toHaveBeenCalledWith("step-imaging-records");
  });

  it("fails immediately when upload UI errors before confirmation", async () => {
    const neverConfirms = new Promise<never>(() => undefined);
    const neverPersists = new Promise<never>(() => undefined);

    await expect(
      waitForDocumentConfirmationOrPersistence(
        neverConfirms,
        () => neverPersists,
        Promise.resolve("upload_error"),
      ),
    ).rejects.toThrow("byte upload failed before confirmation");
  });

  it("uses the correlated confirm response when it is observed", async () => {
    const response = { status: () => 200 };

    await expect(
      waitForDocumentConfirmationOrPersistence(
        Promise.resolve(response as never),
        () => new Promise<never>(() => undefined),
        new Promise<never>(() => undefined),
      ),
    ).resolves.toEqual({ source: "response", response });
  });

  it("recovers from a lost confirm response using persisted server state", async () => {
    const document = { id: "document-id", processingStatus: "processing" };

    await expect(
      waitForDocumentConfirmationOrPersistence(
        Promise.reject(new Error("response lost")),
        () => Promise.resolve(document as never),
        new Promise<never>(() => undefined),
      ),
    ).resolves.toEqual({ source: "persisted", document });
  });

  it("waits for the authoritative document projection to become OCR-ready", async () => {
    const states = ["processing", "complete"];
    const get = vi.fn(async () => {
      const state = states.shift() ?? "complete";
      return {
        status: () => 200,
        ok: () => true,
        json: async () => ({
          items: [
            {
              id: "123e4567-e89b-42d3-a456-426614174000",
              state,
              label: "Uploaded document",
              file_size_bytes: 1865,
            },
          ],
        }),
      };
    });

    await expect(
      waitForAssessmentDocumentComplete(
        { get } as unknown as APIRequestContext,
        "223e4567-e89b-42d3-a456-426614174000",
        "123e4567-e89b-42d3-a456-426614174000",
        1000,
        0,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "123e4567-e89b-42d3-a456-426614174000",
        state: "complete",
      }),
    );
    expect(get).toHaveBeenCalledTimes(2);
  });
});
