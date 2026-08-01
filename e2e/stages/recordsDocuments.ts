import { expect, type Page } from "@playwright/test";

import type { JourneyContext } from "../journey/context";
import {
  clickByTestId,
  fillByTestId,
  waitForAnyVisibleTestId,
  waitForBrowserNetworkReady,
  waitForEnabledAndClick,
} from "../journey/selectors";
import { AssessmentEntryNavigationTracker } from "../support/assessmentEntryRecovery";
import { uploadSyntheticAssessmentDocumentFromRecordsStep } from "./recordsUpload";

const ASSESSMENT_ENTRY_STAGES = [
  "home-screen",
  "screening-screen",
  "story-capture",
  "story-screen",
] as const;

export function recordsStepLocator(page: Page) {
  return page.getByTestId("step-imaging-records");
}

async function clickRecordsContinue(page: Page): Promise<void> {
  const recordsContinue = page.getByTestId("records-continue-btn");
  if (await recordsContinue.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await waitForEnabledAndClick(page, "records-continue-btn");
    return;
  }
  const skip = page.getByRole("button", { name: /skip for now/i });
  if (await skip.isVisible({ timeout: 1_000 }).catch(() => false)) {
    await expect(skip).toBeEnabled({ timeout: 30_000 });
    await skip.click({ timeout: 10_000 });
    return;
  }
  const complete = page.getByRole("button", { name: /complete intake/i });
  await expect(complete).toBeEnabled({ timeout: 30_000 });
  await complete.click({ timeout: 10_000 });
}

async function waitForAssessmentEntry(
  page: Page,
  profiler: JourneyContext["profiler"],
): Promise<string> {
  const navigationTracker = new AssessmentEntryNavigationTracker();
  navigationTracker.start(page);
  try {
    await clickRecordsContinue(page);
    try {
      const stage = await waitForAnyVisibleTestId(
        page,
        ASSESSMENT_ENTRY_STAGES,
        60_000,
      );
      if (stage === "home-screen") {
        await expect(page.getByTestId("start-assessment-btn")).toBeVisible({
          timeout: 30_000,
        });
        await waitForEnabledAndClick(page, "start-assessment-btn");
        return await waitForAnyVisibleTestId(
          page,
          ["screening-screen", "story-capture", "story-screen"],
          60_000,
        );
      }
      return stage;
    } catch (error) {
      const decision = navigationTracker.consumeRetryableFailure(1, 2);
      if (!decision.retry) throw error;
      await profiler.measure(
        "assessment_entry.transport_recovery",
        "recovery",
        async () => {
          await waitForBrowserNetworkReady(page);
          const reloadResponse = await page.reload({
            waitUntil: "domcontentloaded",
            timeout: 45_000,
          });
          if (reloadResponse == null || !reloadResponse.ok()) {
            throw new Error(
              `Assessment entry recovery navigation failed status=${reloadResponse?.status() ?? "none"}`,
            );
          }
        },
      );
      return await waitForAnyVisibleTestId(
        page,
        ASSESSMENT_ENTRY_STAGES,
        60_000,
      );
    }
  } finally {
    navigationTracker.stop();
  }
}

export async function runRecordsDocumentsStage(
  context: JourneyContext,
): Promise<void> {
  const { page, profiler, scenario, email } = context;
  await context.step("records and documents", async () => {
    await expect(recordsStepLocator(page)).toBeVisible({ timeout: 60_000 });
    await uploadSyntheticAssessmentDocumentFromRecordsStep(page, email);
    const firstAssessmentScreen = await profiler.measure(
      "onboarding.records_to_assessment_entry",
      "stage",
      () => waitForAssessmentEntry(page, profiler),
    );
    if (firstAssessmentScreen === "screening-screen") return;
    if (
      firstAssessmentScreen !== "story-capture" &&
      firstAssessmentScreen !== "story-screen"
    ) {
      throw new Error(
        `Unexpected assessment entry stage ${firstAssessmentScreen}`,
      );
    }
    await clickByTestId(page, "story-capture-text-tab");
    await fillByTestId(
      page,
      "story-capture-text-input",
      scenario.assessmentStory,
    );
    await page.getByTestId("story-capture-text-input").blur();
    await profiler.measure(
      "assessment.story_to_documents",
      "page",
      async () => {
        await waitForEnabledAndClick(page, "story-capture-continue-btn");
        await expect(page.getByTestId("documents-screen")).toBeVisible({
          timeout: 60_000,
        });
      },
    );
    await profiler.measure(
      "assessment.documents_to_screening",
      "page",
      async () => {
        await waitForEnabledAndClick(page, "documents-skip-btn");
        await expect(page.getByTestId("screening-screen")).toBeVisible({
          timeout: 60_000,
        });
      },
    );
  });
}
