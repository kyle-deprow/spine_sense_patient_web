import type { APIRequestContext, Page } from "@playwright/test";
import { describe, expect, it, vi } from "vitest";

import { assessmentDocumentConfirmationFromResponse } from "../../../e2e/journey/context";
import { recordsStepLocator } from "../../../e2e/stages/recordsDocuments";
import {
  DOCUMENT_OCR_READINESS_TIMEOUT_MS,
  waitForAssessmentDocumentComplete,
  waitForDocumentConfirmationOrPersistence,
} from "../../../e2e/stages/recordsUpload";

describe("records documents readiness", () => {
  it("parses the backend assessment document confirmation contract", () => {
    expect(
      assessmentDocumentConfirmationFromResponse({
        document_id: "123e4567-e89b-42d3-a456-426614174000",
        processing_status: "processing",
      }),
    ).toEqual({
      documentId: "123e4567-e89b-42d3-a456-426614174000",
      processingStatus: "processing",
    });

    expect(() =>
      assessmentDocumentConfirmationFromResponse({
        id: "123e4567-e89b-42d3-a456-426614174000",
        processing_status: "processing",
      }),
    ).toThrow("did not include document_id");
  });

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

  it("allows an event-triggered OCR execution to finish after scale-from-zero latency", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const get = vi.fn(async () => {
      const state = Date.now() >= 130_000 ? "complete" : "processing";
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

    try {
      const readiness = waitForAssessmentDocumentComplete(
        { get } as unknown as APIRequestContext,
        "223e4567-e89b-42d3-a456-426614174000",
        "123e4567-e89b-42d3-a456-426614174000",
      );
      await vi.advanceTimersByTimeAsync(130_000);

      await expect(readiness).resolves.toEqual(
        expect.objectContaining({ state: "complete" }),
      );
      // A floor, not an exact value. The budget has to cover one 60s KEDA
      // polling interval plus a full OCR execution, and a production run on
      // 2026-08-20 observed a single execution take 5m42s on its own -- longer
      // than the 300_000ms this used to pin, which is what failed
      // results-report while OCR was still healthily processing. Raising the
      // budget must stay allowed; shrinking it below the observed latency must
      // not.
      expect(DOCUMENT_OCR_READINESS_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails immediately when the authoritative OCR projection is terminal", async () => {
    const get = vi.fn(async () => ({
      status: () => 200,
      ok: () => true,
      json: async () => ({
        items: [
          {
            id: "123e4567-e89b-42d3-a456-426614174000",
            state: "failed",
            label: "Uploaded document",
            file_size_bytes: 1865,
          },
        ],
      }),
    }));

    await expect(
      waitForAssessmentDocumentComplete(
        { get } as unknown as APIRequestContext,
        "223e4567-e89b-42d3-a456-426614174000",
        "123e4567-e89b-42d3-a456-426614174000",
      ),
    ).rejects.toThrow("entered failed state before OCR readiness");
    expect(get).toHaveBeenCalledTimes(1);
  });
});
