import fs from "node:fs";
import path from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { patientClinicalScenario } from "./fixtures/patientClinicalScenario";

const BACKEND_RESET_URL = process.env.PATIENT_WEB_BACKEND_RESET_URL;
const BACKEND_RESET_TOKEN = process.env.PATIENT_WEB_BACKEND_RESET_TOKEN;
const GATEWAY_RESET_URL = process.env.PATIENT_WEB_GATEWAY_RESET_URL;
const GATEWAY_RESET_TOKEN = process.env.PATIENT_WEB_GATEWAY_RESET_TOKEN;
const BACKEND_REGISTRATION_CODE_URL =
  process.env.PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL;
const TEST_SUPPORT_TOKEN = process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN;
const EXPECT_SECURE_COOKIES =
  process.env.PATIENT_WEB_EXPECT_SECURE_COOKIES === "true";
const SIGNUP_PASSWORD =
  process.env.PATIENT_E2E_SIGNUP_PASSWORD ?? "E2eSignup123!!";
const INCLUDE_VOICE_TRANSCRIPTION =
  process.env.PATIENT_WEB_INCLUDE_VOICE_TRANSCRIPTION === "true";
const AUDIO_FIXTURE =
  process.env.PATIENT_WEB_E2E_AUDIO_FILE ??
  path.resolve(__dirname, "fixtures/synthetic-voice.wav");
const LIVE_TRANSCRIPTION_WS_ORIGIN =
  process.env.PATIENT_WEB_LIVE_TRANSCRIPTION_WS_ORIGIN ?? null;

type BrowserCookie = {
  name: string;
  httpOnly: boolean;
  path: string;
  sameSite: "Lax" | "None" | "Strict";
  secure: boolean;
};

type CapturedRequest = {
  method: string;
  path: string;
  isBulkUpload: boolean;
};

type TrafficCapture = {
  requests: CapturedRequest[];
  websocketPaths: string[];
};

type LiveTranscriptionSession = {
  session_id: string;
  websocket_path: string;
  token: string;
  expires_in_seconds: number;
};

async function resetBackend(request: APIRequestContext) {
  if (!BACKEND_RESET_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_RESET_URL is required so patient web E2E starts from seeded state",
    );
  }
  if (!BACKEND_RESET_TOKEN) {
    throw new Error(
      "PATIENT_WEB_BACKEND_RESET_TOKEN is required so patient web E2E starts from seeded state",
    );
  }

  if (GATEWAY_RESET_URL) {
    if (!GATEWAY_RESET_TOKEN) {
      throw new Error(
        "PATIENT_WEB_GATEWAY_RESET_TOKEN is required when PATIENT_WEB_GATEWAY_RESET_URL is set",
      );
    }
    const gatewayResponse = await request.post(GATEWAY_RESET_URL, {
      headers: { authorization: `Bearer ${GATEWAY_RESET_TOKEN}` },
    });
    expect(
      gatewayResponse.ok(),
      `PATIENT_WEB_GATEWAY_RESET_URL must clear gateway E2E state status=${gatewayResponse.status()}`,
    ).toBeTruthy();
  }

  const response = await request.post(BACKEND_RESET_URL, {
    headers: { authorization: `Bearer ${BACKEND_RESET_TOKEN}` },
  });
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

async function expectNoTokenLeak(responseText: string) {
  expect(responseText.includes("access_token")).toBe(false);
  expect(responseText.includes("refresh_token")).toBe(false);
  expect(responseText.includes("accessToken")).toBe(false);
  expect(responseText.includes("refreshToken")).toBe(false);
}

function uniqueSyntheticEmail(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `patient-web-voice-${unique}@e2e.example.com`;
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

async function acceptConsentIfPresent(page: Page) {
  const consentVisible = await page
    .getByTestId("consent-screen")
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (!consentVisible) return;

  await clickIfPresent(page, "consent-checkbox-pa-cons-privacy", 5_000);
  await page.waitForTimeout(250);
  await clickIfPresent(page, "consent-checkbox-pa-cons-educational", 5_000);
  await page.waitForTimeout(250);
  await clickIfPresent(page, "consent-checkbox-pa-cons-ai-analysis", 5_000);
  await page.waitForTimeout(250);

  const accept = page.getByTestId("consent-accept");
  await expect(accept).toBeEnabled({ timeout: 30_000 });
  await accept.click();
}

async function registerAndAuthenticateSyntheticPatient(
  page: Page,
  request: APIRequestContext,
) {
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
  await page.getByTestId("register-last-name").fill("Voice");
  await page.getByTestId("register-email").fill(email);
  await page.getByTestId("register-password").fill(SIGNUP_PASSWORD);
  await page.getByTestId("register-confirm-password").fill(SIGNUP_PASSWORD);
  await clickIfPresent(page, "register-consent-storage");
  await expect(page.getByTestId("register-submit")).toBeEnabled();
  await page.getByTestId("register-submit").click();

  const registerResponse = await registerResponsePromise;
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
  const verifyResponsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/verify/registration") &&
      response.request().method() === "POST",
  );
  await page.getByTestId("verify-otp-digit-0").fill(code);
  await expect(page.getByTestId("verify-submit")).toBeEnabled();
  await page.getByTestId("verify-submit").click();

  const response = await verifyResponsePromise;
  expect(response.ok()).toBeTruthy();
  await expectNoTokenLeak(await response.text());

  await expect(page.getByTestId("consent-screen")).toBeVisible({
    timeout: 60_000,
  });
  await acceptConsentIfPresent(page);

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
}

function captureTranscriptionTraffic(page: Page): TrafficCapture {
  const traffic: TrafficCapture = { requests: [], websocketPaths: [] };
  page.on("request", (request) => {
    const url = new URL(request.url());
    traffic.requests.push({
      method: request.method(),
      path: url.pathname,
      isBulkUpload: isBulkUploadRequest(request.method(), url),
    });
  });
  page.on("websocket", (websocket) => {
    traffic.websocketPaths.push(new URL(websocket.url()).pathname);
  });
  return traffic;
}

function hasRequest(
  traffic: TrafficCapture,
  method: string,
  pathPattern: RegExp,
): boolean {
  return traffic.requests.some(
    (request) => request.method === method && pathPattern.test(request.path),
  );
}

function isBulkUploadRequest(method: string, url: URL): boolean {
  if (method !== "PUT") return false;
  if (url.pathname.startsWith("/api/")) return false;
  return (
    /(^|\.)blob\.core\.windows\.net$/i.test(url.hostname) ||
    /(^|\.)blob\.storage\.azure\.net$/i.test(url.hostname) ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "localhost" ||
    url.searchParams.has("X-Amz-Signature") ||
    url.searchParams.has("sv")
  );
}

function expectNoBulkUpload(traffic: TrafficCapture) {
  expect(
    traffic.requests.filter((request) => request.isBulkUpload),
    "live transcription must stream audio instead of uploading a retained audio object",
  ).toHaveLength(0);
}

async function requestIntakeLiveTranscriptionSession(
  page: Page,
): Promise<LiveTranscriptionSession> {
  return page.evaluate(async () => {
    const csrfCookie = document.cookie
      .split(";")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("spine_patient_csrf="))
      ?.slice("spine_patient_csrf=".length);

    if (!csrfCookie) {
      throw new Error("missing_csrf");
    }

    const response = await fetch(
      "/api/proxy/api/v1/patients/me/intake/story/live-transcription-session",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": decodeURIComponent(csrfCookie),
        },
        body: JSON.stringify({ content_type: "audio/wav" }),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `live transcription session failed status=${response.status} body=${text.slice(0, 160)}`,
      );
    }
    return JSON.parse(text) as LiveTranscriptionSession;
  });
}

async function streamFixtureToLiveTranscription(
  page: Page,
  session: LiveTranscriptionSession,
  audioBytes: number[],
) {
  await page.evaluate(
    async ({ session: liveSession, audioBytes: wavBytes, wsOrigin }) => {
      if (!liveSession.websocket_path.startsWith("/ws/")) {
        throw new Error(
          "Live transcription WebSocket path must be same-origin /ws.",
        );
      }

      const url = new URL(
        liveSession.websocket_path,
        wsOrigin ?? window.location.origin,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("token", liveSession.token);

      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url.toString());
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error("live transcription websocket timed out"));
        }, 30_000);

        socket.binaryType = "arraybuffer";
        socket.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("live transcription websocket failed"));
        };
        socket.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          try {
            const parsed = JSON.parse(event.data) as { type?: unknown };
            if (parsed.type === "error") {
              window.clearTimeout(timeout);
              reject(new Error("live transcription websocket returned error"));
            }
            if (parsed.type === "done") {
              window.clearTimeout(timeout);
              resolve();
              socket.close();
            }
          } catch {
            // Ignore non-contract messages.
          }
        };
        socket.onopen = () => {
          const bytes = new Uint8Array(wavBytes);
          const chunkSize = 16_000;
          for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            socket.send(bytes.slice(offset, offset + chunkSize));
          }
          socket.send(JSON.stringify({ type: "finish" }));
        };
      });
    },
    { session, audioBytes, wsOrigin: LIVE_TRANSCRIPTION_WS_ORIGIN },
  );
}

async function openMiScribeSetup(page: Page) {
  await page.goto("/home/miscribe/new?visitLocationState=IL");
  await expect(page.getByTestId("miscribe-new")).toBeVisible({
    timeout: 60_000,
  });
}

async function completeMiScribeSetup(page: Page) {
  await page
    .getByTestId("miscribe-new-provider-name")
    .fill("Synthetic Provider");
  await page.getByTestId("miscribe-new-provider-type-physician").click();
  await page.getByTestId("miscribe-new-reason-follow_up").click();
  await expect(page.getByTestId("miscribe-new-consent")).toBeVisible();
  await expect(page.getByTestId("miscribe-new-consent-checkbox")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId("miscribe-new-consent-checkbox").click();
  await expect(page.getByTestId("miscribe-new-start")).toBeEnabled({
    timeout: 30_000,
  });
  await page.getByTestId("miscribe-new-start").click();
  await expect(page.getByTestId("miscribe-record-screen")).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByTestId("ready-state")).toBeVisible({
    timeout: 60_000,
  });
}

test.describe("patient web voice transcription contracts @voice-transcription", () => {
  test.skip(
    !INCLUDE_VOICE_TRANSCRIPTION,
    "Set PATIENT_WEB_INCLUDE_VOICE_TRANSCRIPTION=true to run PHI-capable voice transcription E2E.",
  );

  test.beforeEach(async ({ page, request }) => {
    test.skip(
      !fs.existsSync(AUDIO_FIXTURE),
      `Missing audio fixture: ${AUDIO_FIXTURE}`,
    );
    installPhiSafeDiagnostics(page);
    await resetBackend(request);
  });

  test("streams the intake story audio fixture over the live transcription service", async ({
    page,
    request,
  }) => {
    await registerAndAuthenticateSyntheticPatient(page, request);
    const traffic = captureTranscriptionTraffic(page);
    const session = await requestIntakeLiveTranscriptionSession(page);
    expect(session.session_id).toBeTruthy();
    expect(session.websocket_path).toMatch(/^\/ws\//);
    expect(session.expires_in_seconds).toBeGreaterThan(0);

    await streamFixtureToLiveTranscription(
      page,
      session,
      Array.from(fs.readFileSync(AUDIO_FIXTURE)),
    );

    expect(
      hasRequest(
        traffic,
        "POST",
        /\/api\/proxy\/api\/v1\/patients\/me\/intake\/story\/live-transcription-session$/,
      ),
    ).toBe(true);
    expect(
      traffic.websocketPaths.some((path) =>
        /\/ws\/.*live-transcription/i.test(path),
      ),
    ).toBe(true);
    expectNoBulkUpload(traffic);
  });

  test("uploads MiScribe recording audio through the bulk transcription path", async ({
    page,
    request,
  }) => {
    await registerAndAuthenticateSyntheticPatient(page, request);
    const traffic = captureTranscriptionTraffic(page);
    await openMiScribeSetup(page);
    await completeMiScribeSetup(page);

    await page.getByTestId("record-mic").click();
    await expect(page.getByTestId("record-stop")).toBeVisible({
      timeout: 60_000,
    });
    await page.waitForTimeout(3_500);
    await page.getByTestId("record-stop").click();
    await expect(page.getByTestId("processing-state")).toBeVisible({
      timeout: 120_000,
    });

    await expect
      .poll(
        () =>
          hasRequest(
            traffic,
            "POST",
            /\/api\/proxy\/api\/v1\/patients\/me\/miscribe\/recordings\/[0-9a-f-]+\/upload-url$/,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(() => traffic.requests.some((request) => request.isBulkUpload), {
        timeout: 60_000,
      })
      .toBe(true);
    await expect
      .poll(
        () =>
          hasRequest(
            traffic,
            "POST",
            /\/api\/proxy\/api\/v1\/patients\/me\/miscribe\/recordings\/[0-9a-f-]+\/upload-complete$/,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);
    await expect
      .poll(
        () =>
          hasRequest(
            traffic,
            "POST",
            /\/api\/proxy\/api\/v1\/patients\/me\/miscribe\/recordings\/[0-9a-f-]+\/process$/,
          ),
        { timeout: 60_000 },
      )
      .toBe(true);

    expect(
      traffic.requests.some((request) =>
        /\/story\/live-transcription-session$/.test(request.path),
      ),
      "MiScribe must remain on bulk upload, not story live transcription",
    ).toBe(false);
  });
});
