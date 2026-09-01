#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const outputDir =
  process.env.PATIENT_WEB_PATIENT_APP_EXPORT_DIR ??
  path.resolve(__dirname, "..", "patient-app-export");
const patientAppDir = path.resolve(__dirname, "..", "..", "spine_sense_app");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const vectorIconFontsDir = path.join(
  patientAppDir,
  "node_modules",
  "@expo",
  "vector-icons",
  "build",
  "vendor",
  "react-native-vector-icons",
  "Fonts",
);
const brandFontFiles = [
  "ClashDisplay-Bold.otf",
  "ClashDisplay-Semibold.otf",
  "Satoshi-Bold.otf",
  "Satoshi-Medium.otf",
  "Satoshi-Regular.otf",
];
const brandFontsDir = path.join(patientAppDir, "assets", "fonts");
const vectorIconFontAssetRe =
  /\/assets\/node_modules\/[^"'`)\s]+\/Fonts\/([A-Za-z0-9_]+)\.[a-f0-9]+\.ttf/g;

// ENVIRONMENT is the single deployment label for the whole platform. The Expo
// bundle has its own, narrower vocabulary (src/config/env.ts accepts only
// development | e2e | staging | production and silently falls back to
// `development` for anything else), so the mapping is explicit and fails loudly
// on an unknown label rather than quietly shipping a `development` bundle.
// `local` maps to `e2e` because the Make-managed local patient web stack IS the
// E2E harness (test-support endpoints, insecure-cookie allowance, Playwright).
const EXPO_ENVIRONMENT_BY_DEPLOYMENT_LABEL = {
  local: "e2e",
  e2e: "e2e",
  test: "e2e",
  dev: "development",
  development: "development",
  staging: "staging",
  prod: "production",
  production: "production",
};

function resolveExpoEnvironment() {
  const label = (process.env.ENVIRONMENT ?? "").trim() || "production";
  const expoEnvironment = EXPO_ENVIRONMENT_BY_DEPLOYMENT_LABEL[label];
  if (!expoEnvironment) {
    console.error(
      `ENVIRONMENT=${label} is not a known deployment label for the patient app export. ` +
        `Expected one of: ${Object.keys(EXPO_ENVIRONMENT_BY_DEPLOYMENT_LABEL).join(", ")}.`,
    );
    process.exit(1);
  }
  return expoEnvironment;
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });

// The app's hosted-config contract (its scripts/release/production-config-contract.cjs,
// values from its eas.json) refuses a staging/production export unless these
// exact public URLs are stamped in. The WEB bundle never reads them at runtime:
// platform/auth/tokenSession.web.ts returns '' for the client base URL and every
// call is rewritten onto the BFF proxy, so the cookie boundary is unaffected.
// Local labels (local/e2e/dev map to e2e/development) keep the BFF-relative
// default so a local export can never point a browser at a hosted origin.
const HOSTED_PUBLIC_URLS = {
  staging: {
    api: "https://api.staging.spinesense.ai/api/v1",
    stt: "https://app.staging.spinesense.ai",
  },
  production: {
    api: "https://api.spinesense.ai/api/v1",
    stt: "https://app.spinesense.ai",
  },
};

const expoEnvironment = resolveExpoEnvironment();
const hostedUrls = HOSTED_PUBLIC_URLS[expoEnvironment];
// Container builds pass these ARGs even when unset, so a BLANK override
// means "no override", never "use the empty string".
const blankAsUnset = (value) => (value ?? "").trim() || undefined;
const apiBaseUrlOverride = blankAsUnset(process.env.PATIENT_APP_API_BASE_URL);
const sttEdgeBaseUrl =
  blankAsUnset(process.env.PATIENT_APP_STT_EDGE_BASE_URL) ?? hostedUrls?.stt;

function withoutDeferredCapabilityEnvironment(sourceEnvironment) {
  const inheritedEnvironment = { ...sourceEnvironment };
  delete inheritedEnvironment.PATIENT_APP_EPIC_FHIR_ENABLED;
  delete inheritedEnvironment.EXPO_PUBLIC_EPIC_FHIR_ENABLED;
  return inheritedEnvironment;
}

const env = {
  ...withoutDeferredCapabilityEnvironment(process.env),
  SPINESENSE_PATIENT_WEB_EXPORT: "1",
  SPINESENSE_WEB_OUTPUT: "single",
  SPINESENSE_SKIP_REANIMATED_BABEL_PLUGIN: "1",
  EXPO_PUBLIC_ENVIRONMENT: expoEnvironment,
  EXPO_PUBLIC_API_BASE_URL:
    apiBaseUrlOverride ?? hostedUrls?.api ?? "/api/proxy/api/v1",
  ...(sttEdgeBaseUrl ? { EXPO_PUBLIC_STT_EDGE_BASE_URL: sttEdgeBaseUrl } : {}),
};

const args = [
  "--dir",
  patientAppDir,
  "build:web",
  "--",
  "--output-dir",
  outputDir,
  "--max-workers",
  "1",
  ...process.argv.slice(2),
];

const result = spawnSync(pnpm, args, {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

if (!fs.existsSync(path.join(outputDir, "index.html"))) {
  console.error(
    `Patient app export did not produce index.html at ${outputDir}`,
  );
  process.exit(1);
}

copyVectorIconFontAssets();
copyBrandFontAssets();

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
    if (![".html", ".js", ".css"].includes(path.extname(filePath))) continue;
    const contents = fs.readFileSync(filePath, "utf8");
    for (const match of contents.matchAll(vectorIconFontAssetRe)) {
      const requestPath = match[0];
      const family = match[1];
      if (typeof family === "string") {
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
      console.error(
        `Expo web bundle requested ${requestPath}, but source font is missing: ${source}`,
      );
      process.exit(1);
    }

    const target = resolveExportTarget(requestPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }

  console.log(
    `Copied ${requested.size} Expo vector icon font asset(s) into ${outputDir}`,
  );
}

function copyBrandFontAssets() {
  const targetDir = path.join(outputDir, "assets", "fonts");
  fs.mkdirSync(targetDir, { recursive: true });

  for (const fileName of brandFontFiles) {
    const source = path.join(brandFontsDir, fileName);
    if (!fs.existsSync(source)) {
      console.error(`Patient app brand font is missing: ${source}`);
      process.exit(1);
    }
    fs.copyFileSync(source, path.join(targetDir, fileName));
  }

  console.log(
    `Copied ${brandFontFiles.length} brand font asset(s) into ${targetDir}`,
  );
}

function resolveExportTarget(requestPath) {
  const target = path.resolve(outputDir, requestPath.replace(/^\/+/, ""));
  const relativeTarget = path.relative(outputDir, target);
  if (
    relativeTarget === "" ||
    relativeTarget.startsWith("..") ||
    path.isAbsolute(relativeTarget)
  ) {
    console.error(
      `Refusing to copy Expo font outside patient app export: ${requestPath}`,
    );
    process.exit(1);
  }
  return target;
}
