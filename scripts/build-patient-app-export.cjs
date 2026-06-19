#!/usr/bin/env node

const { spawnSync } = require('node:child_process');

const outputDir =
  process.env.PATIENT_WEB_PATIENT_APP_EXPORT_DIR ??
  '../spine_sense_patient_web/patient-app-export';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

const env = {
  ...process.env,
  SPINESENSE_PATIENT_WEB_EXPORT: '1',
  SPINESENSE_WEB_OUTPUT: 'single',
  SPINESENSE_SKIP_REANIMATED_BABEL_PLUGIN: '1',
  EXPO_PUBLIC_ENVIRONMENT: process.env.PATIENT_APP_ENVIRONMENT ?? 'production',
  EXPO_PUBLIC_API_BASE_URL: process.env.PATIENT_APP_API_BASE_URL ?? '/api/proxy/api/v1',
};

const args = [
  '--dir',
  '../spine_sense_app',
  'build:web',
  '--',
  '--output-dir',
  outputDir,
  '--max-workers',
  '1',
  '--no-minify',
  ...process.argv.slice(2),
];

const result = spawnSync(pnpm, args, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
