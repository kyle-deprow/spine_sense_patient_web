import { defineConfig, devices } from "@playwright/test";
import scopeManifest from "./e2e/scopes.json";
import { rejectPlaywrightUiMode } from "./e2e/support/artifactPolicy";

rejectPlaywrightUiMode(process.argv);

import { acceptedConsentStorageState } from "./e2e/fixtures/cookieConsent";

const baseURL = process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101";
const outputDir =
  process.env.PATIENT_WEB_E2E_OUTPUT_DIR ??
  "/tmp/spine-sense-patient-web-test-results";
const requestedScopes = (process.env.E2E_SCOPES ?? "full")
  .split(",")
  .map((scope) => scope.trim())
  .filter(Boolean);
const unknownScopes = requestedScopes.filter(
  (scope) => !(scope in scopeManifest.scopes),
);
if (unknownScopes.length > 0) {
  throw new Error(
    `E2E_SCOPES contains unsupported scope(s): ${unknownScopes.join(",")}`,
  );
}
const selectedTags = requestedScopes.map(
  (scope) =>
    scopeManifest.scopes[scope as keyof typeof scopeManifest.scopes]?.tag ??
    `@scope-${scope}`,
);
const selectedSpecs = [
  ...new Set(
    requestedScopes.map(
      (scope) =>
        scopeManifest.scopes[scope as keyof typeof scopeManifest.scopes]?.spec,
    ),
  ),
].filter((spec): spec is string => typeof spec === "string");

if (selectedSpecs.length === 0) {
  throw new Error("E2E_SCOPES did not resolve to any approved Playwright spec");
}

export default defineConfig({
  testDir: ".",
  testMatch: selectedSpecs,
  grep: new RegExp(selectedTags.join("|")),
  outputDir,
  globalSetup: "./e2e/support/artifactPolicy.ts",
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  workers: 1,
  // Recovery is classified inside the canonical journey. A Playwright-level
  // retry would replay deterministic app, clinical, or authorization failures.
  retries: 0,
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
