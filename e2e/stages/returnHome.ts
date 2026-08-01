import { expect } from "@playwright/test";

import type { JourneyContext } from "../journey/context";
import { expectNoBrowserStorage } from "../journey/context";
import { waitForEnabledAndClick } from "../journey/selectors";

export async function runReturnHomeStage(
  context: JourneyContext,
): Promise<void> {
  const { page, profiler } = context;
  await context.step("return home", async () => {
    await profiler.measure("results.to_home", "page", async () => {
      await waitForEnabledAndClick(page, "tab-home", 30_000);
      await expect(
        page.locator('[data-testid="home-screen"]:visible'),
      ).toBeVisible({ timeout: 60_000 });
    });
    await expect(page.getByTestId("assessment-entry-banner")).toBeHidden();
    await expect(
      page.locator('[data-testid="clinical-summary-card"]:visible'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="summary-headline"]:visible'),
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="active-problems-card"]:visible'),
    ).toBeVisible();
    await expectNoBrowserStorage(page);
  });
}
