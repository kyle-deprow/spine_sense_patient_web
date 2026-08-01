import { expect } from "@playwright/test";

import type { JourneyContext } from "../journey/context";
import {
  TRANSITION_BUDGETS_MS,
  expectNoBrowserStorage,
} from "../journey/context";
import { clickAndWaitForResponse } from "../journey/selectors";
import {
  expectOptionalReportSwitchCanOnlySubmitWhenAvailable,
  expectRenderedAssessmentPdf,
  isAssessmentReportGenerationResponse,
} from "../journey/results";

export async function runResultsReportStage(
  context: JourneyContext,
): Promise<void> {
  const { page, request, profiler } = context;
  await context.step("results and report", async () => {
    await expect(page.getByTestId("results-screen")).toBeVisible({
      timeout: 120_000,
    });
    await page.getByTestId("sticky-tab-wrapper").scrollIntoViewIfNeeded();
    await expect(page.getByText("Treatment Strategy")).toBeVisible();
    await expect(page.getByTestId("results-treatment")).toBeVisible();
    await expect(page.getByTestId("results-self-care")).toBeVisible();
    await expect(page.getByTestId("results-share")).toBeEnabled();
    await page.getByTestId("results-share").click();
    const options = page.getByTestId("results-report-options");
    await expect(options).toBeVisible();
    await expectOptionalReportSwitchCanOnlySubmitWhenAvailable(
      options
        .getByTestId("results-report-options-include-documents")
        .getByRole("switch"),
      "Document summaries",
    );
    await expectOptionalReportSwitchCanOnlySubmitWhenAvailable(
      options
        .getByTestId("results-report-options-include-trends")
        .getByRole("switch"),
      "Symptom trends",
    );
    await expect(
      options.getByTestId("results-report-options-generate"),
    ).toHaveAttribute("aria-label", "Generate PDF");
    const response = await profiler.measure(
      "results.report_generation",
      "report",
      () =>
        clickAndWaitForResponse({
          page,
          testId: "results-report-options-generate",
          matches: isAssessmentReportGenerationResponse,
          timeout: TRANSITION_BUDGETS_MS.report,
        }),
    );
    expect(response.status()).toBe(201);
    await expectRenderedAssessmentPdf(request, response);
    await expect(page.getByTestId("results-report-error")).toBeHidden();
    await expectNoBrowserStorage(page);
  });
}
