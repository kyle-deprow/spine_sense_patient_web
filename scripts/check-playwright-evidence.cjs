#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_GATES = [
  'csp-security-headers',
  'xss-assessment-document-symptom-results',
  'phi-free-console',
  'idle-session-expiry-clears-phi',
  'refresh-rotation-no-token-exposure',
  'csrf-failure-modes',
  'cookie-flags-path-scope',
  'proxy-allowlist-smuggling-traversal',
  'no-store-headers',
  'object-url-revocation',
  'autocomplete-bfcache-logout',
  'direct-backend-blocked',
];

function readEvidence(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Unable to read Playwright evidence JSON: ${filePath}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function getGateStatuses(evidence) {
  if (evidence && typeof evidence === 'object' && !Array.isArray(evidence)) {
    if (evidence.gates && typeof evidence.gates === 'object' && !Array.isArray(evidence.gates)) {
      return evidence.gates;
    }
  }
  console.error('Playwright evidence must be JSON with a top-level "gates" object.');
  process.exit(1);
}

function gatePassed(value) {
  if (value === 'passed' || value === 'pass' || value === true) return true;
  if (value && typeof value === 'object') {
    return value.status === 'passed' || value.status === 'pass' || value.passed === true;
  }
  return false;
}

// The Playwright tests (e2e/patient-app-web.spec.ts) do not auto-generate this
// evidence file — it must be produced manually after a full PHI-capable staging
// run and committed alongside a release.  The playwright.config.ts reporter is
// currently set to `list` only (no JSON output), so there is no machine-readable
// Playwright artefact to derive gates from automatically.
//
// To generate the file, run the E2E suite against a staging environment and
// write the gate outcomes to a JSON file with a top-level "gates" object (see
// e2e/playwright-evidence.example.json), then point to it via:
//   PATIENT_WEB_PLAYWRIGHT_EVIDENCE=<path> pnpm test:e2e:verify
// or pass the path as a CLI argument.
//
// Release validation must fail closed when evidence is missing. Developers who
// intentionally want to run the rest of local validation without staging
// evidence can set PATIENT_WEB_ALLOW_MISSING_PLAYWRIGHT_EVIDENCE=1.

function allowMissingEvidence() {
  return process.env.PATIENT_WEB_ALLOW_MISSING_PLAYWRIGHT_EVIDENCE === '1';
}

function missingEvidence(message) {
  if (allowMissingEvidence()) {
    console.warn(`Warning: ${message}`);
    console.warn('Skipping gate check because PATIENT_WEB_ALLOW_MISSING_PLAYWRIGHT_EVIDENCE=1.');
    return;
  }

  console.error(message);
  console.error(
    'Set PATIENT_WEB_PLAYWRIGHT_EVIDENCE or pass a JSON evidence path to verify PHI-capable release gates.',
  );
  console.error('See e2e/playwright-evidence.example.json for the required format.');
  process.exit(1);
}

function main() {
  const evidencePath = process.env.PATIENT_WEB_PLAYWRIGHT_EVIDENCE || process.argv[2];
  if (!evidencePath) {
    missingEvidence('No Playwright security evidence path provided.');
    return;
  }

  const resolvedPath = path.resolve(process.cwd(), evidencePath);
  if (!fs.existsSync(resolvedPath)) {
    missingEvidence(`Playwright evidence file not found: ${resolvedPath}`);
    return;
  }

  const statuses = getGateStatuses(readEvidence(resolvedPath));
  const missing = REQUIRED_GATES.filter((gate) => !gatePassed(statuses[gate]));

  if (missing.length > 0) {
    console.error('Playwright security evidence is missing required passing gates:');
    for (const gate of missing) {
      console.error(`- ${gate}`);
    }
    process.exit(1);
  }

  console.log(`Playwright security evidence passed: ${REQUIRED_GATES.length} gates verified.`);
}

if (require.main === module) {
  main();
}
