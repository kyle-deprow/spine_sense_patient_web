import fs from "node:fs";
import path from "node:path";

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
  type TestInfo,
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
const SYNTHETIC_ONBOARDING_DOB = "1985-01-15";
const SYNTHETIC_RUN_NAMESPACE = (
  process.env.PATIENT_WEB_E2E_RUN_ID ?? "local"
)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 18);

type BrowserCookie = {
  name: string;
  value?: string;
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

type MiScribeRecordingPolicy = {
  policy_version: string;
  consent_text_version: string;
  requires_all_party_attestation: boolean;
};

type MiScribeRecording = {
  id: string;
};

type MiScribeUploadUrl = {
  upload_url: string;
  method: string;
  required_headers: Record<string, string>;
  content_type: string;
  max_bytes: number;
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

function syntheticEmailForTest(testInfo: TestInfo): string {
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `patient-web-voice-${SYNTHETIC_RUN_NAMESPACE}-${testInfo.parallelIndex}-${testInfo.retry}-${slug}@e2e.example.com`;
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
  await expect(accept).toBeHidden({ timeout: 60_000 });
}

async function csrfTokenForApiPath(page: Page, apiPath: string): Promise<string> {
  const url = new URL(apiPath, page.url()).toString();
  const cookies = await page.context().cookies(url);
  const csrfCookie = cookies
    .filter(
      (cookie) =>
        cookie.name === "spine_patient_csrf" &&
        apiPath.startsWith(cookie.path),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];

  if (!csrfCookie?.value) {
    throw new Error("missing_csrf");
  }
  return csrfCookie.value;
}

async function completeSyntheticOnboardingGate(page: Page) {
  const csrfToken = await csrfTokenForApiPath(
    page,
    "/api/proxy/api/v1/patients/me",
  );
  const session = await page.evaluate(
    async ({ csrfToken, dateOfBirth }) => {
      const updateResponse = await fetch("/api/proxy/api/v1/patients/me", {
        method: "PATCH",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({ date_of_birth: dateOfBirth }),
      });
      const updateText = await updateResponse.text();
      if (!updateResponse.ok) {
        throw new Error(
          `synthetic onboarding profile patch failed status=${updateResponse.status} body=${updateText.slice(0, 160)}`,
        );
      }

      const sessionResponse = await fetch("/api/auth/session", {
        credentials: "include",
      });
      const sessionText = await sessionResponse.text();
      if (!sessionResponse.ok) {
        throw new Error(
          `synthetic onboarding session refresh failed status=${sessionResponse.status} body=${sessionText.slice(0, 160)}`,
        );
      }

      return JSON.parse(sessionText) as { has_completed_onboarding?: unknown };
    },
    { csrfToken, dateOfBirth: SYNTHETIC_ONBOARDING_DOB },
  );

  expect(session.has_completed_onboarding).toBe(true);
  await page.goto("/", { waitUntil: "domcontentloaded" });
}

async function registerAndAuthenticateSyntheticPatient(
  page: Page,
  request: APIRequestContext,
  testInfo: TestInfo,
) {
  const email = syntheticEmailForTest(testInfo);
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
  await completeSyntheticOnboardingGate(page);

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

function recordTraffic(traffic: TrafficCapture, method: string, url: string) {
  const parsed = new URL(url);
  traffic.requests.push({
    method,
    path: parsed.pathname,
    isBulkUpload: isBulkUploadRequest(method, parsed),
  });
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
  const csrfToken = await csrfTokenForApiPath(
    page,
    "/api/proxy/api/v1/patients/me/intake/story/live-transcription-session",
  );
  return page.evaluate(async ({ csrfToken }) => {
    const response = await fetch(
      "/api/proxy/api/v1/patients/me/intake/story/live-transcription-session",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
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
  }, { csrfToken });
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

async function uploadMiScribeFixtureThroughBulkPath(
  page: Page,
  audioBytes: number[],
  traffic: TrafficCapture,
) {
  const proxyFetch = async <T>(
    path: string,
    options: { method: string; body?: object } = { method: "GET" },
  ): Promise<T> => {
    const url = new URL(path, page.url()).toString();
    const headers: Record<string, string> = {};
    if (options.method !== "GET" && options.method !== "HEAD") {
      headers.origin = new URL(page.url()).origin;
      headers.referer = page.url();
      headers["content-type"] = "application/json";
      headers["x-csrf-token"] = await csrfTokenForApiPath(page, path);
    }
    const response = await page.context().request.fetch(url, {
      method: options.method,
      headers,
      data: options.body,
    });
    recordTraffic(traffic, options.method, url);
    const text = await response.text();
    if (!response.ok()) {
      throw new Error(
        `MiScribe bulk request failed path=${path} status=${response.status()} body=${text.slice(0, 160)}`,
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  };

  const policy = await proxyFetch<MiScribeRecordingPolicy>(
    "/api/proxy/api/v1/patients/me/miscribe/recording-policy?visit_location_state=IL",
  );
  await proxyFetch<unknown>("/api/proxy/api/v1/patients/me/consents", {
    method: "POST",
    body: {
        consent_type: "miscribe_recording",
        consent_version: policy.consent_text_version,
        acknowledged_at: new Date().toISOString(),
      },
  });
  const recording = await proxyFetch<MiScribeRecording>(
    "/api/proxy/api/v1/patients/me/miscribe/recordings/setup",
    {
      method: "POST",
      body: {
          provider_name: "Synthetic Provider",
          provider_type: "physician",
          visit_reason: "follow_up",
          visit_reason_note: null,
          visit_location_state: "IL",
          all_parties_consent_attested:
            policy.requires_all_party_attestation,
          recording_consent_policy_version: policy.policy_version,
          recording_consent_text_version: policy.consent_text_version,
      },
    },
  );
  if (policy.requires_all_party_attestation) {
    await proxyFetch<MiScribeRecording>(
      `/api/proxy/api/v1/patients/me/miscribe/recordings/${recording.id}/all-party-attestation`,
      { method: "POST", body: {} },
    );
  }
  await proxyFetch<MiScribeRecording>(
    `/api/proxy/api/v1/patients/me/miscribe/recordings/${recording.id}/begin`,
    { method: "POST", body: {} },
  );

  const uploadGrant = await proxyFetch<MiScribeUploadUrl>(
    `/api/proxy/api/v1/patients/me/miscribe/recordings/${recording.id}/upload-url`,
    {
      method: "POST",
      body: { content_type: "audio/wav" },
    },
  );
  if (audioBytes.length > uploadGrant.max_bytes) {
    throw new Error("audio fixture exceeds MiScribe upload grant max_bytes");
  }

  const uploadResponse = await fetch(uploadGrant.upload_url, {
    method: uploadGrant.method || "PUT",
    headers: uploadGrant.required_headers,
    body: new Uint8Array(audioBytes),
  });
  recordTraffic(traffic, uploadGrant.method || "PUT", uploadGrant.upload_url);
  const uploadResponseText = await uploadResponse.text();
  if (!uploadResponse.ok) {
    throw new Error(
      `MiScribe bulk audio upload failed status=${uploadResponse.status} body=${uploadResponseText.slice(0, 160)}`,
    );
  }

  await proxyFetch<MiScribeRecording>(
    `/api/proxy/api/v1/patients/me/miscribe/recordings/${recording.id}/upload-complete`,
    {
      method: "POST",
      body: {
        duration_seconds: 3,
        content_type: uploadGrant.content_type || "audio/wav",
        size_bytes: audioBytes.length,
      },
    },
  );
  await proxyFetch<unknown>(
    `/api/proxy/api/v1/patients/me/miscribe/recordings/${recording.id}/process`,
    { method: "POST", body: {} },
  );

  return { recording_id: recording.id };
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

  test.afterEach(async ({ request }) => {
    await resetBackend(request);
  });

  test("streams the intake story audio fixture over the live transcription service", async ({
    page,
    request,
  }, testInfo) => {
    await registerAndAuthenticateSyntheticPatient(page, request, testInfo);
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
  }, testInfo) => {
    await registerAndAuthenticateSyntheticPatient(page, request, testInfo);
    const traffic = captureTranscriptionTraffic(page);
    const result = await uploadMiScribeFixtureThroughBulkPath(
      page,
      Array.from(fs.readFileSync(AUDIO_FIXTURE)),
      traffic,
    );
    expect(result.recording_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

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
