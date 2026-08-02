import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SCREENING_POST_SUBMIT_FAILURE_TEST_IDS,
  SCREENING_POST_SUBMIT_READINESS_TEST_IDS,
  submitScreening,
  waitForScreeningPostSubmitReadiness,
} from "../../../e2e/stages/screening";

function pageWithVisibleTestIds(visibleTestIds: ReadonlySet<string>): Page {
  const hiddenLocator = {
    isVisible: async () => false,
    first() {
      return this;
    },
  };

  return {
    getByTestId: (testId: string) => ({
      isVisible: async () => visibleTestIds.has(testId),
    }),
    getByText: () => hiddenLocator,
    getByRole: () => hiddenLocator,
  } as unknown as Page;
}

describe("screening post-submit readiness", () => {
  it("selects a deterministic stage when route containers overlap", async () => {
    const visibleTestIds = new Set<string>([
      SCREENING_POST_SUBMIT_READINESS_TEST_IDS[0],
      SCREENING_POST_SUBMIT_READINESS_TEST_IDS[2],
    ]);
    const page = pageWithVisibleTestIds(visibleTestIds);

    await expect(
      waitForScreeningPostSubmitReadiness(page, 1_000),
    ).resolves.toBe(SCREENING_POST_SUBMIT_READINESS_TEST_IDS[0]);
  });

  it.each(["adaptive-loading-error-state", "adaptive-error-state"] as const)(
    "rejects the explicit failure surface %s",
    async (failureTestId) => {
      const page = pageWithVisibleTestIds(new Set([failureTestId]));

      expect(SCREENING_POST_SUBMIT_FAILURE_TEST_IDS).toContain(failureTestId);
      await expect(
        waitForScreeningPostSubmitReadiness(page, 1_000),
      ).rejects.toThrow(
        `Screening submit reached failure state: ${failureTestId}`,
      );
    },
  );

  it.each(["adaptive-screen", "review-screen"] as const)(
    "accepts the post-submit handoff %s",
    async (readinessTestId) => {
      const page = pageWithVisibleTestIds(new Set([readinessTestId]));

      await expect(
        waitForScreeningPostSubmitReadiness(page, 1_000),
      ).resolves.toBe(readinessTestId);
    },
  );

  it("owns only the first allowed handoff even if adaptive later enters an error state", async () => {
    const visibleTestIds = new Set(["adaptive-loading-state"]);
    const page = pageWithVisibleTestIds(visibleTestIds);

    const observed = await submitScreening(page, {} as never);
    visibleTestIds.clear();
    visibleTestIds.add("adaptive-loading-error-state");

    expect(observed).toBe("adaptive-loading-state");
    expect(visibleTestIds).toEqual(new Set(["adaptive-loading-error-state"]));
  });

  it("does not wait for post-submit readiness a second time in the stage runner", () => {
    const source = readFileSync(
      resolve(process.cwd(), "e2e/stages/screening.ts"),
      "utf8",
    );
    const runner = source.slice(
      source.indexOf("export async function runScreeningStage"),
    );

    expect(runner).not.toContain("waitForScreeningPostSubmitReadiness(page");
    expect(runner).toContain("submitScreening(page, profiler)");
    expect(runner.match(/"screening\.submit"/g)).toHaveLength(1);
    expect(runner).toContain("expectClientRequestContracts(");
    expect(runner.indexOf("expectClientRequestContracts(")).toBeGreaterThan(
      runner.indexOf("submitScreening(page, profiler)"),
    );
  });
});
