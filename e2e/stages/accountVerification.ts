import { expect, type Response as PlaywrightResponse } from "@playwright/test";
import type { JourneyContext } from "../journey/context";
import type { Page, Request as PlaywrightRequest } from "@playwright/test";
import {
  EXPECT_SECURE_COOKIES,
  TRANSITION_BUDGETS_MS,
  cookieHasExpectedShape,
  getRegistrationVerificationCode,
  hasCookie,
  expectNoBrowserStorage,
  expectNoTokenLeak,
  isRecord,
} from "../journey/context";
import {
  clickIfPresent,
  fillByTestId,
  waitForBrowserNetworkReady,
  waitForEnabledAndClick,
} from "../journey/selectors";
import {
  assertRecoveryAttempt,
  classifyRecovery,
} from "../support/recoveryPolicy";
import { maybeThrowForcedMidFlowFailure } from "../support/forcedMidFlowFailure";

export async function warmCsrfSession(page: Page) {
  const response = await page.request.get("/api/auth/session");
  expect([200, 401]).toContain(response.status());
  const cookies = await page.context().cookies();
  expect(hasCookie(cookies, "spine_patient_csrf")).toBe(true);
}

export async function gotoWelcome(page: Page) {
  const navigate = async () => {
    const response = await page.goto("/welcome", {
      waitUntil: "domcontentloaded",
      timeout: Math.min(45_000, TRANSITION_BUDGETS_MS.page),
    });
    if (response == null)
      throw new Error("Welcome navigation returned no response");
    if (!response.ok()) {
      const decision = classifyRecovery({ status: response.status() });
      if (!decision.retry) {
        throw new Error(
          `Welcome navigation failed status=${response.status()}`,
        );
      }
      assertRecoveryAttempt(decision, 1, 2);
      await waitForBrowserNetworkReady(page);
      const recovered = await page.goto("/welcome", {
        waitUntil: "domcontentloaded",
        timeout: Math.min(45_000, TRANSITION_BUDGETS_MS.page),
      });
      if (recovered == null || !recovered.ok()) {
        throw new Error(
          `Welcome navigation recovery failed status=${recovered?.status() ?? "none"}`,
        );
      }
    }
  };
  try {
    await navigate();
  } catch (error) {
    const decision = classifyRecovery({
      failureText: error instanceof Error ? error.message : String(error),
    });
    if (!decision.retry) throw error;
    assertRecoveryAttempt(decision, 1, 2);
    await waitForBrowserNetworkReady(page);
    await navigate();
  }
  // The screen container is the stable readiness contract. The start button
  // is intentionally also visible here, so combining both locators with
  // Locator.or() would create a strict-mode violation.
  await expect(page.getByTestId("welcome-screen")).toBeVisible({
    timeout: TRANSITION_BUDGETS_MS.page,
  });
}

export async function clickWelcomeGetStarted(page: Page) {
  if (await clickIfPresent(page, "welcome-get-started", 2000)) {
    return;
  }
  await page.getByRole("button", { name: /start my assessment/i }).click();
}

export async function expectAuthenticatedCookieSession(page: Page) {
  const browserVisibleCookies = await page.evaluate(() => document.cookie);
  expect(browserVisibleCookies.includes("spine_patient_sess")).toBe(false);
  expect(browserVisibleCookies.includes("spine_patient_refresh")).toBe(false);

  const cookies = await page.context().cookies();
  expect(
    cookieHasExpectedShape(cookies, "spine_patient_sess", {
      httpOnly: true,
      path: "/api",
      sameSite: "Lax",
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true);
  expect(
    cookieHasExpectedShape(cookies, "spine_patient_refresh", {
      httpOnly: true,
      path: "/api/auth/refresh",
      sameSite: "Strict",
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true);
  expect(
    cookieHasExpectedShape(cookies, "spine_patient_csrf", {
      httpOnly: false,
      path: "/",
      sameSite: "Strict",
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true);
  expect(hasCookie(cookies, "spine_patient_sess_iat")).toBe(true);
}

export async function expectConsentScreenAfterVerification(page: Page) {
  if (
    await page
      .getByTestId("consent-screen")
      .isVisible({ timeout: 60_000 })
      .catch(() => false)
  ) {
    return;
  }
  await expect(
    page.getByRole("heading", { name: /Privacy & Consent/i }),
  ).toBeVisible({
    timeout: 60_000,
  });
}

export async function fillVerificationCode(
  page: Page,
  verificationCode: string,
): Promise<void> {
  await fillByTestId(page, "verify-otp-digit-0", verificationCode);
}

export async function isPostVerificationState(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies();
  if (
    hasCookie(cookies, "spine_patient_sess") &&
    hasCookie(cookies, "spine_patient_refresh")
  ) {
    return true;
  }
  return (
    (await page
      .getByTestId("consent-screen")
      .isVisible({ timeout: 1000 })
      .catch(() => false)) ||
    (await page
      .getByTestId("onboarding-layout")
      .isVisible({ timeout: 1000 })
      .catch(() => false))
  );
}

export async function isPostVerificationStateImmediate(
  page: Page,
): Promise<boolean> {
  const cookies = await page.context().cookies();
  return (
    (hasCookie(cookies, "spine_patient_sess") &&
      hasCookie(cookies, "spine_patient_refresh")) ||
    (await page.getByTestId("consent-screen").isVisible()) ||
    (await page.getByTestId("onboarding-layout").isVisible())
  );
}

type VerificationRequestOutcome = {
  authenticated: boolean;
  responses: PlaywrightResponse[];
  failedRequests: PlaywrightRequest[];
};

export function isExactVerificationRequest(
  request: PlaywrightRequest,
  pathname: string,
  code?: string,
): boolean {
  if (
    new URL(request.url()).pathname !== pathname ||
    request.method() !== "POST"
  ) {
    return false;
  }
  if (code == null) return true;
  try {
    const payload = request.postDataJSON() as unknown;
    return (
      isRecord(payload) &&
      typeof payload.code === "string" &&
      payload.code === code
    );
  } catch {
    return false;
  }
}

export async function waitForVerificationAttemptToSettle(
  page: Page,
  timeout: number,
): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isPostVerificationStateImmediate(page)) return true;
    if (
      (await page.getByTestId("verify-error").isVisible()) &&
      (await page.getByTestId("verify-submit").isEnabled())
    ) {
      return false;
    }
  }
  throw new Error("Timed out waiting for verification attempt to settle");
}

export async function observeVerificationConfirmAttempt(
  page: Page,
  code: string,
): Promise<VerificationRequestOutcome> {
  const requests = new Set<PlaywrightRequest>();
  const responses: PlaywrightResponse[] = [];
  const failedRequests: PlaywrightRequest[] = [];
  const collectRequest = (request: PlaywrightRequest) => {
    if (
      isExactVerificationRequest(
        request,
        "/api/auth/verify/registration/confirm",
        code,
      )
    ) {
      requests.add(request);
    }
  };
  const collectResponse = (response: PlaywrightResponse) => {
    if (requests.has(response.request())) responses.push(response);
  };
  const collectFailure = (request: PlaywrightRequest) => {
    if (requests.has(request)) failedRequests.push(request);
  };

  page.on("request", collectRequest);
  page.on("response", collectResponse);
  page.on("requestfailed", collectFailure);
  try {
    await waitForEnabledAndClick(page, "verify-submit");
    const authenticated = await waitForVerificationAttemptToSettle(
      page,
      60_000,
    );
    return { authenticated, responses, failedRequests };
  } finally {
    page.off("request", collectRequest);
    page.off("response", collectResponse);
    page.off("requestfailed", collectFailure);
  }
}

export async function observeVerificationResendAttempt(
  page: Page,
): Promise<VerificationRequestOutcome & { resent: boolean }> {
  const requests = new Set<PlaywrightRequest>();
  const responses: PlaywrightResponse[] = [];
  const failedRequests: PlaywrightRequest[] = [];
  const collectRequest = (request: PlaywrightRequest) => {
    if (
      isExactVerificationRequest(request, "/api/auth/verify/registration/send")
    ) {
      requests.add(request);
    }
  };
  const collectResponse = (response: PlaywrightResponse) => {
    if (requests.has(response.request())) responses.push(response);
  };
  const collectFailure = (request: PlaywrightRequest) => {
    if (requests.has(request)) failedRequests.push(request);
  };

  page.on("request", collectRequest);
  page.on("response", collectResponse);
  page.on("requestfailed", collectFailure);
  try {
    await expect(page.getByTestId("verify-resend")).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByTestId("verify-resend").click();
    const outcome = await Promise.race([
      page
        .getByTestId("verify-resent")
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(() => "resent" as const),
      page
        .getByTestId("verify-error")
        .waitFor({ state: "visible", timeout: 60_000 })
        .then(() => "error" as const),
    ]);
    return {
      authenticated: false,
      resent: outcome === "resent",
      responses,
      failedRequests,
    };
  } finally {
    page.off("request", collectRequest);
    page.off("response", collectResponse);
    page.off("requestfailed", collectFailure);
  }
}

export async function assertVerificationResponsesDoNotLeakTokens(
  responses: readonly PlaywrightResponse[],
): Promise<void> {
  for (const response of responses) {
    const responseText = await response.text();
    expect(responseText.includes("access_token")).toBe(false);
    expect(responseText.includes("refresh_token")).toBe(false);
    expect(responseText.includes("mfa_token")).toBe(false);
  }
}

export async function requestFreshVerificationChallenge(
  page: Page,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await waitForBrowserNetworkReady(page, 15_000);
    await expect(page.getByTestId("verify-screen")).toBeVisible({
      timeout: 60_000,
    });
    const outcome = await observeVerificationResendAttempt(page);

    await assertVerificationResponsesDoNotLeakTokens(outcome.responses);
    const successfulResponse = outcome.responses.find((response) =>
      response.ok(),
    );
    if (outcome.resent && successfulResponse != null) return;

    const terminalResponse = outcome.responses.at(-1);
    const failureText = outcome.failedRequests.at(-1)?.failure()?.errorText;
    const recovery = classifyRecovery({
      ...(terminalResponse == null
        ? {}
        : { status: terminalResponse.status() }),
      ...(failureText == null ? {} : { failureText }),
    });
    if (!recovery.retry || attempt >= 2) {
      throw new Error(
        terminalResponse == null
          ? `verification resend failed without a response; failed_requests=${outcome.failedRequests.length}`
          : `verification resend failed status=${terminalResponse.status()}`,
      );
    }
    assertRecoveryAttempt(recovery, attempt, 2);
  }
  throw new Error("Verification resend recovery exhausted");
}

export async function submitVerificationWithTransientRetry(
  page: Page,
  getVerificationCode: () => Promise<string>,
): Promise<PlaywrightResponse | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (await isPostVerificationState(page)) return null;
    await expect(page.getByTestId("verify-screen")).toBeVisible({
      timeout: 60_000,
    });
    let outcome: VerificationRequestOutcome | undefined;
    try {
      const verificationCode = await getVerificationCode();
      await fillVerificationCode(page, verificationCode);
      outcome = await observeVerificationConfirmAttempt(page, verificationCode);
    } catch (error) {
      lastError = error;
      if (await isPostVerificationState(page)) return null;
      const recovery = classifyRecovery({
        failureText: error instanceof Error ? error.message : String(error),
      });
      if (!recovery.retry || attempt >= 3) throw error;
      assertRecoveryAttempt(recovery, attempt, 3);
      await waitForBrowserNetworkReady(page, 15_000);
      continue;
    }
    if (outcome != null) {
      await assertVerificationResponsesDoNotLeakTokens(outcome.responses);
      if (outcome.authenticated) return null;
      const successfulResponse = outcome.responses.find((response) =>
        response.ok(),
      );
      if (successfulResponse != null) return successfulResponse;

      const terminalResponse = outcome.responses.at(-1);
      if (terminalResponse == null) {
        lastError = new Error(
          `verification submit failed without a response; failed_requests=${outcome.failedRequests.length}`,
        );
        const failureText = outcome.failedRequests.at(-1)?.failure()?.errorText;
        const recovery = classifyRecovery({
          ...(failureText == null ? {} : { failureText }),
        });
        if (!recovery.retry) throw lastError;
        if (attempt >= 3) throw lastError;
        assertRecoveryAttempt(recovery, attempt, 3);
      } else {
        lastError = new Error(
          `verification submit failed status=${terminalResponse.status()}`,
        );
        const recovery = classifyRecovery({
          status: terminalResponse.status(),
        });
        if (!recovery.retry) {
          return terminalResponse;
        }
        if (attempt >= 3) throw lastError;
        assertRecoveryAttempt(recovery, attempt, 3);
      }
    }
    await waitForBrowserNetworkReady(page, 15_000);
    if (attempt < 3) await requestFreshVerificationChallenge(page);
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out submitting verification after transient retries");
}

export async function runAccountVerificationStage(
  context: JourneyContext,
): Promise<void> {
  const { page, profiler, scenario, email, request } = context;
  await context.step("account verification", async () => {
    await profiler.measure("session.csrf_warm", "stage", () =>
      warmCsrfSession(page),
    );
    await profiler.measure("launch.welcome", "page", () => gotoWelcome(page));
    await profiler.measure("welcome.to_registration", "page", async () => {
      await clickWelcomeGetStarted(page);
      await expect(page.getByTestId("register-screen")).toBeVisible({
        timeout: 30_000,
      });
    });
    const fillRegistrationForm = async () => {
      await fillByTestId(
        page,
        "register-first-name",
        scenario.registration.firstName,
      );
      await fillByTestId(
        page,
        "register-last-name",
        scenario.registration.lastName,
      );
      await fillByTestId(page, "register-email", email);
      await fillByTestId(
        page,
        "register-password",
        scenario.registration.password,
      );
      await fillByTestId(
        page,
        "register-confirm-password",
        scenario.registration.password,
      );
      await clickIfPresent(page, "register-consent-storage");
    };
    await fillRegistrationForm();
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/register") &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );
    await page.getByTestId("register-submit").click();
    const registrationResponse = await responsePromise;
    expect(registrationResponse.ok()).toBe(true);
    await expectNoTokenLeak(registrationResponse);
    await expect(page.getByTestId("verify-screen")).toBeVisible({
      timeout: 60_000,
    });
    await expectNoBrowserStorage(page);
    maybeThrowForcedMidFlowFailure("auth");
    const verifyResponse = await profiler.measure(
      "verification.to_authenticated_session",
      "page",
      () =>
        submitVerificationWithTransientRetry(page, () =>
          getRegistrationVerificationCode(request, email),
        ),
    );
    if (verifyResponse != null) await expectNoTokenLeak(verifyResponse);
    expect(page.url()).not.toContain("verification");
    await expectAuthenticatedCookieSession(page);
    await profiler.measure("authenticated_session.to_consent", "page", () =>
      expectConsentScreenAfterVerification(page),
    );
  });
}
