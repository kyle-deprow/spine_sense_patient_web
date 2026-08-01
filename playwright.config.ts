import { defineConfig, devices } from "@playwright/test";

import { acceptedConsentStorageState } from "./e2e/fixtures/cookieConsent";

const baseURL = process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101";
const outputDir =
  process.env.PATIENT_WEB_E2E_OUTPUT_DIR ??
  "/tmp/spine-sense-patient-web-test-results";

export default defineConfig({
  testDir: "./e2e",
  testMatch: ["full-assessment.spec.ts"],
  outputDir,
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    trace: "off",
    video: "off",
    screenshot: "off",
    // Arrive as a patient who has already answered the cookie modal, so specs
    // about everything else are not each re-testing the gate.
    // `cookie-consent.spec.ts` opts out and walks it for real.
    storageState: acceptedConsentStorageState(baseURL),
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
