import { describe, expect, it } from "vitest";

import { requireSummaryReadyDocument } from "../../../e2e/stages/documentAnalysis";

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
});
