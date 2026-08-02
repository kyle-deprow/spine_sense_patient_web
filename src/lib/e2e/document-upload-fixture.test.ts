import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT } from "./document-upload-fixture";

describe("synthetic document upload fixture", () => {
  it("pins byte length and digest to the shared metadata contract", () => {
    const bytes = Buffer.from(
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.base64,
      "base64",
    );

    expect(bytes.length).toBe(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.fileSizeBytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.contentSha256,
    );
    expect(SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT.ocrExpectedLines).toEqual([
      "SPINESENSE SYNTHETIC E2E RECORD",
      "Synthetic OCR validation record.",
    ]);
  });
});
