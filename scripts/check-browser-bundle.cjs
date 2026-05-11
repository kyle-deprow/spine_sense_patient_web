#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BUNDLE_ROOT = path.join('.next', 'static');
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs']);

const FORBIDDEN_PATTERNS = [
  {
    label: 'expo-secure-store',
    pattern: /\bexpo-secure-store\b/,
  },
  {
    label: 'react-native-mmkv',
    pattern: /\breact-native-mmkv\b/,
  },
  {
    label: 'expo-local-authentication',
    pattern: /\bexpo-local-authentication\b/,
  },
  {
    label: 'expo-file-system',
    pattern: /\bexpo-file-system\b/,
  },
  {
    label: 'expo-camera',
    pattern: /\bexpo-camera\b/,
  },
  {
    label: 'expo-av',
    pattern: /\bexpo-av\b/,
  },
  {
    label: 'expo-notifications',
    pattern: /\bexpo-notifications\b/,
  },
  {
    label: '@sentry/react-native',
    pattern: /\b@sentry\/react-native\b/,
  },
  {
    label: 'SecureStore browser path',
    pattern: /\bSecureStore\b|\bsecure_token_storage\b/,
  },
  {
    label: 'MMKV browser path',
    pattern: /\bMMKV\b|\bpersistent_phi_storage\b/,
  },
  {
    label: 'JS-readable backend token field',
    pattern: /\b(access_token|refresh_token)\b/,
  },
  {
    label: 'durable browser storage API',
    pattern:
      /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|\bcaches\s*\.\s*(open|keys|match|has|delete)\b|\bCacheStorage\b/,
  },
  {
    label: 'service worker registration',
    pattern: /\bnavigator\s*\.\s*serviceWorker\b|\bserviceWorker\s*\.\s*register\b/,
  },
  {
    label: 'direct backend URL in browser bundle',
    pattern: /\bBACKEND_INTERNAL_URL\b|http:\/\/localhost:8000|https?:\/\/[^'")\s]+\/api\/v1\//,
  },
];

function collectBundleFiles(rootDir) {
  const files = [];

  function walk(currentDir) {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
        files.push(entryPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function scanFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8');
  return FORBIDDEN_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ label }) => ({
    filePath,
    label,
  }));
}

const PATIENT_APP_EXPORT_ROOT = 'patient-app-export';

function main() {
  const rootDir = process.cwd();
  const bundleRoot = path.resolve(rootDir, process.argv[2] ?? DEFAULT_BUNDLE_ROOT);

  if (!fs.existsSync(bundleRoot)) {
    console.error(
      `Browser bundle directory not found: ${path.relative(rootDir, bundleRoot)}. Run pnpm build first.`,
    );
    process.exit(1);
  }

  const files = collectBundleFiles(bundleRoot);
  if (files.length === 0) {
    console.error(`No browser bundle files found under ${path.relative(rootDir, bundleRoot)}.`);
    process.exit(1);
  }

  // Also scan the patient app export bundle if it exists. It lives outside
  // .next/static but is served directly by the BFF, so the same PHI/token
  // constraints apply. Skip with a warning when not yet built.
  const patientAppExportRoot = path.resolve(rootDir, PATIENT_APP_EXPORT_ROOT);
  if (fs.existsSync(patientAppExportRoot)) {
    const exportFiles = collectBundleFiles(patientAppExportRoot);
    files.push(...exportFiles);
  } else {
    console.warn(
      `Warning: patient app export directory not found (${PATIENT_APP_EXPORT_ROOT}). Run pnpm build:patient-app to include it in the scan.`,
    );
  }

  const violations = files.flatMap(scanFile);
  if (violations.length > 0) {
    console.error('Forbidden browser bundle content found:');
    for (const violation of violations) {
      console.error(`- ${path.relative(rootDir, violation.filePath)}: ${violation.label}`);
    }
    process.exit(1);
  }

  console.log(`Browser bundle smoke passed: scanned ${files.length} files.`);
}

if (require.main === module) {
  main();
}
