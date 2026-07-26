import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const BASE_URL = process.env.PATIENT_WEB_BASE_URL ?? "http://127.0.0.1:43101";
const RAW_PROVIDER_CODE = "synthetic-provider-code";
const EXPECTED_STATE = "synthetic-oauth-state";
const ATTACKER_STATE = "attacker-oauth-state";

const START_QUERY =
  "/api/fhir/start?endpointId=epic-shared-sandbox-r4" +
  "&permissionPolicyVersion=phase_1c_documents_labs.v1" +
  "&categories=Demographics" +
  "&categories=Diagnostic%20reports" +
  "&categories=Laboratory%20results" +
  "&purposeCode=patient_directed_record_import" +
  "&retentionNoticeVersion=fhir_retention.v1";

type BrowserCookie = {
  name: string;
  value: string;
};

function sanitizeBrowserDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s)]+/g, "[origin]")
    .replace(/\?[^)\]\s"']+/g, "?[query]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/\b(code|state)=([^&\s]+)/gi, "$1=[redacted]")
    .replace(/\b(cookie|set-cookie)\b\s*[:=]\s*[^\n\r]+/gi, "$1=[redacted]")
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

async function expectFhirOauthEnabled(page: Page) {
  const response = await page.request.get(START_QUERY, {
    headers: { Referer: `${BASE_URL}/profile/fhir` },
    maxRedirects: 0,
  });
  expect(
    response.status(),
    "FHIR OAuth BFF gate must be enabled; run through make patient-web-e2e-fhir-oauth",
  ).toBe(401);
  expect(
    response.headers()["cache-control"],
    "FHIR OAuth disabled/unauthorized responses must be no-store",
  ).toContain("no-store");
}

async function expectFhirCallbackRedirect(
  page: Page,
  path: string,
  expectedStatus: string,
) {
  const response = await page.request.get(path, { maxRedirects: 0 });
  expect(response.status()).toBe(307);
  expect(response.headers()["cache-control"]).toContain("no-store");
  const location = response.headers()["location"] ?? "";
  expect(location).toMatch(
    new RegExp(`/fhir/callback\\?fhirStatus=${expectedStatus}$`),
  );
  expect(location).not.toContain(RAW_PROVIDER_CODE);
  expect(location).not.toContain(EXPECTED_STATE);
  expect(location).not.toContain(ATTACKER_STATE);
}

async function addSyntheticCookie(
  context: BrowserContext,
  name: string,
  value: string,
  path: string,
) {
  await context.addCookies([
    {
      name,
      value,
      url: `${BASE_URL}${path}`,
      httpOnly: true,
      secure: BASE_URL.startsWith("https://"),
      sameSite: "Lax",
    },
  ]);
}

function hasCookie(cookies: BrowserCookie[], name: string): boolean {
  return cookies.some((cookie) => cookie.name === name);
}

test.describe("FHIR OAuth BFF browser boundary @fhir-oauth", () => {
  test.beforeEach(async ({ page }) => {
    installPhiSafeDiagnostics(page);
    await expectFhirOauthEnabled(page);
  });

  test("scrubs raw callback code and state when the patient session is absent", async ({
    page,
  }) => {
    await expectFhirCallbackRedirect(
      page,
      `/api/fhir/callback?code=${RAW_PROVIDER_CODE}&state=${EXPECTED_STATE}`,
      "failed",
    );

    const response = await page.goto(
      `/api/fhir/callback?code=${RAW_PROVIDER_CODE}&state=${EXPECTED_STATE}`,
      { waitUntil: "domcontentloaded" },
    );

    expect(response?.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/fhir\/callback\?fhirStatus=failed$/);
    expect(page.url()).not.toContain(RAW_PROVIDER_CODE);
    expect(page.url()).not.toContain(EXPECTED_STATE);
    await expect(page.getByTestId("fhir-callback-screen")).toBeVisible();
    await expectNoBrowserStorage(page);

    const browserVisibleCookies = await page.evaluate(() => document.cookie);
    expect(browserVisibleCookies).not.toContain("spine_patient_sess");
    expect(browserVisibleCookies).not.toContain("spine_fhir_oauth_state");
    expect(
      hasCookie(await page.context().cookies(), "spine_fhir_oauth_state"),
    ).toBe(false);
  });

  test("clears HttpOnly FHIR state on callback mismatch and scrubs browser state", async ({
    context,
    page,
  }) => {
    await addSyntheticCookie(
      context,
      "spine_patient_sess",
      "synthetic-session-cookie-value",
      "/api",
    );
    await addSyntheticCookie(
      context,
      "spine_fhir_oauth_state",
      EXPECTED_STATE,
      "/api/fhir",
    );

    const response = await page.goto(
      `/api/fhir/callback?code=${RAW_PROVIDER_CODE}&state=${ATTACKER_STATE}`,
      { waitUntil: "domcontentloaded" },
    );

    expect(response?.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/fhir\/callback\?fhirStatus=failed$/);
    expect(page.url()).not.toContain(RAW_PROVIDER_CODE);
    expect(page.url()).not.toContain(ATTACKER_STATE);
    await expect(page.getByTestId("fhir-callback-screen")).toBeVisible();
    await expectNoBrowserStorage(page);

    const cookies = await context.cookies();
    expect(hasCookie(cookies, "spine_patient_sess")).toBe(true);
    expect(hasCookie(cookies, "spine_fhir_oauth_state")).toBe(false);
    const browserVisibleCookies = await page.evaluate(() => document.cookie);
    expect(browserVisibleCookies).not.toContain(
      "synthetic-session-cookie-value",
    );
    expect(browserVisibleCookies).not.toContain(EXPECTED_STATE);
  });

  test("rejects cross-site start without issuing browser-visible FHIR state", async ({
    context,
    page,
  }) => {
    await addSyntheticCookie(
      context,
      "spine_patient_sess",
      "synthetic-session-cookie-value",
      "/api",
    );

    const response = await page.request.get(START_QUERY, {
      headers: { Referer: "https://evil.example.test/launch" },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(403);
    expect(response.headers()["cache-control"]).toContain("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "origin_forbidden",
    });
    expect(hasCookie(await context.cookies(), "spine_fhir_oauth_state")).toBe(
      false,
    );
  });
});
