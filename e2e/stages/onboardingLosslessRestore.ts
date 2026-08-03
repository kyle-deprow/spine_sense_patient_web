import {
  expect,
  type Page,
  type Response as PlaywrightResponse,
} from "@playwright/test";

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
// Mirrors INTAKE_DRAFT_DEBOUNCE_MS in app/(auth)/onboarding/[step].tsx.
const INTAKE_DRAFT_DEBOUNCE_MS = 2_000;
const KEEPALIVE_WINDOW_SAFETY_MS = 300;
const MIN_KEEPALIVE_WINDOW_MS = 500;
const LATEST_INTAKE_PROGRESS_PATH =
  "/api/proxy/api/v1/patients/me/intake/progress/latest";
const TREATMENT_HISTORY_SECTIONS = [
  "conditions",
  "surgery",
  "bone",
  "trauma",
  "meds",
] as const;

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
  options: {
    timeoutMs?: number;
    matches?: (response: PlaywrightResponse) => boolean;
  } = {},
): Promise<PlaywrightResponse> {
  const responsePromise = page.waitForResponse(
    (response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "PUT" &&
        url.pathname.endsWith(pathnameSuffix) &&
        (options.matches == null || options.matches(response))
      );
    },
    { timeout: options.timeoutMs ?? DRAFT_FLUSH_TIMEOUT_MS },
  );
  // Promise.all attaches a rejection handler to the response waiter before
  // the action can finish, so a missed response is reported as this assertion
  // failure rather than an unhandled rejection during the next interaction.
  const [response] = await Promise.all([responsePromise, action()]);
  expect(response.ok(), `BFF PUT ${pathnameSuffix} should succeed`).toBe(true);
  return response;
}

async function dispatchHiddenVisibilityChange(
  page: Page,
  backgroundPage: Page,
): Promise<void> {
  // screenProtection.web.ts subscribes directly to document.visibilitychange.
  // A second page therefore gives this test a real browser transition instead
  // of only exercising a synthetic event. Keep a short probe because headless
  // browser implementations do not all deliver cross-page visibility events.
  await page.evaluate(() => {
    const windowWithProbe = window as typeof window & {
      __onboardingObservedHidden?: Promise<boolean>;
    };
    windowWithProbe.__onboardingObservedHidden = new Promise<boolean>(
      (resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timeoutId);
          document.removeEventListener("visibilitychange", onVisibilityChange);
          resolve(value);
        };
        const onVisibilityChange = () => {
          if (document.visibilityState === "hidden") finish(true);
        };
        const timeoutId = window.setTimeout(() => finish(false), 750);
        document.addEventListener("visibilitychange", onVisibilityChange);
      },
    );
  });
  await backgroundPage.bringToFront();
  const observedHidden = await page.evaluate(async () => {
    const windowWithProbe = window as typeof window & {
      __onboardingObservedHidden?: Promise<boolean>;
    };
    const observedHidden =
      (await windowWithProbe.__onboardingObservedHidden) ?? false;
    delete windowWithProbe.__onboardingObservedHidden;
    return observedHidden;
  });

  if (!observedHidden) {
    // Fallback for engines that do not expose cross-page visibility state to
    // the first page. Restore the original descriptor before dispatching the
    // matching visible event so screen-protection-overlay cannot remain stuck.
    await page.bringToFront();
    await page.evaluate(() => {
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        document,
        "visibilityState",
      );
      try {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      } finally {
        if (originalDescriptor == null) {
          Reflect.deleteProperty(document, "visibilityState");
        } else {
          Object.defineProperty(
            document,
            "visibilityState",
            originalDescriptor,
          );
        }
        document.dispatchEvent(new Event("visibilitychange"));
      }
    });
  }

  await page.bringToFront();
  await expect(page.getByTestId("screen-protection-overlay")).toHaveCount(0, {
    timeout: 5_000,
  });
}

function stepDataFromLatestProgress(
  progress: Awaited<ReturnType<typeof tryBffJson>>,
): Record<string, unknown> | null {
  const stepData = progress?.stepData ?? progress?.step_data;
  return isRecord(stepData) ? stepData : null;
}

function treatmentHistoryFromLatestProgress(
  progress: Awaited<ReturnType<typeof tryBffJson>>,
): Record<string, unknown> | null {
  const stepData = stepDataFromLatestProgress(progress);
  const treatmentHistory = stepData?.["treatment-history"];
  return isRecord(treatmentHistory) ? treatmentHistory : null;
}

function hasAllTreatmentHistorySections(
  progress: Awaited<ReturnType<typeof tryBffJson>>,
): boolean {
  const treatmentHistory = treatmentHistoryFromLatestProgress(progress);
  return (
    treatmentHistory != null &&
    TREATMENT_HISTORY_SECTIONS.every((section) =>
      isRecord(treatmentHistory[section]),
    )
  );
}

async function expectTreatmentHistoryOnServer(
  context: JourneyContext,
): Promise<void> {
  let lastTransportError = "none observed";
  const pollMessage =
    "latest intake progress should contain all treatment-history draft sections";
  try {
    await expect
      .poll(
        async () => {
          try {
            return hasAllTreatmentHistorySections(
              await tryBffJson(context, LATEST_INTAKE_PROGRESS_PATH),
            );
          } catch (error) {
            lastTransportError =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            return false;
          }
        },
        { timeout: 60_000, message: pollMessage },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${pollMessage}; last transport error: ${lastTransportError}`,
      { cause: error },
    );
  }
}

async function expectStoryOnServer(
  context: JourneyContext,
  narrative: string,
): Promise<void> {
  let lastTransportError = "none observed";
  const pollMessage = "latest intake progress should contain the typed story";
  try {
    await expect
      .poll(
        async () => {
          try {
            const progress = await tryBffJson(
              context,
              LATEST_INTAKE_PROGRESS_PATH,
            );
            const stepData = stepDataFromLatestProgress(progress);
            const storyStep = stepData?.["chief-complaint"];
            const nestedNarrative = isRecord(storyStep)
              ? storyStep.narrative
              : undefined;
            const serverNarrative =
              progress?.storyNarrative ?? progress?.story_narrative;
            return (
              serverNarrative === narrative || nestedNarrative === narrative
            );
          } catch (error) {
            lastTransportError =
              error instanceof Error
                ? `${error.name}: ${error.message}`
                : String(error);
            return false;
          }
        },
        { timeout: 60_000, message: pollMessage },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${pollMessage}; last transport error: ${lastTransportError}`,
      { cause: error },
    );
  }
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
): Promise<number> {
  await completeProfileIfPresent(page);
  await expectChiefComplaintAfterProfileSave(page);
  await enterChiefComplaintText(page, narrative);
  const lastEditAt = Date.now();
  return lastEditAt;
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
  await expectTreatmentHistoryChoiceSelected(
    page,
    "medical-history-conditions-none",
    60_000,
  );
  for (const prefix of [
    "medical-history-surgery",
    "medical-history-bone",
    "medical-history-trauma",
    "medical-history-meds",
  ]) {
    await expectTreatmentHistoryChoiceSelected(page, prefix + "-no");
  }
  await expect(page.getByTestId("intake-draft-error")).toHaveCount(0);
}

async function expectTreatmentHistoryChoiceSelected(
  page: Page,
  testId: string,
  timeoutMs = 2_000,
): Promise<void> {
  const choice = page.getByTestId(testId);
  try {
    await expect(choice).toHaveAttribute("aria-checked", "true", {
      timeout: timeoutMs,
    });
  } catch {
    // Older controls used aria-pressed; retain this only as a compatibility
    // fallback after checking the current aria-checked contract.
    await expect(choice).toHaveAttribute("aria-pressed", "true", {
      timeout: timeoutMs,
    });
  }
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

    const response = await page.goto("/assessment", {
      waitUntil: "domcontentloaded",
    });
    expect(
      response?.ok(),
      `goto /assessment should succeed (status=${response?.status()})`,
    ).toBe(true);
    await expect(page).toHaveURL(/\/onboarding\/treatment-history$/);
    await expect(page.getByTestId("onboarding-layout")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("intake-step-treatment-history")).toBeVisible(
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("step-profile")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-resume-error")).toHaveCount(0);

    // Supplement the route-resume assertion with the original in-place reload
    // so the restored treatment-history step data is checked as well.
    await reloadOnboardingPage(page);
    await expect(page).toHaveURL(/\/onboarding\/treatment-history$/);
    await expect(page.getByTestId("intake-step-treatment-history")).toBeVisible(
      { timeout: 60_000 },
    );
    await expect(page.getByTestId("step-medical-history")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("onboarding-resume-error")).toHaveCount(0);
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
    // Prepare the second page before typing so creating it cannot itself flush
    // the dirty story before the keepalive response waiter is armed.
    const backgroundPage = await page.context().newPage();
    try {
      await backgroundPage.goto("about:blank", {
        waitUntil: "domcontentloaded",
      });
      await page.bringToFront();
      await expect(page.getByTestId("screen-protection-overlay")).toHaveCount(
        0,
      );

      const lastEditAt = await completeProfileAndEnterChiefComplaint(
        page,
        narrative,
      );

      // This waiter is armed immediately before the real hidden transition and
      // expires before the 2s trailing debounce. The raw keepalive transport
      // has no x-app-version header, while apiClient adds it to normal PUTs.
      const timeoutMs =
        INTAKE_DRAFT_DEBOUNCE_MS -
        (Date.now() - lastEditAt) -
        KEEPALIVE_WINDOW_SAFETY_MS;
      if (timeoutMs < MIN_KEEPALIVE_WINDOW_MS) {
        throw new Error(
          `Keepalive window collapsed to ${timeoutMs}ms; the debounce may already have flushed`,
        );
      }
      const keepaliveResponse = await waitForBffPut(
        page,
        "/intake/story",
        () => dispatchHiddenVisibilityChange(page, backgroundPage),
        {
          timeoutMs,
          matches: (response) =>
            response.request().headers()["x-app-version"] == null,
        },
      );
      expect(
        (await keepaliveResponse.request().allHeaders())["x-app-version"],
      ).toBeUndefined();
      await expectStoryOnServer(context, narrative);

      await reloadOnboardingPage(page);
      await assertRestoredChiefComplaint(page, narrative);
      maybeThrowForcedMidFlowFailure("onboarding-draft-restore");
      const normalStoryResponse = await waitForBffPut(
        page,
        "/intake/story",
        () => saveStoryAndReachTreatmentHistory(page),
        {
          matches: (response) =>
            response.request().headers()["x-app-version"] != null,
        },
      );
      expect(
        (await normalStoryResponse.request().allHeaders())["x-app-version"],
      ).toBeDefined();

      await fillTreatmentHistoryWithNoAnswers(page);
      await expectTreatmentHistoryOnServer(context);
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
    } finally {
      await backgroundPage.close().catch(() => {});
    }
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
    // Keep forced-failure tests before the intro end-state transition.
    maybeThrowForcedMidFlowFailure("onboarding-intro-idempotence");
    await continueWelcomeIntroIfPresent(page);
    await expect(page.getByTestId("onboarding-layout")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("step-profile")).toBeVisible({
      timeout: 60_000,
    });

    const response = await page.goto("/assessment", {
      waitUntil: "domcontentloaded",
    });
    expect(
      response?.ok(),
      `goto /assessment should succeed (status=${response?.status()})`,
    ).toBe(true);
    await expect(page).toHaveURL(/\/onboarding\/profile$/);
    await expect(page.getByTestId("welcome-intro-screen")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-layout")).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId("step-profile")).toBeVisible({
      timeout: 60_000,
    });

    const consents = await tryBffJson(
      context,
      "/api/proxy/api/v1/patients/me/consents",
    );
    const items = consents?.items;
    if (!Array.isArray(items)) {
      throw new Error("BFF consent ledger must contain items");
    }
    const total = consents?.total;
    const hasMore = consents?.has_more;
    if (typeof total !== "number" || typeof hasMore !== "boolean") {
      throw new Error(
        "BFF consent ledger must expose total and has_more pagination metadata",
      );
    }
    expect(total).toBe(items.length);
    expect(hasMore).toBe(false);
    const informationalGrants = items.filter(
      (item) =>
        isRecord(item) &&
        (item.consent_type ?? item.consentType) === "informational_only",
    );
    expect(informationalGrants).toHaveLength(1);
  });
}
