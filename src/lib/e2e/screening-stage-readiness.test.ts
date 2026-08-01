import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";

import {
  SCREENING_POST_SUBMIT_READINESS_TEST_IDS,
  waitForScreeningPostSubmitReadiness,
} from "../../../e2e/stages/screening";

describe("screening post-submit readiness", () => {
  it("selects a deterministic stage when route containers overlap", async () => {
    const visibleTestIds = new Set<string>([
      SCREENING_POST_SUBMIT_READINESS_TEST_IDS[0],
      SCREENING_POST_SUBMIT_READINESS_TEST_IDS[2],
    ]);
    const page = {
      getByTestId: (testId: string) => ({
        isVisible: async () => visibleTestIds.has(testId),
      }),
    } as unknown as Page;

    await expect(
      waitForScreeningPostSubmitReadiness(page, 1_000),
    ).resolves.toBe(SCREENING_POST_SUBMIT_READINESS_TEST_IDS[0]);
  });
});
