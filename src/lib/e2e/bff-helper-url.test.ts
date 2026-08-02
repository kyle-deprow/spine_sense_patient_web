import { describe, expect, it } from "vitest";

import { validateBffHelperUrl } from "../../../e2e/journey/context";

const bffBaseUrl = "https://patient-web.example.test";
const environmentVariable = "PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL";
const helperPath = "/api/test/registration-verification-code";

describe("patient-web E2E helper URL contract", () => {
  it("accepts the exact same-origin BFF support route", () => {
    expect(
      validateBffHelperUrl(
        `${bffBaseUrl}${helperPath}`,
        environmentVariable,
        helperPath,
        bffBaseUrl,
      ),
    ).toBe(`${bffBaseUrl}${helperPath}`);
  });

  it("accepts the exact document persistence BFF support route", () => {
    const persistencePath = "/api/test/document-upload-persistence";
    expect(
      validateBffHelperUrl(
        `${bffBaseUrl}${persistencePath}`,
        "PATIENT_WEB_BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL",
        persistencePath,
        bffBaseUrl,
      ),
    ).toBe(`${bffBaseUrl}${persistencePath}`);
  });

  it("rejects a direct backend document persistence helper", () => {
    const persistencePath = "/api/test/document-upload-persistence";
    expect(() =>
      validateBffHelperUrl(
        `https://api.example.test${persistencePath}`,
        "PATIENT_WEB_BACKEND_DOCUMENT_UPLOAD_PERSISTENCE_URL",
        persistencePath,
        bffBaseUrl,
      ),
    ).toThrow(/same-origin BFF route/);
  });

  it("accepts only the same-origin post-analysis persistence helper", () => {
    const analysisPath = "/api/test/document-analysis-persistence";
    expect(
      validateBffHelperUrl(
        `${bffBaseUrl}${analysisPath}`,
        "PATIENT_WEB_BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL",
        analysisPath,
        bffBaseUrl,
      ),
    ).toBe(`${bffBaseUrl}${analysisPath}`);
    expect(() =>
      validateBffHelperUrl(
        `https://api.example.test${analysisPath}`,
        "PATIENT_WEB_BACKEND_DOCUMENT_ANALYSIS_PERSISTENCE_URL",
        analysisPath,
        bffBaseUrl,
      ),
    ).toThrow(/same-origin BFF route/);
  });

  it.each([
    "https://api.example.test/api/test/registration-verification-code",
    "https://patient-web.example.test/api/test/document-scan-result",
    "https://patient-web.example.test/api/test/registration-verification-code?redirect=backend",
    "/api/test/registration-verification-code",
  ])("rejects a helper URL outside the exact BFF boundary: %s", (url) => {
    expect(() =>
      validateBffHelperUrl(url, environmentVariable, helperPath, bffBaseUrl),
    ).toThrow(/same-origin BFF route|absolute same-origin BFF URL/);
  });

  it("treats an unset helper as unavailable for the caller's required check", () => {
    expect(
      validateBffHelperUrl(
        undefined,
        environmentVariable,
        helperPath,
        bffBaseUrl,
      ),
    ).toBeUndefined();
  });
});
