import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT } from "./document-upload-fixture";

describe("synthetic document upload fixture", () => {
  it("pins byte length and digest to the shared metadata contract", () => {
    const bytes = readFileSync(
      resolve("e2e/fixtures/synthetic-assessment-report.pdf"),
    );

    expect(bytes.length).toBe(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.fileSizeBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.contentSha256,
    );
    expect(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrMarkers).toEqual([
      "SpineSense",
      "Clinical Summary",
      "Symptoms",
    ]);
    expect(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrPageCount).toBe(3);
    expect(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.expectedOcrProvider).toBe(
      "azure_openai_luna_vision",
    );
    expect(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumOcrTextLength).toBe(1000);
    expect(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.minimumSummaryLength).toBe(100);
  });
});
