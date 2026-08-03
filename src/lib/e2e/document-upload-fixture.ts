export const SYNTHETIC_DOCUMENT_UPLOAD_CONTRACT = {
  name: "synthetic-assessment-report.pdf",
  mimeType: "application/pdf",
  fileSizeBytes: 356286,
  contentSha256:
    "cae3f6cff796b6d1f8880c62b594157942f387f7ddf1c5182f3d1d4c755f8c39",
  processingStatus: "complete",
  scanStatus: "clean",
  generationState: "clean",
  expectedOcrPageCount: 3,
  expectedOcrProvider: "azure_openai_luna_vision",
  expectedOcrMarkers: ["SpineSense", "Clinical Summary", "Symptoms"],
  minimumOcrTextLength: 1000,
  minimumSummaryLength: 100,
} as const;
