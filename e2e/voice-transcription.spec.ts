import fs from "node:fs";
import path from "node:path";

import {
  expect,
  test,
  type Page,
  type Response,
  type TestInfo,
} from "@playwright/test";

import { fullAssessmentScenario } from "./fixtures/fullAssessmentScenario";

const BACKEND_CLEANUP_URL = process.env.PATIENT_WEB_BACKEND_E2E_CLEANUP_URL;
const GATEWAY_CLEANUP_URL = process.env.PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL;
const BACKEND_REGISTRATION_CODE_URL =
  process.env.PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL;
const TEST_SUPPORT_TOKEN = process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN;
const EXPECT_SECURE_COOKIES =
  process.env.PATIENT_WEB_EXPECT_SECURE_COOKIES === "true";
const SIGNUP_PASSWORD =
  process.env.PATIENT_E2E_SIGNUP_PASSWORD ?? "E2eSignup123!!";
const AUDIO_FIXTURE = path.resolve(__dirname, "fixtures/synthetic-voice.wav");
const LIVE_TRANSCRIPTION_WS_ORIGIN =
  process.env.PATIENT_WEB_LIVE_TRANSCRIPTION_WS_ORIGIN ?? null;
const BULK_UPLOAD_MAX_ATTEMPTS = 3;
const TRANSIENT_UPLOAD_ERROR_CODES = new Set([
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TRANSIENT_UPLOAD_HTTP_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_SUPPORT_HTTP_STATUSES = new Set([
  404, 408, 429, 500, 502, 503, 504,
]);
const TRANSIENT_SUPPORT_HTTP_STATUSES_EXCEPT_NOT_FOUND = new Set([
  408, 429, 500, 502, 503, 504,
]);
const SYNTHETIC_RUN_NAMESPACE = (process.env.PATIENT_WEB_E2E_RUN_ID ?? "local")
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

type AssessmentRecord = {
  id: string;
  revision: number;
};

type ScreeningState = {
  visible_questions: Array<{ id?: unknown; question_id?: unknown }>;
  revision: number;
};

type IntakeStoryAudioUpload = {
  upload_id: string;
  upload_url: string;
  required_headers: Record<string, string>;
  content_type: string;
  max_bytes: number;
  expires_in_seconds: number;
};

type IntakeStoryTranscriptionResponse = {
  narrative: string;
  input_method: "voice";
};

type BulkTranscriptionResult = {
  upload_id: string;
  narrative: string;
  narrative_length: number;
};

type LiveTranscriptionResult = {
  partialTranscript: string;
  finalTranscript: string;
  chunksSent: number;
};

function expectSyntheticTranscript(transcript: string, pathName: string) {
  expect(
    /synthetic/i.test(transcript),
    `${pathName} must recognize the synthetic fixture marker`,
  ).toBe(true);
  expect(
    /transcription/i.test(transcript),
    `${pathName} must recognize the transcription fixture marker`,
  ).toBe(true);
}

function wavDurationSeconds(audioBytes: Buffer): number {
  if (
    audioBytes.length < 44 ||
    audioBytes.toString("ascii", 0, 4) !== "RIFF" ||
    audioBytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("voice fixture must be a RIFF/WAVE file");
  }

  let byteRate: number | null = null;
  let dataSize: number | null = null;
  for (let offset = 12; offset + 8 <= audioBytes.length; ) {
    const chunkName = audioBytes.toString("ascii", offset, offset + 4);
    const chunkSize = audioBytes.readUInt32LE(offset + 4);
    const chunkData = offset + 8;
    if (chunkData + chunkSize > audioBytes.length) {
      throw new Error("voice fixture contains an invalid WAV chunk size");
    }
    if (chunkName === "fmt " && chunkSize >= 16) {
      byteRate = audioBytes.readUInt32LE(chunkData + 8);
    } else if (chunkName === "data") {
      dataSize = chunkSize;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }
  if (!byteRate || dataSize === null) {
    throw new Error("voice fixture is missing WAV format or audio data");
  }
  return Math.max(1, Math.ceil(dataSize / byteRate));
}

function transientNetworkErrorCode(error: unknown): string | null {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return "ETIMEDOUT";
  }
  if (!(error instanceof TypeError)) return null;
  const cause = (error as TypeError & { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return null;
  }
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" && TRANSIENT_UPLOAD_ERROR_CODES.has(code)
    ? code
    : null;
}

type SafeSupportResponse = {
  ok: boolean;
  status: number;
  text: string;
};

async function supportPost(
  label: string,
  url: string,
  body?: object,
  options?: { attempts?: number; transientStatuses?: Set<number> },
): Promise<SafeSupportResponse> {
  if (!TEST_SUPPORT_TOKEN) {
    throw new Error(
      "PATIENT_WEB_TEST_SUPPORT_TOKEN is required for E2E support requests",
    );
  }
  const maxAttempts = options?.attempts ?? 12;
  const transientStatuses =
    options?.transientStatuses ?? TRANSIENT_SUPPORT_HTTP_STATUSES;
  let lastFailure = "network_error";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${TEST_SUPPORT_TOKEN}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      if (
        response.ok ||
        !transientStatuses.has(response.status) ||
        attempt === maxAttempts
      ) {
        return { ok: response.ok, status: response.status, text };
      }
      lastFailure = `status_${response.status}`;
    } catch (error) {
      const code = transientNetworkErrorCode(error);
      if (code === null) {
        throw new Error(`${label} failed reason=non_transient_network_error`);
      }
      lastFailure = code;
      if (attempt === maxAttempts) break;
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(attempt * 1_000, 5_000)),
    );
  }
  throw new Error(
    `${label} failed after ${maxAttempts} attempts reason=${lastFailure}`,
  );
}

class ProxyFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
    readonly retryAfter: string | null,
  ) {
    super(message);
    this.name = "ProxyFetchError";
  }
}

async function cleanupE2eState() {
  if (!BACKEND_CLEANUP_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_E2E_CLEANUP_URL is required so patient web E2E starts from clean synthetic state",
    );
  }
  if (!GATEWAY_CLEANUP_URL) {
    throw new Error(
      "PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL is required so patient web E2E starts from clean synthetic state",
    );
  }
  const gatewayResponse = await supportPost(
    "gateway cleanup",
    GATEWAY_CLEANUP_URL,
    undefined,
    { transientStatuses: TRANSIENT_SUPPORT_HTTP_STATUSES_EXCEPT_NOT_FOUND },
  );
  if (gatewayResponse.status === 404) {
    console.warn(
      "[voice-e2e] gateway cleanup endpoint returned 404; root prod runner cleanup remains authoritative",
    );
  } else {
    expect(
      gatewayResponse.ok,
      `PATIENT_WEB_GATEWAY_E2E_CLEANUP_URL must clear gateway E2E state status=${gatewayResponse.status}`,
    ).toBeTruthy();
  }

  const response = await supportPost("backend cleanup", BACKEND_CLEANUP_URL);
  expect(
    response.ok,
    [
      "PATIENT_WEB_BACKEND_E2E_CLEANUP_URL must clean synthetic E2E state",
      `status=${response.status}`,
      `body=${sanitizeBrowserDiagnostic(response.text)}`,
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

function syntheticEmailForTest(testInfo: TestInfo, authAttempt = 0): string {
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return `patient-web-voice-${SYNTHETIC_RUN_NAMESPACE}-${testInfo.parallelIndex}-${testInfo.retry}-${authAttempt}-${slug}@e2e.example.com`;
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

async function getRegistrationVerificationCode(email: string): Promise<string> {
  if (!BACKEND_REGISTRATION_CODE_URL) {
    throw new Error(
      "PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL is required to verify synthetic registration",
    );
  }
  const response = await supportPost(
    "registration verification code lookup",
    BACKEND_REGISTRATION_CODE_URL,
    { email },
  );
  expect(
    response.status,
    `registration verification code lookup failed status=${response.status}`,
  ).toBe(200);
  const payload = parseJsonBody(response.text) as { code?: unknown };
  if (typeof payload.code !== "string") {
    throw new Error("registration verification code lookup returned no code");
  }
  return payload.code;
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
      const response = await registerResponsePromise;
      if (response.ok()) return response;
      lastError = new Error(
        `voice registration failed status=${response.status()}`,
      );
      if (![409, 502, 503, 504].includes(response.status())) return response;
      if (
        response.status() === 409 &&
        (await page
          .getByTestId("verify-screen")
          .isVisible({ timeout: 10_000 })
          .catch(() => false))
      ) {
        return response;
      }
    } catch (error) {
      lastError = error;
    }
    if (attempt === 3) break;
    await page.waitForTimeout(attempt * 1_000);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Voice registration submit did not produce a response");
}

async function submitVerificationAndWait(
  page: Page,
  getVerificationCode: () => Promise<string>,
): Promise<Response> {
  let lastError: unknown;
  let lastVerificationCode: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForBrowserNetworkReady(page);
      try {
        lastVerificationCode = await getVerificationCode();
      } catch (error) {
        lastError = error;
        if (lastVerificationCode == null) throw error;
      }
      await page.getByTestId("verify-otp-digit-0").fill(lastVerificationCode);
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
      const response = await verifyResponsePromise;
      if (response.ok()) return response;
      lastError = new Error(
        `voice verification failed status=${response.status()}`,
      );
      if (![422, 502, 503, 504].includes(response.status())) return response;
    } catch (error) {
      lastError = error;
    }
    if (attempt === 3) break;
    await page.waitForTimeout(attempt * 1_000);
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Voice verification submit did not produce a response");
}

async function acceptConsentIfPresent(page: Page) {
  const consentVisible = await page
    .getByTestId("consent-screen")
    .isVisible({ timeout: 5_000 })
    .catch(() => false);
  if (!consentVisible) return;

  let lastFailure: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForBrowserNetworkReady(page);
      await clickIfPresent(page, "consent-checkbox-pa-cons-privacy", 5_000);
      await page.waitForTimeout(250);
      await clickIfPresent(page, "consent-checkbox-pa-cons-educational", 5_000);
      await page.waitForTimeout(250);
      await clickIfPresent(page, "consent-checkbox-pa-cons-ai-analysis", 5_000);
      await page.waitForTimeout(250);

      const accept = page.getByTestId("consent-accept");
      await expect(accept).toBeEnabled({ timeout: 30_000 });
      await accept.click();
      await expect(accept).toBeHidden({ timeout: 30_000 });
      return;
    } catch (error) {
      lastFailure =
        error instanceof Error
          ? sanitizeBrowserDiagnostic(error.message)
          : "unknown_consent_submit_failure";
      const stillOnConsent = await page
        .getByTestId("consent-screen")
        .isVisible({ timeout: 5_000 })
        .catch(() => false);
      if (attempt === 3 || !stillOnConsent) break;
      await page.waitForTimeout(attempt * 1_000);
    }
  }

  if (lastFailure) {
    throw new Error(lastFailure);
  }
}

async function csrfTokenForApiPath(
  page: Page,
  apiPath: string,
): Promise<string> {
  const url = new URL(apiPath, page.url()).toString();
  const cookies = await page.context().cookies(url);
  const csrfCookie = cookies
    .filter(
      (cookie) =>
        cookie.name === "spine_patient_csrf" && apiPath.startsWith(cookie.path),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];

  if (!csrfCookie?.value) {
    throw new Error("missing_csrf");
  }
  return csrfCookie.value;
}

async function patientProxyJson<T = unknown>(
  page: Page,
  path: string,
  options: { method: "PATCH" | "POST"; body: object },
): Promise<T> {
  let lastFailure = "network_error";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitForBrowserNetworkReady(page);
    const csrfToken = await csrfTokenForApiPath(page, path);
    const response = await page.evaluate(
      async ({ path, method, body, csrfToken }) => {
        try {
          const browserResponse = await fetch(path, {
            method,
            credentials: "include",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrfToken,
            },
            body: JSON.stringify(body),
          });
          return {
            networkError: false,
            ok: browserResponse.ok,
            status: browserResponse.status,
            text: await browserResponse.text(),
          };
        } catch {
          return {
            networkError: true,
            ok: false,
            status: 0,
            text: "",
          };
        }
      },
      { path, method: options.method, body: options.body, csrfToken },
    );
    if (response.networkError) {
      lastFailure = "network_error";
      if (attempt < 3) {
        await page.waitForTimeout(attempt * 1_000);
        continue;
      }
      break;
    }
    if (!response.ok) {
      lastFailure = `status_${response.status}`;
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        if (attempt < 3) {
          await page.waitForTimeout(attempt * 1_000);
          continue;
        }
      }
      throw new Error(
        `synthetic setup request failed path=${sanitizeBrowserDiagnostic(path)} status=${response.status} body=${sanitizeBrowserDiagnostic(response.text)}`,
      );
    }
    if (response.text.trim().length === 0) {
      return undefined as T;
    }
    return parseJsonBody(response.text) as T;
  }

  throw new Error(
    `synthetic setup request failed path=${sanitizeBrowserDiagnostic(path)} reason=${lastFailure}`,
  );
}

async function completeSyntheticOnboardingThroughApi(page: Page) {
  const { onboarding } = fullAssessmentScenario;
  const profileDateOfBirth = fullAssessmentScenario.registration.dateOfBirth;
  const heightCm =
    (Number(onboarding.heightFeet) * 12 + Number(onboarding.heightInches)) *
    2.54;
  const weightKg = Number(onboarding.weightPounds) * 0.453592;

  await patientProxyJson(page, "/api/proxy/api/v1/patients/me", {
    method: "PATCH",
    body: {
      date_of_birth: profileDateOfBirth,
      sex_at_birth: onboarding.sexAtBirth,
      height_cm: Math.round(heightCm),
      weight_kg: Math.round(weightKg),
    },
  });

  await patientProxyJson(page, "/api/proxy/api/v1/patients/me/intake/profile", {
    method: "POST",
    body: {
      step_data: {
        dateOfBirth: profileDateOfBirth,
        sexAtBirth: onboarding.sexAtBirth,
        heightFt: onboarding.heightFeet,
        heightIn: onboarding.heightInches,
        weight: onboarding.weightPounds,
        occupation: onboarding.occupation,
        activityLevel: onboarding.activityLevel,
      },
    },
  });

  await patientProxyJson(
    page,
    "/api/proxy/api/v1/patients/me/intake/chief-complaint",
    {
      method: "POST",
      body: {
        step_data: {
          narrative: onboarding.chiefComplaint,
          inputMethod: "text",
        },
      },
    },
  );

  await patientProxyJson(
    page,
    "/api/proxy/api/v1/patients/me/intake/treatment-history",
    {
      method: "POST",
      body: {
        step_data: onboarding.intakeStepData["treatment-history"],
      },
    },
  );

  await patientProxyJson(
    page,
    "/api/proxy/api/v1/patients/me/intake/imaging-records",
    {
      method: "POST",
      body: {
        step_data: {
          skipped: true,
          documents: [],
        },
      },
    },
  );

  await patientProxyJson(
    page,
    "/api/proxy/api/v1/patients/me/intake/progress/complete",
    {
      method: "POST",
      body: {},
    },
  );

  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const response = await fetch("/api/auth/session", {
            credentials: "include",
          });
          if (!response.ok) return false;
          const session = (await response.json()) as {
            has_completed_onboarding?: unknown;
          };
          return session.has_completed_onboarding === true;
        }),
      {
        message: "synthetic voice patient should have completed onboarding",
        timeout: 60_000,
      },
    )
    .toBe(true);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await waitForHomeScreen(page);
}

async function registerAndAuthenticateSyntheticPatient(
  page: Page,
  testInfo: TestInfo,
) {
  let lastFailure: string | null = null;

  for (let authAttempt = 0; authAttempt < 3; authAttempt += 1) {
    const email = syntheticEmailForTest(testInfo, authAttempt);
    try {
      await page.request.get("/api/auth/session");
      await page.goto("/register");
      await expect(page.getByTestId("register-screen")).toBeVisible();

      await page.getByTestId("register-first-name").fill("Synthetic");
      await page.getByTestId("register-last-name").fill("Voice");
      await page.getByTestId("register-email").fill(email);
      await page.getByTestId("register-password").fill(SIGNUP_PASSWORD);
      await page.getByTestId("register-confirm-password").fill(SIGNUP_PASSWORD);
      await clickIfPresent(page, "register-consent-storage");

      const registerResponse = await submitRegistrationAndWait(page);
      const registerResponseText = await registerResponse.text();
      if (!registerResponse.ok()) {
        const verifyScreenVisible = await page
          .getByTestId("verify-screen")
          .isVisible({ timeout: 10_000 })
          .catch(() => false);
        const acceptedConflict =
          registerResponse.status() === 409 &&
          /registration_conflict/.test(registerResponseText) &&
          /email/.test(registerResponseText) &&
          verifyScreenVisible;
        if (!acceptedConflict) {
          lastFailure = `registration failed status=${registerResponse.status()} body=${sanitizeBrowserDiagnostic(registerResponseText)}`;
          if (authAttempt < 2) {
            await cleanupE2eState().catch(() => undefined);
            continue;
          }
          throw new Error(lastFailure);
        }
      }
      await expectNoTokenLeak(registerResponseText);
      await expect(page.getByTestId("verify-screen")).toBeVisible({
        timeout: 60_000,
      });

      const response = await submitVerificationAndWait(page, () =>
        getRegistrationVerificationCode(email),
      );
      const responseText = await response.text();
      if (!response.ok()) {
        lastFailure = `verification failed status=${response.status()} body=${sanitizeBrowserDiagnostic(responseText)}`;
        if (authAttempt < 2) {
          await cleanupE2eState().catch(() => undefined);
          continue;
        }
        throw new Error(lastFailure);
      }
      await expectNoTokenLeak(responseText);
      lastFailure = null;
      break;
    } catch (error) {
      lastFailure =
        error instanceof Error
          ? sanitizeBrowserDiagnostic(error.message)
          : "unknown_auth_failure";
      if (authAttempt < 2) {
        await cleanupE2eState().catch(() => undefined);
        continue;
      }
      throw new Error(lastFailure);
    }
  }

  if (lastFailure) {
    throw new Error(lastFailure);
  }

  await expect(page.getByTestId("consent-screen")).toBeVisible({
    timeout: 60_000,
  });
  await acceptConsentIfPresent(page);
  await completeSyntheticOnboardingThroughApi(page);

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

async function startAssessmentFromActiveUi(
  page: Page,
): Promise<AssessmentRecord> {
  await waitForHomeScreen(page);
  const createResponsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/proxy\/api\/v1\/patients\/me\/assessments\/?$/.test(
        new URL(response.url()).pathname,
      ),
  );
  const start = page.getByTestId("start-assessment-btn").first();
  await expect(start).toBeVisible({ timeout: 60_000 });
  await expect(start).toBeEnabled();
  await start.click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  return (await createResponse.json()) as AssessmentRecord;
}

async function waitForHomeScreen(page: Page) {
  let lastFailure: string | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await waitForBrowserNetworkReady(page);
      if (attempt > 1) {
        await page.goto("/", { waitUntil: "domcontentloaded" });
      }
      await expect(page.getByTestId("home-screen")).toBeVisible({
        timeout: 60_000,
      });
      return;
    } catch (error) {
      lastFailure =
        error instanceof Error
          ? sanitizeBrowserDiagnostic(error.message)
          : "unknown_home_screen_failure";
      if (attempt === 3) break;
      await page.waitForTimeout(attempt * 1_000);
    }
  }
  if (lastFailure) {
    throw new Error(lastFailure);
  }
}

async function getAuthoritativeScreeningState(
  page: Page,
  assessmentId: string,
): Promise<ScreeningState> {
  const path = `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/screening/state`;
  const response = await page.evaluate(async (path) => {
    const browserResponse = await fetch(path, { credentials: "include" });
    return {
      ok: browserResponse.ok,
      status: browserResponse.status,
      text: await browserResponse.text(),
    };
  }, path);
  if (!response.ok) {
    throw new Error(
      `screening state discovery failed status=${response.status}`,
    );
  }
  return JSON.parse(response.text) as ScreeningState;
}

function firstIssuedQuestionId(state: ScreeningState): string {
  expect(state.revision).toBeGreaterThanOrEqual(0);
  expect(state.visible_questions.length).toBeGreaterThan(0);
  const first = state.visible_questions[0];
  const questionId = first?.id ?? first?.question_id;
  if (typeof questionId !== "string" || !/^[A-Za-z0-9_-]+$/.test(questionId)) {
    throw new Error("screening state did not issue a valid first question id");
  }
  return questionId;
}

async function requestQuestionNoteLiveTranscriptionSession(
  page: Page,
  assessmentId: string,
  questionId: string,
  expectedRevision: number,
): Promise<LiveTranscriptionSession> {
  const path = `/api/proxy/api/v1/patients/me/assessments/${assessmentId}/questions/${questionId}/note/live-transcription-session`;
  const csrfToken = await csrfTokenForApiPath(page, path);
  return page.evaluate(
    async ({ csrfToken, path, expectedRevision }) => {
      const response = await fetch(path, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          expected_revision: expectedRevision,
          content_type: "audio/wav",
        }),
      });
      if (!response.ok) {
        throw new Error(
          `live transcription session failed status=${response.status}`,
        );
      }
      return (await response.json()) as LiveTranscriptionSession;
    },
    { csrfToken, path, expectedRevision },
  );
}

async function streamFixtureToLiveTranscription(
  page: Page,
  session: LiveTranscriptionSession,
  audioBytes: number[],
): Promise<LiveTranscriptionResult> {
  return page.evaluate(
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
      if (
        Array.from(url.searchParams.keys()).some(
          (name) => name.toLowerCase() === "token",
        )
      ) {
        throw new Error(
          "Live transcription WebSocket URL must not contain a token.",
        );
      }
      const wsUrl = url.toString();
      if (wsUrl.includes(liveSession.token)) {
        throw new Error(
          "Live transcription token must not be present in the WebSocket URL.",
        );
      }

      return new Promise<LiveTranscriptionResult>((resolve, reject) => {
        const socket = new WebSocket(wsUrl);
        const timeout = window.setTimeout(() => {
          socket.close();
          reject(new Error("live transcription websocket timed out"));
        }, 30_000);
        let ready = false;
        let audioSent = false;
        let chunksSent = 0;
        const partialTexts: string[] = [];
        const finalTexts: string[] = [];

        socket.binaryType = "arraybuffer";
        socket.onerror = () => {
          window.clearTimeout(timeout);
          reject(new Error("live transcription websocket failed"));
        };
        socket.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          try {
            const parsed = JSON.parse(event.data) as {
              type?: unknown;
              text?: unknown;
              code?: unknown;
            };
            if (parsed.type === "ready") {
              if (audioSent) {
                window.clearTimeout(timeout);
                reject(
                  new Error("live transcription audio was sent before ready."),
                );
                socket.close();
                return;
              }
              ready = true;
              const bytes = new Uint8Array(wavBytes);
              const chunkSize = 16_000;
              chunksSent = Math.ceil(bytes.length / chunkSize);
              for (let offset = 0; offset < bytes.length; offset += chunkSize) {
                socket.send(bytes.slice(offset, offset + chunkSize));
              }
              socket.send(JSON.stringify({ type: "finish" }));
              audioSent = true;
              return;
            }
            if (parsed.type === "partial" && typeof parsed.text === "string") {
              const partialText = parsed.text.trim();
              if (partialText) partialTexts.push(partialText);
              return;
            }
            if (parsed.type === "final" && typeof parsed.text === "string") {
              const finalText = parsed.text.trim();
              if (finalText) finalTexts.push(finalText);
              return;
            }
            if (parsed.type === "error") {
              window.clearTimeout(timeout);
              const safeCode =
                typeof parsed.code === "string" &&
                [
                  "streaming_failed",
                  "streaming_not_supported",
                  "streaming_timeout",
                ].includes(parsed.code)
                  ? parsed.code
                  : "unknown";
              reject(
                new Error(
                  `live transcription websocket returned error code=${safeCode}`,
                ),
              );
              socket.close();
              return;
            }
            if (parsed.type === "done") {
              if (!ready || !audioSent) {
                window.clearTimeout(timeout);
                reject(
                  new Error(
                    "live transcription completed before ready audio send.",
                  ),
                );
                socket.close();
                return;
              }
              const finalTranscript = finalTexts.join(" ").trim();
              if (!finalTranscript) {
                window.clearTimeout(timeout);
                reject(
                  new Error(
                    "live transcription completed without a final transcript.",
                  ),
                );
                socket.close();
                return;
              }
              window.clearTimeout(timeout);
              resolve({
                partialTranscript: partialTexts.join(" ").trim(),
                finalTranscript,
                chunksSent,
              });
              socket.close();
            }
          } catch {
            // Ignore non-contract messages.
          }
        };
        socket.onopen = () => {
          socket.send(
            JSON.stringify({ type: "authenticate", token: liveSession.token }),
          );
        };
      });
    },
    { session, audioBytes, wsOrigin: LIVE_TRANSCRIPTION_WS_ORIGIN },
  );
}

function parseJsonBody(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { unparseable: true };
  }
}

function safeProxyFailureCategory(body: unknown): string {
  if (!body || typeof body !== "object") return "unclassified";
  const detail = (body as Record<string, unknown>).detail;
  if (typeof detail !== "string") return "unclassified";
  const categories: Readonly<Record<string, string>> = {
    "LLM provider rejected request": "llm_provider_rejected",
    "LLM provider unavailable": "llm_provider_unavailable",
    "LLM provider failed": "llm_provider_failed",
    "LLM provider timeout": "llm_provider_timeout",
    "LLM provider rate limit": "llm_provider_rate_limited",
    "Guardrail 'phi_leakage' blocked response: phi_leak_detected":
      "llm_phi_guardrail_blocked",
    "Guardrail 'structured_schema' blocked response: schema_invalid_json":
      "llm_schema_invalid_json",
    "Guardrail 'structured_schema' blocked response: schema_validation_failed":
      "llm_schema_validation_failed",
  };
  return categories[detail] ?? "unclassified";
}

async function proxyJson<T>(
  page: Page,
  traffic: TrafficCapture,
  path: string,
  options: { method: "POST"; body: object },
): Promise<T> {
  let lastNetworkError = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await waitForBrowserNetworkReady(page);
    const csrfToken = await csrfTokenForApiPath(page, path);
    const response = await page.evaluate(
      async ({ path, method, body, csrfToken }) => {
        try {
          const browserResponse = await fetch(path, {
            method,
            credentials: "include",
            headers: {
              "content-type": "application/json",
              "x-csrf-token": csrfToken,
            },
            body: JSON.stringify(body),
          });
          return {
            networkError: false,
            ok: browserResponse.ok,
            status: browserResponse.status,
            text: await browserResponse.text(),
          };
        } catch {
          return {
            networkError: true,
            ok: false,
            status: 0,
            text: "",
          };
        }
      },
      { path, method: options.method, body: options.body, csrfToken },
    );
    recordTraffic(
      traffic,
      options.method,
      new URL(path, page.url()).toString(),
    );
    if (response.networkError) {
      lastNetworkError = true;
      if (attempt < 3) {
        await page.waitForTimeout(attempt * 1_000);
        continue;
      }
      break;
    }
    const body = parseJsonBody(response.text);
    if (!response.ok) {
      if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
        if (attempt < 3) {
          await page.waitForTimeout(attempt * 1_000);
          continue;
        }
      }
      throw new ProxyFetchError(
        "onboarding story request failed status=" +
          response.status +
          " category=" +
          safeProxyFailureCategory(body),
        response.status,
        body,
        null,
      );
    }
    return body as T;
  }

  throw new Error(
    `onboarding story request failed reason=${lastNetworkError ? "network_error" : "transient_http_error"}`,
  );
}

async function uploadOnboardingStoryFixtureThroughCompletedFilePath(
  page: Page,
  audioBytes: Buffer,
  traffic: TrafficCapture,
): Promise<BulkTranscriptionResult> {
  expect(wavDurationSeconds(audioBytes)).toBeGreaterThan(0);

  const audioUploadsPath =
    "/api/proxy/api/v1/patients/me/intake/story/audio-uploads";
  const upload = await proxyJson<IntakeStoryAudioUpload>(
    page,
    traffic,
    audioUploadsPath,
    {
      method: "POST",
      body: {
        content_type: "audio/wav",
        size_bytes: audioBytes.length,
      },
    },
  );
  expect(upload.upload_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  expect(upload.content_type).toBe("audio/wav");
  if (audioBytes.length > upload.max_bytes) {
    throw new Error("audio fixture exceeds onboarding story upload max_bytes");
  }

  const uploadUrl = new URL(upload.upload_url);
  expect(uploadUrl.protocol).toBe("https:");
  let uploadCompleted = false;
  let lastUploadFailure = "unknown";
  let uploadAttempts = 0;
  for (let attempt = 1; attempt <= BULK_UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    uploadAttempts = attempt;
    recordTraffic(traffic, "PUT", upload.upload_url);
    try {
      const uploadResponse = await fetch(upload.upload_url, {
        method: "PUT",
        headers: upload.required_headers,
        body: new Uint8Array(audioBytes),
      });
      if (uploadResponse.ok) {
        uploadCompleted = true;
        break;
      }
      lastUploadFailure = "status=" + uploadResponse.status;
      if (!TRANSIENT_UPLOAD_HTTP_STATUSES.has(uploadResponse.status)) {
        break;
      }
    } catch (error) {
      const transientCode = transientNetworkErrorCode(error);
      lastUploadFailure = transientCode ?? "non_transient_network_error";
      if (transientCode === null) break;
    }
    if (attempt < BULK_UPLOAD_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
  }
  if (!uploadCompleted) {
    throw new Error(
      "onboarding story audio upload failed after " +
        uploadAttempts +
        " attempts: " +
        lastUploadFailure,
    );
  }

  const transcriptionPath =
    "/api/proxy/api/v1/patients/me/intake/story/transcriptions";
  const transcription = await proxyJson<IntakeStoryTranscriptionResponse>(
    page,
    traffic,
    transcriptionPath,
    { method: "POST", body: { upload_id: upload.upload_id } },
  );
  expect(Object.keys(transcription).sort()).toEqual([
    "input_method",
    "narrative",
  ]);
  expect(transcription.input_method).toBe("voice");
  expect(
    transcription.narrative.trim().length,
    "onboarding My Story transcription must return text from the completed file",
  ).toBeGreaterThan(0);

  return {
    upload_id: upload.upload_id,
    narrative: transcription.narrative,
    narrative_length: transcription.narrative.trim().length,
  };
}
test.describe("patient web voice transcription contracts @voice-transcription", () => {
  test.beforeEach(async ({ page }) => {
    expect(
      fs.existsSync(AUDIO_FIXTURE),
      "The committed synthetic WAV fixture is required for production voice E2E.",
    ).toBe(true);
    installPhiSafeDiagnostics(page);
    await cleanupE2eState();
  });

  test.afterEach(async () => {
    await cleanupE2eState();
  });

  test("transcribes a completed onboarding My Story WAV through the bulk path", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    await registerAndAuthenticateSyntheticPatient(page, testInfo);
    const traffic = captureTranscriptionTraffic(page);
    const result = await uploadOnboardingStoryFixtureThroughCompletedFilePath(
      page,
      fs.readFileSync(AUDIO_FIXTURE),
      traffic,
    );

    expect(result.upload_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(
      result.narrative_length,
      "onboarding My Story bulk processing must return a non-empty transcript",
    ).toBeGreaterThan(0);
    expectSyntheticTranscript(result.narrative, "onboarding bulk");

    expect(
      hasRequest(
        traffic,
        "POST",
        /\/api\/proxy\/api\/v1\/patients\/me\/intake\/story\/audio-uploads$/,
      ),
    ).toBe(true);
    expect(
      traffic.requests.some((request) => request.isBulkUpload),
      "onboarding My Story must upload the committed WAV to the issued object URL",
    ).toBe(true);
    expect(
      hasRequest(
        traffic,
        "POST",
        /\/api\/proxy\/api\/v1\/patients\/me\/intake\/story\/transcriptions$/,
      ),
    ).toBe(true);
    expect(traffic.websocketPaths).toHaveLength(0);
  });

  test("streams the assessment Add Note WAV in chunks over the canonical WebSocket", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    await registerAndAuthenticateSyntheticPatient(page, testInfo);
    const traffic = captureTranscriptionTraffic(page);
    const assessment = await startAssessmentFromActiveUi(page);
    await expect(page.getByTestId("screening-screen")).toBeVisible({
      timeout: 120_000,
    });
    const screeningState = await getAuthoritativeScreeningState(
      page,
      assessment.id,
    );
    const questionId = firstIssuedQuestionId(screeningState);
    await expect(page.getByTestId(`question-${questionId}`)).toBeVisible({
      timeout: 60_000,
    });
    const addNote = page.getByTestId("screening-nav-note");
    await expect(addNote).toBeVisible();
    await expect(addNote).toBeEnabled();
    await addNote.click();
    await expect(page.getByTestId("screening-question-note-mic")).toBeVisible();
    await expect(page.getByTestId("screening-question-note-mic")).toBeEnabled();
    await page.getByTestId("screening-question-note-close").click();
    const session = await requestQuestionNoteLiveTranscriptionSession(
      page,
      assessment.id,
      questionId,
      screeningState.revision,
    );
    expect(session.session_id).toBeTruthy();
    expect(session.websocket_path).toBe(
      `/ws/patients/me/assessments/${assessment.id}/questions/${questionId}/note/live-transcription`,
    );
    expect(session.expires_in_seconds).toBeGreaterThan(0);

    const transcription = await streamFixtureToLiveTranscription(
      page,
      session,
      Array.from(fs.readFileSync(AUDIO_FIXTURE)),
    );
    expect(
      transcription.finalTranscript.length,
      "assessment Add Note streaming must produce a final transcription before done",
    ).toBeGreaterThan(0);
    expectSyntheticTranscript(
      transcription.finalTranscript,
      "question-note streaming",
    );
    expect(typeof transcription.partialTranscript).toBe("string");
    expect(
      transcription.chunksSent,
      "assessment Add Note must stream the WAV as multiple binary chunks",
    ).toBeGreaterThan(1);

    expect(
      hasRequest(
        traffic,
        "POST",
        /\/api\/proxy\/api\/v1\/patients\/me\/assessments\/[0-9a-f-]+\/questions\/[A-Za-z0-9_-]+\/note\/live-transcription-session$/,
      ),
    ).toBe(true);
    expect(traffic.websocketPaths).toContain(session.websocket_path);
    expectNoBulkUpload(traffic);
    expect(
      hasRequest(
        traffic,
        "POST",
        /\/api\/proxy\/api\/v1\/patients\/me\/intake\/story\/audio-uploads$/,
      ),
      "assessment Add Note streaming must not use onboarding completed-file upload",
    ).toBe(false);
  });
});
