import {
  expect,
  type Page,
  type Request as PlaywrightRequest,
  type Response as PlaywrightResponse,
} from "@playwright/test";

import { fullAssessmentScenario } from "../fixtures/fullAssessmentScenario";
import {
  clickByTestId,
  clickIfPresent,
  fillByTestId,
  waitForAnyVisibleTestId,
  waitForBrowserNetworkReady,
  waitForEnabledAndClick,
} from "../journey/selectors";
import { logMilestone } from "../journey/context";
import {
  assertRecoveryAttempt,
  classifyRecovery,
} from "../support/recoveryPolicy";
import {
  decideProfileTransition,
  PROFILE_SUBMISSION_MAX_ATTEMPTS,
  type ProfileTransitionDecision,
} from "../../src/lib/e2e/profile-transition";
import type { JourneyContext } from "../journey/context";
import { maybeThrowForcedMidFlowFailure } from "../support/forcedMidFlowFailure";

export async function isConsentVisible(page: Page): Promise<boolean> {
  return (
    (await page
      .getByTestId("consent-screen")
      .isVisible({ timeout: 500 })
      .catch(() => false)) ||
    (await page
      .getByRole("heading", { name: /Privacy & Consent/i })
      .isVisible({ timeout: 500 })
      .catch(() => false))
  );
}

export async function waitForScreeningNavReady(page: Page) {
  const next = page.getByTestId("screening-nav-next");
  const gatewayResponses: number[] = [];
  const failedRequests: string[] = [];
  const observeResponse = (response: PlaywrightResponse) => {
    if (new URL(response.url()).pathname.includes("/screening/")) {
      gatewayResponses.push(response.status());
    }
  };
  const observeFailure = (request: PlaywrightRequest) => {
    if (new URL(request.url()).pathname.includes("/screening/")) {
      failedRequests.push(request.failure()?.errorText ?? "");
    }
  };
  page.on("response", observeResponse);
  page.on("requestfailed", observeFailure);
  try {
    if (await next.isVisible({ timeout: 10_000 }).catch(() => false)) return;

    const retry = page.getByRole("button", { name: /^retry$/i }).first();
    if (await retry.isVisible({ timeout: 1000 }).catch(() => false)) {
      const status = gatewayResponses.at(-1);
      const failureText = failedRequests.at(-1);
      const observation: { status?: number; failureText?: string } = {};
      if (status != null) observation.status = status;
      if (failureText != null) observation.failureText = failureText;
      const decision = classifyRecovery(observation);
      if (!status && !failureText) {
        throw new Error(
          "Screening retry UI appeared without network/gateway evidence",
        );
      }
      if (!decision.retry) {
        throw new Error(
          `Screening navigation failed without retryable transport evidence (${decision.reason})`,
        );
      }
      assertRecoveryAttempt(decision, 1, 2);
      await waitForBrowserNetworkReady(page);
      await retry.click({ timeout: 10_000 });
      await expect(next).toBeVisible({ timeout: 120_000 });
      return;
    }
    await waitForBrowserNetworkReady(page);
    await expect(next).toBeVisible({ timeout: 120_000 });
  } finally {
    page.off("response", observeResponse);
    page.off("requestfailed", observeFailure);
  }
}

export async function clickConsentAccept(
  page: Page,
): Promise<ReturnType<typeof classifyRecovery> | null> {
  const responses: PlaywrightResponse[] = [];
  const failures: PlaywrightRequest[] = [];
  const observeResponse = (response: PlaywrightResponse) => {
    if (new URL(response.url()).pathname.endsWith("/consents"))
      responses.push(response);
  };
  const observeFailure = (request: PlaywrightRequest) => {
    if (new URL(request.url()).pathname.endsWith("/consents"))
      failures.push(request);
  };
  page.on("response", observeResponse);
  page.on("requestfailed", observeFailure);
  try {
    if (
      await page
        .getByTestId("consent-accept")
        .isVisible({ timeout: 1000 })
        .catch(() => false)
    ) {
      await waitForEnabledAndClick(page, "consent-accept", 30_000, 1);
    } else {
      const accept = page.getByRole("button", { name: /Accept & Continue/i });
      await expect(accept).toBeEnabled({ timeout: 30_000 });
      await accept.click();
    }
    await expect
      .poll(() => responses.length + failures.length, {
        timeout: 30_000,
        message: "consent acceptance requests should settle",
      })
      .toBeGreaterThanOrEqual(3);
    const failedRequest = failures.at(-1);
    const failedResponse = responses.find((response) => !response.ok());
    if (failedRequest != null || failedResponse != null) {
      const observation: { status?: number; failureText?: string } = {};
      if (failedResponse != null) observation.status = failedResponse.status();
      const failureText = failedRequest?.failure()?.errorText;
      if (failureText != null) observation.failureText = failureText;
      return classifyRecovery(observation);
    }
    return null;
  } finally {
    page.off("response", observeResponse);
    page.off("requestfailed", observeFailure);
  }
}

export async function acceptConsentIfPresent(page: Page): Promise<boolean> {
  if (!(await isConsentVisible(page))) {
    return false;
  }

  const consentScroll = page.getByTestId("consent-flow-scroll");
  const initialScrollTop = await consentScroll.evaluate(
    (element) => element.scrollTop,
  );
  const firstConsent = page.getByTestId("consent-checkbox-pa-cons-privacy");
  if (await firstConsent.isVisible({ timeout: 1000 }).catch(() => false)) {
    await firstConsent.click();
  } else {
    await page
      .getByRole("checkbox", {
        name: /I agree to Privacy and Health Data Use/i,
      })
      .click();
  }
  await expect
    .poll(() => consentScroll.evaluate((element) => element.scrollTop), {
      message: "first consent should auto-scroll to the next required consent",
    })
    .toBeGreaterThan(initialScrollTop);

  const nextConsent = page.getByTestId("consent-checkbox-pa-cons-educational");
  await expect
    .poll(
      async () => {
        const [containerBox, consentBox] = await Promise.all([
          consentScroll.boundingBox(),
          nextConsent.boundingBox(),
        ]);
        if (containerBox == null || consentBox == null) return false;
        return (
          consentBox.y >= containerBox.y &&
          consentBox.y + consentBox.height <=
            containerBox.y + containerBox.height
        );
      },
      { message: "auto-scroll should reveal the next required consent" },
    )
    .toBe(true);

  if (!(await clickIfPresent(page, "consent-checkbox-pa-cons-educational"))) {
    await page
      .getByRole("checkbox", {
        name: /I understand SpineSense is educational use only/i,
      })
      .click();
  }
  if (!(await clickIfPresent(page, "consent-checkbox-pa-cons-ai-analysis"))) {
    await page
      .getByRole("checkbox", { name: /I authorize AI-assisted assessment/i })
      .click();
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitForBrowserNetworkReady(page);
    const decision = await clickConsentAccept(page);
    if (decision == null) {
      await expect
        .poll(() => isConsentVisible(page), {
          timeout: 30_000,
          message: "consent acceptance should leave the consent screen",
        })
        .toBe(false);
      return true;
    }
    if (!decision.retry || attempt >= 3) {
      throw new Error(
        `Consent acceptance failed without retryable transport evidence (${decision.reason})`,
      );
    }
    assertRecoveryAttempt(decision, attempt, 3);
    logMilestone(
      `consent transport recovery ${attempt}/3 (${decision.reason})`,
    );
  }

  throw new Error("Consent accept did not transition after retrying online.");
}

export async function waitForFirstVisibleEnabledAndClick(
  page: Page,
  testId: string,
  timeout = 30_000,
) {
  const locators = page.getByTestId(testId);
  await expect(locators.first()).toBeVisible({ timeout });

  const count = await locators.count();
  for (let index = 0; index < count; index += 1) {
    const locator = locators.nth(index);
    if (!(await locator.isVisible({ timeout: 1000 }).catch(() => false)))
      continue;
    await expect(locator).toBeEnabled({ timeout });
    await locator.scrollIntoViewIfNeeded();
    await locator.click();
    return;
  }

  throw new Error(`No visible enabled control found for ${testId}`);
}
export async function completeProfileIfPresent(page: Page) {
  if (
    !(await page
      .getByTestId("step-profile")
      .isVisible({ timeout: 1000 })
      .catch(() => false))
  ) {
    return;
  }

  const { onboarding } = fullAssessmentScenario;
  await fillByTestId(page, "profile-dob", onboarding.dateOfBirthDisplay);
  await clickByTestId(page, `profile-sex-${onboarding.sexAtBirth}`);
  await fillByTestId(page, "profile-height-ft", onboarding.heightFeet);
  await fillByTestId(page, "profile-height-in", onboarding.heightInches);
  await fillByTestId(page, "profile-weight", onboarding.weightPounds);
  await fillByTestId(page, "profile-occupation", onboarding.occupation);
  await clickByTestId(
    page,
    `profile-activity-${onboarding.activityLevel.toLowerCase().replace(/\s+/g, "-")}`,
  );
  for (
    let attempt = 1;
    attempt <= PROFILE_SUBMISSION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    await waitForBrowserNetworkReady(page);

    if (await isChiefComplaintStepVisible(page)) return;
    await expect(page.getByTestId("step-profile")).toBeVisible({
      timeout: 5_000,
    });
    await waitForEnabledAndClick(page, "profile-continue-btn");

    const readDecision = async (): Promise<ProfileTransitionDecision> => {
      const chiefComplaintVisible = await isChiefComplaintStepVisible(page);
      const profileVisible = await page
        .getByTestId("step-profile")
        .isVisible({ timeout: 500 })
        .catch(() => false);
      const continueEnabled = profileVisible
        ? await page
            .getByTestId("profile-continue-btn")
            .isEnabled({ timeout: 500 })
            .catch(() => false)
        : false;
      const errorText = profileVisible
        ? await page
            .getByTestId("intake-submit-error")
            .textContent({ timeout: 500 })
            .catch(() => null)
        : null;

      return decideProfileTransition(attempt, {
        chiefComplaintVisible,
        continueEnabled,
        errorText,
        profileVisible,
      });
    };

    await expect
      .poll(async () => (await readDecision()).status, {
        message:
          "profile submission should advance or settle into a bounded retryable state",
        timeout: 30_000,
      })
      .not.toBe("pending");

    const decision = await readDecision();
    if (decision.status === "complete") return;

    if (decision.status !== "retry") {
      throw new Error("Profile transition did not produce a terminal decision");
    }
    console.warn(
      `[full-assessment] Retrying profile transition after ${decision.reason}`,
    );
  }
}

export async function continueWelcomeIntroIfPresent(
  page: Page,
): Promise<boolean> {
  const stage = await waitForAnyVisibleTestId(
    page,
    ["welcome-intro-screen", "onboarding-layout"],
    10_000,
  ).catch(async () => {
    const welcomeCta = page.getByRole("button", { name: /let's begin/i });
    if (await welcomeCta.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return "welcome-intro-screen";
    }
    throw new Error(
      "Neither onboarding test IDs nor the visible welcome intro CTA became visible",
    );
  });
  if (stage !== "welcome-intro-screen") {
    return false;
  }

  const lockup = page.getByTestId("welcome-intro-lockup");
  const initialTransform = await lockup.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await expect
    .poll(
      () => lockup.evaluate((element) => getComputedStyle(element).transform),
      {
        message: "welcome lockup should animate into its docked position",
        timeout: 5_000,
      },
    )
    .not.toBe(initialTransform);

  const content = page.getByTestId("welcome-intro-content");
  await expect
    .poll(
      () =>
        content.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).opacity),
        ),
      {
        message: "welcome content should fade in after the logo animation",
        timeout: 6_000,
      },
    )
    .toBeGreaterThan(0.95);

  if (!(await clickIfPresent(page, "welcome-intro-begin"))) {
    await page.getByRole("button", { name: /let's begin/i }).click();
  }
  return true;
}

export async function expectTreatmentHistoryAfterStorySave(page: Page) {
  await expect(page.getByTestId("medical-history-conditions-none")).toBeVisible(
    { timeout: 60_000 },
  );
}

export async function isChiefComplaintStepVisible(
  page: Page,
): Promise<boolean> {
  return (
    (await page
      .getByTestId("step-chief-complaint-select")
      .isVisible({ timeout: 1000 })
      .catch(() => false)) ||
    (await page
      .getByTestId("chief-complaint-text-option")
      .isVisible({ timeout: 1000 })
      .catch(() => false)) ||
    (await page
      .getByText(/Tell us what's/i)
      .isVisible({ timeout: 1000 })
      .catch(() => false))
  );
}

export async function expectChiefComplaintAfterProfileSave(page: Page) {
  await expect
    .poll(() => isChiefComplaintStepVisible(page), {
      timeout: 60_000,
      message: "Expected chief complaint step after profile save",
    })
    .toBe(true);
}

export async function expectImagingRecordsAfterHistorySave(page: Page) {
  await expect
    .poll(
      async () =>
        (await page
          .getByTestId("records-continue-btn")
          .isVisible({ timeout: 1000 })
          .catch(() => false)) ||
        (await page
          .getByTestId("step-imaging-records")
          .isVisible({ timeout: 1000 })
          .catch(() => false)) ||
        (await page
          .getByRole("button", { name: /complete intake/i })
          .isVisible({ timeout: 1000 })
          .catch(() => false)) ||
        (await page
          .getByText(/Bring in your records/i)
          .isVisible({ timeout: 1000 })
          .catch(() => false)),
      {
        timeout: 60_000,
        message: "Expected imaging records step after treatment history save",
      },
    )
    .toBe(true);
}

export async function clickRecordsContinue(page: Page) {
  if (
    await page
      .getByTestId("records-continue-btn")
      .isVisible({ timeout: 1000 })
      .catch(() => false)
  ) {
    await waitForEnabledAndClick(page, "records-continue-btn");
    return;
  }

  const skip = page.getByRole("button", { name: /skip for now/i });
  if (await skip.isVisible({ timeout: 1000 }).catch(() => false)) {
    await expect(skip).toBeEnabled({ timeout: 30_000 });
    await skip.click({ timeout: 10_000 });
    return;
  }

  const complete = page.getByRole("button", { name: /complete intake/i });
  await expect(complete).toBeVisible({ timeout: 30_000 });
  await expect(complete).toBeEnabled({ timeout: 30_000 });
  await complete.click({ timeout: 10_000 });
}

export async function clickChiefComplaintSave(page: Page) {
  if (
    await page
      .getByTestId("text-save-btn")
      .isVisible({ timeout: 1000 })
      .catch(() => false)
  ) {
    await waitForEnabledAndClick(page, "text-save-btn");
    return;
  }

  const save = page.getByRole("button", { name: /save and continue/i });
  await expect(save).toBeVisible({ timeout: 30_000 });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click({ timeout: 10_000 });
}

export async function fillTreatmentHistoryWithNoAnswers(page: Page) {
  await clickByTestId(page, "medical-history-conditions-none");
  for (const prefix of [
    "medical-history-surgery",
    "medical-history-bone",
    "medical-history-trauma",
    "medical-history-meds",
  ]) {
    await clickByTestId(page, prefix + "-no");
    const choice = page.getByTestId(prefix + "-no");
    try {
      await expect(choice).toHaveAttribute("aria-checked", "true", {
        timeout: 2_000,
      });
    } catch {
      await expect(choice).toHaveAttribute("aria-pressed", "true", {
        timeout: 2_000,
      });
    }
  }
  await clickByTestId(page, "medical-history-nicotine-no");
}

export async function runConsentOnboardingStage(
  context: JourneyContext,
): Promise<void> {
  const { page, profiler, scenario } = context;
  await context.step("consent and onboarding", async () => {
    await profiler.measure("consent.to_onboarding", "page", async () => {
      await acceptConsentIfPresent(page);
      await continueWelcomeIntroIfPresent(page);
      await expect(page.getByTestId("onboarding-layout")).toBeVisible({
        timeout: 60_000,
      });
    });
    await profiler.measure(
      "onboarding.profile_to_chief_complaint",
      "page",
      async () => {
        await completeProfileIfPresent(page);
        await expectChiefComplaintAfterProfileSave(page);
      },
    );
    await clickByTestId(page, "chief-complaint-text-option");
    await expect(page.getByTestId("step-chief-complaint-text")).toBeVisible();
    await fillByTestId(
      page,
      "narrative-input",
      scenario.onboarding.chiefComplaint,
    );
    await page.getByTestId("narrative-input").blur();
    await profiler.measure(
      "onboarding.chief_complaint_to_history",
      "page",
      async () => {
        await clickChiefComplaintSave(page);
        await expectTreatmentHistoryAfterStorySave(page);
      },
    );
    await fillTreatmentHistoryWithNoAnswers(page);
    maybeThrowForcedMidFlowFailure("consent-onboarding");
    await profiler.measure(
      "onboarding.history_to_records",
      "page",
      async () => {
        await waitForEnabledAndClick(page, "medical-history-continue-btn");
        await expectImagingRecordsAfterHistorySave(page);
      },
    );
  });
}
