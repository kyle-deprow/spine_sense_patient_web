import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.PATIENT_WEB_BASE_URL ?? 'http://127.0.0.1:43101'
const outputDir =
  process.env.PATIENT_WEB_E2E_OUTPUT_DIR ?? '/tmp/spine-sense-patient-web-test-results'

export default defineConfig({
  testDir: './e2e',
  outputDir,
  timeout: 120_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
