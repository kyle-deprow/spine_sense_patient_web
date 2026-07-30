import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
  type Response,
} from "@playwright/test";

const BACKEND_CLEANUP_URL = process.env.PATIENT_WEB_BACKEND_E2E_CLEANUP_URL;
const BACKEND_REGISTRATION_CODE_URL =
  process.env.PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL;
const TEST_SUPPORT_TOKEN = process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN;
const GATEWAY_CLEANUP_URL = process.env.PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL;
const EXPECT_SECURE_COOKIES =
  process.env.PATIENT_WEB_EXPECT_SECURE_COOKIES === "true";
const SIGNUP_PASSWORD =
  process.env.PATIENT_E2E_SIGNUP_PASSWORD ?? "E2eSignup123!!";

type BrowserCookie = {
  name: string;
  httpOnly: boolean;
  path: string;
  sameSite: "Lax" | "None" | "Strict";
  secure: boolean;
};

async function postCleanupWithRetry(
  request: APIRequestContext,
  url: string,
  label: string,
): Promise<APIResponse> {
  let response: APIResponse | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    response = await request.post(url, {
      headers: { authorization: `Bearer ${TEST_SUPPORT_TOKEN}` },
      timeout: 30_000,
    });
    if (response.ok() || ![502, 503, 504].includes(response.status())) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
  if (response == null) {
    throw new Error(`${label} cleanup did not return a response`);
  }
  return response;
}

async function cleanupE2eState(request: APIRequestContext) {
  if (!BACKEND_CLEANUP_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_E2E_CLEANUP_URL is required for tests that create synthetic E2E users",
    );
  }
  if (!GATEWAY_CLEANUP_URL) {
    throw new Error(
      "PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL is required for tests that create synthetic E2E users",
    );
  }
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for patient web E2E cleanup",
    );
  }

  const gatewayResponse = await postCleanupWithRetry(
    request,
    GATEWAY_CLEANUP_URL,
    "patient web gateway",
  );
  expect(
    gatewayResponse.ok(),
    `PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL must clear gateway E2E state status=${gatewayResponse.status()}`,
  ).toBeTruthy();

  const response = await postCleanupWithRetry(
    request,
    BACKEND_CLEANUP_URL,
    "backend synthetic",
  );
  const responseText = await response.text();
  expect(
    response.ok(),
    [
      "PATIENT_WEB_BACKEND_E2E_CLEANUP_URL must clean synthetic E2E state",
      `status=${response.status()}`,
      `body=${sanitizeBrowserDiagnostic(responseText)}`,
    ].join(" "),
  ).toBeTruthy();
}

function sanitizeBrowserDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s)]+/g, "[origin]")
    .replace(/\?[^)\]\s"']+/g, "?[query]")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      "[uuid]",
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/\b(cookie|set-cookie)\b\s*[:=]\s*[^\n\r]+/gi, "$1=[redacted]")
    .replace(
      /\b(authorization|x-csrf-token|csrf-token)\b\s*[:=]\s*[^;\n\r]+/gi,
      "$1=[redacted]",
    )
    .replace(/"(cookie|set-cookie)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/"(cookie|set-cookie)"\s*:\s*\[[^\]]*\]/gi, '"$1":["[redacted]"]')
    .replace(
      /"(authorization|x-csrf-token|csrf-token)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    )
    .replace(
      /\b(password|verification_code|verificationCode|mfa_code|mfaCode)\b\s*[:=]\s*[^,\s)]+/gi,
      "$1=[redacted]",
    )
    .replace(/"[^"]*token[^"]*"\s*:\s*"[^"]+"/gi, (match) =>
      match.replace(/:\s*"[^"]+"/, ':"[token]"'),
    )
    .replace(/"password"\s*:\s*"[^"]+"/gi, '"password":"[redacted]"')
    .replace(/"csrfToken"\s*:\s*"[^"]+"/gi, '"csrfToken":"[redacted]"')
    .replace(/"csrf_token"\s*:\s*"[^"]+"/gi, '"csrf_token":"[redacted]"')
    .slice(0, 800);
}

function sanitizeBrowserDiagnosticStack(error: Error): string | null {
  if (!error.stack) return null;
  const frames = error.stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("at "))
    .slice(0, 6)
    .map(sanitizeBrowserDiagnostic);
  if (frames.length === 0) return null;
  return [sanitizeBrowserDiagnostic(error.name || "Error"), ...frames].join(
    "\n",
  );
}

function installPhiSafeDiagnostics(page: Page) {
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    console.log(
      `[browser:${message.type()}] ${sanitizeBrowserDiagnostic(message.text())}`,
    );
  });
  page.on("pageerror", (error) => {
    console.log(`[pageerror] ${sanitizeBrowserDiagnostic(error.message)}`);
    const stack = sanitizeBrowserDiagnosticStack(error);
    if (stack) {
      console.log(`[pageerror-stack] ${stack}`);
    }
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    console.log(
      `[response:${response.status()}] ${sanitizeBrowserDiagnostic(url.pathname)}`,
    );
  });
}

async function waitForBrowserNetworkReady(page: Page, timeout = 30_000) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (!navigator.onLine) return false;
          try {
            const response = await fetch("/api/health", {
              cache: "no-store",
            });
            return response.ok;
          } catch {
            return false;
          }
        }),
      {
        message: "browser context should be online and able to reach the BFF",
        timeout,
      },
    )
    .toBe(true);
}

async function gotoHydratedRoute(
  page: Page,
  path: string,
  screenTestId: string,
): Promise<Response | null> {
  let lastResponse: Response | null = null;
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      lastResponse = await page.goto(path, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      expect(lastResponse?.ok()).toBeTruthy();
      await waitForBrowserNetworkReady(page);
      await expect(page.getByTestId(screenTestId)).toBeVisible({
        timeout: 30_000,
      });
      return lastResponse;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await page.waitForTimeout(2_000);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Route ${path} did not hydrate ${screenTestId}`);
}

function cookieHasExpectedShape(
  cookies: BrowserCookie[],
  name: string,
  expected: {
    httpOnly: boolean;
    path: string;
    sameSite: "Lax" | "Strict";
    secure: boolean;
  },
): boolean {
  const cookie = cookies.find((entry) => entry.name === name);
  return (
    cookie?.httpOnly === expected.httpOnly &&
    cookie.path === expected.path &&
    cookie.sameSite === expected.sameSite &&
    cookie.secure === expected.secure
  );
}

function hasCookie(cookies: BrowserCookie[], name: string): boolean {
  return cookies.some((entry) => entry.name === name);
}

async function expectNoTokenLeak(responseText: string) {
  expect(responseText.includes("access_token")).toBe(false);
  expect(responseText.includes("refresh_token")).toBe(false);
  expect(responseText.includes("accessToken")).toBe(false);
  expect(responseText.includes("refreshToken")).toBe(false);
}

function uniqueSyntheticEmail(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `patient-web-signup-${unique}@e2e.example.com`;
}

function isRetryableCsrfFailure(status: number, responseText: string): boolean {
  if (status !== 403) return false;
  try {
    const payload = JSON.parse(responseText) as unknown;
    if (
      payload == null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return false;
    }
    const error = (payload as Record<string, unknown>).error;
    return (
      typeof error === "string" &&
      ["csrf_missing", "csrf_mismatch", "csrf_invalid"].includes(error)
    );
  } catch {
    return false;
  }
}

async function getRegistrationVerificationCode(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  if (!BACKEND_REGISTRATION_CODE_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL is required to verify synthetic registration",
    );
  }
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for registration-code lookup",
    );
  }

  const response = await request.post(BACKEND_REGISTRATION_CODE_URL, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TEST_SUPPORT_TOKEN}`,
    },
    data: { email },
    timeout: 30_000,
  });
  expect(
    response.status(),
    `registration verification code lookup failed status=${response.status()}`,
  ).toBe(200);
  const payload = (await response.json()) as { code?: unknown };
  if (typeof payload.code !== "string") {
    throw new Error("registration verification code lookup returned no code");
  }
  return payload.code;
}

async function clickIfPresent(
  page: Page,
  testId: string,
  timeout = 1000,
): Promise<boolean> {
  const locator = page.getByTestId(testId);
  const visible = await locator.isVisible({ timeout }).catch(() => false);
  if (!visible) return false;
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  return true;
}

async function expectNoBrowserStorage(page: Page) {
  const storage = await page.evaluate(async () => {
    const indexedDbDatabases =
      typeof indexedDB.databases === "function"
        ? await indexedDB.databases()
        : [];

    return {
      localStorageLength: localStorage.length,
      sessionStorageLength: sessionStorage.length,
      indexedDbDatabases: indexedDbDatabases
        .map((db) => db.name)
        .filter(Boolean),
      serviceWorkerCount: navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0,
    };
  });

  expect(storage).toEqual({
    localStorageLength: 0,
    sessionStorageLength: 0,
    indexedDbDatabases: [],
    serviceWorkerCount: 0,
  });
}

async function hasAuthenticatedCookiePair(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies();
  return (
    hasCookie(cookies, "spine_patient_sess") &&
    hasCookie(cookies, "spine_patient_refresh")
  );
}

async function reconcileCommittedVerification(page: Page): Promise<boolean> {
  const committed = await expect
    .poll(
      async () =>
        (await page
          .getByTestId("consent-screen")
          .isVisible()
          .catch(() => false)) || (await hasAuthenticatedCookiePair(page)),
      {
        message:
          "verification outcome should expose consent or an authenticated cookie pair",
        timeout: 5_000,
      },
    )
    .toBe(true)
    .then(() => true)
    .catch(() => false);
  if (!committed) return false;

  if (
    !(await page
      .getByTestId("consent-screen")
      .isVisible()
      .catch(() => false))
  ) {
    await gotoHydratedRoute(page, "/consent", "consent-screen");
  }
  return true;
}

async function recoverCommittedVerificationByLogin(
  page: Page,
  email: string,
): Promise<boolean> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    if (await reconcileCommittedVerification(page)) return true;
    let retryable = true;
    try {
      await gotoHydratedRoute(page, "/login", "login-screen");
      await page.getByTestId("login-email-input").fill(email);
      await page.getByTestId("login-password-input").fill(SIGNUP_PASSWORD);

      const loginResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/auth/login") &&
          response.request().method() === "POST",
        { timeout: 45_000 },
      );
      await expect(page.getByTestId("login-submit")).toBeEnabled({
        timeout: 30_000,
      });
      await page.getByTestId("login-submit").click();
      const response = await loginResponsePromise;
      const responseText = await response.text();
      await expectNoTokenLeak(responseText);

      if (response.ok()) {
        await expect(page.getByTestId("consent-screen")).toBeVisible({
          timeout: 60_000,
        });
        return true;
      }
      if (response.status() !== 401) {
        retryable = false;
        throw new Error(
          `Verification recovery login failed status=${response.status()}`,
        );
      }
      return false;
    } catch (error) {
      lastError = error;
      if (!retryable) throw error;
      if (await reconcileCommittedVerification(page)) return true;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Verification recovery login did not produce a response");
}

async function restartPendingRegistration(
  page: Page,
  email: string,
): Promise<void> {
  await gotoHydratedRoute(page, "/register", "register-screen");
  await page.getByTestId("register-first-name").fill("Synthetic");
  await page.getByTestId("register-last-name").fill("Verified");
  await page.getByTestId("register-email").fill(email);
  await page.getByTestId("register-password").fill(SIGNUP_PASSWORD);
  await page.getByTestId("register-confirm-password").fill(SIGNUP_PASSWORD);
  await clickIfPresent(page, "register-consent-storage");

  const response = await submitRegistrationAndWait(page);
  await expectRegistrationAccepted(page, response);
  await expect(page.getByTestId("verify-screen")).toBeVisible({
    timeout: 60_000,
  });
}

async function submitVerificationResendAndWait(page: Page): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response | null = null;
    try {
      await waitForBrowserNetworkReady(page, 15_000);
      if (attempt > 1) {
        const reloadResponse = await page.reload({
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        expect(reloadResponse?.ok()).toBeTruthy();
        await waitForBrowserNetworkReady(page, 15_000);
        await expect(page.getByTestId("verify-screen")).toBeVisible({
          timeout: 30_000,
        });
      }

      await expect(page.getByTestId("verify-resend")).toBeEnabled({
        timeout: 30_000,
      });
      const responsePromise = page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname ===
            "/api/auth/verify/registration/send" &&
          candidate.request().method() === "POST",
        { timeout: 30_000 },
      );
      void responsePromise.catch(() => undefined);
      await page.getByTestId("verify-resend").click();
      response = await responsePromise;
    } catch (error) {
      lastError = error;
    }
    if (response == null) continue;

    const responseText = await response.text();
    await expectNoTokenLeak(responseText);
    if (response.ok()) return response;

    lastError = new Error(
      `Verification resend failed status=${response.status()}`,
    );
    if (
      ![502, 503, 504].includes(response.status()) &&
      !isRetryableCsrfFailure(response.status(), responseText)
    ) {
      throw lastError;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Verification resend did not produce a response");
}

async function logoutViaBff(page: Page) {
  let status: number | "missing_csrf" | "fetch_failed" = "fetch_failed";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitForBrowserNetworkReady(page);
    status = await page.evaluate(async () => {
      const csrfCookie = document.cookie
        .split(";")
        .map((entry) => entry.trim())
        .find((entry) => entry.startsWith("spine_patient_csrf="))
        ?.slice("spine_patient_csrf=".length);

      if (!csrfCookie) return "missing_csrf";

      try {
        const response = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "include",
          headers: {
            "content-type": "application/json",
            "x-csrf-token": decodeURIComponent(csrfCookie),
          },
          body: "{}",
        });
        return response.status;
      } catch {
        return "fetch_failed";
      }
    });
    if (
      status !== "fetch_failed" &&
      status !== 502 &&
      status !== 503 &&
      status !== 504
    )
      break;
    await page.waitForTimeout(attempt * 1_000);
  }

  const cookies = await page.context().cookies();
  if (status === "missing_csrf") {
    expect(hasCookie(cookies, "spine_patient_sess")).toBe(false);
    expect(hasCookie(cookies, "spine_patient_refresh")).toBe(false);
    expect(hasCookie(cookies, "spine_patient_csrf")).toBe(false);
    return;
  }

  expect(status).toBe(200);
  expect(hasCookie(cookies, "spine_patient_sess")).toBe(false);
  expect(hasCookie(cookies, "spine_patient_refresh")).toBe(false);
  expect(hasCookie(cookies, "spine_patient_csrf")).toBe(false);
}

async function submitRegistrationAndWait(page: Page): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForBrowserNetworkReady(page);
      const registerResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/auth/register") &&
          response.request().method() === "POST",
        { timeout: 45_000 },
      );
      await expect(page.getByTestId("register-submit")).toBeEnabled({
        timeout: 30_000,
      });
      await page.getByTestId("register-submit").click();
      return await registerResponsePromise;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await page.waitForTimeout(attempt * 1_000);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Registration submit did not produce a response");
}

async function expectRegistrationAccepted(
  page: Page,
  registerResponse: Response,
) {
  const registerResponseText = await registerResponse.text();
  if (registerResponse.ok()) {
    await expectNoTokenLeak(registerResponseText);
    return;
  }

  const verifyScreenVisible = await page
    .getByTestId("verify-screen")
    .isVisible({ timeout: 10_000 })
    .catch(() => false);
  if (
    registerResponse.status() === 409 &&
    /registration_conflict/.test(registerResponseText) &&
    /email/.test(registerResponseText) &&
    verifyScreenVisible
  ) {
    await expectNoTokenLeak(registerResponseText);
    return;
  }

  expect(
    registerResponse.ok(),
    `registration failed status=${registerResponse.status()} body=${sanitizeBrowserDiagnostic(registerResponseText)}`,
  ).toBeTruthy();
}

async function submitVerificationAndWait(
  page: Page,
  email: string,
  getVerificationCode: () => Promise<string>,
): Promise<Response | null> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    let response: Response | null = null;
    let recoverable = true;
    try {
      await waitForBrowserNetworkReady(page);
      const verificationCode = await getVerificationCode();
      for (let index = 0; index < 6; index += 1) {
        await page.getByTestId(`verify-otp-digit-${index}`).fill("");
      }
      await page.getByTestId("verify-otp-digit-0").fill(verificationCode);
      const verifyResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/auth/verify/registration/confirm") &&
          response.request().method() === "POST",
        { timeout: 45_000 },
      );
      await expect(page.getByTestId("verify-submit")).toBeEnabled({
        timeout: 30_000,
      });
      await page.getByTestId("verify-submit").click();
      response = await verifyResponsePromise;
      if (response.ok()) return response;
      await expectNoTokenLeak(await response.text());
      lastError = new Error(
        `Verification submit failed status=${response.status()}`,
      );
      if (![401, 403, 422, 502, 503, 504].includes(response.status())) {
        recoverable = false;
        throw lastError;
      }
    } catch (error) {
      lastError = error;
    }
    if (!recoverable) throw lastError;

    if (await reconcileCommittedVerification(page)) return null;
    if (await recoverCommittedVerificationByLogin(page, email)) return null;

    if (attempt === 3) break;
    await restartPendingRegistration(page, email);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Verification submit did not produce a response");
}

test.describe("patient app web deployment", () => {
  test.beforeEach(async ({ page }) => {
    installPhiSafeDiagnostics(page);
  });

  test("serves the app shell with browser hardening headers", async ({
    page,
  }) => {
    const response = await gotoHydratedRoute(page, "/login", "login-screen");
    expect(response?.ok()).toBeTruthy();
    expect(response?.headers()["cache-control"]).toContain("no-store");
    const csp = response?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self' 'nonce-");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).not.toContain("require-trusted-types-for 'script'");

    await expect(page.getByTestId("login-screen")).toBeVisible();
    await expectNoBrowserStorage(page);
  });

  test("registers a new patient through the BFF without exposing tokens", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await cleanupE2eState(request);
    const email = uniqueSyntheticEmail();

    try {
      await page.request.get("/api/auth/session");
      await gotoHydratedRoute(page, "/register", "register-screen");

      await page.getByTestId("register-first-name").fill("Synthetic");
      await page.getByTestId("register-last-name").fill("Patient");
      await page.getByTestId("register-email").fill(email);
      await page.getByTestId("register-password").fill(SIGNUP_PASSWORD);
      await page.getByTestId("register-confirm-password").fill(SIGNUP_PASSWORD);
      await clickIfPresent(page, "register-consent-storage");

      const registerResponse = await submitRegistrationAndWait(page);
      await expectRegistrationAccepted(page, registerResponse);

      await expect(page.getByTestId("verify-screen")).toBeVisible({
        timeout: 60_000,
      });
      expect(page.url()).not.toContain("verificationToken");
      const resendResponse = await submitVerificationResendAndWait(page);
      expect(resendResponse.ok()).toBeTruthy();

      const cookies = await page.context().cookies();
      expect(hasCookie(cookies, "spine_patient_sess")).toBe(false);
      expect(hasCookie(cookies, "spine_patient_refresh")).toBe(false);
      await expectNoBrowserStorage(page);
    } finally {
      await cleanupE2eState(request);
    }
  });

  test("requests a password reset through the BFF without exposing tokens", async ({
    page,
  }) => {
    await page.request.get("/api/auth/session");
    await gotoHydratedRoute(page, "/login", "login-screen");

    await page.getByTestId("login-forgot-password").click();
    await expect(page.getByTestId("reset-password-screen")).toBeVisible();

    const resetResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/auth/password/reset") &&
        response.request().method() === "POST",
    );
    await page.getByTestId("reset-email-input").fill(uniqueSyntheticEmail());
    await page.getByTestId("reset-submit").click();

    const resetResponse = await resetResponsePromise;
    expect(resetResponse.ok()).toBeTruthy();
    await expectNoTokenLeak(await resetResponse.text());
    await expect(page.getByTestId("reset-sent")).toBeVisible();
    await expectNoBrowserStorage(page);
  });

  test("verifies a synthetic patient and clears BFF cookies on logout", async ({
    page,
    request,
  }) => {
    await cleanupE2eState(request);
    const email = uniqueSyntheticEmail();

    try {
      await page.request.get("/api/auth/session");
      await gotoHydratedRoute(page, "/register", "register-screen");

      await page.getByTestId("register-first-name").fill("Synthetic");
      await page.getByTestId("register-last-name").fill("Verified");
      await page.getByTestId("register-email").fill(email);
      await page.getByTestId("register-password").fill(SIGNUP_PASSWORD);
      await page.getByTestId("register-confirm-password").fill(SIGNUP_PASSWORD);
      await clickIfPresent(page, "register-consent-storage");

      const registerResponse = await submitRegistrationAndWait(page);
      await expectRegistrationAccepted(page, registerResponse);
      await expect(page.getByTestId("verify-screen")).toBeVisible({
        timeout: 60_000,
      });

      const verifyResponse = await submitVerificationAndWait(page, email, () =>
        getRegistrationVerificationCode(request, email),
      );
      if (verifyResponse != null) {
        expect(verifyResponse.ok()).toBeTruthy();
        await expectNoTokenLeak(await verifyResponse.text());
      }
      await expect(page.getByTestId("consent-screen")).toBeVisible({
        timeout: 60_000,
      });

      const browserVisibleCookies = await page.evaluate(() => document.cookie);
      expect(browserVisibleCookies.includes("spine_patient_sess")).toBe(false);
      expect(browserVisibleCookies.includes("spine_patient_refresh")).toBe(
        false,
      );

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

      await logoutViaBff(page);
      await expectNoBrowserStorage(page);
    } finally {
      await cleanupE2eState(request);
    }
  });
});

const SEEDED_PATIENT_EMAIL =
  process.env.PATIENT_WEB_SEEDED_EMAIL ?? "patient@e2e.example.com";
const SEEDED_PATIENT_PASSWORD =
  process.env.PATIENT_WEB_SEEDED_PASSWORD ?? "E2eTest123!!";

/** Count object URLs the page creates and revokes, so a leaked handle is visible. */
async function installObjectUrlLedger(page: Page) {
  await page.addInitScript(() => {
    const ledger = { created: [] as string[], revoked: [] as string[] };
    (window as unknown as { __objectUrlLedger: typeof ledger }).__objectUrlLedger = ledger;
    const realCreate = URL.createObjectURL.bind(URL);
    const realRevoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = realCreate(obj as Blob);
      ledger.created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url: string) => {
      ledger.revoked.push(url);
      realRevoke(url);
    };
  });
}

async function readObjectUrlLedger(page: Page) {
  return page.evaluate(() => {
    const ledger = (
      window as unknown as { __objectUrlLedger?: { created: string[]; revoked: string[] } }
    ).__objectUrlLedger ?? { created: [], revoked: [] };
    return {
      outstanding: ledger.created.filter((url) => !ledger.revoked.includes(url)),
      createdCount: ledger.created.length,
    };
  });
}

async function loginSeededPatient(page: Page) {
  await page.request.get("/api/auth/session");
  await gotoHydratedRoute(page, "/login", "login-screen");

  const loginResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("login-email-input").fill(SEEDED_PATIENT_EMAIL);
  await page.getByTestId("login-password-input").fill(SEEDED_PATIENT_PASSWORD);
  await page.getByTestId("login-submit").click();

  const response = await loginResponse;
  expect(response.ok()).toBeTruthy();
  await expectNoTokenLeak(await response.text());
}

const SYNTHETIC_JPEG = Buffer.from(
  // Minimal JPEG header + EOI. Synthetic bytes only — never patient imagery.
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB" +
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEB/9k=",
  "base64",
);

test.describe("patient web document photo upload", () => {
  test.beforeEach(async ({ page }) => {
    installPhiSafeDiagnostics(page);
    await installObjectUrlLedger(page);
  });

  test("offers an image-only photo input and never a simulated camera", async ({
    page,
  }) => {
    const shell = await gotoHydratedRoute(page, "/login", "login-screen");
    // The BFF forbids camera access outright, so any UI promising an in-page
    // camera would be promising something the policy cannot deliver.
    expect(shell?.headers()["permissions-policy"]).toContain("camera=()");

    await loginSeededPatient(page);
    await gotoHydratedRoute(
      page,
      "/profile/documents/upload",
      "document-upload-screen",
    );

    const photoCard = page.getByTestId("document-upload-form-take-photo");
    await expect(photoCard).toBeVisible();

    const chooserPromise = page.waitForEvent("filechooser");
    await photoCard.click();
    const chooser = await chooserPromise;
    const input = chooser.element();

    // Image-only, and no `capture` — the browser decides whether it can offer a
    // camera; the app never forces or asserts one.
    const accept = await input.getAttribute("accept");
    expect(accept).toContain("image/jpeg");
    expect(accept).toContain("image/png");
    expect(accept).not.toContain("application/pdf");
    expect(await input.getAttribute("capture")).toBeNull();

    await chooser.setFiles([]);
  });

  test("uploads a photo through the BFF without leaking tokens, storage, or the patient filename", async ({
    page,
  }) => {
    await loginSeededPatient(page);
    const uploadScreen = await gotoHydratedRoute(
      page,
      "/profile/documents/upload",
      "document-upload-screen",
    );
    expect(uploadScreen?.headers()["cache-control"]).toContain("no-store");

    const requestUploadPromise = page.waitForResponse(
      (response) =>
        response.url().includes("/documents/upload-url") &&
        response.request().method() === "POST",
    );

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("document-upload-form-take-photo").click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      // A patient-chosen filename is itself potentially identifying.
      name: "jane-doe-lumbar-mri-2026.jpg",
      mimeType: "image/jpeg",
      buffer: SYNTHETIC_JPEG,
    });

    const requestUpload = await requestUploadPromise;
    expect(requestUpload.ok()).toBeTruthy();
    const sentBody = requestUpload.request().postData() ?? "";
    expect(sentBody).toContain("captured-document.jpg");
    expect(sentBody).not.toContain("jane-doe");
    expect(requestUpload.request().headers()["x-csrf-token"]).toBeTruthy();
    await expectNoTokenLeak(await requestUpload.text());

    await expectNoBrowserStorage(page);
    const cookies = await page.context().cookies();
    expect(hasCookie(cookies, "spine_patient_sess")).toBe(true);
    const browserVisibleCookies = await page.evaluate(() => document.cookie);
    expect(browserVisibleCookies.includes("spine_patient_sess")).toBe(false);
  });

  test("releases the photo handle when a selection is rejected", async ({
    page,
  }) => {
    await loginSeededPatient(page);
    await gotoHydratedRoute(
      page,
      "/profile/documents/upload",
      "document-upload-screen",
    );

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("document-upload-form-take-photo").click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: "referral-notes.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4 synthetic", "utf8"),
    });

    await expect(
      page.getByTestId("document-upload-form-file-error"),
    ).toContainText(/Photos must be JPG, PNG, or HEIC/);

    // A rejected selection must not leave image bytes reachable in the document.
    await expect
      .poll(async () => (await readObjectUrlLedger(page)).outstanding.length, {
        timeout: 10_000,
      })
      .toBe(0);
  });

  test("leaves no photo handle or browser storage behind once a selection is finished", async ({
    page,
  }) => {
    await loginSeededPatient(page);
    await gotoHydratedRoute(
      page,
      "/profile/documents/upload",
      "document-upload-screen",
    );

    const chooserPromise = page.waitForEvent("filechooser");
    await page.getByTestId("document-upload-form-take-photo").click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: "scan.jpg",
      mimeType: "image/jpeg",
      buffer: SYNTHETIC_JPEG,
    });

    // The upload path itself must release the handle; logout is the backstop,
    // not the thing being relied on.
    await expect
      .poll(async () => (await readObjectUrlLedger(page)).outstanding.length, {
        timeout: 15_000,
      })
      .toBe(0);
    const ledger = await readObjectUrlLedger(page);
    expect(ledger.createdCount).toBeGreaterThan(0);

    await logoutViaBff(page);
    await expectNoBrowserStorage(page);

    const cookies = await page.context().cookies();
    expect(hasCookie(cookies, "spine_patient_sess")).toBe(false);
    expect(hasCookie(cookies, "spine_patient_refresh")).toBe(false);
  });
});
