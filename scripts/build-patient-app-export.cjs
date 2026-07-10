#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const outputDir =
  process.env.PATIENT_WEB_PATIENT_APP_EXPORT_DIR ??
  path.resolve(__dirname, '..', 'patient-app-export');
const patientAppDir = path.resolve(__dirname, '..', '..', 'spine_sense_app');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const vectorIconFontsDir = path.join(
  patientAppDir,
  'node_modules',
  '@expo',
  'vector-icons',
  'build',
  'vendor',
  'react-native-vector-icons',
  'Fonts',
);
const vectorIconFontAssetRe =
  /\/assets\/node_modules\/[^"'`)\s]+\/Fonts\/([A-Za-z0-9_]+)\.[a-f0-9]+\.ttf/g;

validateWebVoicePolicy();

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

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
  patientAppDir,
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

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(path.join(outputDir, 'index.html'))) {
  console.error(`Patient app export did not produce index.html at ${outputDir}`);
  process.exit(1);
}

copyVectorIconFontAssets();

process.exit(0);

function walkFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath);
    if (entry.isFile()) return [entryPath];
    return [];
  });
}

function collectRequestedVectorIconFonts() {
  const requested = new Map();
  for (const filePath of walkFiles(outputDir)) {
    if (!['.html', '.js', '.css'].includes(path.extname(filePath))) continue;
    const contents = fs.readFileSync(filePath, 'utf8');
    for (const match of contents.matchAll(vectorIconFontAssetRe)) {
      const requestPath = match[0];
      const family = match[1];
      if (typeof family === 'string') {
        requested.set(requestPath, family);
      }
    }
  }
  return requested;
}

function copyVectorIconFontAssets() {
  const requested = collectRequestedVectorIconFonts();
  if (requested.size === 0) return;

  for (const [requestPath, family] of requested.entries()) {
    const source = path.join(vectorIconFontsDir, `${family}.ttf`);
    if (!fs.existsSync(source)) {
      console.error(`Expo web bundle requested ${requestPath}, but source font is missing: ${source}`);
      process.exit(1);
    }

    const target = resolveExportTarget(requestPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  console.log(`Copied ${requested.size} Expo vector icon font asset(s) into ${outputDir}`);
}

function resolveExportTarget(requestPath) {
  const target = path.resolve(outputDir, requestPath.replace(/^\/+/, ''));
  const relativeTarget = path.relative(outputDir, target);
  if (
    relativeTarget === '' ||
    relativeTarget.startsWith('..') ||
    path.isAbsolute(relativeTarget)
  ) {
    console.error(`Refusing to copy Expo font outside patient app export: ${requestPath}`);
    process.exit(1);
  }
  return target;
}

function validateWebVoicePolicy() {
  if (process.env.EXPO_PUBLIC_ENABLE_WEB_VOICE !== 'true') return;

  const allowedEnvironments = new Set(['development', 'test', 'e2e']);
  if (!allowedEnvironments.has(process.env.PATIENT_APP_ENVIRONMENT ?? '')) {
    console.error(
      'EXPO_PUBLIC_ENABLE_WEB_VOICE=true requires PATIENT_APP_ENVIRONMENT to be development, test, or e2e',
    );
    process.exit(1);
  }
}
