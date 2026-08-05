#!/usr/bin/env node

const { lstatSync } = require("node:fs");
const { resolve } = require("node:path");
const scopeManifest = require("../e2e/scopes.json");

const packageRoot = resolve(__dirname, "..");

const PLAYWRIGHT_PASSTHROUGH_OPTIONS = new Map([
  ["--headed", { arity: 0 }],
  ["--list", { arity: 0 }],
  ["--project", { arity: 1 }],
  ["--trace", { arity: 1 }],
  ["--ui", { arity: 0, allowAssignment: true }],
  ["--ui-host", { arity: 1 }],
  ["--ui-port", { arity: 1 }],
]);

const APPROVED_SCOPES = [
  "legacy-journey",
  "auth",
  "consent-onboarding",
  "onboarding-intro-idempotence",
  "onboarding-resume",
  "onboarding-draft-restore",
  "documents",
  "screening",
  "adaptive",
  "analysis",
  "results-report",
];
const START_CHECKPOINTS = new Set([
  "fresh",
  "verified_pending_consent",
  "onboarding_ready",
  "records_ready",
  "screening_ready",
  "adaptive_ready",
  "review_ready",
  "results_ready",
]);
const END_CHECKPOINTS = new Set([...START_CHECKPOINTS, "home_complete"]);

function isRegularNonSymlink(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function escapeRegex(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function exactPlaywrightFileFilter(spec) {
  return `^${escapeRegex(resolve(packageRoot, spec))}$`;
}

function assertManifest(manifest) {
  const topLevelFields =
    manifest != null && typeof manifest === "object"
      ? Object.keys(manifest).sort()
      : [];
  if (
    manifest == null ||
    JSON.stringify(topLevelFields) !==
      JSON.stringify(["default_scopes", "scopes", "version"]) ||
    manifest.version !== 3 ||
    !Array.isArray(manifest.default_scopes) ||
    manifest.scopes == null ||
    Array.isArray(manifest.scopes) ||
    typeof manifest.scopes !== "object" ||
    JSON.stringify(manifest.default_scopes) !==
      JSON.stringify(
        APPROVED_SCOPES.filter((scope) => scope !== "legacy-journey"),
      ) ||
    JSON.stringify(Object.keys(manifest.scopes).sort()) !==
      JSON.stringify([...APPROVED_SCOPES].sort())
  ) {
    throw new Error("e2e/scopes.json is not a supported scope manifest");
  }

  const seenSpecs = new Set();
  const seenTags = new Set();
  for (const [scope, definition] of Object.entries(manifest.scopes)) {
    const expectedFields = [
      "end_checkpoint",
      "real_analysis",
      "spec",
      "start_checkpoint",
      "tag",
      "timeout_class",
      ...(scope === "results-report" ? ["fixture"] : []),
    ].sort();
    const fields =
      definition != null && typeof definition === "object"
        ? Object.keys(definition).sort()
        : [];
    const spec = definition?.spec;
    if (
      JSON.stringify(fields) !== JSON.stringify(expectedFields) ||
      definition.tag !==
        (scope === "legacy-journey" ? "@legacy-journey" : `@scope-${scope}`) ||
      seenTags.has(definition.tag) ||
      !START_CHECKPOINTS.has(definition.start_checkpoint) ||
      !END_CHECKPOINTS.has(definition.end_checkpoint) ||
      typeof definition.timeout_class !== "string" ||
      definition.timeout_class.trim().length === 0 ||
      typeof definition.real_analysis !== "boolean" ||
      (scope === "results-report" &&
        definition.fixture !== "results-report-v1") ||
      typeof spec !== "string" ||
      !/^e2e\/[A-Za-z0-9._/-]+\.spec\.ts$/.test(spec) ||
      spec.split("/").includes("..") ||
      !isRegularNonSymlink(resolve(packageRoot, spec)) ||
      seenSpecs.has(spec)
    ) {
      throw new Error(
        `Scope ${scope} must declare exact metadata and own one unique package-relative Playwright spec`,
      );
    }
    seenSpecs.add(spec);
    seenTags.add(definition.tag);
  }
}

function resolveScopeSpecs(rawScopes, manifest = scopeManifest) {
  assertManifest(manifest);
  const requestedScopes =
    rawScopes == null
      ? manifest.default_scopes
      : rawScopes.split(",").map((scope) => scope.trim());
  if (requestedScopes.some((scope) => scope.length === 0)) {
    throw new Error("E2E_SCOPES must contain only approved scope names");
  }

  const unknownScopes = requestedScopes.filter(
    (scope) => !Object.prototype.hasOwnProperty.call(manifest.scopes, scope),
  );
  if (unknownScopes.length > 0) {
    throw new Error("E2E_SCOPES contains unsupported scope name(s)");
  }
  if (new Set(requestedScopes).size !== requestedScopes.length) {
    throw new Error("E2E_SCOPES must not contain duplicate scope names");
  }

  const approvedScopes = requestedScopes.includes("legacy-journey")
    ? ["legacy-journey"]
    : requestedScopes;
  return approvedScopes.map((scope) => manifest.scopes[scope].spec);
}

function assertNoTestSelectionOverrides(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const assignmentIndex = argument.indexOf("=");
    const option =
      assignmentIndex === -1 ? argument : argument.slice(0, assignmentIndex);
    if (["--grep", "--grep-invert", "-g"].includes(option)) {
      throw new Error(
        `Playwright title filtering is not a supported scope API (${option})`,
      );
    }
    if (!argument.startsWith("-")) {
      throw new Error("Explicit Playwright test filters are not supported");
    }

    const policy = PLAYWRIGHT_PASSTHROUGH_OPTIONS.get(option);
    if (policy == null) {
      throw new Error("Unsupported Playwright passthrough option");
    }

    if (assignmentIndex !== -1) {
      const value = argument.slice(assignmentIndex + 1);
      if (
        value.length === 0 ||
        (policy.arity === 0 && policy.allowAssignment !== true)
      ) {
        throw new Error("Playwright passthrough option has invalid arity");
      }
      continue;
    }

    if (policy.arity === 1) {
      const value = args[index + 1];
      if (value == null || value.length === 0 || value.startsWith("-")) {
        throw new Error("Playwright passthrough option is missing its value");
      }
      index += 1;
    }
  }
}

function buildPlaywrightArgv(argv, rawScopes, manifest = scopeManifest) {
  const [node, entrypoint, command, ...playwrightArgs] = argv;
  if (command !== "test") {
    throw new Error("The patient-web Playwright runner supports only test");
  }
  assertNoTestSelectionOverrides(playwrightArgs);
  return [
    node,
    entrypoint,
    command,
    ...resolveScopeSpecs(rawScopes, manifest).map(exactPlaywrightFileFilter),
    ...playwrightArgs,
  ];
}

module.exports = { buildPlaywrightArgv, resolveScopeSpecs };

if (require.main === module) {
  process.argv = buildPlaywrightArgv(process.argv, process.env.E2E_SCOPES);
  process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
  require("@playwright/test/cli");
}
