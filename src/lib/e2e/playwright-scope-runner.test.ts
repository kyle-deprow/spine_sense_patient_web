import { createRequire } from "node:module";
import { readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import scopeManifest from "../../../e2e/scopes.json";

const require = createRequire(import.meta.url);
const runner = require("../../../scripts/run-playwright-e2e.cjs") as {
  buildPlaywrightArgv: (
    argv: string[],
    rawScopes?: string,
    manifest?: unknown,
  ) => string[];
  resolveScopeSpecs: (rawScopes?: string, manifest?: unknown) => string[];
};

function exactFileFilter(spec: string): string {
  const absoluteSpec = resolve(process.cwd(), spec);
  return `^${absoluteSpec.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}$`;
}

describe("patient-web Playwright scope runner", () => {
  it("resolves the default and requested scopes to exact manifest specs", () => {
    expect(runner.resolveScopeSpecs()).toEqual([
      "e2e/scopes/auth.spec.ts",
      "e2e/scopes/consent-onboarding.spec.ts",
      "e2e/scopes/documents.spec.ts",
      "e2e/scopes/screening.spec.ts",
      "e2e/scopes/adaptive.spec.ts",
      "e2e/scopes/analysis.spec.ts",
      "e2e/scopes/results-report.spec.ts",
    ]);
    expect(runner.resolveScopeSpecs(" screening,auth ")).toEqual([
      "e2e/scopes/screening.spec.ts",
      "e2e/scopes/auth.spec.ts",
    ]);
    expect(runner.resolveScopeSpecs("auth,legacy-journey,analysis")).toEqual([
      "e2e/legacy-journey.spec.ts",
    ]);
  });

  it("collects the seven-test checkpoint suite and excludes the legacy journey", () => {
    const result = spawnSync(
      process.execPath,
      ["scripts/run-playwright-e2e.cjs", "test", "--list"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, E2E_SCOPES: undefined },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/Total: 7 tests(?:\s|$)/);
    expect(result.stdout).not.toContain("@legacy-journey");
    const discoveredTests = result.stdout
      .split("\n")
      .filter((line) => line.includes("@scope-"));
    expect(discoveredTests).toHaveLength(7);
    for (const scope of scopeManifest.default_scopes) {
      expect(
        discoveredTests.filter((line) => line.includes(`@scope-${scope}`)),
      ).toHaveLength(1);
    }
  });

  it("inserts exact spec arguments before supported Playwright options", () => {
    expect(
      runner.buildPlaywrightArgv(
        ["node", "runner", "test", "--project", "chromium", "--headed"],
        "documents,analysis",
      ),
    ).toEqual([
      "node",
      "runner",
      "test",
      exactFileFilter("e2e/scopes/documents.spec.ts"),
      exactFileFilter("e2e/scopes/analysis.spec.ts"),
      "--project",
      "chromium",
      "--headed",
    ]);
  });

  it.each([
    "unknown",
    "toString",
    "__proto__",
    "../auth",
    "auth;analysis",
    "auth,,analysis",
    "auth,auth",
    "full",
    " , ",
  ])("rejects invalid scope input %j", (scope) => {
    expect(() => runner.resolveScopeSpecs(scope)).toThrow();
  });

  it.each([
    ["--grep", "auth"],
    ["--grep=@scope-auth"],
    ["-g", "auth"],
    ["--config", "alternate.config.ts"],
    ["--config=alternate.config.ts"],
    ["e2e/legacy-journey.spec.ts"],
  ])("rejects a Playwright selection override %j", (...selectionArgs) => {
    expect(() =>
      runner.buildPlaywrightArgv(
        ["node", "runner", "test", ...selectionArgs],
        "auth",
      ),
    ).toThrow();
  });

  it.each([
    ["--unknown"],
    ["--project"],
    ["--project", "--headed"],
    ["--headed=true"],
    ["--config="],
    ["--workers", "2"],
    ["--retries=1"],
    ["--reporter", "html"],
    ["--output=test-results"],
    ["--shard", "1/2"],
    ["--pass-with-no-tests"],
  ])("rejects an unsupported or malformed passthrough %j", (...args) => {
    expect(() =>
      runner.buildPlaywrightArgv(["node", "runner", "test", ...args], "auth"),
    ).toThrow();
  });

  it("allows artifact-policy options to reach resolved policy enforcement", () => {
    expect(
      runner.buildPlaywrightArgv(
        [
          "node",
          "runner",
          "test",
          "--trace",
          "on",
          "--ui-host=127.0.0.1",
          "--ui=true",
        ],
        "auth",
      ),
    ).toEqual([
      "node",
      "runner",
      "test",
      exactFileFilter("e2e/scopes/auth.spec.ts"),
      "--trace",
      "on",
      "--ui-host=127.0.0.1",
      "--ui=true",
    ]);
  });

  it("requires one unique safe spec path for every manifest scope", () => {
    const duplicateSpec = {
      ...scopeManifest,
      scopes: {
        ...scopeManifest.scopes,
        auth: {
          ...scopeManifest.scopes.auth,
          spec: scopeManifest.scopes["legacy-journey"].spec,
        },
      },
    };
    expect(() => runner.resolveScopeSpecs("auth", duplicateSpec)).toThrow(
      "unique package-relative Playwright spec",
    );

    const traversalSpec = {
      ...scopeManifest,
      scopes: {
        ...scopeManifest.scopes,
        auth: {
          ...scopeManifest.scopes.auth,
          spec: "e2e/../outside.spec.ts",
        },
      },
    };
    expect(() => runner.resolveScopeSpecs("auth", traversalSpec)).toThrow(
      "unique package-relative Playwright spec",
    );

    const missingSpec = {
      ...scopeManifest,
      scopes: {
        ...scopeManifest.scopes,
        auth: {
          ...scopeManifest.scopes.auth,
          spec: "e2e/scopes/missing.spec.ts",
        },
      },
    };
    expect(() => runner.resolveScopeSpecs("auth", missingSpec)).toThrow(
      "unique package-relative Playwright spec",
    );

    const legacyPaths = {
      ...scopeManifest,
      scopes: {
        ...scopeManifest.scopes,
        auth: {
          ...scopeManifest.scopes.auth,
          paths: ["e2e/stages/accountVerification.ts"],
        },
      },
    };
    expect(() => runner.resolveScopeSpecs("auth", legacyPaths)).toThrow(
      "unique package-relative Playwright spec",
    );
  });

  it.each([
    ["start_checkpoint", "not_a_checkpoint"],
    ["end_checkpoint", "not_a_checkpoint"],
    ["timeout_class", "   "],
    ["tag", "@scope-analysis"],
  ])("rejects invalid auth manifest metadata %s=%j", (field, value) => {
    const invalidManifest = {
      ...scopeManifest,
      scopes: {
        ...scopeManifest.scopes,
        auth: {
          ...scopeManifest.scopes.auth,
          [field]: value,
        },
      },
    };
    expect(() => runner.resolveScopeSpecs("auth", invalidManifest)).toThrow(
      "exact metadata",
    );
  });

  it("requires the exact named results-report fixture", () => {
    const invalidFixture = {
      ...scopeManifest,
      scopes: {
        ...scopeManifest.scopes,
        "results-report": {
          ...scopeManifest.scopes["results-report"],
          fixture: "results-report-v2",
        },
      },
    };
    expect(() =>
      runner.resolveScopeSpecs("results-report", invalidFixture),
    ).toThrow("exact metadata");
  });

  it("rejects symlinked spec entrypoints", () => {
    const symlink = resolve(process.cwd(), "e2e/scopes/auth-link.spec.ts");
    symlinkSync("auth.spec.ts", symlink);
    try {
      const symlinkManifest = {
        ...scopeManifest,
        scopes: {
          ...scopeManifest.scopes,
          auth: {
            ...scopeManifest.scopes.auth,
            spec: "e2e/scopes/auth-link.spec.ts",
          },
        },
      };
      expect(() => runner.resolveScopeSpecs("auth", symlinkManifest)).toThrow(
        "unique package-relative Playwright spec",
      );
    } finally {
      unlinkSync(symlink);
    }
  });

  it("excludes a filename confusable under Playwright regex semantics", () => {
    const confusable = resolve(
      process.cwd(),
      "e2e/scopes/authXspecYts.spec.ts",
    );
    writeFileSync(
      confusable,
      'import { test } from "@playwright/test";\ntest("confusable", () => {});\n',
      { flag: "wx" },
    );
    try {
      const result = spawnSync(
        process.execPath,
        ["scripts/run-playwright-e2e.cjs", "test", "--list"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, E2E_SCOPES: "auth" },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("auth checkpoint @scope-auth");
      expect(result.stdout).toContain("Total: 1 test in 1 file");
      expect(result.stdout).not.toContain("confusable");
    } finally {
      unlinkSync(confusable);
    }
  });

  it("keeps one exact spec entrypoint per manifest scope", () => {
    const specs = Object.values(scopeManifest.scopes).map(({ spec }) => spec);
    expect(new Set(specs).size).toBe(specs.length);
    expect(specs).toEqual([
      "e2e/legacy-journey.spec.ts",
      "e2e/scopes/auth.spec.ts",
      "e2e/scopes/consent-onboarding.spec.ts",
      "e2e/scopes/onboarding-resume.spec.ts",
      "e2e/scopes/onboarding-draft-restore.spec.ts",
      "e2e/scopes/onboarding-intro-idempotence.spec.ts",
      "e2e/scopes/documents.spec.ts",
      "e2e/scopes/screening.spec.ts",
      "e2e/scopes/adaptive.spec.ts",
      "e2e/scopes/analysis.spec.ts",
      "e2e/scopes/results-report.spec.ts",
    ]);

    for (const [scope, { spec }] of Object.entries(scopeManifest.scopes)) {
      if (scope === "legacy-journey") {
        continue;
      }
      expect(readFileSync(resolve(process.cwd(), spec), "utf8")).toContain(
        `defineScopedAssessment(${JSON.stringify(scope)})`,
      );
    }
  });
});
