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

function main() {
  const evidencePath = process.env.PATIENT_WEB_PLAYWRIGHT_EVIDENCE || process.argv[2];
  if (!evidencePath) {
    console.error(
      'Missing Playwright security evidence. Set PATIENT_WEB_PLAYWRIGHT_EVIDENCE or pass a JSON evidence path.',
    );
    console.error('PHI-capable patient web release remains blocked until this gate passes.');
    process.exit(1);
  }

  const resolvedPath = path.resolve(process.cwd(), evidencePath);
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
