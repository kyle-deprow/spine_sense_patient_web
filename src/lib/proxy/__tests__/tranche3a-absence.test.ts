import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { NextRequest } from "next/server";
import * as ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET as appCatchAllGet } from "@/app/[...path]/route";
import { GET as authCatchAllGet } from "@/app/api/auth/[...path]/route";
import {
  ALLOWED_PROXY_ROUTES,
  validateProxyTarget,
} from "@/lib/proxy/allowlist";

const PROJECT_ROOT = process.cwd();
const ASSESSMENT_ID = "10000000-0000-4000-8000-000000000001";
const SECOND_ID = "10000000-0000-4000-8000-000000000002";
const REQUIRE_BUILT_MANIFESTS =
  process.env.TRANCHE3A_REQUIRE_NEXT_MANIFEST === "1" ||
  process.env.npm_lifecycle_event === "validate:tranche3a-manifest";

const PRODUCTION_ROOTS = ["src/app/api", "src/lib/server"] as const;
const SELECTED_CONTRIBUTORS = [
  "Dockerfile",
  "scripts/build-patient-app-export.cjs",
  ".env.example",
] as const;
const DELETED_SOURCE = [
  "src/app/api/auth/google/start/route.ts",
  "src/app/api/auth/google/callback/route.ts",
  "src/app/api/auth/google/route.test.ts",
  "src/app/api/fhir/start/route.ts",
  "src/app/api/fhir/callback/route.ts",
  "src/app/api/fhir/route.test.ts",
  "src/lib/server/google-oauth.ts",
  "src/lib/server/fhir-oauth.ts",
] as const;
const REGULAR_NEXT_ROUTE_MANIFESTS = [
  ".next/app-path-routes-manifest.json",
  ".next/server/app-paths-manifest.json",
  ".next/routes-manifest.json",
] as const;
const STANDALONE_NEXT_ROUTE_MANIFESTS = [
  ".next/standalone/.next/app-path-routes-manifest.json",
  ".next/standalone/.next/server/app-paths-manifest.json",
  ".next/standalone/.next/routes-manifest.json",
] as const;

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function validation(method: string, targetPath: string) {
  return validateProxyTarget(
    targetPath.slice(1).split("/"),
    method,
    `/api/proxy${targetPath}`,
  );
}

function isTestSource(relativePath: string): boolean {
  return (
    relativePath.includes("/__tests__/") ||
    /(?:^|\/)__mocks__(?:\/|$)/u.test(relativePath) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(relativePath)
  );
}

function walkProductionFiles(relativeRoot: string): string[] {
  const absoluteRoot = resolve(PROJECT_ROOT, relativeRoot);
  expect(statSync(absoluteRoot).isDirectory()).toBe(true);

  const files: string[] = [];
  const walk = (absoluteDirectory: string) => {
    for (const entry of readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      const relativePath = relative(PROJECT_ROOT, absolutePath).replaceAll(
        "\\",
        "/",
      );
      if (entry.isDirectory()) {
        if (!isTestSource(`${relativePath}/`)) walk(absolutePath);
      } else if (entry.isFile() && !isTestSource(relativePath)) {
        files.push(relativePath);
      } else if (!entry.isFile()) {
        throw new Error(`Unsupported production contributor: ${relativePath}`);
      }
    }
  };

  walk(absoluteRoot);
  return files.sort();
}

function sanitizeAuthorizedDenyEvidence(
  relativePath: string,
  source: string,
): string {
  if (relativePath !== "scripts/build-patient-app-export.cjs") return source;

  return source.replace(
    /^\s*delete inheritedEnvironment\.(?:PATIENT_APP_EPIC_FHIR_ENABLED|EXPO_PUBLIC_EPIC_FHIR_ENABLED);\s*$/gmu,
    "",
  );
}

type ContributorEvidence = {
  auth: boolean;
  fhir: boolean;
  google: boolean;
};

function emptyEvidence(): ContributorEvidence {
  return { auth: false, fhir: false, google: false };
}

function semanticWords(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .split(/[^a-z0-9]+/giu)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function hasFhirWords(words: readonly string[]): boolean {
  if (words.some((word) => word.includes("fhir"))) return true;

  for (let start = 0; start < words.length; start += 1) {
    let candidate = "";
    for (
      let index = start;
      index < Math.min(words.length, start + 4);
      index += 1
    ) {
      candidate += words[index];
      if (candidate === "fhir") return true;
      if (!"fhir".startsWith(candidate)) break;
    }
  }
  return false;
}

function hasAuthWords(words: readonly string[]): boolean {
  if (
    words.some((word) =>
      [
        "auth",
        "authenticate",
        "authentication",
        "authorization",
        "callback",
        "clientid",
        "clientsecret",
        "login",
        "oauth",
        "signin",
      ].includes(word),
    )
  ) {
    return true;
  }
  return words.some(
    (word, index) =>
      (word === "sign" && words[index + 1] === "in") ||
      (word === "client" && ["id", "secret"].includes(words[index + 1] ?? "")),
  );
}

function collectSemanticEvidence(
  evidence: ContributorEvidence,
  value: string,
  googleContext: "structured" | "static",
): void {
  if (value.trim().toLowerCase() === "metadata.google.internal") return;
  const words = semanticWords(value);
  if (hasFhirWords(words)) evidence.fhir = true;
  if (hasAuthWords(words)) evidence.auth = true;

  if (googleContext === "structured") {
    if (words.includes("google")) evidence.google = true;
    return;
  }

  const trimmed = value.trim().toLowerCase();
  const googleAuthUrl =
    /(?:accounts\.google\.com|oauth2\.googleapis\.com|googleapis\.com\/oauth)/iu.test(
      value,
    );
  if (
    trimmed === "google" ||
    googleAuthUrl ||
    (words.includes("google") &&
      (words.includes("provider") || hasAuthWords(words)))
  ) {
    evidence.google = true;
  }
}

function staticStringValue(
  node: ts.Expression,
  bindings: ReadonlyMap<string, ts.Expression>,
  resolving = new Set<string>(),
): string | undefined {
  if (ts.isParenthesizedExpression(node)) {
    return staticStringValue(node.expression, bindings, resolving);
  }
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const substitution = staticStringValue(
        span.expression,
        bindings,
        resolving,
      );
      if (substitution === undefined) return undefined;
      value += substitution + span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(node.left, bindings, resolving);
    const right = staticStringValue(node.right, bindings, resolving);
    return left === undefined || right === undefined
      ? undefined
      : `${left}${right}`;
  }
  if (ts.isIdentifier(node)) {
    if (resolving.has(node.text)) return undefined;
    const initializer = bindings.get(node.text);
    if (initializer === undefined) return undefined;
    const nextResolving = new Set(resolving);
    nextResolving.add(node.text);
    return staticStringValue(initializer, bindings, nextResolving);
  }
  return undefined;
}

function normalizedRegexPattern(regexText: string): string {
  const finalSlash = regexText.lastIndexOf("/");
  const pattern =
    regexText.startsWith("/") && finalSlash > 0
      ? regexText.slice(1, finalSlash)
      : regexText;
  return pattern
    .replace(/\\u\{([0-9a-f]+)\}/giu, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)),
    )
    .replace(/\\u([0-9a-f]{4})/giu, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)),
    )
    .replace(/\\x([0-9a-f]{2})/giu, (_match, codePoint: string) =>
      String.fromCodePoint(Number.parseInt(codePoint, 16)),
    )
    .replace(/\\([^a-z0-9])/giu, "$1");
}

function collectScriptEvidence(
  relativePath: string,
  source: string,
  evidence: ContributorEvidence,
): void {
  const scriptKind = relativePath.endsWith(".cjs")
    ? ts.ScriptKind.JS
    : ts.ScriptKind.TSX;
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const bindings = new Map<string, ts.Expression>();
  const collectBindings = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  for (const initializer of bindings.values()) {
    const value = staticStringValue(initializer, bindings);
    if (value !== undefined) {
      collectSemanticEvidence(evidence, value, "static");
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) {
      collectSemanticEvidence(evidence, node.text, "structured");
    }
    if (ts.isStringLiteralLike(node)) {
      collectSemanticEvidence(evidence, node.text, "static");
    }
    if (ts.isRegularExpressionLiteral(node)) {
      collectSemanticEvidence(
        evidence,
        normalizedRegexPattern(node.text),
        "static",
      );
    }
    if (
      ts.isTemplateExpression(node) ||
      (ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const value = staticStringValue(node, bindings);
      if (value !== undefined) {
        collectSemanticEvidence(evidence, value, "static");
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function collectLineTokenEvidence(
  relativePath: string,
  source: string,
  evidence: ContributorEvidence,
): void {
  for (const sourceLine of source.split(/\r?\n/u)) {
    const trimmed = sourceLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.replace(/\s+#.*$/u, "");

    if (relativePath.startsWith(".env")) {
      const separator = line.indexOf("=");
      const key = separator < 0 ? line : line.slice(0, separator);
      const value = separator < 0 ? "" : line.slice(separator + 1);
      collectSemanticEvidence(evidence, key, "structured");
      collectSemanticEvidence(evidence, value, "static");
      continue;
    }

    const [directive = "", ...rest] = line.split(/\s+/u);
    if (["ARG", "ENV"].includes(directive.toUpperCase())) {
      for (const assignment of rest) {
        const separator = assignment.indexOf("=");
        const key = separator < 0 ? assignment : assignment.slice(0, separator);
        const value = separator < 0 ? "" : assignment.slice(separator + 1);
        collectSemanticEvidence(evidence, key, "structured");
        collectSemanticEvidence(evidence, value, "static");
      }
    } else {
      collectSemanticEvidence(evidence, rest.join(" "), "static");
    }
  }
}

function contributorEvidence(
  relativePath: string,
  source: string,
): ContributorEvidence {
  const evidence = emptyEvidence();
  for (const pathToken of relativePath.split(/[\\/]/u)) {
    collectSemanticEvidence(evidence, pathToken, "structured");
  }

  const sanitized = sanitizeAuthorizedDenyEvidence(relativePath, source);
  if (relativePath === "Dockerfile" || relativePath.startsWith(".env")) {
    collectLineTokenEvidence(relativePath, sanitized, evidence);
  } else {
    collectScriptEvidence(relativePath, sanitized, evidence);
  }
  return evidence;
}

function deferredExposureLabels(
  contributors: ReadonlyArray<{ relativePath: string; source: string }>,
): string[] {
  const labels: string[] = [];
  const evidence = contributors.map(({ relativePath, source }) =>
    contributorEvidence(relativePath, source),
  );
  if (evidence.some(({ fhir }) => fhir)) labels.push("fhir");
  if (
    evidence.some(({ google }) => google) &&
    evidence.some(({ auth }) => auth)
  ) {
    labels.push("google-auth");
  }

  return labels;
}

function collectManifestStrings(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectManifestStrings(item, output);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      output.push(key);
      collectManifestStrings(item, output);
    }
  }
}

function isDeferredManifestRoute(value: string): boolean {
  const words = semanticWords(value);
  if (!words.includes("api")) return false;
  if (hasFhirWords(words)) return true;
  return words.includes("google") && hasAuthWords(words);
}

function missingRequiredManifestGroups(
  regularManifests: readonly string[],
  standaloneManifests: readonly string[],
): string[] {
  const missing: string[] = [];
  if (regularManifests.length === 0) missing.push("regular");
  if (standaloneManifests.length === 0) missing.push("standalone");
  return missing;
}

describe("Tranche 3A public exposure inventory", () => {
  beforeEach(() => {
    vi.stubEnv("ENVIRONMENT", "test");
    vi.stubEnv(
      "PATIENT_WEB_CSRF_SECRET",
      "test-patient-web-csrf-secret-at-least-32-bytes",
    );
    vi.stubEnv("PATIENT_WEB_ALLOWED_ORIGINS", "http://localhost");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(DELETED_SOURCE)(
    "keeps deleted route/helper source absent: %s",
    (relativePath) => {
      expect(existsSync(resolve(PROJECT_ROOT, relativePath))).toBe(false);
    },
  );

  it("scans every active API/server/build contributor for deferred exposure", () => {
    const productionFiles = [
      ...PRODUCTION_ROOTS.flatMap(walkProductionFiles),
      ...SELECTED_CONTRIBUTORS,
    ];

    expect(productionFiles).toContain("src/app/api/auth/[...path]/route.ts");
    expect(productionFiles).toContain("src/lib/server/config.ts");

    const contributors = productionFiles.map((relativePath) => {
      const absolutePath = resolve(PROJECT_ROOT, relativePath);
      expect(statSync(absolutePath).isFile()).toBe(true);
      return {
        relativePath,
        source: readFileSync(absolutePath, "utf8"),
      };
    });
    expect(deferredExposureLabels(contributors)).toEqual([]);
  });

  it.each([
    [
      "src/app/api/auth/provider/route.ts",
      `const provider = "goo" + "gle"; const action = "call" + "back";`,
      "google-auth",
    ],
    [
      "src/lib/server/identity-helper.ts",
      `const beginLogin = () => provider("Google");`,
      "google-auth",
    ],
    [
      "src/lib/server/config.ts",
      `const key = "EXPO_PUBLIC_EPIC_" + "FH" + "IR_ENABLED";`,
      "fhir",
    ],
    [
      "src/app/api/clinical/fh-ir/route.ts",
      "export const GET = handler;",
      "fhir",
    ],
    [
      "src/app/api/clinical/f-h-i-r/route.ts",
      "export const GET = handler;",
      "fhir",
    ],
    ["src/lib/server/config.ts", "const F_H_I_R_ENDPOINT = endpoint;", "fhir"],
    [
      "src/lib/server/template.ts",
      'const endpoint = `${"FH"}${"IR"}`;',
      "fhir",
    ],
    [
      "src/lib/server/composed.ts",
      'const a = "FH"; const b = "IR"; const endpoint = a + b;',
      "fhir",
    ],
    ["src/lib/server/regex.ts", String.raw`const route = /F\x48IR/;`, "fhir"],
    [
      "src/lib/server/regex-unicode.ts",
      String.raw`const route = /F\u0048IR/;`,
      "fhir",
    ],
    [
      "src/lib/server/regex-punctuation.ts",
      String.raw`const route = /F\-H\-I\-R/;`,
      "fhir",
    ],
    [
      "src/lib/server/escaped-string.ts",
      String.raw`const route = "F\x48IR";`,
      "fhir",
    ],
  ] as const)(
    "detects renamed, split, or indirect production exposure: %s",
    (relativePath, source, label) => {
      expect(deferredExposureLabels([{ relativePath, source }])).toContain(
        label,
      );
    },
  );

  it("detects Google provider and auth evidence across contributors", () => {
    expect(
      deferredExposureLabels([
        {
          relativePath: "src/lib/server/provider.ts",
          source: `export const provider = "Google";`,
        },
        {
          relativePath: "src/app/api/session/route.ts",
          source: "export async function callback() {}",
        },
      ]),
    ).toContain("google-auth");
  });

  it("detects Google login evidence without a proximity limit", () => {
    expect(
      deferredExposureLabels([
        {
          relativePath: "src/lib/server/provider.ts",
          source: `const provider = "Google";${" ".repeat(220)}function login() {}`,
        },
      ]),
    ).toContain("google-auth");
  });

  it.each([
    [
      "src/lib/server/config.ts",
      `const host = "metadata.google.internal"; const authenticate = true;`,
    ],
    ["src/app/api/auth/login/route.ts", "emailPasswordLogin();"],
    ["src/lib/server/report.ts", "saveReportToDevice();"],
    [
      "src/lib/server/release-proof.ts",
      `export const status = "proof hiring is complete";`,
    ],
    [
      "src/lib/server/releaseProof.ts",
      "export const proofHiringIsComplete = true;",
    ],
  ] as const)(
    "does not reject included generic production content: %s",
    (relativePath, source) => {
      expect(deferredExposureLabels([{ relativePath, source }])).toEqual([]);
    },
  );

  it("does not correlate unrelated Google prose with email/password auth", () => {
    expect(
      deferredExposureLabels([
        {
          relativePath: "src/lib/server/release-note.ts",
          source: 'export const note = "Google opened a new office";',
        },
        {
          relativePath: "src/app/api/auth/login/route.ts",
          source: "export function emailPasswordLogin() {}",
        },
      ]),
    ).toEqual([]);
  });

  it.each([
    [[".next/routes-manifest.json"], [], ["standalone"]],
    [[], [".next/standalone/.next/routes-manifest.json"], ["regular"]],
    [
      [".next/routes-manifest.json"],
      [".next/standalone/.next/routes-manifest.json"],
      [],
    ],
  ] as const)(
    "requires regular and standalone manifest groups: %#",
    (regular, standalone, missing) => {
      expect(missingRequiredManifestGroups(regular, standalone)).toEqual(
        missing,
      );
    },
  );

  it("keeps canonical post-build manifest validation in the release path", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(PROJECT_ROOT, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.["validate:tranche3a-manifest"]).toBe(
      "vitest run src/lib/proxy/__tests__/tranche3a-absence.test.ts",
    );
    expect(packageJson.scripts?.["validate:local"]).toBe(
      "pnpm lint && pnpm type-check && pnpm test && pnpm build:patient-app && pnpm build && pnpm validate:tranche3a-manifest && pnpm smoke:bundle",
    );
    expect(packageJson.scripts?.["release:validate"]).toBe(
      "pnpm validate:local",
    );
  });

  it("strips both inherited FHIR variables from the spawned Expo child", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "tranche3a-export-env-"));
    const binDir = join(fixtureRoot, "bin");
    const outputDir = join(fixtureRoot, "export");
    const mockPnpm = join(binDir, "pnpm");

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        mockPnpm,
        `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const outputFlag = args.indexOf("--output-dir");
if (outputFlag < 0 || !args[outputFlag + 1]) process.exit(2);
const outputDir = args[outputFlag + 1];
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "index.html"), "<!doctype html>");
fs.writeFileSync(path.join(outputDir, "spawn-env.json"), JSON.stringify({
  patientAppEpicFhirEnabled: Object.hasOwn(process.env, "PATIENT_APP_EPIC_FHIR_ENABLED"),
  expoPublicEpicFhirEnabled: Object.hasOwn(process.env, "EXPO_PUBLIC_EPIC_FHIR_ENABLED")
}));
`,
        { mode: 0o755 },
      );
      chmodSync(mockPnpm, 0o755);

      const result = spawnSync(
        process.execPath,
        [resolve(PROJECT_ROOT, "scripts/build-patient-app-export.cjs")],
        {
          cwd: PROJECT_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${binDir}:${process.env.PATH ?? ""}`,
            PATIENT_WEB_PATIENT_APP_EXPORT_DIR: outputDir,
            PATIENT_APP_EPIC_FHIR_ENABLED: "operator-supplied",
            EXPO_PUBLIC_EPIC_FHIR_ENABLED: "operator-supplied",
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(
        JSON.parse(readFileSync(join(outputDir, "spawn-env.json"), "utf8")),
      ).toEqual({
        patientAppEpicFhirEnabled: false,
        expoPublicEpicFhirEnabled: false,
      });

      const buildSource = readFileSync(
        resolve(PROJECT_ROOT, "scripts/build-patient-app-export.cjs"),
        "utf8",
      );
      expect(buildSource).not.toContain("...process.env");
      expect(buildSource).toContain(
        "...withoutDeferredCapabilityEnvironment(process.env)",
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("keeps removed targets out of the resolved allowlist inventory", () => {
    const activeInventory = compact(
      ALLOWED_PROXY_ROUTES.map((route) =>
        [route.prefix, ...route.methods, route.pathPattern?.source ?? ""].join(
          " ",
        ),
      ).join("\n"),
    );

    for (const removedTarget of [
      "live-transcription-session",
      "intake/story/audio-uploads",
      "intake/story/segments",
      "patients/me/miscribe",
      "patients/me/providers",
      "patients/me/link",
      "invite-codes/validate",
      "/api/v1/shares",
      "/api/v1/fhir",
      "push-notification",
      "notification-preferences",
      "patient-devices",
    ]) {
      expect(activeInventory).not.toContain(compact(removedTarget));
    }
  });

  it.each([
    [
      "POST",
      `/api/v1/patients/me/assessments/${ASSESSMENT_ID}/questions/R01/note/live-transcription-session`,
    ],
    ["POST", "/api/v1/patients/me/intake/story/audio-uploads"],
    ["POST", "/api/v1/patients/me/intake/story/segments/session"],
    ["POST", "/api/v1/patients/me/intake/story/segments"],
    ["POST", "/api/v1/patients/me/intake/story/segments/finalize"],
    ["GET", "/api/v1/patients/me/miscribe/recording-policy"],
    ["GET", "/api/v1/patients/me/miscribe/recordings"],
    ["POST", "/api/v1/patients/me/miscribe/recordings/setup"],
    [
      "POST",
      `/api/v1/patients/me/miscribe/recordings/${ASSESSMENT_ID}/process`,
    ],
    ["DELETE", `/api/v1/patients/me/miscribe/recordings/${ASSESSMENT_ID}`],
    ["GET", "/api/v1/patients/me/providers"],
    ["POST", "/api/v1/patients/me/link"],
    ["POST", `/api/v1/patients/me/providers/${ASSESSMENT_ID}/revoke`],
    ["POST", "/api/v1/invite-codes/validate"],
    ["POST", "/api/v1/shares"],
    ["GET", "/api/v1/fhir/policy"],
    ["GET", "/api/v1/fhir/endpoints"],
    ["GET", "/api/v1/fhir/connections"],
    ["GET", `/api/v1/fhir/connections/${ASSESSMENT_ID}`],
    ["DELETE", `/api/v1/fhir/connections/${ASSESSMENT_ID}`],
    ["DELETE", `/api/v1/fhir/connections/${ASSESSMENT_ID}/permission`],
    ["DELETE", `/api/v1/fhir/connections/${ASSESSMENT_ID}/attempt`],
    ["POST", `/api/v1/fhir/connections/${ASSESSMENT_ID}/sync`],
    ["GET", `/api/v1/fhir/connections/${ASSESSMENT_ID}/import-status`],
    ["GET", `/api/v1/fhir/imports/${SECOND_ID}/preview`],
    ["POST", `/api/v1/fhir/imports/${SECOND_ID}/commit`],
    ["GET", "/api/v1/fhir/import-history"],
    ["GET", "/api/v1/fhir/import-history/export"],
    ["GET", "/api/v1/patients/me/notification-preferences"],
    ["POST", "/api/v1/patients/me/devices"],
  ] as const)("blocks removed proxy target: %s %s", (method, targetPath) => {
    expect(validation(method, targetPath)).toEqual({
      ok: false,
      status: 404,
      code: "proxy_path_not_allowed",
    });
  });

  it.each(["google/start", "google/callback"])(
    "rejects removed Google request through generic auth catch-all: %s",
    async (authPath) => {
      const response = await authCatchAllGet(
        new NextRequest(`http://localhost/api/auth/${authPath}`),
        { params: Promise.resolve({ path: authPath.split("/") }) },
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    },
  );

  it.each(["/api/fhir/start", "/api/fhir/callback"])(
    "rejects removed FHIR request through generic app catch-all: %s",
    async (pathname) => {
      const response = await appCatchAllGet(
        new NextRequest(`http://localhost${pathname}`),
      );
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: "api_route_not_found",
      });
    },
  );

  it.each([
    ["POST", "/api/v1/patients/me/assessments"],
    ["POST", `/api/v1/patients/me/assessments/${ASSESSMENT_ID}/story`],
    ["GET", "/api/v1/patients/me/intake/story"],
    ["PUT", "/api/v1/patients/me/intake/story"],
    ["GET", "/api/v1/patients/me/intake/progress/latest"],
    ["POST", "/api/v1/patients/me/intake/route"],
    ["GET", `/api/v1/patients/me/reports/${ASSESSMENT_ID}`],
    ["POST", `/api/v1/patients/me/reports/${ASSESSMENT_ID}/download-url`],
    ["POST", `/api/v1/patients/me/reports/${ASSESSMENT_ID}/email-self`],
    ["GET", "/api/v1/patients/me/documents"],
    ["POST", "/api/v1/patients/me/documents/upload-url"],
    ["GET", `/api/v1/patients/me/documents/${ASSESSMENT_ID}/findings`],
  ] as const)(
    "preserves included proxy target: %s %s",
    (method, targetPath) => {
      expect(validation(method, targetPath)).toMatchObject({ ok: true });
    },
  );

  it.each([
    "src/app/api/auth/login/route.ts",
    "src/app/api/auth/register/route.ts",
    "src/app/api/auth/mfa/verify/route.ts",
    "src/app/api/auth/refresh/route.ts",
    "src/app/api/proxy/[...path]/route.ts",
    "src/app/api/health/route.ts",
  ])("preserves included BFF route source: %s", (relativePath) => {
    expect(existsSync(resolve(PROJECT_ROOT, relativePath))).toBe(true);
  });

  it("rejects deferred routes in generated Next manifests after build", () => {
    const regularManifests = REGULAR_NEXT_ROUTE_MANIFESTS.filter(
      (relativePath) => existsSync(resolve(PROJECT_ROOT, relativePath)),
    );
    const standaloneManifests = STANDALONE_NEXT_ROUTE_MANIFESTS.filter(
      (relativePath) => existsSync(resolve(PROJECT_ROOT, relativePath)),
    );
    const manifests = [...regularManifests, ...standaloneManifests];

    if (REQUIRE_BUILT_MANIFESTS) {
      expect(
        missingRequiredManifestGroups(regularManifests, standaloneManifests),
      ).toEqual([]);
    }
    if (manifests.length === 0) return;

    for (const relativePath of manifests) {
      expect([
        ...REGULAR_NEXT_ROUTE_MANIFESTS,
        ...STANDALONE_NEXT_ROUTE_MANIFESTS,
      ]).toContain(relativePath);
      expect(existsSync(resolve(PROJECT_ROOT, relativePath))).toBe(true);
      const parsed = JSON.parse(
        readFileSync(resolve(PROJECT_ROOT, relativePath), "utf8"),
      ) as unknown;
      const manifestEntries: string[] = [];
      collectManifestStrings(parsed, manifestEntries);
      expect(
        manifestEntries.filter(isDeferredManifestRoute),
        relativePath,
      ).toEqual([]);
    }
  });
});
