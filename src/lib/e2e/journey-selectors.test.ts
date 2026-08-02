import { describe, expect, it } from "vitest";

import {
  waitForAnyVisibleTestId,
  waitForDynamicQuestionAdvance,
} from "../../../e2e/journey/selectors";

function adaptiveLoadingPage(visibleText: string) {
  return {
    getByTestId: () => ({
      isVisible: async () => false,
    }),
    getByText: (pattern: RegExp) => ({
      first: () => ({
        isVisible: async () => pattern.test(visibleText),
      }),
    }),
  } as unknown as Parameters<typeof waitForAnyVisibleTestId>[0];
}

describe("shared journey selectors", () => {
  it("waits through an unmounted adaptive route gap for the exact review screen", async () => {
    let reviewChecks = 0;
    const page = {
      getByTestId: (testId: string) => ({
        isVisible: async () => {
          if (testId === "review-screen") {
            reviewChecks += 1;
            return reviewChecks >= 2;
          }
          return false;
        },
      }),
      getByText: () => ({
        first: () => ({ isVisible: async () => false }),
      }),
      locator: () => ({
        first: () => ({ isVisible: async () => false }),
      }),
    } as unknown as Parameters<typeof waitForDynamicQuestionAdvance>[0];

    await expect(
      waitForDynamicQuestionAdvance(
        page,
        "adaptive-screen",
        "adaptive-question",
        null,
        "adaptive-submit",
        ["review-screen"],
        100,
      ),
    ).resolves.toBe("review-screen");
  });

  it.each([
    "Could not prepare follow-up questions",
    "Follow-up questions are taking too long",
  ])(
    "maps the root adaptive loading recovery surface into the bounded error state: %s",
    async (title) => {
      await expect(
        waitForAnyVisibleTestId(
          adaptiveLoadingPage(title),
          ["adaptive-loading-error-state"],
          100,
        ),
      ).resolves.toBe("adaptive-loading-error-state");
    },
  );

  it("does not mistake ordinary adaptive loading for a recovery error", async () => {
    await expect(
      waitForAnyVisibleTestId(
        adaptiveLoadingPage("Generating follow-up questions..."),
        ["adaptive-loading-error-state"],
        5,
      ),
    ).rejects.toThrow(
      "None of these test IDs became visible: adaptive-loading-error-state",
    );
  });

  it("recognizes the exact production timeout title without a rendered test ID", async () => {
    await expect(
      waitForAnyVisibleTestId(
        adaptiveLoadingPage("Follow-up questions are taking too long"),
        ["adaptive-loading-timeout"],
        100,
      ),
    ).resolves.toBe("adaptive-loading-timeout");
  });

  it("does not classify the ordinary recovery title as a product timeout", async () => {
    await expect(
      waitForAnyVisibleTestId(
        adaptiveLoadingPage("Could not prepare follow-up questions"),
        ["adaptive-loading-timeout"],
        5,
      ),
    ).rejects.toThrow(
      "None of these test IDs became visible: adaptive-loading-timeout",
    );
  });
});
