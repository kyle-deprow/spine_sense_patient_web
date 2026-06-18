import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { patientClinicalScenario } from "./fixtures/patientClinicalScenario";

const PATIENT_EMAIL = patientClinicalScenario.patient.email;
const PATIENT_PASSWORD = patientClinicalScenario.patient.password;
const BACKEND_RESET_URL = process.env.PATIENT_WEB_BACKEND_RESET_URL;
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

async function resetBackend(request: APIRequestContext) {
  if (!BACKEND_RESET_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_RESET_URL is required so patient web E2E starts from seeded state",
    );
  }

  const response = await request.post(BACKEND_RESET_URL);
  const responseText = await response.text();
  expect(
    response.ok(),
    [
      `PATIENT_WEB_BACKEND_RESET_URL must reset and seed ${patientClinicalScenario.seedKey}`,
      `status=${response.status()}`,
      `body=${sanitizeBrowserDiagnostic(responseText)}`,
    ].join(" "),
  ).toBeTruthy();
}

function sanitizeBrowserDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s)]+/g, "[origin]")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      "[uuid]",
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .slice(0, 800);
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
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    console.log(
      `[response:${response.status()}] ${sanitizeBrowserDiagnostic(url.pathname)}`,
    );
  });
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

async function clickIfPresent(page: Page, testId: string, timeout = 1000): Promise<boolean> {
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

async function expectSeededClinicalDashboard(page: Page) {
  const {
    clinicalSummaryHeadline,
    clinicalSummarySubheadline,
    activeProblemCondition,
    activeProblemLevels,
    activeProblemSummary,
  } = patientClinicalScenario.dashboardAssertions;

  const clinicalSummary = page.getByTestId("clinical-summary-card");
  await expect(
    clinicalSummary,
    `Missing seeded clinical summary card for ${patientClinicalScenario.seedKey}`,
  ).toBeVisible();
  await expect(
    clinicalSummary.getByText(clinicalSummaryHeadline),
    `Missing seeded clinical summary headline: ${clinicalSummaryHeadline}`,
  ).toBeVisible();
  await expect(
    clinicalSummary.getByText(clinicalSummarySubheadline),
    `Missing seeded clinical summary subheadline: ${clinicalSummarySubheadline}`,
  ).toBeVisible();

  const activeProblems = page.getByTestId("active-problems-card");
  await expect(
    activeProblems,
    `Missing seeded active problems card for ${patientClinicalScenario.seedKey}`,
  ).toBeVisible();
  await expect(
    activeProblems.getByTestId("symptom-summary-text"),
    `Missing seeded active problem summary: ${activeProblemSummary}`,
  ).toContainText(activeProblemSummary);
  await expect(
    activeProblems.getByTestId("top-condition"),
    `Missing seeded active problem condition: ${activeProblemCondition}`,
  ).toContainText(activeProblemCondition);

  for (const level of activeProblemLevels) {
    await expect(
      activeProblems.getByTestId("top-condition-levels"),
      `Missing seeded active problem spinal level: ${level}`,
    ).toContainText(level);
  }
}

async function expectSeededClinicalResults(page: Page) {
  const {
    diagnosisLabel,
    spinalLevel,
    symptomNames,
    treatmentLabels,
    activityLabels,
  } = patientClinicalScenario.resultsAssertions;

  await expect(
    page.getByTestId("results-screen"),
    `Missing seeded results screen for ${patientClinicalScenario.seedKey}`,
  ).toBeVisible({ timeout: 60_000 });

  const diagnosis = page.getByTestId("results-diagnosis");
  await expect(
    diagnosis.getByText(diagnosisLabel),
    `Missing seeded results diagnosis label: ${diagnosisLabel}`,
  ).toBeVisible();
  await expect(
    diagnosis.getByText(spinalLevel),
    `Missing seeded results spinal level: ${spinalLevel}`,
  ).toBeVisible();

  const symptoms = page.getByTestId("results-symptoms");
  for (const symptomName of symptomNames) {
    await expect(
      symptoms.getByText(symptomName),
      `Missing seeded results symptom: ${symptomName}`,
    ).toBeVisible();
  }

  await page.getByTestId("results-tab-care").click();

  const treatment = page.getByTestId("results-treatment");
  for (const treatmentLabel of treatmentLabels) {
    await expect(
      treatment.getByText(treatmentLabel),
      `Missing seeded results treatment label: ${treatmentLabel}`,
    ).toBeVisible();
  }

  const activity = page.getByTestId("results-activity");
  for (const activityLabel of activityLabels) {
    await expect(
      activity.getByText(activityLabel),
      `Missing seeded results activity label: ${activityLabel}`,
    ).toBeVisible();
  }
}

async function loginAsSeededPatient(page: Page) {
  await page.request.get("/api/auth/session");
  await page.goto("/login");
  await expect(page.getByTestId("login-screen")).toBeVisible();

  const loginResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/login") &&
      response.request().method() === "POST",
  );

  await page.getByTestId("login-email-input").fill(PATIENT_EMAIL);
  await page.getByTestId("login-password-input").fill(PATIENT_PASSWORD);
  await page.getByTestId("login-submit").click();

  const response = await loginResponse;
  expect(response.ok()).toBeTruthy();
  const responseText = await response.text();
  expect(
    responseText.includes("access_token") ||
      responseText.includes("refresh_token"),
  ).toBe(false);

  await expect(page.getByTestId("home-screen")).toBeVisible({
    timeout: 60_000,
  });

  const browserVisibleCookies = await page.evaluate(() => document.cookie);
  expect(
    browserVisibleCookies.includes("spine_patient_sess") ||
      browserVisibleCookies.includes("spine_patient_refresh"),
  ).toBe(false);

  const cookies = await page.context().cookies();
  expect(
    cookieHasExpectedShape(cookies, "spine_patient_sess", {
      httpOnly: true,
      path: "/",
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
}

async function logoutViaBff(page: Page) {
  const status = await page.evaluate(async () => {
    const csrfCookie = document.cookie
      .split(";")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("spine_patient_csrf="))
      ?.slice("spine_patient_csrf=".length);

    if (!csrfCookie) return "missing_csrf";

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
  });

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

test.describe("patient app web deployment", () => {
  test.beforeEach(async ({ request }) => {
    await resetBackend(request);
  });

  test.beforeEach(async ({ page }) => {
    installPhiSafeDiagnostics(page);
  });

  test("serves the app shell with browser hardening headers", async ({
    page,
  }) => {
    const response = await page.goto("/login");
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
  }) => {
    const email = uniqueSyntheticEmail();

    await page.request.get("/api/auth/session");
    await page.goto("/register");
    await expect(page.getByTestId("register-screen")).toBeVisible();

    const registerResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/auth/register") &&
        response.request().method() === "POST",
    );
    await page.getByTestId("register-first-name").fill("Synthetic");
    await page.getByTestId("register-last-name").fill("Patient");
    await page.getByTestId("register-email").fill(email);
    await page.getByTestId("register-phone").fill("5551234567");
    await page.getByTestId("register-date-of-birth").fill("1990-01-15");
    await page.getByTestId("register-password").fill(SIGNUP_PASSWORD);
    await page.getByTestId("register-confirm-password").fill(SIGNUP_PASSWORD);
    await clickIfPresent(page, "register-consent-storage");
    await expect(page.getByTestId("register-submit")).toBeEnabled();
    await page.getByTestId("register-submit").click();

    const registerResponse = await registerResponsePromise;
    expect(registerResponse.ok()).toBeTruthy();
    await expectNoTokenLeak(await registerResponse.text());

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
  });

  test("renders seeded synthetic clinical dashboard and results without exposing tokens", async ({
    page,
  }) => {
    await loginAsSeededPatient(page);
    await expectNoBrowserStorage(page);

    await expectSeededClinicalDashboard(page);
    await page.getByTestId("clinical-summary-card").click();
    await expectSeededClinicalResults(page);

    await expectNoBrowserStorage(page);
    await logoutViaBff(page);
  });

  test("routes a seeded completed assessment to results without exposing tokens", async ({
    page,
  }) => {
    await loginAsSeededPatient(page);
    await expectNoBrowserStorage(page);

    await page.goto("/assessment");
    await expectSeededClinicalDashboard(page);
    await page.getByTestId("clinical-summary-card").click();
    await expectSeededClinicalResults(page);
    await expectNoBrowserStorage(page);
    await logoutViaBff(page);
  });
});
