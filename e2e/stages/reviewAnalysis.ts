import { expect } from "@playwright/test";

import type { JourneyContext } from "../journey/context";
import {
  waitForEnabledAndClick,
  waitForAnyVisibleTestId,
} from "../journey/selectors";
import { expectAnalysisRequestContracts } from "../journey/contracts";
import { isRecord } from "../journey/context";
import { maybeThrowForcedMidFlowFailure } from "../support/forcedMidFlowFailure";
import { verifyAnalyzedDocument } from "./documentAnalysis";

export function expectCompletedAnalysisResponse(
  responseUrl: string,
  pageUrl: string,
  payload: unknown,
): void {
  const response = new URL(responseUrl);
  const page = new URL(pageUrl);
  expect(
    response.origin,
    "analysis must be read through the same-origin BFF",
  ).toBe(page.origin);
  const assessmentId = response.pathname.match(
    /\/assessments\/([^/]+)\/analysis$/,
  )?.[1];
  expect(
    assessmentId,
    "analysis response must identify its assessment route",
  ).toBeDefined();
  expect(
    response.pathname.startsWith("/api/proxy/api/v1/patients/me/assessments/"),
    "analysis must use the approved patient BFF proxy path",
  ).toBe(true);
  expect(
    isRecord(payload),
    "completed analysis must be a structured object",
  ).toBe(true);
  if (!isRecord(payload)) return;
  expect(payload.status).toBe("complete");
  expect(payload.assessment_id).toBe(assessmentId);
  expect(
    typeof payload.results_schema_version === "string" &&
      payload.results_schema_version.length > 0,
    "completed analysis must declare its server schema version",
  ).toBe(true);
}

export async function waitForAnalysisReadyAndConfirm(
  context: JourneyContext,
  onProcessingBeforeCompletion: () => void = () => {},
): Promise<void> {
  onProcessingBeforeCompletion();
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
    const completedAnalysis = page.waitForResponse(
      async (response) => {
        const url = new URL(response.url());
        if (
          response.request().method() !== "GET" ||
          !url.pathname.endsWith("/analysis") ||
          response.status() !== 200
        ) {
          return false;
        }
        try {
          const payload: unknown = await response.json();
          return isRecord(payload) && payload.status === "complete";
        } catch {
          return false;
        }
      },
      { timeout: 480_000 },
    );
    void completedAnalysis.catch(() => undefined);
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
    await waitForAnalysisReadyAndConfirm(context, () =>
      maybeThrowForcedMidFlowFailure("analysis"),
    );
    const completed = await completedAnalysis;
    expectCompletedAnalysisResponse(
      completed.url(),
      page.url(),
      await completed.json(),
    );
    await expect(page.getByTestId("results-screen")).toBeVisible({
      timeout: 480_000,
    });
    await expect(page.getByText("Assessment Results")).toBeVisible();
    await expect(page.getByTestId("results-disclaimer")).toBeVisible();
    await expect(page.getByTestId("results-diagnosis")).toBeVisible();
    await verifyAnalyzedDocument(context);
  });
}

export async function runReviewAnalysisStage(
  context: JourneyContext,
): Promise<void> {
  await runReviewStage(context);
  await runAnalysisStage(context);
}
