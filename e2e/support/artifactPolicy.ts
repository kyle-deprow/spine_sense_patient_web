import type { FullConfig } from "@playwright/test";

const CAPTURE_OPTIONS = ["trace", "video", "screenshot"] as const;
const UI_MODE_OPTIONS = ["--ui", "--ui-host", "--ui-port"] as const;

export function rejectPlaywrightUiMode(argv: readonly string[]): void {
  const selectedOption = argv.find((argument) =>
    UI_MODE_OPTIONS.some(
      (option) => argument === option || argument.startsWith(`${option}=`),
    ),
  );

  if (selectedOption !== undefined) {
    throw new Error(
      `PHI-safe Playwright artifact policy rejects UI mode (${selectedOption})`,
    );
  }
}

function isOff(value: unknown): boolean {
  if (value === "off") {
    return true;
  }
  return (
    typeof value === "object" &&
    value !== null &&
    "mode" in value &&
    value.mode === "off"
  );
}

export default function enforcePhiSafeArtifactPolicy(config: FullConfig): void {
  if (process.env.PLAYWRIGHT_NO_COPY_PROMPT !== "1") {
    throw new Error(
      "PHI-safe Playwright artifact policy requires process-start PLAYWRIGHT_NO_COPY_PROMPT=1",
    );
  }

  for (const project of config.projects) {
    for (const option of CAPTURE_OPTIONS) {
      if (!isOff(project.use[option])) {
        throw new Error(
          `PHI-safe Playwright artifact policy requires ${project.name}.${option}=off`,
        );
      }
    }
  }
}
