import { expect, type Page } from "@playwright/test";

import { tryBffJson } from "../checkpoints";
import { isRecord, type JourneyContext } from "../journey/context";
import {
  clickByTestId,
  fillByTestId,
  waitForEnabledAndClick,
} from "../journey/selectors";
import {
  acceptConsentIfPresent,
  clickChiefComplaintSave,
  completeProfileIfPresent,
  continueWelcomeIntroIfPresent,
  expectChiefComplaintAfterProfileSave,
  expectImagingRecordsAfterHistorySave,
  expectTreatmentHistoryAfterStorySave,
  fillTreatmentHistoryWithNoAnswers,
} from "./consentOnboarding";
import { maybeThrowForcedMidFlowFailure } from "../support/forcedMidFlowFailure";

const DRAFT_FLUSH_TIMEOUT_MS = 30_000;
const DRAFT_DEBOUNCE_SETTLE_MS = 2_100;

async function reloadOnboardingPage(page: Page): Promise<void> {
  const response = await page.reload({
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  expect(response?.ok()).toBe(true);
}

async function waitForBffPut(
  page: Page,
  pathnameSuffix: string,
  action: () => Promise<void>,
): Promise<void> {
  const responsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "PUT" &&
        url.pathname.endsWith(pathnameSuffix)
      );
    },
    { timeout: DRAFT_FLUSH_TIMEOUT_MS },
  );
  await action();
  const response = await responsePromise;
  expect(response.ok(), `BFF PUT ${pathnameSuffix} should succeed`).toBe(true);
}

async function dispatchHiddenVisibilityChange(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    Reflect.deleteProperty(document, "visibilityState");
  });
}

async function enterChiefComplaintText(
  page: Page,
  narrative: string,
): Promise<void> {
  await clickByTestId(page, "chief-complaint-text-option");
  await expect(page.getByTestId("step-chief-complaint-text")).toBeVisible();
  await fillByTestId(page, "narrative-input", narrative);
  await page.getByTestId("narrative-input").blur();
}

async function completeProfileAndEnterChiefComplaint(
  page: Page,
  narrative: string,
): Promise<void> {
  await completeProfileIfPresent(page);
  await expectChiefComplaintAfterProfileSave(page);
  await enterChiefComplaintText(page, narrative);
}

async function saveStoryAndReachTreatmentHistory(page: Page): Promise<void> {
  await clickChiefComplaintSave(page);
  await expectTreatmentHistoryAfterStorySave(page);
}

async function finishTreatmentHistoryWithoutCompletingIntake(
  page: Page,
): Promise<void> {
  await fillTreatmentHistoryWithNoAnswers(page);
  await waitForEnabledAndClick(page, "medical-history-continue-btn");
  await expectImagingRecordsAfterHistorySave(page);
}

async function assertRestoredChiefComplaint(
  page: Page,
  narrative: string,
): Promise<void> {
  await expect(page.getByTestId("step-chief-complaint-text")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("narrative-input")).toHaveValue(narrative);
  await expect(page.getByTestId("intake-draft-error")).toHaveCount(0);
}

async function assertRestoredTreatmentHistory(page: Page): Promise<void> {
  await expect(page.getByTestId("step-medical-history")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("medical-history-conditions-none"))
    .toHaveAttribute("aria-pressed", "true")
    .catch(async () => {
      await expect(
        page.getByTestId("medical-history-conditions-none"),
      ).toHaveAttribute("aria-checked", "true");
    });
  await expect(page.getByTestId("intake-draft-error")).toHaveCount(0);
}

export async function runOnboardingResumeStage(
  context: JourneyContext,
): Promise<void> {
  const { page, scenario } = context;
  await context.step("onboarding resume", async () => {
    await completeProfileAndEnterChiefComplaint(
      page,
      scenario.onboarding.chiefComplaint,
    );
    await saveStoryAndReachTreatmentHistory(page);

    await reloadOnboardingPage(page);
    await expect(page.getByTestId("onboarding-layout")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("welcome-intro-screen")).toHaveCount(0);
    await expect(page.getByTestId("step-profile")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-resume-error")).toHaveCount(0);
    await expect(page.getByTestId("intake-step-treatment-history")).toBeVisible(
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("step-medical-history")).toBeVisible();
    maybeThrowForcedMidFlowFailure("onboarding-resume");

    await finishTreatmentHistoryWithoutCompletingIntake(page);
  });
}

export async function runOnboardingDraftRestoreStage(
  context: JourneyContext,
): Promise<void> {
  const { page, scenario } = context;
  const narrative = scenario.onboarding.chiefComplaint;

  await context.step("onboarding draft restore", async () => {
    await completeProfileAndEnterChiefComplaint(page, narrative);

    // Dispatch while the debounce is pending so the pagehide/visibility path
    // sends the story through the browser keepalive transport once. The wait
    // below also lets the ordinary ~2s debounce settle before reloading.
    await waitForBffPut(page, "/intake/story", async () => {
      await dispatchHiddenVisibilityChange(page);
    });
    await page.waitForTimeout(DRAFT_DEBOUNCE_SETTLE_MS);

    await reloadOnboardingPage(page);
    await assertRestoredChiefComplaint(page, narrative);
    maybeThrowForcedMidFlowFailure("onboarding-draft-restore");
    await saveStoryAndReachTreatmentHistory(page);

    await waitForBffPut(page, "/intake/steps/treatment-history/draft", () =>
      fillTreatmentHistoryWithNoAnswers(page),
    );
    await reloadOnboardingPage(page);
    await assertRestoredTreatmentHistory(page);

    await waitForEnabledAndClick(page, "medical-history-continue-btn");
    await expectImagingRecordsAfterHistorySave(page);

    await clickByTestId(page, "records-documents-paste-tab");
    await expect(page.getByTestId("records-paste-title")).toBeVisible();
    await waitForBffPut(
      page,
      "/intake/steps/imaging-records/draft",
      async () => {
        await fillByTestId(page, "records-paste-title", "Synthetic MRI note");
        await fillByTestId(
          page,
          "records-paste-text",
          "Synthetic pasted imaging findings retained across onboarding reload.",
        );
      },
    );
    await expect(page.getByTestId("intake-draft-error")).toHaveCount(0);

    // Toggling the paste panel closed keeps pasteDraft in the imaging step
    // data; it is intentionally not the cancel/clear action.
    await clickByTestId(page, "records-documents-paste-tab");
    await expect(page.getByTestId("records-paste-text")).toHaveCount(0);
    await reloadOnboardingPage(page);
    await expect(page.getByTestId("step-imaging-records")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("records-paste-title")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("records-paste-title")).toHaveValue(
      "Synthetic MRI note",
    );
    await expect(page.getByTestId("records-paste-text")).toHaveValue(
      "Synthetic pasted imaging findings retained across onboarding reload.",
    );
  });
}

export async function runOnboardingIntroIdempotenceStage(
  context: JourneyContext,
): Promise<void> {
  const { page } = context;
  await context.step("onboarding intro idempotence", async () => {
    await acceptConsentIfPresent(page);
    await expect(page.getByTestId("welcome-intro-screen")).toBeVisible({
      timeout: 60_000,
    });
    await continueWelcomeIntroIfPresent(page);
    await expect(page.getByTestId("onboarding-layout")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("step-profile")).toBeVisible({
      timeout: 60_000,
    });

    await reloadOnboardingPage(page);
    await expect(page.getByTestId("welcome-intro-screen")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-layout")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("step-profile")).toBeVisible({
      timeout: 60_000,
    });
    maybeThrowForcedMidFlowFailure("onboarding-intro-idempotence");

    const consents = await tryBffJson(
      context,
      "/api/proxy/api/v1/patients/me/consents/active",
    );
    const items = consents?.items;
    if (!Array.isArray(items)) {
      throw new Error("BFF active consent list must contain items");
    }
    const informationalGrants = items.filter(
      (item) =>
        isRecord(item) &&
        (item.consent_type ?? item.consentType) === "informational_only",
    );
    expect(informationalGrants).toHaveLength(1);
  });
}
