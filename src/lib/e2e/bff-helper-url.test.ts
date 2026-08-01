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
