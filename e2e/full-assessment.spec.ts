import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
  type Response as PlaywrightResponse,
} from '@playwright/test'

import { fullAssessmentScenario } from './fixtures/fullAssessmentScenario'

const BACKEND_RESET_URL = process.env.PATIENT_WEB_BACKEND_RESET_URL
const BACKEND_RESET_TOKEN = process.env.PATIENT_WEB_BACKEND_RESET_TOKEN
const BACKEND_REGISTRATION_CODE_URL = process.env.PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL
const GATEWAY_RESET_URL = process.env.PATIENT_WEB_GATEWAY_RESET_URL
const GATEWAY_RESET_TOKEN = process.env.PATIENT_WEB_GATEWAY_RESET_TOKEN
const EXPECT_SECURE_COOKIES = process.env.PATIENT_WEB_EXPECT_SECURE_COOKIES === 'true'
const ENABLE_FULL_ASSESSMENT_STRESS =
  process.env.PATIENT_WEB_FULL_ASSESSMENT_STRESS !== 'false'
const FULL_FLOW_TIMEOUT_MS = 15 * 60 * 1000
const ASSESSMENT_REPORT_PROXY_PATH_RE =
  /^\/api\/proxy\/api\/v1\/patients\/me\/assessments\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/reports$/i
const STRESS_RELOAD_AFTER_SCREENING_QUESTION_ID = 'A03_Q2b'
const STRESS_BACKTRACK_AFTER_SCREENING_QUESTION_ID = 'R03'

type BrowserCookie = {
  name: string
  httpOnly: boolean
  path: string
  sameSite: 'Lax' | 'None' | 'Strict'
  secure: boolean
}

type AssessmentAnswer = {
  readonly id: string
  readonly value: string | number | readonly (string | number)[]
}

type TextAnswer = {
  readonly id: string
  readonly text: string
}

type ScreeningStressState = {
  reloadedDuringScreening: boolean
  backtrackedDuringScreening: boolean
}

const SCREENING_ANSWERS_BY_ID = new Map(
  [
    ...fullAssessmentScenario.screening,
    ...fullAssessmentScenario.adaptive,
  ].map((answer) => [answer.id, answer]),
)
const SCREENING_TEXT_ANSWERS_BY_ID = new Map(
  [
    ...fullAssessmentScenario.adaptiveText,
  ].map((answer) => [answer.id, answer]),
)
const FINAL_SCREENING_QUESTION_ID =
  fullAssessmentScenario.screening[fullAssessmentScenario.screening.length - 1]?.id

function logMilestone(message: string): void {
  console.log(`[milestone] ${message}`)
}

function uniqueSyntheticEmail(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return `casey.assessment.${unique}@e2e.example.com`
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s)]+/g, '[origin]')
    .replace(/\?[^)\]\s"']+/g, '?[query]')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      '[uuid]',
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [token]')
    .replace(/\b(cookie|set-cookie)\b\s*[:=]\s*[^\n\r]+/gi, '$1=[redacted]')
    .replace(/\b(authorization|x-csrf-token|csrf-token)\b\s*[:=]\s*[^;\n\r]+/gi, '$1=[redacted]')
    .replace(/"(cookie|set-cookie)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/"(cookie|set-cookie)"\s*:\s*\[[^\]]*\]/gi, '"$1":["[redacted]"]')
    .replace(/"(authorization|x-csrf-token|csrf-token)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"')
    .replace(/\b(password|verification_code|verificationCode|mfa_code|mfaCode)\b\s*[:=]\s*[^,\s)]+/gi, '$1=[redacted]')
    .replace(/"[^"]*token[^"]*"\s*:\s*"[^"]+"/gi, (match) =>
      match.replace(/:\s*"[^"]+"/, ':"[token]"'),
    )
    .replace(/"password"\s*:\s*"[^"]+"/gi, '"password":"[redacted]"')
    .replace(/"csrfToken"\s*:\s*"[^"]+"/gi, '"csrfToken":"[redacted]"')
    .replace(/"csrf_token"\s*:\s*"[^"]+"/gi, '"csrf_token":"[redacted]"')
    .slice(0, 800)
}

function sanitizeDiagnosticStack(error: Error): string | null {
  if (!error.stack) return null
  const frames = error.stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('at '))
    .slice(0, 6)
    .map(sanitizeDiagnostic)
  if (frames.length === 0) return null
  return [sanitizeDiagnostic(error.name || 'Error'), ...frames].join('\n')
}

function installPhiSafeDiagnostics(page: Page) {
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return
    console.log(`[browser:${message.type()}] ${sanitizeDiagnostic(message.text())}`)
  })
  page.on('pageerror', (error) => {
    console.log(`[pageerror] ${sanitizeDiagnostic(error.message)}`)
    const stack = sanitizeDiagnosticStack(error)
    if (stack) {
      console.log(`[pageerror-stack] ${stack}`)
    }
  })
  page.on('response', (response) => {
    const url = new URL(response.url())
    const isAssessmentApi = url.pathname.includes('/api/proxy/api/v1/patients/me/assessments/')
    if (
      response.status() < 400 &&
      !isAssessmentApi &&
      !url.pathname.endsWith('/api/proxy/api/v1/patients/me/intake/route')
    ) {
      return
    }
    const requestId = response.headers()['x-request-id'] ?? response.headers()['request-id']
    const suffix = requestId != null ? ` request_id=${sanitizeDiagnostic(requestId)}` : ''
    console.log(`[response:${response.status()}] ${sanitizeDiagnostic(url.pathname)}${suffix}`)
    if (
      url.pathname.endsWith('/api/proxy/api/v1/patients/me/intake/route') ||
      (response.status() === 422 && url.pathname.endsWith('/api/proxy/api/v1/patients/me/')) ||
      (response.status() === 422 && url.pathname.endsWith('/screening/answers'))
    ) {
      void response
        .text()
        .then((body) => console.log(`[response-body:${response.status()}] ${sanitizeDiagnostic(body)}`))
        .catch(() => undefined)
    }
  })
}

function isAssessmentReportGenerationResponse(response: PlaywrightResponse): boolean {
  const url = new URL(response.url())
  return (
    response.request().method() === 'POST' &&
    ASSESSMENT_REPORT_PROXY_PATH_RE.test(url.pathname)
  )
}

async function postTestSupport(
  request: APIRequestContext,
  url: string,
  token: string | undefined,
  label: string,
): Promise<APIResponse> {
  const options: Parameters<APIRequestContext['post']>[1] = { timeout: 90_000 }
  if (token) options.headers = { authorization: `Bearer ${token}` }
  const response = await request.post(url, options)
  expect(response.status(), `${label} failed status=${response.status()}`).toBe(200)
  return response
}

async function resetBackend(request: APIRequestContext) {
  if (!BACKEND_RESET_URL) {
    throw new Error('PATIENT_WEB_BACKEND_RESET_URL is required for full assessment E2E')
  }
  if (!BACKEND_RESET_TOKEN) {
    throw new Error('PATIENT_WEB_BACKEND_RESET_TOKEN is required for full assessment E2E')
  }

  if (GATEWAY_RESET_URL) {
    if (!GATEWAY_RESET_TOKEN) {
      throw new Error(
        'PATIENT_WEB_GATEWAY_RESET_TOKEN is required when PATIENT_WEB_GATEWAY_RESET_URL is set',
      )
    }
    await postTestSupport(request, GATEWAY_RESET_URL, GATEWAY_RESET_TOKEN, 'patient web gateway reset')
  }

  await postTestSupport(request, BACKEND_RESET_URL, BACKEND_RESET_TOKEN, 'backend reset')
}

async function getRegistrationVerificationCode(
  request: APIRequestContext,
  email: string,
  fallbackCode: string,
): Promise<string> {
  if (!BACKEND_REGISTRATION_CODE_URL) {
    if (EXPECT_SECURE_COOKIES || BACKEND_RESET_TOKEN) {
      throw new Error('PATIENT_WEB_BACKEND_REGISTRATION_CODE_URL is required for deployed full assessment E2E')
    }
    return fallbackCode
  }

  const response = await request.post(BACKEND_REGISTRATION_CODE_URL, {
    headers: {
      'content-type': 'application/json',
      ...(BACKEND_RESET_TOKEN ? { authorization: `Bearer ${BACKEND_RESET_TOKEN}` } : {}),
    },
    data: { email },
    timeout: 30_000,
  })
  expect(
    response.status(),
    `registration verification code lookup failed status=${response.status()}`,
  ).toBe(200)
  const payload = (await response.json()) as { code?: unknown }
  if (typeof payload.code !== 'string') {
    throw new Error('registration verification code lookup returned no code')
  }
  return payload.code
}

async function expectNoTokenLeak(responseText: string) {
  expect(responseText.includes('access_token')).toBe(false)
  expect(responseText.includes('refresh_token')).toBe(false)
  expect(responseText.includes('accessToken')).toBe(false)
  expect(responseText.includes('refreshToken')).toBe(false)
  expect(responseText.includes('mfa_token')).toBe(false)
  expect(responseText.includes('mfaToken')).toBe(false)
}

async function expectNoBrowserStorage(page: Page) {
  const storage = await page.evaluate(async () => {
    const indexedDbDatabases =
      typeof indexedDB.databases === 'function' ? await indexedDB.databases() : []

    return {
      localStorageLength: localStorage.length,
      sessionStorageLength: sessionStorage.length,
      indexedDbDatabases: indexedDbDatabases.map((db) => db.name).filter(Boolean),
      serviceWorkerCount: navigator.serviceWorker
        ? (await navigator.serviceWorker.getRegistrations()).length
        : 0,
    }
  })

  expect(storage).toEqual({
    localStorageLength: 0,
    sessionStorageLength: 0,
    indexedDbDatabases: [],
    serviceWorkerCount: 0,
  })
}

function hasCookie(cookies: BrowserCookie[], name: string): boolean {
  return cookies.some((entry) => entry.name === name)
}

function cookieHasExpectedShape(
  cookies: BrowserCookie[],
  name: string,
  expected: {
    httpOnly: boolean
    path: string
    sameSite: 'Lax' | 'Strict'
    secure: boolean
  },
): boolean {
  const cookie = cookies.find((entry) => entry.name === name)
  return (
    cookie?.httpOnly === expected.httpOnly &&
    cookie.path === expected.path &&
    cookie.sameSite === expected.sameSite &&
    cookie.secure === expected.secure
  )
}

async function warmCsrfSession(page: Page) {
  const response = await page.request.get('/api/auth/session')
  expect([200, 401]).toContain(response.status())
  const cookies = await page.context().cookies()
  expect(hasCookie(cookies, 'spine_patient_csrf')).toBe(true)
}

async function gotoWelcome(page: Page) {
  const isWelcomeVisible = async () =>
    (await page.getByTestId('welcome-screen').isVisible({ timeout: 1000 }).catch(() => false)) ||
    (await page
      .getByRole('button', { name: /start my assessment/i })
      .isVisible({ timeout: 1000 })
      .catch(() => false)) ||
    (await page
      .getByText(/Understand Your Spine/i)
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false))

  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto('/', { waitUntil: 'commit', timeout: 45_000 }).catch(() => undefined)
    if (await isWelcomeVisible()) {
      return
    }
    await page.waitForTimeout(1500)
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto('/welcome', { waitUntil: 'commit', timeout: 45_000 }).catch(() => undefined)
    if (await isWelcomeVisible()) {
      return
    }
    await page.waitForTimeout(1500)
  }

  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined)
  const visible = await expect
    .poll(isWelcomeVisible, {
      timeout: 60_000,
      message: 'Expected the welcome screen or Start My Assessment CTA to be visible',
    })
    .toBe(true)
    .then(() => true)
    .catch(() => false)
  if (!visible) {
    const diagnostic = await page
      .evaluate(() => ({
        href: location.href,
        text: document.body.innerText.slice(0, 500),
      }))
      .catch((error) => ({ href: page.url(), text: `diagnostic unavailable: ${error.message}` }))
    throw new Error(`Expected welcome screen. href=${sanitizeDiagnostic(diagnostic.href)} text=${sanitizeDiagnostic(diagnostic.text)}`)
  }
}

async function clickWelcomeGetStarted(page: Page) {
  if (await clickIfPresent(page, 'welcome-get-started', 2000)) {
    return
  }
  await page.getByRole('button', { name: /start my assessment/i }).click()
}

async function expectAuthenticatedCookieSession(page: Page) {
  const browserVisibleCookies = await page.evaluate(() => document.cookie)
  expect(browserVisibleCookies.includes('spine_patient_sess')).toBe(false)
  expect(browserVisibleCookies.includes('spine_patient_refresh')).toBe(false)

  const cookies = await page.context().cookies()
  expect(
    cookieHasExpectedShape(cookies, 'spine_patient_sess', {
      httpOnly: true,
      path: '/',
      sameSite: 'Lax',
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true)
  expect(
    cookieHasExpectedShape(cookies, 'spine_patient_refresh', {
      httpOnly: true,
      path: '/api/auth/refresh',
      sameSite: 'Strict',
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true)
  expect(
    cookieHasExpectedShape(cookies, 'spine_patient_csrf', {
      httpOnly: false,
      path: '/',
      sameSite: 'Strict',
      secure: EXPECT_SECURE_COOKIES,
    }),
  ).toBe(true)
  expect(hasCookie(cookies, 'spine_patient_sess_iat')).toBe(true)
}

async function expectConsentScreenAfterVerification(page: Page) {
  if (await page.getByTestId('consent-screen').isVisible({ timeout: 60_000 }).catch(() => false)) {
    return
  }
  await expect(page.getByRole('heading', { name: /Privacy & Consent/i })).toBeVisible({
    timeout: 60_000,
  })
}

async function byTestId(page: Page, testId: string): Promise<Locator> {
  const locator = page.getByTestId(testId)
  await expect(locator).toBeVisible({ timeout: 30_000 })
  return locator
}

async function clickByTestId(page: Page, testId: string) {
  const locator = await byTestId(page, testId)
  await locator.click()
}

async function fillByTestId(page: Page, testId: string, value: string) {
  const locator = await byTestId(page, testId)
  await locator.fill(value)
}

async function clickIfPresent(page: Page, testId: string, timeout = 1000): Promise<boolean> {
  const locator = page.getByTestId(testId)
  const visible = await locator.isVisible({ timeout }).catch(() => false)
  if (!visible) return false
  await locator.scrollIntoViewIfNeeded()
  await locator.click()
  return true
}

async function waitForAnyVisibleTestId(
  page: Page,
  testIds: readonly string[],
  timeout = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const testId of testIds) {
      if (await isVisibleByTestIdOrSemantic(page, testId, 500)) {
        return testId
      }
    }
    await page.waitForTimeout(250)
  }

  throw new Error(`None of these test IDs became visible: ${testIds.join(', ')}`)
}

async function waitForAssessmentStage(
  page: Page,
  testIds: readonly string[],
  timeout = 360_000,
): Promise<string> {
  return waitForAnyVisibleTestId(page, testIds, timeout)
}

async function waitForRetryOutcome(
  page: Page,
  errorTestId: string,
  nextTestIds: readonly string[],
  timeout = 30_000,
): Promise<string> {
  const nextStage = await waitForAnyVisibleTestId(page, nextTestIds, timeout).catch(() => null)
  if (nextStage != null) return nextStage

  if (await page.getByTestId(errorTestId).isVisible({ timeout: 1000 }).catch(() => false)) {
    return errorTestId
  }

  return waitForAnyVisibleTestId(page, nextTestIds, 30_000)
}

function semanticLocatorForTestId(page: Page, testId: string): Locator | null {
  switch (testId) {
    case 'adaptive-screen':
    case 'adaptive-list':
      return page.getByText(/^Adaptive\s*·\s*Q\d+\s+of\s+\d+$/i).first()
    case 'review-screen':
      return page.getByTestId('review-ready-title')
    case 'assessment-processing':
      return page
        .getByText(/Your assessment is being generated by our clinical AI engine|Determining clinical pathway/i)
        .first()
    case 'results-screen':
      return page.getByText('Assessment Results').first()
    case 'tab-home':
      return page.getByRole('tab', { name: /Home/i }).last()
    case 'adaptive-submit':
      return page.getByRole('button', { name: /^(Continue to next question|Submit answers)$/i }).first()
    default:
      return null
  }
}

async function isVisibleByTestIdOrSemantic(page: Page, testId: string, timeout = 500): Promise<boolean> {
  if (await page.getByTestId(testId).isVisible({ timeout }).catch(() => false)) return true
  const semantic = semanticLocatorForTestId(page, testId)
  return semantic != null && (await semantic.isVisible({ timeout }).catch(() => false))
}

async function actionableLocatorForTestId(page: Page, testId: string): Promise<Locator> {
  const semantic = semanticLocatorForTestId(page, testId)
  if (semantic != null && (await semantic.isVisible({ timeout: 500 }).catch(() => false))) {
    return semantic
  }

  const visibleLocator = page.locator(`[data-testid="${testId}"]:visible`).first()
  if (await visibleLocator.isVisible({ timeout: 500 }).catch(() => false)) return visibleLocator

  return page.getByTestId(testId).first()
}

async function visibleDynamicQuestionTestId(
  page: Page,
  questionPrefix: string,
): Promise<string | null> {
  return page
    .locator(`[data-testid^="${questionPrefix}-"]:visible`)
    .evaluateAll((elements) => {
      for (const element of elements) {
        const testId = element.getAttribute('data-testid')
        if (
          testId != null &&
          !testId.includes('-option-') &&
          !testId.includes('-input') &&
          !testId.includes('-stop-')
        ) {
          return testId
        }
      }
      return null
    })
    .catch(() => null)
}

async function waitForDynamicQuestionAdvance(
  page: Page,
  currentScreenTestId: string,
  questionPrefix: string,
  previousQuestionTestId: string | null,
  submitTestId: string,
  nextStageTestIds: readonly string[],
  timeout = 120_000,
): Promise<string> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const testId of nextStageTestIds) {
      if (await isVisibleByTestIdOrSemantic(page, testId, 250)) {
        return testId
      }
    }

    if (!(await isVisibleByTestIdOrSemantic(page, currentScreenTestId, 250))) {
      return 'left-current-screen'
    }

    const currentQuestionTestId = await visibleDynamicQuestionTestId(page, questionPrefix)
    if (
      previousQuestionTestId != null &&
      currentQuestionTestId != null &&
      currentQuestionTestId !== previousQuestionTestId
    ) {
      return currentScreenTestId
    }

    const submit = await actionableLocatorForTestId(page, submitTestId)
    if (await submit.isVisible({ timeout: 250 }).catch(() => false)) {
      if (
        previousQuestionTestId == null &&
        !(await submit.isEnabled({ timeout: 250 }).catch(() => false))
      ) {
        return currentScreenTestId
      }
    }

    await page.waitForTimeout(250)
  }

  throw new Error(`Timed out waiting for ${currentScreenTestId} to advance`)
}

async function maybeContinueSectionTransition(page: Page) {
  await clickIfPresent(page, 'screening-section-transition-continue')
}

async function waitForEnabledAndClick(
  page: Page,
  testId: string,
  timeout = 30_000,
  attempts = 4,
) {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const locator = await actionableLocatorForTestId(page, testId)
    await expect(locator).toBeVisible({ timeout })
    await expect(locator).toBeEnabled({ timeout })
    try {
      await locator.scrollIntoViewIfNeeded()
      await locator.click({ timeout: 10_000 })
      return
    } catch (error) {
      lastError = error
      await page.waitForTimeout(250)
      if (!(await locator.isVisible({ timeout: 250 }).catch(() => false))) {
        return
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Could not click ${testId}`)
}

async function clickAndWaitForResponse({
  page,
  testId,
  matches,
  retryErrorTestId,
  timeout = 60_000,
  attempts = retryErrorTestId == null ? 1 : 3,
}: {
  page: Page
  testId: string
  matches: (response: PlaywrightResponse) => boolean
  retryErrorTestId?: string
  timeout?: number
  attempts?: number
}): Promise<PlaywrightResponse> {
  if (attempts > 1 && retryErrorTestId == null) {
    throw new Error(`Retries for ${testId} require a retryErrorTestId`)
  }

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const responsePromise = page.waitForResponse(matches, { timeout })
    await waitForEnabledAndClick(page, testId)

    try {
      return await responsePromise
    } catch (error) {
      lastError = error
      if (attempt >= attempts) {
        break
      }

      if (retryErrorTestId != null) {
        const retryableErrorVisible = await page
          .getByTestId(retryErrorTestId)
          .isVisible({ timeout: 1000 })
          .catch(() => false)
        if (!retryableErrorVisible) {
          break
        }
      }

      await page.waitForTimeout(1500)
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`No response matched after clicking ${testId}`)
}

async function clickAndWaitForResponseOrSuccess({
  page,
  testId,
  matches,
  successTestId,
  timeout = 60_000,
}: {
  page: Page
  testId: string
  matches: (response: PlaywrightResponse) => boolean
  successTestId: string
  timeout?: number
}): Promise<PlaywrightResponse | null> {
  const observedResponses: PlaywrightResponse[] = []
  const collectResponse = (response: PlaywrightResponse) => {
    if (matches(response)) {
      observedResponses.push(response)
    }
  }

  page.on('response', collectResponse)
  try {
    await waitForEnabledAndClick(page, testId)

    const response = await Promise.race([
      page.waitForResponse(matches, { timeout }).catch(() => null),
      page.getByTestId(successTestId).waitFor({ state: 'visible', timeout }).then(() => null),
    ])

    return response ?? observedResponses.find((candidate) => candidate.ok()) ?? observedResponses[0] ?? null
  } finally {
    page.off('response', collectResponse)
  }
}

async function isConsentVisible(page: Page): Promise<boolean> {
  return (
    await page.getByTestId('consent-screen').isVisible({ timeout: 500 }).catch(() => false)
  ) || (
    await page.getByRole('heading', { name: /Privacy & Consent/i }).isVisible({ timeout: 500 }).catch(() => false)
  )
}

async function acceptConsentIfPresent(page: Page): Promise<boolean> {
  if (!(await isConsentVisible(page))) {
    return false
  }

  if (!(await clickIfPresent(page, 'consent-checkbox-pa-cons-privacy'))) {
    await page.getByRole('checkbox', { name: /I agree to Privacy and Health Data Use/i }).click()
  }
  await page.waitForTimeout(250)
  if (!(await clickIfPresent(page, 'consent-checkbox-pa-cons-educational'))) {
    await page.getByRole('checkbox', { name: /I understand SpineSense is educational use only/i }).click()
  }
  await page.waitForTimeout(250)
  if (!(await clickIfPresent(page, 'consent-checkbox-pa-cons-ai-analysis'))) {
    await page.getByRole('checkbox', { name: /I authorize AI-assisted assessment/i }).click()
  }
  await page.waitForTimeout(250)

  if (await page.getByTestId('consent-accept').isVisible({ timeout: 1000 }).catch(() => false)) {
    await waitForEnabledAndClick(page, 'consent-accept')
  } else {
    const accept = page.getByRole('button', { name: /Accept & Continue/i })
    await expect(accept).toBeEnabled({ timeout: 30_000 })
    await accept.click()
  }
  return true
}

async function waitForFirstVisibleEnabledAndClick(page: Page, testId: string, timeout = 30_000) {
  const locators = page.getByTestId(testId)
  await expect(locators.first()).toBeVisible({ timeout })

  const count = await locators.count()
  for (let index = 0; index < count; index += 1) {
    const locator = locators.nth(index)
    if (!(await locator.isVisible({ timeout: 1000 }).catch(() => false))) continue
    await expect(locator).toBeEnabled({ timeout })
    await locator.scrollIntoViewIfNeeded()
    await locator.click()
    return
  }

  throw new Error(`No visible enabled control found for ${testId}`)
}

function answerValues(value: AssessmentAnswer['value']): readonly (string | number)[] {
  return typeof value === 'string' || typeof value === 'number' ? [value] : value
}

const DYNAMIC_OPTION_LABEL_PREFERENCES = [
  /^same all day$/i,
  /^no$/i,
  /^none$/i,
  /^not sure$/i,
  /^no change$/i,
  /^constant$/i,
  /^under 10 min/i,
  /^later in the day$/i,
  /^driving$/i,
  /^sitting$/i,
  /^walking$/i,
  /^somewhat helpful$/i,
  /^mild$/i,
  /^physical therapy$/i,
]

async function findVisibleCandidate(
  page: Page,
  candidates: readonly string[],
): Promise<Locator | null> {
  for (const testId of candidates) {
    const locators = page.getByTestId(testId)
    const count = await locators.count()
    for (let index = 0; index < count; index += 1) {
      const locator = locators.nth(index)
      await locator.scrollIntoViewIfNeeded().catch(() => undefined)
      if (await locator.isVisible({ timeout: 1000 }).catch(() => false)) {
        return locator
      }
    }
  }
  return null
}

async function clickPreferredVisibleOption(page: Page): Promise<boolean> {
  const visibleOptions: Array<{ label: string; locator: Locator }> = []
  for (const role of ['button', 'checkbox', 'radio'] as const) {
    const optionControls = page.getByRole(role, { name: /^Option \d+ of \d+:/ })
    const count = await optionControls.count()

    for (let index = 0; index < count; index += 1) {
      const locator = optionControls.nth(index)
      if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) continue
      const accessibleName = await locator.getAttribute('aria-label')
      const label =
        accessibleName?.replace(/^Option \d+ of \d+:\s*/i, '').trim() ??
        (await locator.textContent().catch(() => ''))?.trim() ??
        ''
      if (label.length > 0) {
        visibleOptions.push({ label, locator })
      }
    }
  }
  if (visibleOptions.length === 0) return false

  for (const preference of DYNAMIC_OPTION_LABEL_PREFERENCES) {
    const option = visibleOptions.find((candidate) => preference.test(candidate.label))
    if (option != null) {
      await option.locator.click()
      return true
    }
  }

  await visibleOptions[0]!.locator.click()
  return true
}

async function clickScreeningSubmitIfPresent(page: Page, timeout = 30_000): Promise<boolean> {
  const footerSubmit = page.getByTestId('screening-nav-next')
  if (await footerSubmit.isVisible({ timeout: 1000 }).catch(() => false)) {
    if (!(await isScreeningSubmitButton(page))) return false
    await expect(footerSubmit).toBeEnabled({ timeout })
    await footerSubmit.click()
    await page.waitForTimeout(500)
    if (!(await footerSubmit.isVisible({ timeout: 500 }).catch(() => false))) return true
    return true
  }

  const submit = page.getByRole('button', { name: /submit answers/i }).first()
  if (await submit.isVisible({ timeout }).catch(() => false)) {
    await expect(submit).toBeEnabled({ timeout })
    await submit.click({ timeout: 10_000 })
    await page.waitForTimeout(500)
    if (!(await submit.isVisible({ timeout: 500 }).catch(() => false))) return true
    return true
  }

  return false
}

const POST_SCREENING_STAGE_TEST_IDS = [
    'adaptive-loading-state',
    'adaptive-loading-error-state',
    'adaptive-screen',
    'adaptive-error-state',
    'review-screen',
    'assessment-processing',
    'results-screen',
    'home-screen',
  ] as const

async function submitScreening(page: Page) {
  const existingStage = await waitForAnyVisibleTestId(page, POST_SCREENING_STAGE_TEST_IDS, 1000).catch(() => null)
  if (existingStage != null) return

  await expect(page.getByTestId('screening-nav-next')).toBeVisible({ timeout: 30_000 })

  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(await clickScreeningSubmitIfPresent(page)).toBe(true)
    const nextStage = await waitForAnyVisibleTestId(page, POST_SCREENING_STAGE_TEST_IDS, 20_000).catch(() => null)
    if (nextStage != null) return
  }

  await waitForAnyVisibleTestId(page, POST_SCREENING_STAGE_TEST_IDS, 120_000)
}

async function fillVisibleDynamicTextbox(page: Page): Promise<boolean> {
  const textboxes = page.getByRole('textbox')
  const count = await textboxes.count()
  for (let index = 0; index < count; index += 1) {
    const locator = textboxes.nth(index)
    if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) continue
    await locator.fill(
      'Synthetic E2E note: symptoms are mostly low-back pain and sitting or bending can make them worse.',
    )
    return true
  }
  return false
}

function answerCandidateTestIds(prefix: string, id: string, value: string | number): string[] {
  const normalized = String(value)
  return [
    `${prefix}-${id}-option-${normalized}`,
    `${prefix}-${id}-stop-${normalized}`,
    `${prefix}-${id}-zone-${normalized}`,
    `${prefix}-${id}-region-${normalized}`,
    `${prefix}-${id}-acknowledge-btn`,
  ]
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function answerLabelCandidates(value: string | number): string[] {
  const normalized = String(value)
  const spaced = normalized.replaceAll('_', ' ')
  const explicit: Record<string, string[]> = {
    none: ['None of these', 'None'],
    pain: ['Pain or tingling', 'Pain'],
    pain_tingling: ['Pain or tingling'],
    numbness_tingling: ['Numbness', 'Numbness or tingling'],
    no_walking_problem: ["I don't really have a walking problem"],
    none_now: ['None currently'],
    not_applicable: ['Not applicable', 'Not applicable — leg symptoms do not force me to stop walking'],
    one_ongoing_problem: ["It's all one ongoing problem"],
    same_all_day: ['Same all day'],
    not_sure: ['Not sure'],
    no_change: ['No change'],
    lt_10_min: ['Under 10 min', 'Less than 10 min'],
    under_10_min: ['Under 10 min', 'Less than 10 min'],
  }
  return [...(explicit[normalized] ?? []), spaced, normalized]
}

async function answerOneValue(page: Page, prefix: string, id: string, value: string | number) {
  const normalized = String(value)
  const locator = await findVisibleCandidate(page, answerCandidateTestIds(prefix, id, value))
  if (locator != null) {
    await locator.click()
    return
  }

  if (typeof value === 'number') {
    const painLevel = page.getByRole('radio', {
      name: new RegExp(`^Pain level ${normalized}\\b`, 'i'),
    }).first()
    if (await painLevel.isVisible({ timeout: 1000 }).catch(() => false)) {
      await painLevel.click()
      return
    }
  }

  for (const label of answerLabelCandidates(value)) {
    const exactOptionLabel = new RegExp(`^Option \\d+ of \\d+:\\s*${escapeRegExp(label)}$`, 'i')
    const exactLabel = new RegExp(`^${escapeRegExp(label)}$`, 'i')
    for (const role of ['radio', 'checkbox'] as const) {
      for (const name of [exactOptionLabel, exactLabel]) {
        const control = page.getByRole(role, { name }).first()
        if (await control.isVisible({ timeout: 500 }).catch(() => false)) {
          await control.click()
          return
        }
      }
    }
  }

  const input = page.getByTestId(`${prefix}-${id}-input`)
  if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
    await input.fill(normalized)
    return
  }

  if (normalized === 'acknowledged') {
    const acknowledge = page.getByRole('button', { name: /i understand|acknowledge/i }).first()
    if (await acknowledge.isVisible({ timeout: 1000 }).catch(() => false)) {
      await acknowledge.click()
      return
    }
  }

  throw new Error(`No visible control found for ${prefix}-${id}=${normalized}`)
}

async function isEnabled(page: Page, testId: string): Promise<boolean> {
  const locator = await actionableLocatorForTestId(page, testId)
  if (!(await locator.isVisible({ timeout: 500 }).catch(() => false))) return false
  return locator.isEnabled({ timeout: 500 }).catch(() => false)
}

async function answerQuestion(page: Page, prefix: string, answer: AssessmentAnswer) {
  for (const value of answerValues(answer.value)) {
    await answerOneValue(page, prefix, answer.id, value)
  }
}

async function answerTextQuestion(page: Page, prefix: string, answer: TextAnswer) {
  const input = page.getByTestId(`${prefix}-${answer.id}-input`)
  if (!(await input.isVisible({ timeout: 1000 }).catch(() => false))) return false
  await input.scrollIntoViewIfNeeded()
  await input.fill(answer.text)
  return true
}

async function currentVisibleScreeningQuestionId(page: Page): Promise<string> {
  const visibleQuestionIds = await page
    .locator('[data-testid^="question-"]:visible')
    .evaluateAll((elements) => {
      const ids: string[] = []
      for (const element of elements) {
        const testId = element.getAttribute('data-testid')
        const match = /^question-([A-Za-z0-9_]+)$/.exec(testId ?? '')
        if (match?.[1] != null) {
          ids.push(match[1])
        }
      }
      return ids
    })

  if (visibleQuestionIds.length === 0) {
    throw new Error('No current visible screening question container was found')
  }

  return visibleQuestionIds[0]!
}

async function currentVisibleScreeningAnswer(page: Page): Promise<AssessmentAnswer> {
  const questionId = await currentVisibleScreeningQuestionId(page)
  const answer = SCREENING_ANSWERS_BY_ID.get(questionId)
  if (answer == null) {
    throw new Error(`No screening fixture answer is defined for current question ${questionId}`)
  }

  return answer
}

async function waitForScreeningNavIdle(page: Page, timeout = 30_000) {
  const next = page.getByTestId('screening-nav-next')
  await expect(next).toBeVisible({ timeout })
  await expect(next).not.toHaveAttribute('aria-busy', 'true', { timeout })
  await expect(next).not.toContainText(/Saving/i, { timeout })
}

async function isScreeningSubmitButton(page: Page): Promise<boolean> {
  const next = page.getByTestId('screening-nav-next')
  if (!(await next.isVisible({ timeout: 500 }).catch(() => false))) return false

  const [ariaLabel, text] = await Promise.all([
    next.getAttribute('aria-label').catch(() => null),
    next.innerText().catch(() => ''),
  ])

  if (!/submit answers/i.test(`${ariaLabel ?? ''} ${text}`)) return false

  const currentQuestionId = await currentVisibleScreeningQuestionId(page).catch(() => null)
  return currentQuestionId === FINAL_SCREENING_QUESTION_ID
}

async function waitForScreeningAdvance(page: Page, previousQuestionId: string, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const postScreeningStage = await waitForAnyVisibleTestId(page, POST_SCREENING_STAGE_TEST_IDS, 250).catch(() => null)
    if (postScreeningStage != null) {
      return
    }

    const screeningNavGone = !(await page.getByTestId('screening-nav-next').isVisible({ timeout: 250 }).catch(() => false))
    if (screeningNavGone) {
      return
    }

    if (await page.getByTestId('screening-section-transition-continue').isVisible({ timeout: 250 }).catch(() => false)) {
      await maybeContinueSectionTransition(page)
      continue
    }

    const currentQuestionId = await currentVisibleScreeningQuestionId(page).catch(() => null)
    if (currentQuestionId != null && currentQuestionId !== previousQuestionId) {
      await waitForScreeningNavIdle(page)
      return
    }

    await page.waitForTimeout(250)
  }

  throw new Error(`Timed out waiting for screening question ${previousQuestionId} to advance`)
}

async function clickScreeningNextAndWaitForAdvance(page: Page, previousQuestionId: string) {
  const next = page.getByTestId('screening-nav-next')

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await waitForEnabledAndClick(page, 'screening-nav-next', 30_000, 1)

    try {
      await waitForScreeningAdvance(page, previousQuestionId, attempt === 2 ? 60_000 : 20_000)
      return
    } catch (error) {
      const currentQuestionId = await currentVisibleScreeningQuestionId(page).catch(() => null)
      if (attempt === 2 || currentQuestionId !== previousQuestionId) {
        throw error
      }

      await waitForScreeningNavIdle(page, 10_000)
      if (!(await next.isEnabled({ timeout: 500 }).catch(() => false))) {
        throw error
      }
    }
  }
}

async function expectNoAssessmentBlockingState(page: Page) {
  await expect(page.getByTestId('emergency-screen')).toBeHidden({ timeout: 500 })
  await expect(page.getByTestId('adaptive-loading-error-state')).toBeHidden({ timeout: 500 })
  await expect(page.getByTestId('adaptive-error-state')).toBeHidden({ timeout: 500 })
  await expect(page.getByTestId('assessment-processing-failed')).toBeHidden({ timeout: 500 })
}

async function stressReloadCurrentScreeningQuestion(page: Page) {
  const questionIdBeforeReload = await currentVisibleScreeningQuestionId(page)
  logMilestone(`stress: reloading during screening at ${questionIdBeforeReload}`)

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 })
  await expect(page.getByTestId('screening-screen')).toBeVisible({ timeout: 60_000 })
  await waitForScreeningNavIdle(page, 60_000)
  await expectNoBrowserStorage(page)

  const questionIdAfterReload = await currentVisibleScreeningQuestionId(page)
  expect(questionIdAfterReload).toBe(questionIdBeforeReload)
  await expectNoAssessmentBlockingState(page)
}

async function stressBacktrackOneScreeningQuestion(
  page: Page,
  previousQuestionId: string,
  expectedCurrentQuestionId: string,
) {
  logMilestone(`stress: backtracking from ${expectedCurrentQuestionId} to ${previousQuestionId}`)

  await waitForEnabledAndClick(page, 'screening-nav-back')
  await waitForScreeningAdvance(page, expectedCurrentQuestionId, 30_000)
  await waitForScreeningNavIdle(page)
  expect(await currentVisibleScreeningQuestionId(page)).toBe(previousQuestionId)

  await clickScreeningNextAndWaitForAdvance(page, previousQuestionId)
  await waitForScreeningNavIdle(page)
  expect(await currentVisibleScreeningQuestionId(page)).toBe(expectedCurrentQuestionId)
  await expectNoAssessmentBlockingState(page)
}

async function answerScreening(page: Page) {
  await expect(page.getByTestId('screening-nav-next')).toBeVisible({ timeout: 60_000 })
  const stressState: ScreeningStressState = {
    reloadedDuringScreening: false,
    backtrackedDuringScreening: false,
  }

  for (let questionIndex = 0; questionIndex < 80; questionIndex += 1) {
    const postScreeningStage = await waitForAnyVisibleTestId(page, POST_SCREENING_STAGE_TEST_IDS, 250).catch(() => null)
    if (postScreeningStage != null) return

    const screeningNavGone = !(await page.getByTestId('screening-nav-next').isVisible({ timeout: 250 }).catch(() => false))
    if (screeningNavGone) return

    const questionId = await currentVisibleScreeningQuestionId(page)
    const textAnswer = SCREENING_TEXT_ANSWERS_BY_ID.get(questionId)
    if (textAnswer != null && (await answerTextQuestion(page, 'question', textAnswer))) {
      // Text answer entered.
    } else {
      const answer = SCREENING_ANSWERS_BY_ID.get(questionId)
      if (answer == null) {
        throw new Error(`No screening fixture answer is defined for current question ${questionId}`)
      }
      await answerQuestion(page, 'question', answer)
    }

    await expect(
      page.getByTestId('screening-nav-next'),
      `Expected fixture answer ${questionId} to enable screening navigation`,
    ).toBeEnabled({ timeout: 30_000 })

    if (await isScreeningSubmitButton(page)) {
      return
    }

    await clickScreeningNextAndWaitForAdvance(page, questionId)
    await expectNoAssessmentBlockingState(page)

    if (
      ENABLE_FULL_ASSESSMENT_STRESS &&
      !stressState.reloadedDuringScreening &&
      questionId === STRESS_RELOAD_AFTER_SCREENING_QUESTION_ID
    ) {
      await stressReloadCurrentScreeningQuestion(page)
      stressState.reloadedDuringScreening = true
    }

    if (
      ENABLE_FULL_ASSESSMENT_STRESS &&
      !stressState.backtrackedDuringScreening &&
      questionId === STRESS_BACKTRACK_AFTER_SCREENING_QUESTION_ID
    ) {
      const expectedCurrentQuestionId = await currentVisibleScreeningQuestionId(page)
      await stressBacktrackOneScreeningQuestion(page, questionId, expectedCurrentQuestionId)
      stressState.backtrackedDuringScreening = true
    }
  }

  throw new Error('Timed out answering screening questions before reaching submit')
}

async function answerVisibleDynamicQuestions(
  page: Page,
  prefix: 'adaptive-question',
  options: readonly AssessmentAnswer[],
  textAnswers: readonly TextAnswer[],
  submitTestId: string,
) {
  let answered = 0
  for (const answer of textAnswers) {
    if (await answerTextQuestion(page, prefix, answer)) answered += 1
  }
  for (const answer of options) {
    try {
      await answerQuestion(page, prefix, answer)
      answered += 1
    } catch {
      // Live LLM may omit candidate questions. Required visible questions are
      // handled by the submit-enabled assertion below.
    }
  }
  if (!(await isEnabled(page, submitTestId)) && (await clickPreferredVisibleOption(page))) {
    answered += 1
  }
  if (!(await isEnabled(page, submitTestId)) && (await fillVisibleDynamicTextbox(page))) {
    answered += 1
  }

  return answered
}

async function completeAdaptiveIfPresent(page: Page): Promise<string | null> {
  const adaptiveScreen = page.getByTestId('adaptive-screen')
  let initialStage = await waitForAssessmentStage(page, [
    'adaptive-loading-state',
    'adaptive-loading-error-state',
    'adaptive-screen',
    'adaptive-error-state',
  ])
  for (let retryAttempt = 0; retryAttempt < 3; retryAttempt += 1) {
    if (initialStage === 'adaptive-loading-error-state') {
      await waitForEnabledAndClick(page, 'adaptive-loading-retry')
      initialStage = await waitForRetryOutcome(page, 'adaptive-loading-error-state', [
        'adaptive-loading-state',
        'adaptive-screen',
        'adaptive-error-state',
      ])
    }

    if (initialStage === 'adaptive-loading-state') {
      initialStage = await waitForAssessmentStage(page, [
        'adaptive-loading-error-state',
        'adaptive-screen',
        'adaptive-error-state',
      ])
      continue
    }

    break
  }
  if (initialStage !== 'adaptive-screen') return initialStage

  await expect(page.getByTestId('adaptive-list')).toBeVisible({ timeout: 30_000 })
  for (let index = 0; index < 20; index += 1) {
    if (!(await adaptiveScreen.isVisible({ timeout: 1000 }).catch(() => false))) {
      return waitForAnyVisibleTestId(
        page,
        ['review-screen'],
        60_000,
      ).catch(() => 'left-adaptive-screen')
    }
    await answerVisibleDynamicQuestions(
      page,
      'adaptive-question',
      fullAssessmentScenario.adaptive,
      fullAssessmentScenario.adaptiveText,
      'adaptive-submit',
    )
    const currentQuestionTestId = await visibleDynamicQuestionTestId(page, 'adaptive-question')
    await waitForEnabledAndClick(page, 'adaptive-submit')
    const nextStage = await waitForDynamicQuestionAdvance(
      page,
      'adaptive-screen',
      'adaptive-question',
      currentQuestionTestId,
      'adaptive-submit',
      [
        'adaptive-loading-state',
        'adaptive-error-state',
        'review-screen',
      ],
    )
    if (nextStage !== 'adaptive-screen') return nextStage
  }

  throw new Error('Adaptive questionnaire did not exit after 20 questions')
}

async function waitForAnalysisReadyAndConfirm(page: Page) {
  const analysisStage = await waitForAnyVisibleTestId(
    page,
    ['results-ready-confirm', 'assessment-processing-failed'],
    480_000,
  )
  if (analysisStage === 'assessment-processing-failed') {
    const failureReason = await page
      .getByTestId('processing-failure-reason')
      .textContent({ timeout: 1000 })
      .catch(() => null)
    throw new Error(
      `Assessment analysis failed during full E2E${failureReason ? `: ${sanitizeDiagnostic(failureReason)}` : ''}`,
    )
  }

  await waitForEnabledAndClick(page, 'results-ready-confirm', 30_000)
}

async function completeProfileIfPresent(page: Page) {
  if (!(await page.getByTestId('step-profile').isVisible({ timeout: 1000 }).catch(() => false))) {
    return
  }

  const { onboarding } = fullAssessmentScenario
  await fillByTestId(page, 'profile-dob', onboarding.dateOfBirthDisplay)
  await clickByTestId(page, `profile-sex-${onboarding.sexAtBirth}`)
  await fillByTestId(page, 'profile-height-ft', onboarding.heightFeet)
  await fillByTestId(page, 'profile-height-in', onboarding.heightInches)
  await fillByTestId(page, 'profile-weight', onboarding.weightPounds)
  await fillByTestId(page, 'profile-occupation', onboarding.occupation)
  await clickByTestId(page, `profile-activity-${onboarding.activityLevel}`)
  await waitForEnabledAndClick(page, 'profile-continue-btn')
}

async function continueWelcomeIntroIfPresent(page: Page): Promise<boolean> {
  const stage = await waitForAnyVisibleTestId(
    page,
    ['welcome-intro-screen', 'onboarding-layout'],
    10_000,
  ).catch(async () => {
    const welcomeCta = page.getByRole('button', { name: /let's begin/i })
    if (await welcomeCta.isVisible({ timeout: 1_000 }).catch(() => false)) {
      return 'welcome-intro-screen'
    }
    throw new Error(
      "Neither onboarding test IDs nor the visible welcome intro CTA became visible",
    )
  })
  if (stage !== 'welcome-intro-screen') {
    return false
  }

  if (!(await clickIfPresent(page, 'welcome-intro-begin'))) {
    await page.getByRole('button', { name: /let's begin/i }).click()
  }
  return true
}

async function expectTreatmentHistoryAfterStorySave(page: Page) {
  await expect(page.getByTestId('medical-history-conditions-none')).toBeVisible({ timeout: 60_000 })
}

async function expectChiefComplaintAfterProfileSave(page: Page) {
  await expect
    .poll(
      async () =>
        (await page.getByTestId('step-chief-complaint-select').isVisible({ timeout: 1000 }).catch(() => false)) ||
        (await page.getByTestId('chief-complaint-text-option').isVisible({ timeout: 1000 }).catch(() => false)) ||
        (await page.getByText(/Tell us what's/i).isVisible({ timeout: 1000 }).catch(() => false)),
      {
        timeout: 60_000,
        message: 'Expected chief complaint step after profile save',
      },
    )
    .toBe(true)
}

async function expectImagingRecordsAfterHistorySave(page: Page) {
  await expect
    .poll(
      async () =>
        (await page.getByTestId('records-continue-btn').isVisible({ timeout: 1000 }).catch(() => false)) ||
        (await page.getByTestId('step-imaging-records').isVisible({ timeout: 1000 }).catch(() => false)) ||
        (await page.getByRole('button', { name: /complete intake/i }).isVisible({ timeout: 1000 }).catch(() => false)) ||
        (await page.getByText(/Bring in your records/i).isVisible({ timeout: 1000 }).catch(() => false)),
      {
        timeout: 60_000,
        message: 'Expected imaging records step after treatment history save',
      },
    )
    .toBe(true)
}

async function clickRecordsContinue(page: Page) {
  if (await page.getByTestId('records-continue-btn').isVisible({ timeout: 1000 }).catch(() => false)) {
    await waitForEnabledAndClick(page, 'records-continue-btn')
    return
  }

  const skip = page.getByRole('button', { name: /skip for now/i })
  if (await skip.isVisible({ timeout: 1000 }).catch(() => false)) {
    await expect(skip).toBeEnabled({ timeout: 30_000 })
    await skip.click({ timeout: 10_000 })
    return
  }

  const complete = page.getByRole('button', { name: /complete intake/i })
  await expect(complete).toBeVisible({ timeout: 30_000 })
  await expect(complete).toBeEnabled({ timeout: 30_000 })
  await complete.click({ timeout: 10_000 })
}

async function clickChiefComplaintSave(page: Page) {
  if (await page.getByTestId('text-save-btn').isVisible({ timeout: 1000 }).catch(() => false)) {
    await waitForEnabledAndClick(page, 'text-save-btn')
    return
  }

  const save = page.getByRole('button', { name: /save and continue/i })
  await expect(save).toBeVisible({ timeout: 30_000 })
  await expect(save).toBeEnabled({ timeout: 30_000 })
  await save.click({ timeout: 10_000 })
}

async function waitForAssessmentEntry(page: Page): Promise<string> {
  let firstAssessmentScreen = await waitForAnyVisibleTestId(
    page,
    [
      'home-screen',
      'assessment-entry-guard',
      'screening-screen',
      'story-capture',
      'story-screen',
    ],
    120_000,
  )

  if (firstAssessmentScreen === 'home-screen') {
    await expect(page.getByTestId('start-assessment-btn').first()).toBeVisible()
    await expectNoBrowserStorage(page)
    await waitForFirstVisibleEnabledAndClick(page, 'start-assessment-btn')
    firstAssessmentScreen = await waitForAnyVisibleTestId(page, [
      'screening-screen',
      'story-capture',
      'story-screen',
    ])
  }

  if (firstAssessmentScreen === 'assessment-entry-guard') {
    firstAssessmentScreen = await waitForAnyVisibleTestId(page, [
      'screening-screen',
      'story-capture',
      'story-screen',
    ], 120_000)
  }

  return firstAssessmentScreen
}

test.describe('patient web full assessment flow', () => {
  test.beforeEach(async ({ request }) => {
    await resetBackend(request)
  })

  test.beforeEach(async ({ page }) => {
    installPhiSafeDiagnostics(page)
  })

  test('registers a new patient and completes assessment to home @full-assessment', async ({
    page,
    request,
  }) => {
    test.setTimeout(FULL_FLOW_TIMEOUT_MS)

    let email = uniqueSyntheticEmail()
    const { registration, onboarding } = fullAssessmentScenario

    logMilestone('reset complete; warming csrf')
    await warmCsrfSession(page)
    logMilestone('csrf warm; opening welcome')
    await gotoWelcome(page)
    logMilestone('welcome visible; opening registration')
    await clickWelcomeGetStarted(page)

    await expect(page.getByTestId('register-screen')).toBeVisible({ timeout: 30_000 })
    logMilestone('registration screen visible; submitting registration')
    await fillByTestId(page, 'register-first-name', registration.firstName)
    await fillByTestId(page, 'register-last-name', registration.lastName)
    await fillByTestId(page, 'register-email', email)
    await fillByTestId(page, 'register-password', registration.password)
    await fillByTestId(page, 'register-confirm-password', registration.password)
    await clickIfPresent(page, 'register-consent-storage')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const registerResponse = await clickAndWaitForResponseOrSuccess({
        page,
        testId: 'register-submit',
        successTestId: 'verify-screen',
        matches: (response) =>
          response.url().includes('/api/auth/register') &&
          response.request().method() === 'POST',
      })
      if (registerResponse != null) {
        expect(registerResponse.ok()).toBeTruthy()
        await expectNoTokenLeak(await registerResponse.text())
      }
      expect(page.url()).not.toContain('verification')

      if (await page.getByTestId('verify-screen').isVisible({ timeout: 10_000 }).catch(() => false)) {
        break
      }
      if (attempt === 2) {
        await expect(page.getByTestId('verify-screen')).toBeVisible({ timeout: 60_000 })
        break
      }

      logMilestone('registration submitted without verification transition; retrying with fresh email')
      email = uniqueSyntheticEmail()
      await fillByTestId(page, 'register-email', email)
    }

    await expect(page.getByTestId('verify-screen')).toBeVisible({ timeout: 60_000 })
    logMilestone('verification screen visible; checking browser storage')
    await expectNoBrowserStorage(page)

    const verificationCode = await getRegistrationVerificationCode(request, email, registration.verificationCode)
    await fillByTestId(page, 'verify-otp-digit-0', verificationCode)
    logMilestone('verification code entered; submitting verification')
    const verifyResponse = await clickAndWaitForResponse({
      page,
      testId: 'verify-submit',
      matches: (response) =>
        response.url().includes('/api/auth/verify/registration/confirm') &&
        response.request().method() === 'POST',
    })
    expect(verifyResponse.ok()).toBeTruthy()
    await expectNoTokenLeak(await verifyResponse.text())
    expect(page.url()).not.toContain('verification')
    logMilestone('verification accepted; checking authenticated cookie session')
    await expectAuthenticatedCookieSession(page)

    logMilestone('authenticated cookies verified; waiting for consent')
    await expectConsentScreenAfterVerification(page)
    logMilestone('consent screen visible; accepting consent')
    await acceptConsentIfPresent(page)

    logMilestone('consent accepted; continuing welcome intro')
    await continueWelcomeIntroIfPresent(page)
    await expect(page.getByTestId('onboarding-layout')).toBeVisible({ timeout: 60_000 })
    logMilestone('onboarding layout visible; filling onboarding')
    await completeProfileIfPresent(page)
    await expectChiefComplaintAfterProfileSave(page)
    await clickByTestId(page, 'chief-complaint-text-option')
    await expect(page.getByTestId('step-chief-complaint-text')).toBeVisible()
    await fillByTestId(page, 'narrative-input', onboarding.chiefComplaint)
    await clickChiefComplaintSave(page)
    await expectTreatmentHistoryAfterStorySave(page)
    await clickByTestId(page, 'medical-history-conditions-none')
    await waitForEnabledAndClick(page, 'medical-history-continue-btn')

    await expectImagingRecordsAfterHistorySave(page)
    await clickRecordsContinue(page)

    const firstAssessmentScreen = await waitForAssessmentEntry(page)
    if (firstAssessmentScreen === 'story-capture' || firstAssessmentScreen === 'story-screen') {
      await clickByTestId(page, 'story-capture-text-tab')
      await fillByTestId(page, 'story-capture-text-input', fullAssessmentScenario.assessmentStory)
      await page.getByTestId('story-capture-text-input').blur()
      await waitForEnabledAndClick(page, 'story-capture-continue-btn')

      await expect(page.getByTestId('documents-screen')).toBeVisible({ timeout: 60_000 })
      await clickByTestId(page, 'documents-skip-btn')
    }

    await expect(page.getByTestId('screening-screen')).toBeVisible({ timeout: 60_000 })
    await answerScreening(page)
    await submitScreening(page)

    const postAdaptiveStage = await completeAdaptiveIfPresent(page)
    if (postAdaptiveStage !== 'review-screen') {
      throw new Error(`Expected review-screen after adaptive flow, got ${postAdaptiveStage}`)
    }
    await expect(page.getByTestId('review-screen')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('review-ready-icon')).toBeVisible()
    await expect(page.getByTestId('review-ready-title')).toBeVisible()
    await expect(page.getByText('ASSESSMENT COMPLETE')).toBeVisible()
    await expect(page.getByText(/build your personalized clinical picture/i)).toBeVisible()
    await waitForEnabledAndClick(page, 'review-submit')

    await expect(page.getByTestId('assessment-processing')).toBeVisible({
      timeout: 30_000,
    })
    await waitForAnalysisReadyAndConfirm(page)
    await expect(page.getByTestId('results-screen')).toBeVisible({
      timeout: 480_000,
    })
    await expect(page.getByText('Assessment Results')).toBeVisible()
    await expect(page.getByTestId('results-disclaimer')).toBeVisible()
    await expect(page.getByTestId('results-diagnosis')).toBeVisible()
    await page.getByTestId('sticky-tab-wrapper').scrollIntoViewIfNeeded()
    await expect(page.getByText('Treatment Strategy')).toBeVisible()
    await expect(page.getByTestId('results-treatment')).toBeVisible()
    await expect(page.getByTestId('results-self-care')).toBeVisible()
    await expect(page.getByTestId('results-share')).toBeVisible()
    await expect(page.getByTestId('results-share')).toBeEnabled()
    await expect(page.getByTestId('results-share')).toHaveAttribute(
      'aria-label',
      'Open PDF report options',
    )
    await page.getByTestId('results-share').click()
    await expect(page.getByTestId('results-report-options')).toBeVisible()
    await expect(page.getByTestId('results-report-options-generate')).toHaveAttribute(
      'aria-label',
      'Generate PDF',
    )
    const reportResponse = await clickAndWaitForResponse({
      page,
      testId: 'results-report-options-generate',
      matches: isAssessmentReportGenerationResponse,
      retryErrorTestId: 'results-report-error',
      timeout: 120_000,
      attempts: 2,
    })
    expect(reportResponse.status()).toBe(201)
    await expect(page.getByTestId('results-report-error')).toBeHidden()
    await waitForEnabledAndClick(page, 'tab-home', 30_000)

    await expect(page.locator('[data-testid="home-screen"]:visible')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('assessment-entry-banner')).toBeHidden()
    await expect(page.locator('[data-testid="clinical-summary-card"]:visible')).toBeVisible()
    await expect(page.locator('[data-testid="summary-headline"]:visible')).toBeVisible()
    await expect(page.locator('[data-testid="active-problems-card"]:visible')).toBeVisible()
    await expectNoBrowserStorage(page)
  })
})
