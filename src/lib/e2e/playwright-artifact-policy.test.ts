import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enforcePhiSafeArtifactPolicy, {
  rejectPlaywrightUiMode,
} from "../../../e2e/support/artifactPolicy";
import packageJson from "../../../package.json";

describe("Playwright artifact policy", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the process-start wrapper and global policy setup", async () => {
    vi.stubEnv("PLAYWRIGHT_NO_COPY_PROMPT", undefined);
    expect(process.env.PLAYWRIGHT_NO_COPY_PROMPT).toBeUndefined();

    const { default: config } = await import("../../../playwright.config");

    expect(process.env.PLAYWRIGHT_NO_COPY_PROMPT).toBeUndefined();
    expect(packageJson.scripts["test:e2e"]).toBe(
      "node scripts/run-playwright-e2e.cjs test",
    );
    expect(config.use).toMatchObject({
      trace: "off",
      video: "off",
      screenshot: "off",
    });
    expect(config.globalSetup).toBe("./e2e/support/artifactPolicy.ts");
  });

  it.each(["trace", "video", "screenshot"] as const)(
    "rejects an effective %s override in any resolved project",
    (option) => {
      vi.stubEnv("PLAYWRIGHT_NO_COPY_PROMPT", "1");
      const config = {
        projects: [
          {
            name: "safe-project",
            use: { trace: "off", video: "off", screenshot: "off" },
          },
          {
            name: "unsafe-project",
            use: {
              trace: "off",
              video: "off",
              screenshot: "off",
              [option]: "on",
            },
          },
        ],
      };

      expect(() => enforcePhiSafeArtifactPolicy(config as never)).toThrow(
        `unsafe-project.${option}=off`,
      );
    },
  );

  it("accepts only projects whose effective capture modes are all off", () => {
    vi.stubEnv("PLAYWRIGHT_NO_COPY_PROMPT", "1");
    const config = {
      projects: [
        {
          name: "chromium",
          use: { trace: "off", video: "off", screenshot: "off" },
        },
      ],
    };

    expect(() => enforcePhiSafeArtifactPolicy(config as never)).not.toThrow();
    expect(process.env.PLAYWRIGHT_NO_COPY_PROMPT).toBe("1");
  });

  it.each([undefined, "", "0", "true"])(
    "rejects a missing or non-exact process-start gate: %s",
    (value) => {
      vi.stubEnv("PLAYWRIGHT_NO_COPY_PROMPT", value);

      expect(() =>
        enforcePhiSafeArtifactPolicy({ projects: [] } as never),
      ).toThrow("requires process-start PLAYWRIGHT_NO_COPY_PROMPT=1");
    },
  );

  it.each([
    "--ui",
    "--ui=true",
    "--ui-host",
    "--ui-host=127.0.0.1",
    "--ui-port",
    "--ui-port=43199",
  ])("rejects UI selector %s during config evaluation", (selector) => {
    expect(() =>
      rejectPlaywrightUiMode(["node", "playwright", "test", selector]),
    ).toThrow(`rejects UI mode (${selector})`);
  });

  it("allows non-UI Playwright arguments", () => {
    expect(() =>
      rejectPlaywrightUiMode([
        "node",
        "playwright",
        "test",
        "--debug",
        "--headed",
      ]),
    ).not.toThrow();
  });
});
