import { expect } from "@playwright/test";

import type { JourneyContext } from "../journey/context";
import {
  waitForEnabledAndClick,
  waitForAnyVisibleTestId,
} from "../journey/selectors";
import { expectAnalysisRequestContracts } from "../journey/contracts";

async function waitForAnalysisReadyAndConfirm(
  context: JourneyContext,
): Promise<void> {
  await context.profiler.measure(
    "processing.to_results_ready",
    "analysis",
    async () => {
      const stage = await waitForAnyVisibleTestId(
        context.page,
        ["results-ready-confirm", "assessment-processing-failed"],
        480_000,
      );
      if (stage === "assessment-processing-failed") {
        throw new Error("Assessment analysis failed during full E2E");
      }
      await waitForEnabledAndClick(
        context.page,
        "results-ready-confirm",
        30_000,
      );
    },
  );
}

export async function runReviewStage(context: JourneyContext): Promise<void> {
  const { page } = context;
  await context.step("review", async () => {
    await expect(page.getByTestId("review-screen")).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("review-ready-icon")).toBeVisible();
    await expect(page.getByTestId("review-ready-title")).toBeVisible();
    await expect(page.getByText("ASSESSMENT COMPLETE")).toBeVisible();
    await expect(
      page.getByText(/build your personalized clinical picture/i),
    ).toBeVisible();
  });
}

export async function runAnalysisStage(context: JourneyContext): Promise<void> {
  const { page, profiler } = context;
  await context.step("analysis", async () => {
    const analysisRequest = page.waitForRequest((request) => {
      if (request.method() === "GET") return false;
      return new URL(request.url()).pathname.endsWith("/analysis/run");
    });
    await profiler.measure("review.to_processing", "page", async () => {
      await waitForEnabledAndClick(page, "review-submit");
      await expect(page.getByTestId("assessment-processing")).toBeVisible({
        timeout: 30_000,
      });
    });
    await analysisRequest;
    expectAnalysisRequestContracts(context.questionnaireMutations);
    await waitForAnalysisReadyAndConfirm(context);
    await expect(page.getByTestId("results-screen")).toBeVisible({
      timeout: 480_000,
    });
    await expect(page.getByText("Assessment Results")).toBeVisible();
    await expect(page.getByTestId("results-disclaimer")).toBeVisible();
    await expect(page.getByTestId("results-diagnosis")).toBeVisible();
  });
}

export async function runReviewAnalysisStage(
  context: JourneyContext,
): Promise<void> {
  await runReviewStage(context);
  await runAnalysisStage(context);
}
