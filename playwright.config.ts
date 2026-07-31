import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101";
const outputDir =
  process.env.PATIENT_WEB_E2E_OUTPUT_DIR ??
  "/tmp/spine-sense-patient-web-test-results";
const includeFullAssessment =
  process.env.PATIENT_WEB_INCLUDE_FULL_ASSESSMENT === "true";
const includeProdReportEmail =
  process.env.PATIENT_WEB_INCLUDE_PROD_REPORT_EMAIL === "true";
const includeFhirOauth = process.env.PATIENT_WEB_INCLUDE_FHIR_OAUTH === "true";
const fakeAudioFile = path.resolve(
  __dirname,
  "e2e/fixtures/synthetic-voice.wav",
);
// `%noloop` stops the fake device at end-of-file instead of looping. Chromium
// splits the switch value on `%` and accepts only the literal `noloop`; any
// other suffix trips a CHECK and aborts the audio service, and a path
// containing a literal `%` silently falls back to looping. Keep both facts in
// mind before touching this path.
const longFakeAudioFile = `${path.resolve(
  __dirname,
  "e2e/fixtures/synthetic-voice-long.wav",
)}%noloop`;
// `@keyboard-ios` is excluded from every branch: it only runs under the
// `webkit-iphone` project (a real WebKit engine at an iPhone viewport), so
// running it on Desktop Chrome would silently pass without exercising the
// class of bug it exists to catch.
// `@voice-transcription` already substring-matches `@voice-transcription-long`,
// so the base inversions exclude the long suite for free. It is named
// explicitly anyway so a future rename of either tag cannot silently pull a
// ~10 minute test into the default suite.
const baseProjectGrepInvert = includeFullAssessment
  ? /@voice-transcription|@prod-report-email|@fhir-oauth|@keyboard-ios/
  : includeProdReportEmail
    ? /@full-assessment|@voice-transcription|@fhir-oauth|@keyboard-ios/
    : includeFhirOauth
      ? /@full-assessment|@voice-transcription|@prod-report-email|@keyboard-ios/
      : /@full-assessment|@voice-transcription|@prod-report-email|@fhir-oauth|@keyboard-ios/;

export default defineConfig({
  testDir: "./e2e",
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
  },
  projects: [
    {
      name: "chromium",
      grepInvert: baseProjectGrepInvert,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "chromium-voice",
      grep: /@voice-transcription/,
      // Without this the unanchored grep above substring-matches
      // `@voice-transcription-long`, so the long test would also run here
      // against the short, *looping* fixture under the 120s global timeout —
      // and `pnpm test:e2e:voice` is what the prod release gate runs.
      grepInvert: /@voice-transcription-long/,
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-audio-capture=${fakeAudioFile}`,
          ],
        },
      },
    },
    {
      // >2 minutes of real microphone capture through MediaRecorder, so the
      // budget is dominated by wall-clock audio rather than by the app.
      // 600s, set here and nowhere else: an in-body `test.setTimeout()` would
      // silently override this, and 420s would collide exactly with the
      // server's own INTAKE_STORY_MAX_SOCKET_SECONDS, turning a server socket
      // timeout into an opaque Playwright timeout.
      name: "chromium-voice-long",
      grep: /@voice-transcription-long/,
      timeout: 600_000,
      retries: 0,
      use: {
        ...devices["Desktop Chrome"],
        permissions: ["microphone"],
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            `--use-file-for-fake-audio-capture=${longFakeAudioFile}`,
          ],
        },
      },
    },
    // Real WebKit at an iPhone viewport. Tag-gated (like `chromium-voice`) so
    // it never slows the default run. Requires the WebKit browser binary:
    //   pnpm exec playwright install webkit
    {
      name: "webkit-iphone",
      grep: /@keyboard-ios/,
      use: { ...devices["iPhone 14"] },
    },
  ],
});
