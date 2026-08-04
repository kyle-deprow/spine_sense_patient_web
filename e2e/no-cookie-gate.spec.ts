import { expect, test, type Page } from "@playwright/test";

/**
 * The cookie consent gate was removed, and this is what keeps it removed.
 *
 * Every cookie the app sets is strictly necessary to a session the patient
 * asked for, so there was never a lawful requirement to gate on them — and
 * measurement of live ad traffic showed roughly nine in ten arrivals leaving
 * at that sheet before seeing anything about the product. Re-introducing it,
 * or letting a stray render of the old modal survive a refactor, would silently
 * restore that loss.
 *
 * This spec therefore asserts the negative: a genuinely first-time browser
 * reaches the welcome content, unobstructed, with nothing to dismiss.
 */

// A browser that has never been here. The suite no longer seeds any consent
// state, but stating it makes the intent explicit rather than incidental.
test.use({ storageState: { cookies: [], origins: [] } });

const CONSENT_TEST_IDS = [
  "cookie-consent-modal",
  "cookie-consent-sheet",
  "cookie-consent-accept-all",
  "cookie-consent-decline",
  "cookie-consent-declined",
] as const;

async function gotoWelcome(page: Page) {
  const response = await page.goto("/welcome", { waitUntil: "domcontentloaded" });
  expect(response?.status(), "welcome should be served").toBeLessThan(400);
}

test.describe("no cookie gate", () => {
  test("a first-time visitor lands straight on the welcome content", async ({
    page,
  }) => {
    await gotoWelcome(page);

    // The product, not a privacy sheet, is the first thing rendered.
    await expect(page.getByTestId("welcome-get-started")).toBeVisible();
    await expect(page.getByText("Understand")).toBeVisible();
  });

  test("presents nothing to accept, decline, or dismiss", async ({ page }) => {
    await gotoWelcome(page);
    await expect(page.getByTestId("welcome-get-started")).toBeVisible();

    for (const testId of CONSENT_TEST_IDS) {
      await expect(
        page.getByTestId(testId),
        `${testId} must not render — the consent gate was removed`,
      ).toHaveCount(0);
    }
  });

  test("the CTA is reachable without dismissing anything first", async ({
    page,
  }) => {
    await gotoWelcome(page);

    // No dismissal step: if a modal were overlaying the page this click would
    // hit it instead, and the navigation below would never happen.
    await page.getByTestId("welcome-get-started").click();

    await expect(page).toHaveURL(/register/);
  });

  test("writes no consent cookie, because nothing asks for consent", async ({
    page,
  }) => {
    await gotoWelcome(page);
    await expect(page.getByTestId("welcome-get-started")).toBeVisible();

    const cookies = await page.context().cookies();
    expect(
      cookies.map((cookie) => cookie.name),
      "the obsolete consent cookie must not come back",
    ).not.toContain("spine_patient_cookie_consent");
  });
});
