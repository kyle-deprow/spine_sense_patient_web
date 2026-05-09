#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const sourceDir = path.resolve(
  rootDir,
  process.env.PATIENT_APP_WEB_EXPORT_DIR ?? path.join('..', 'spine_sense_app', 'dist'),
);
const targetDir = path.resolve(
  rootDir,
  process.env.PATIENT_WEB_STATIC_EXPORT_DIR ?? 'patient-app-export',
);

function assertExportExists() {
  const indexPath = path.join(sourceDir, 'index.html');
  if (!fs.existsSync(indexPath)) {
    console.error(`Patient app export not found at ${sourceDir}`);
    console.error('Run `pnpm --dir ../spine_sense_app build:web` or set PATIENT_APP_WEB_EXPORT_DIR.');
    process.exit(1);
  }
}

function copyExport() {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

assertExportExists();
copyExport();

console.log(`Copied patient app export from ${sourceDir} to ${targetDir}`);
