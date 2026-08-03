import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requireSummaryReadyDocument,
  safePersistenceMismatchAxes,
  waitForDocumentAnalysisPersistence,
} from "../../../e2e/stages/documentAnalysis";

const DOCUMENT_ID = "123e4567-e89b-42d3-a456-426614174000";
const readyDocument = {
  id: DOCUMENT_ID,
  status: "summary_ready",
  processing_stage: "complete",
  is_terminal: true,
  category: "imaging",
  document_type: "file_upload",
  doc_type: "Imaging record",
  summary: "Synthetic server summary.",
};

describe("post-analysis document readiness", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts only the exact structurally complete summary-ready document", () => {
    expect(
      requireSummaryReadyDocument(
        { documents: [{ ...readyDocument, id: "other" }, readyDocument] },
        DOCUMENT_ID,
      ),
    ).toEqual({ id: DOCUMENT_ID });
  });

  it.each([
    { ...readyDocument, status: "processing" },
    { ...readyDocument, processing_stage: "summary" },
    { ...readyDocument, is_terminal: false },
    { ...readyDocument, category: "" },
    { ...readyDocument, document_type: "" },
    { ...readyDocument, doc_type: "" },
    { ...readyDocument, summary: "" },
  ])(
    "rejects incomplete summary readiness without inspecting prose: %#",
    (document) => {
      expect(
        requireSummaryReadyDocument({ documents: [document] }, DOCUMENT_ID),
      ).toBeNull();
    },
  );

  it("does not substitute another summary-ready document", () => {
    expect(
      requireSummaryReadyDocument(
        { documents: [{ ...readyDocument, id: "other" }] },
        DOCUMENT_ID,
      ),
    ).toBeNull();
  });

  it("reports only allowlisted persistence mismatch axes", () => {
    expect(
      safePersistenceMismatchAxes({
        error: "support_conflict",
        mismatches: ["patient_summary", "patient_findings"],
      }),
    ).toEqual(["patient_findings", "patient_summary"]);
    expect(
      safePersistenceMismatchAxes({
        mismatches: ["patient_summary", "raw_patient_detail"],
      }),
    ).toBeNull();
  });

  it("waits for durable summary readiness and returns the successful attestation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const ready = { assessment_id: "synthetic-assessment" };
    const probe = vi
      .fn()
      .mockResolvedValueOnce({
        status: 409,
        payload: {
          error: "support_conflict",
          mismatches: ["summary_status", "summary_completed_at"],
        },
      })
      .mockResolvedValueOnce({ status: 200, payload: ready });

    const persistence = waitForDocumentAnalysisPersistence(probe, 10_000, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    await expect(persistence).resolves.toBe(ready);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each(["summary_status", "summary_completed_at"])(
    "retries the individual transient summary axis %s",
    async (axis) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const ready = { assessment_id: "synthetic-assessment" };
      const probe = vi
        .fn()
        .mockResolvedValueOnce({
          status: 409,
          payload: {
            error: "support_conflict",
            mismatches: [axis],
          },
        })
        .mockResolvedValueOnce({ status: 200, payload: ready });

      const persistence = waitForDocumentAnalysisPersistence(
        probe,
        10_000,
        1000,
      );
      await vi.advanceTimersByTimeAsync(1000);

      await expect(persistence).resolves.toBe(ready);
      expect(probe).toHaveBeenCalledTimes(2);
    },
  );

  it("times out while only durable summary readiness axes remain pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const probe = vi.fn().mockResolvedValue({
      status: 409,
      payload: {
        error: "support_conflict",
        mismatches: ["summary_completed_at", "summary_status"],
      },
    });

    const persistence = waitForDocumentAnalysisPersistence(probe, 2000, 1000);
    const rejection = expect(persistence).rejects.toThrow(
      "timed out mismatches=summary_completed_at,summary_status",
    );
    await vi.advanceTimersByTimeAsync(2000);

    await rejection;
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      status: 409,
      payload: {
        error: "support_conflict",
        mismatches: ["summary_status", "ocr_text_lineage"],
      },
      expected: "mismatches=ocr_text_lineage,summary_status",
    },
    {
      status: 409,
      payload: {
        error: "support_conflict",
        mismatches: ["summary_status", "unknown_axis"],
      },
      expected: "mismatches=unknown",
    },
    {
      status: 503,
      payload: { error: "support_unavailable" },
      expected: "status=503",
    },
    {
      status: 409,
      payload: { mismatches: ["summary_status"] },
      expected: "status=409",
    },
    {
      status: 409,
      payload: {
        error: "unexpected_conflict",
        mismatches: ["summary_completed_at"],
      },
      expected: "status=409",
    },
  ])(
    "fails immediately for a nonretryable persistence result: %#",
    async ({ status, payload, expected }) => {
      const probe = vi.fn().mockResolvedValue({ status, payload });

      await expect(
        waitForDocumentAnalysisPersistence(probe, 10_000, 1000),
      ).rejects.toThrow(expected);
      expect(probe).toHaveBeenCalledTimes(1);
    },
  );
});
