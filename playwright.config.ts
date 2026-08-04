import { defineConfig, devices } from "@playwright/test";
import { rejectPlaywrightUiMode } from "./e2e/support/artifactPolicy";

rejectPlaywrightUiMode(process.argv);

const baseURL = process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101";
const outputDir =
  process.env.PATIENT_WEB_E2E_OUTPUT_DIR ??
  "/tmp/spine-sense-patient-web-test-results";
export default defineConfig({
  testDir: ".",
  testMatch: "e2e/**/*.spec.ts",
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
    // No seeded consent state: the cookie gate was removed, so every spec now
    // arrives the way a first-time patient does. `no-cookie-gate.spec.ts`
    // asserts that arrival is unobstructed.
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
