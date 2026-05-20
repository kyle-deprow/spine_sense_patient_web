import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

import { fullAssessmentScenario } from './fixtures/fullAssessmentScenario'

const BACKEND_RESET_URL = process.env.PATIENT_WEB_BACKEND_RESET_URL
const EXPECT_SECURE_COOKIES = process.env.PATIENT_WEB_EXPECT_SECURE_COOKIES === 'true'
const FULL_FLOW_TIMEOUT_MS = 10 * 60 * 1000

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

function uniqueSyntheticEmail(): string {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  return `casey.assessment.${unique}@e2e.example.com`
}

function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/https?:\/\/[^/\s)]+/g, '[origin]')
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,
      '[uuid]',
    )
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]')
    .replace(/"verification_token"\s*:\s*"[^"]+"/gi, '"verification_token":"[token]"')
    .replace(/"verificationToken"\s*:\s*"[^"]+"/gi, '"verificationToken":"[token]"')
    .replace(/"mfa_token"\s*:\s*"[^"]+"/gi, '"mfa_token":"[token]"')
    .replace(/"access_token"\s*:\s*"[^"]+"/gi, '"access_token":"[token]"')
    .replace(/"refresh_token"\s*:\s*"[^"]+"/gi, '"refresh_token":"[token]"')
    .slice(0, 800)
}

function installPhiSafeDiagnostics(page: Page) {
  page.on('console', (message) => {
    if (!['error', 'warning'].includes(message.type())) return
    console.log(`[browser:${message.type()}] ${sanitizeDiagnostic(message.text())}`)
  })
  page.on('pageerror', (error) => {
    console.log(`[pageerror] ${sanitizeDiagnostic(error.message)}`)
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    const url = new URL(response.url())
    console.log(`[response:${response.status()}] ${url.pathname}`)
  })
}

async function resetBackend(request: APIRequestContext) {
  if (!BACKEND_RESET_URL) {
    throw new Error('PATIENT_WEB_BACKEND_RESET_URL is required for full assessment E2E')
  }

  const response = await request.post(BACKEND_RESET_URL)
  const responseText = await response.text()
  expect(
    response.ok(),
    `backend reset failed status=${response.status()} body=${sanitizeDiagnostic(responseText)}`,
  ).toBeTruthy()
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

async function byTestId(page: Page, testId: string): Promise<Locator> {
  const locator = page.getByTestId(testId)
  await locator.scrollIntoViewIfNeeded()
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
      if (await page.getByTestId(testId).isVisible({ timeout: 500 }).catch(() => false)) {
        return testId
      }
    }
    await page.waitForTimeout(250)
  }

  throw new Error(`None of these test IDs became visible: ${testIds.join(', ')}`)
}

async function maybeContinueSectionTransition(page: Page) {
  await clickIfPresent(page, 'screening-section-transition-continue')
}

async function waitForEnabledAndClick(page: Page, testId: string, timeout = 30_000) {
  const locator = page.getByTestId(testId)
  await expect(locator).toBeVisible({ timeout })
  await expect(locator).toBeEnabled({ timeout })
  await locator.scrollIntoViewIfNeeded()
  await locator.click()
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

async function answerOneValue(page: Page, prefix: string, id: string, value: string | number) {
  const normalized = String(value)
  const candidates = [
    `${prefix}-${id}-option-${normalized}`,
    `${prefix}-${id}-stop-${normalized}`,
    `${prefix}-${id}-zone-${normalized}`,
    `${prefix}-${id}-region-${normalized}`,
    `${prefix}-${id}-acknowledge-btn`,
  ]
  const locator = await findVisibleCandidate(page, candidates)
  if (locator != null) {
    await locator.click()
    return
  }

  const input = page.getByTestId(`${prefix}-${id}-input`)
  if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
    await input.fill(normalized)
    return
  }

  throw new Error(`No visible control found for ${prefix}-${id}=${normalized}`)
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

async function answerScreening(page: Page) {
  await expect(page.getByTestId('screening-nav-next')).toBeVisible({ timeout: 60_000 })
  for (const answer of fullAssessmentScenario.screening) {
    await answerQuestion(page, 'question', answer)
    await waitForEnabledAndClick(page, 'screening-nav-next')
    await maybeContinueSectionTransition(page)
    await expect(page.getByTestId('emergency-screen')).toBeHidden({ timeout: 500 }).catch(() => undefined)
  }
}

async function answerVisibleDynamicQuestions(
  page: Page,
  prefix: 'adaptive-question' | 'refinement-question',
  options: readonly AssessmentAnswer[],
  textAnswers: readonly TextAnswer[],
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

  return answered
}

async function completeAdaptiveIfPresent(page: Page) {
  const adaptiveScreen = page.getByTestId('adaptive-screen')
  if (!(await adaptiveScreen.isVisible({ timeout: 90_000 }).catch(() => false))) return

  await expect(page.getByTestId('adaptive-list')).toBeVisible({ timeout: 30_000 })
  await answerVisibleDynamicQuestions(
    page,
    'adaptive-question',
    fullAssessmentScenario.adaptive,
    fullAssessmentScenario.adaptiveText,
  )
  await waitForEnabledAndClick(page, 'adaptive-submit')
}

async function completeRefinementIfPresent(page: Page) {
  const refinementScreen = page.getByTestId('refinement-screen')
  if (!(await refinementScreen.isVisible({ timeout: 120_000 }).catch(() => false))) return

  await answerVisibleDynamicQuestions(
    page,
    'refinement-question',
    fullAssessmentScenario.refinement,
    fullAssessmentScenario.refinementText,
  )
  await waitForEnabledAndClick(page, 'refinement-submit')
}

async function completeProfileIfPresent(page: Page) {
  if (!(await page.getByTestId('step-profile').isVisible({ timeout: 1000 }).catch(() => false))) {
    return
  }

  const { registration, onboarding } = fullAssessmentScenario
  await fillByTestId(page, 'profile-first-name', registration.firstName)
  await fillByTestId(page, 'profile-last-name', registration.lastName)
  await fillByTestId(page, 'profile-dob', onboarding.dateOfBirthDisplay)
  await clickByTestId(page, `profile-sex-${onboarding.sexAtBirth}`)
  await fillByTestId(page, 'profile-height-ft', onboarding.heightFeet)
  await fillByTestId(page, 'profile-height-in', onboarding.heightInches)
  await fillByTestId(page, 'profile-weight', onboarding.weightPounds)
  await fillByTestId(page, 'profile-occupation', onboarding.occupation)
  await clickByTestId(page, `profile-activity-${onboarding.activityLevel}`)
  await waitForEnabledAndClick(page, 'profile-continue-btn')
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
  }) => {
    test.setTimeout(FULL_FLOW_TIMEOUT_MS)

    const email = uniqueSyntheticEmail()
    const { registration, onboarding } = fullAssessmentScenario

    await warmCsrfSession(page)
    await page.goto('/')
    await expect(page.getByTestId('welcome-screen')).toBeVisible({ timeout: 60_000 })
    await clickByTestId(page, 'welcome-get-started')

    await expect(page.getByTestId('register-screen')).toBeVisible({ timeout: 30_000 })
    await fillByTestId(page, 'register-first-name', registration.firstName)
    await fillByTestId(page, 'register-last-name', registration.lastName)
    await fillByTestId(page, 'register-email', email)
    await fillByTestId(page, 'register-date-of-birth', registration.dateOfBirth)
    await fillByTestId(page, 'register-password', registration.password)
    await fillByTestId(page, 'register-confirm-password', registration.password)
    await clickIfPresent(page, 'register-consent-storage')

    const registerResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/auth/register') &&
        response.request().method() === 'POST',
    )
    await waitForEnabledAndClick(page, 'register-submit')
    const registerResponse = await registerResponsePromise
    expect(registerResponse.ok()).toBeTruthy()
    await expectNoTokenLeak(await registerResponse.text())
    expect(page.url()).not.toContain('verification')

    await expect(page.getByTestId('verify-screen')).toBeVisible({ timeout: 60_000 })
    await expectNoBrowserStorage(page)

    const verifyResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes('/api/auth/verify/registration/confirm') &&
        response.request().method() === 'POST',
    )
    await fillByTestId(page, 'verify-otp-digit-0', registration.verificationCode)
    await waitForEnabledAndClick(page, 'verify-submit')
    const verifyResponse = await verifyResponsePromise
    expect(verifyResponse.ok()).toBeTruthy()
    await expectNoTokenLeak(await verifyResponse.text())
    expect(page.url()).not.toContain('verification')
    await expectAuthenticatedCookieSession(page)

    await expect(page.getByTestId('consent-screen')).toBeVisible({ timeout: 60_000 })
    await clickByTestId(page, 'consent-checkbox-pa-cons-privacy')
    await clickByTestId(page, 'consent-checkbox-pa-cons-educational')
    await clickByTestId(page, 'consent-checkbox-pa-cons-ai-analysis')
    await waitForEnabledAndClick(page, 'consent-accept')

    await expect(page.getByTestId('onboarding-layout')).toBeVisible({ timeout: 60_000 })
    await completeProfileIfPresent(page)
    await expect(page.getByTestId('intake-step-chief-complaint')).toBeVisible({ timeout: 60_000 })
    await clickByTestId(page, 'chief-complaint-text-option')
    await expect(page.getByTestId('step-chief-complaint-text')).toBeVisible()
    await fillByTestId(page, 'narrative-input', onboarding.chiefComplaint)
    await waitForEnabledAndClick(page, 'text-save-btn')

    await expect(page.getByTestId('intake-step-treatment-history')).toBeVisible({
      timeout: 60_000,
    })
    await clickByTestId(page, 'medical-history-conditions-none')
    await waitForEnabledAndClick(page, 'medical-history-continue-btn')

    await expect(page.getByTestId('intake-step-imaging-records')).toBeVisible({
      timeout: 30_000,
    })
    await waitForEnabledAndClick(page, 'records-continue-btn')

    await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('start-assessment-btn').first()).toBeVisible()
    await expectNoBrowserStorage(page)

    await waitForFirstVisibleEnabledAndClick(page, 'start-assessment-btn')
    const firstAssessmentScreen = await waitForAnyVisibleTestId(page, [
      'screening-screen',
      'story-capture',
    ])
    if (firstAssessmentScreen === 'story-capture') {
      await clickByTestId(page, 'story-capture-text-tab')
      await fillByTestId(page, 'story-capture-text-input', fullAssessmentScenario.assessmentStory)
      await page.getByTestId('story-capture-text-input').blur()
      await waitForEnabledAndClick(page, 'story-capture-continue-btn')

      await expect(page.getByTestId('documents-screen')).toBeVisible({ timeout: 60_000 })
      await clickByTestId(page, 'documents-skip-btn')
    }

    await expect(page.getByTestId('screening-screen')).toBeVisible({ timeout: 60_000 })
    await answerScreening(page)

    await expect(page.getByTestId('adaptive-loading-state')).toBeVisible({
      timeout: 30_000,
    })
    await completeAdaptiveIfPresent(page)

    await completeRefinementIfPresent(page)

    await expect(page.getByTestId('review-screen')).toBeVisible({ timeout: 120_000 })
    await expect(page.getByTestId('review-title')).toBeVisible()
    await expect(page.getByText('Review Your Assessment')).toBeVisible()
    await expect(page.getByTestId('review-story')).toBeVisible()
    await expect(page.getByTestId('review-screening')).toBeVisible()
    await expect(page.getByTestId('review-adaptive')).toBeVisible()
    await page.getByTestId('review-refinement').scrollIntoViewIfNeeded().catch(() => undefined)
    await waitForEnabledAndClick(page, 'review-submit')

    await expect(page.getByTestId('assessment-processing')).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId('results-screen')).toBeVisible({
      timeout: 480_000,
    })
    await expect(page.getByText('Your Results')).toBeVisible()
    await expect(page.getByTestId('results-disclaimer')).toBeVisible()
    await expect(page.getByTestId('results-diagnosis')).toBeVisible()
    await expect(page.getByTestId('results-evidence')).toBeVisible()
    await expect(page.getByTestId('results-share')).toBeVisible()
    await waitForEnabledAndClick(page, 'results-done', 30_000)

    await expect(page.getByTestId('home-screen')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('assessment-entry-banner')).toBeHidden()
    await expect(page.getByTestId('clinical-summary-card')).toBeVisible()
    await expect(page.getByTestId('summary-headline')).toBeVisible()
    await expect(page.getByTestId('active-problems-card')).toBeVisible()
    await expectNoBrowserStorage(page)
  })
})
