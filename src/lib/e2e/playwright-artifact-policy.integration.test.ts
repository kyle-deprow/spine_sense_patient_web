import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const playwrightCli = require.resolve("@playwright/test/cli");
const packageRunner = resolve(process.cwd(), "scripts/run-playwright-e2e.cjs");
const temporaryRoots: string[] = [];

function allFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory() ? allFiles(path) : [path];
  });
}

function assertNoBrowserArtifacts(outputDir: string, sentinel: string): void {
  const files = allFiles(outputDir);
  expect(files.map((file) => file.slice(outputDir.length + 1))).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /(^|\/)(error-context\.md|trace\.zip|[^/]+\.(png|jpe?g|webm))$/i,
      ),
    ]),
  );

  const sentinelBytes = Buffer.from(sentinel);
  for (const file of files) {
    expect(readFileSync(file).includes(sentinelBytes), file).toBe(false);
  }
}

describe("Playwright artifact policy integration", () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces process-start and resolved artifact policy", () => {
    const root = mkdtempSync(
      join(process.cwd(), ".playwright-artifact-policy-"),
    );
    temporaryRoots.push(root);
    const configPath = join(root, "playwright.config.ts");
    const specPath = join(root, "e2e", "legacy-journey.spec.ts");
    const safeOutputDir = join(root, "safe-output");
    const rawOutputDir = join(root, "raw-output");
    const unsafeOutputDir = join(root, "unsafe-output");
    const uiOutputDir = join(root, "ui-output");
    const executedMarker = join(root, "executed.marker");
    const sentinel = "SYNTHETIC_BROWSER_ARTIFACT_SENTINEL_7D8A";
    const packageConfig = resolve(process.cwd(), "playwright.config.ts");
    const globalSetup = resolve(process.cwd(), "e2e/support/artifactPolicy.ts");

    writeFileSync(
      configPath,
      `
          import { defineConfig } from "@playwright/test";
          import packageConfig from ${JSON.stringify(packageConfig)};

          export default defineConfig(packageConfig, {
            testDir: ${JSON.stringify(root)},
            testMatch: "e2e/legacy-journey.spec.ts",
            grep: /.*/,
            outputDir: process.env.ARTIFACT_PROBE_OUTPUT_DIR,
            globalSetup: ${JSON.stringify(globalSetup)},
          });
        `,
    );
    mkdirSync(join(root, "e2e"));
    writeFileSync(
      specPath,
      `
          import { writeFileSync } from "node:fs";
          import { expect, test } from "@playwright/test";

          test("synthetic browser failure", async ({ page }) => {
            writeFileSync(${JSON.stringify(executedMarker)}, "executed");
            await page.setContent("<main>" + process.env.ARTIFACT_PROBE_SENTINEL + "</main>");
            await expect(page.getByText("INTENTIONAL_MISSING_ELEMENT")).toBeVisible({ timeout: 100 });
          });
        `,
    );

    const run = (
      entrypoint: string,
      outputDir: string,
      extraArgs: string[] = [],
      noCopyPrompt = false,
    ) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        ARTIFACT_PROBE_OUTPUT_DIR: outputDir,
        ARTIFACT_PROBE_SENTINEL: sentinel,
        E2E_SCOPES: "legacy-journey",
      };
      if (noCopyPrompt) {
        env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
      } else {
        delete env.PLAYWRIGHT_NO_COPY_PROMPT;
      }
      const result = spawnSync(
        process.execPath,
        [entrypoint, "test", "--config", configPath, ...extraArgs],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 15_000,
          env,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      return result;
    };

    const configOverride = run(packageRunner, safeOutputDir);
    expect(configOverride.status).toBe(1);
    expect(`${configOverride.stdout}${configOverride.stderr}`).toContain(
      "Unsupported Playwright passthrough option",
    );
    expect(existsSync(executedMarker)).toBe(false);
    assertNoBrowserArtifacts(safeOutputDir, sentinel);

    const safeFailure = run(playwrightCli, safeOutputDir, [], true);
    expect(safeFailure.status).toBe(1);
    expect(existsSync(executedMarker)).toBe(true);
    expect(`${safeFailure.stdout}${safeFailure.stderr}`).not.toContain(
      sentinel,
    );
    assertNoBrowserArtifacts(safeOutputDir, sentinel);

    rmSync(executedMarker);
    const rawCli = run(playwrightCli, rawOutputDir);
    expect(rawCli.status).toBe(1);
    expect(`${rawCli.stdout}${rawCli.stderr}`).toContain(
      "requires process-start PLAYWRIGHT_NO_COPY_PROMPT=1",
    );
    expect(existsSync(executedMarker)).toBe(false);
    assertNoBrowserArtifacts(rawOutputDir, sentinel);

    const unsafeOverride = run(
      playwrightCli,
      unsafeOutputDir,
      ["--trace", "on"],
      true,
    );
    expect(unsafeOverride.status).toBe(1);
    expect(`${unsafeOverride.stdout}${unsafeOverride.stderr}`).toContain(
      "PHI-safe Playwright artifact policy requires chromium.trace=off",
    );
    expect(existsSync(executedMarker)).toBe(false);
    assertNoBrowserArtifacts(unsafeOutputDir, sentinel);

    const uiMode = run(
      playwrightCli,
      uiOutputDir,
      ["--ui-host=127.0.0.1"],
      true,
    );
    expect(uiMode.status).toBe(1);
    expect(`${uiMode.stdout}${uiMode.stderr}`).toContain(
      "PHI-safe Playwright artifact policy rejects UI mode (--ui-host=127.0.0.1)",
    );
    expect(existsSync(executedMarker)).toBe(false);
    assertNoBrowserArtifacts(uiOutputDir, sentinel);
  }, 60_000);
});
