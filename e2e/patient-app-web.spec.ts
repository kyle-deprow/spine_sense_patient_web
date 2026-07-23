import {
  expect,
  test,
  type APIRequestContext,
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

  const gatewayResponse = await request.post(GATEWAY_CLEANUP_URL, {
    headers: { authorization: `Bearer ${TEST_SUPPORT_TOKEN}` },
  });
  expect(
    gatewayResponse.ok(),
    `PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL must clear gateway E2E state status=${gatewayResponse.status()}`,
  ).toBeTruthy();

  const response = await request.post(BACKEND_CLEANUP_URL, {
    headers: { authorization: `Bearer ${TEST_SUPPORT_TOKEN}` },
  });
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
    if (status !== "fetch_failed") break;
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

async function submitVerificationAndWait(page: Page): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForBrowserNetworkReady(page);
      const verifyResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/auth/verify/registration") &&
          response.request().method() === "POST",
        { timeout: 45_000 },
      );
      await expect(page.getByTestId("verify-submit")).toBeEnabled({
        timeout: 30_000,
      });
      await page.getByTestId("verify-submit").click();
      return await verifyResponsePromise;
    } catch (error) {
      lastError = error;
      if (attempt === 3) break;
      await page.waitForTimeout(attempt * 1_000);
    }
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
      const registerResponseText = await registerResponse.text();
      expect(
        registerResponse.ok(),
        `registration failed status=${registerResponse.status()} body=${sanitizeBrowserDiagnostic(registerResponseText)}`,
      ).toBeTruthy();
      await expectNoTokenLeak(registerResponseText);

      await expect(page.getByTestId("verify-screen")).toBeVisible({
        timeout: 60_000,
      });
      expect(page.url()).not.toContain("verificationToken");
      const resendResponsePromise = page.waitForResponse(
        (response) =>
          response.url().includes("/api/auth/verify/registration/send") &&
          response.request().method() === "POST",
      );
      await page.getByTestId("verify-resend").click();
      const resendResponse = await resendResponsePromise;
      expect(resendResponse.ok()).toBeTruthy();
      await expectNoTokenLeak(await resendResponse.text());

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
      const registerResponseText = await registerResponse.text();
      expect(
        registerResponse.ok(),
        `registration failed status=${registerResponse.status()} body=${sanitizeBrowserDiagnostic(registerResponseText)}`,
      ).toBeTruthy();
      await expectNoTokenLeak(registerResponseText);
      await expect(page.getByTestId("verify-screen")).toBeVisible({
        timeout: 60_000,
      });

      const code = await getRegistrationVerificationCode(request, email);
      await page.getByTestId("verify-otp-digit-0").fill(code);

      const verifyResponse = await submitVerificationAndWait(page);
      expect(verifyResponse.ok()).toBeTruthy();
      await expectNoTokenLeak(await verifyResponse.text());
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
