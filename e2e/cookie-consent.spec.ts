import { expect, test, type Page } from "@playwright/test";

import { COOKIE_CONSENT_COOKIE } from "./fixtures/cookieConsent";

/**
 * The one spec that meets the cookie gate the way a first-time patient does.
 *
 * Every other spec is seeded past it by the Playwright config, so without this
 * the gate itself would ship untested on the real deployed bundle — which is
 * exactly the class of "renders fine, does nothing" bug this repo keeps
 * finding.
 */

// A browser that has never been here. Overrides the accepted-consent state the
// config seeds for every other spec.
test.use({ storageState: { cookies: [], origins: [] } });

async function consentCookie(page: Page) {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name === COOKIE_CONSENT_COOKIE);
}

async function gotoWelcome(page: Page) {
  const response = await page.goto("/welcome", { waitUntil: "domcontentloaded" });
  expect(response?.status(), "welcome should be served").toBeLessThan(400);
}

test.describe("cookie consent gate", () => {
  test("blocks a first visit and records the choice in a cookie", async ({
    page,
  }) => {
    await gotoWelcome(page);

    await expect(page.getByTestId("cookie-consent-sheet")).toBeVisible();
    expect(
      await consentCookie(page),
      "nothing should be recorded before the patient chooses",
    ).toBeUndefined();

    // Essential is not presented as a choice — there is no switch to turn off.
    await expect(page.getByTestId("cookie-consent-required-badge")).toBeVisible();
    await expect(page.getByTestId("cookie-consent-toggle-essential")).toHaveCount(0);

    // The real cookie names are disclosed on request, not buried in a policy.
    await page.getByTestId("cookie-consent-expand-essential").click();
    await expect(page.getByTestId("cookie-consent-details-essential")).toBeVisible();
    await expect(page.getByText(/spine_patient_sess ·/)).toBeVisible();

    await page.getByTestId("cookie-consent-accept-all").click();

    await expect(page.getByTestId("cookie-consent-sheet")).toBeHidden();
    const recorded = await consentCookie(page);
    expect(recorded?.value).toContain("essential");
    expect(recorded?.path).toBe("/");

    // The choice survives a reload — the gate is not re-asked every visit.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("cookie-consent-sheet")).toBeHidden();
  });

  test("declining explains why and does not let the patient through", async ({
    page,
  }) => {
    await gotoWelcome(page);
    await expect(page.getByTestId("cookie-consent-sheet")).toBeVisible();

    await page.getByTestId("cookie-consent-decline").click();

    await expect(page.getByTestId("cookie-consent-declined")).toBeVisible();
    await expect(page.getByTestId("cookie-consent-declined-title")).toHaveText(
      "Essential cookies are required",
    );
    // Still gated, and still no record — a refusal is not a decision.
    await expect(page.getByTestId("cookie-consent-sheet")).toBeVisible();
    expect(await consentCookie(page)).toBeUndefined();

    await page.getByTestId("cookie-consent-declined-back").click();
    await expect(page.getByTestId("cookie-consent-accept-all")).toBeVisible();
  });

  test("stores the choice without touching durable browser storage", async ({
    page,
  }) => {
    await gotoWelcome(page);
    await page.getByTestId("cookie-consent-accept-all").click();
    await expect(page.getByTestId("cookie-consent-sheet")).toBeHidden();

    const storage = await page.evaluate(async () => {
      const databases =
        typeof indexedDB.databases === "function" ? await indexedDB.databases() : [];
      return {
        localStorageLength: localStorage.length,
        sessionStorageLength: sessionStorage.length,
        indexedDbDatabases: databases.map((db) => db.name).filter(Boolean),
      };
    });

    expect(storage).toEqual({
      localStorageLength: 0,
      sessionStorageLength: 0,
      indexedDbDatabases: [],
    });
  });
});
