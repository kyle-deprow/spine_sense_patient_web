import { expect, test, type Page, type Response } from "@playwright/test";

const CANARY_EMAIL =
  process.env.PATIENT_WEB_PROD_CANARY_EMAIL ??
  "prod-canary-patient@spinesense.ai";
const CANARY_PASSWORD = process.env.PATIENT_WEB_PROD_CANARY_PASSWORD;
const TARGET_EMAIL =
  process.env.PATIENT_WEB_PROD_REPORT_TARGET_EMAIL ?? "etelemi@spinesense.ai";
const CANARY_ASSESSMENT_ID =
  process.env.PATIENT_WEB_PROD_CANARY_ASSESSMENT_ID ??
  "00000000-0000-4000-8a04-000000000001";

function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s)]+/g, "[origin]")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      "[uuid]",
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[email]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(
      /\b(authorization|x-csrf-token|csrf-token)\b\s*[:=]\s*[^;\n\r]+/gi,
      "$1=[redacted]",
    )
    .replace(/"download_url"\s*:\s*"[^"]+"/gi, '"download_url":"[redacted]"')
    .replace(/"downloadUrl"\s*:\s*"[^"]+"/gi, '"downloadUrl":"[redacted]"')
    .slice(0, 800);
}

async function waitForBrowserNetworkReady(page: Page, timeout = 45_000) {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          if (!navigator.onLine) return false;
          try {
            const response = await fetch("/api/health", { cache: "no-store" });
            return response.ok;
          } catch {
            return false;
          }
        }),
      {
        message: "browser context should reach the BFF",
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
  const response = await page.goto(path, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  expect(response?.ok()).toBeTruthy();
  await waitForBrowserNetworkReady(page);
  await expect(page.getByTestId(screenTestId)).toBeVisible({ timeout: 45_000 });
  return response;
}

async function loginCanary(page: Page) {
  await page.request.get("/api/auth/session");
  await gotoHydratedRoute(page, "/login", "login-screen");

  const loginResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/login") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("login-email-input").fill(CANARY_EMAIL);
  await page
    .getByTestId("login-password-input")
    .fill(requireEnv(CANARY_PASSWORD, "PATIENT_WEB_PROD_CANARY_PASSWORD"));
  await page.getByTestId("login-submit").click();

  const response = await loginResponse;
  if (!response.ok()) {
    throw new Error(`canary login failed status=${response.status()}`);
  }
  await expect(page.getByTestId("home-screen")).toBeVisible({
    timeout: 90_000,
  });
}

async function openCanaryResults(page: Page) {
  await gotoHydratedRoute(page, "/assessment", "results-screen");
  await expect(page.getByTestId("results-diagnosis")).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByTestId("share-result-send-button")).toBeVisible({
    timeout: 45_000,
  });
}

function waitForProxyPost(
  page: Page,
  predicate: (url: string) => boolean,
  label: string,
): Promise<Response> {
  return page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" && predicate(response.url()),
      { timeout: 120_000 },
    )
    .then(async (response) => {
      if (!response.ok()) {
        let body = "";
        try {
          body = await response.text();
        } catch {
          body = "[unavailable]";
        }
        throw new Error(
          `${label} failed status=${response.status()} body=${sanitizeDiagnostic(body)}`,
        );
      }
      return response;
    });
}

async function openSendReportSheet(page: Page) {
  await page.getByTestId("share-result-send-button").scrollIntoViewIfNeeded();
  await page.getByTestId("share-result-send-button").click();
  await expect(page.getByTestId("results-send-report")).toBeVisible({
    timeout: 45_000,
  });
  await expect(page.getByTestId("results-send-report-send")).toBeVisible({
    timeout: 45_000,
  });
}

test.describe("@prod-report-email durable canary report email", () => {
  test("queues self-email and third-party report-share from the production canary UI", async ({
    page,
  }) => {
    await loginCanary(page);
    await openCanaryResults(page);

    await openSendReportSheet(page);
    await page.getByTestId("results-send-report-self-ack").click();
    const selfReportResponse = waitForProxyPost(
      page,
      (url) =>
        url.includes(
          `/api/proxy/api/v1/patients/me/assessments/${CANARY_ASSESSMENT_ID}/reports`,
        ),
      "self report generation",
    );
    const emailSelfResponse = waitForProxyPost(
      page,
      (url) =>
        /\/api\/proxy\/api\/v1\/patients\/me\/reports\/[^/]+\/email-self$/u.test(
          new URL(url).pathname,
        ),
      "self email",
    );
    await page.getByTestId("results-send-report-send").click();
    expect((await selfReportResponse).status()).toBe(201);
    expect((await emailSelfResponse).status()).toBe(202);
    await expect(page.getByTestId("results-send-report-success")).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("results-send-report-error")).toBeHidden();
    await page.getByTestId("results-send-report-done").click();
    await expect(page.getByTestId("results-send-report")).toBeHidden({
      timeout: 45_000,
    });

    await openSendReportSheet(page);
    await page
      .getByTestId("results-send-report-destination-third-party")
      .click();
    await expect(
      page.getByTestId("results-send-report-third-party-panel"),
    ).toBeVisible();
    await page
      .getByTestId("results-send-report-recipient-input")
      .fill(TARGET_EMAIL);
    await page.getByTestId("results-send-report-third-party-ack").click();
    const thirdPartyReportResponse = waitForProxyPost(
      page,
      (url) =>
        url.includes(
          `/api/proxy/api/v1/patients/me/assessments/${CANARY_ASSESSMENT_ID}/reports`,
        ),
      "third-party report generation",
    );
    const shareResponse = waitForProxyPost(
      page,
      (url) => new URL(url).pathname === "/api/proxy/api/v1/shares",
      "third-party report share",
    );
    await page.getByTestId("results-send-report-send").click();
    expect((await thirdPartyReportResponse).status()).toBe(201);
    expect((await shareResponse).status()).toBe(201);
    await expect(page.getByTestId("results-send-report-success")).toBeVisible({
      timeout: 120_000,
    });
    await expect(page.getByTestId("results-send-report-error")).toBeHidden();
  });
});
