import { expect, test, type APIRequestContext, type Locator, type Page, type Response } from '@playwright/test'

import { fullAssessmentScenario } from './fixtures/fullAssessmentScenario'

const BACKEND_RESET_URL = process.env.PATIENT_WEB_BACKEND_RESET_URL
const EXPECT_SECURE_COOKIES = process.env.PATIENT_WEB_EXPECT_SECURE_COOKIES === 'true'
const FULL_FLOW_TIMEOUT_MS = 15 * 60 * 1000

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

const SCREENING_ANSWERS_BY_ID = new Map(
  fullAssessmentScenario.screening.map((answer) => [answer.id, answer]),
)

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
    const requestId = response.headers()['x-request-id'] ?? response.headers()['request-id']
    const suffix = requestId != null ? ` request_id=${sanitizeDiagnostic(requestId)}` : ''
    console.log(`[response:${response.status()}] ${url.pathname}${suffix}`)
  })
}

async function resetBackend(request: APIRequestContext) {
  if (!BACKEND_RESET_URL) {
    throw new Error('PATIENT_WEB_BACKEND_RESET_URL is required for full assessment E2E')
  }

  const response = await request.post(BACKEND_RESET_URL)
  expect(
    response.ok(),
    `backend reset failed status=${response.status()}`,
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

async function gotoWelcome(page: Page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.goto('/', { waitUntil: 'commit', timeout: 45_000 }).catch(() => undefined)
    if (await page.getByTestId('welcome-screen').isVisible({ timeout: 15_000 }).catch(() => false)) {
      return
    }
    await page.waitForTimeout(1500)
  }
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined)
  await expect(page.getByTestId('welcome-screen')).toBeVisible({ timeout: 60_000 })
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

async function waitForAssessmentStage(
  page: Page,
  testIds: readonly string[],
  timeout = 360_000,
): Promise<string> {
  return waitForAnyVisibleTestId(page, testIds, timeout)
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
      if (await page.getByTestId(testId).isVisible({ timeout: 250 }).catch(() => false)) {
        return testId
      }
    }

    if (!(await page.getByTestId(currentScreenTestId).isVisible({ timeout: 250 }).catch(() => false))) {
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

    const submit = page.getByTestId(submitTestId)
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

async function waitForEnabledAndClick(page: Page, testId: string, timeout = 30_000) {
  const locator = page.getByTestId(testId)
  await expect(locator).toBeVisible({ timeout })
  await expect(locator).toBeEnabled({ timeout })
  await locator.scrollIntoViewIfNeeded()
  await locator.click()
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
  matches: (response: Response) => boolean
  retryErrorTestId?: string
  timeout?: number
  attempts?: number
}): Promise<Response> {
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

async function submitScreening(page: Page) {
  await expect(page.getByTestId('screening-nav-next')).toBeVisible({ timeout: 30_000 })
  const nextStageTestIds = [
    'adaptive-loading-state',
    'adaptive-screen',
    'adaptive-error-state',
    'refinement-loading-state',
    'refinement-screen',
    'refinement-error-state',
    'review-screen',
  ]

  for (let attempt = 0; attempt < 5; attempt += 1) {
    expect(await clickScreeningSubmitIfPresent(page)).toBe(true)
    const nextStage = await waitForAnyVisibleTestId(page, nextStageTestIds, 20_000).catch(() => null)
    if (nextStage != null) return
  }

  await waitForAnyVisibleTestId(page, nextStageTestIds, 120_000)
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

  const input = page.getByTestId(`${prefix}-${id}-input`)
  if (await input.isVisible({ timeout: 1000 }).catch(() => false)) {
    await input.fill(normalized)
    return
  }

  throw new Error(`No visible control found for ${prefix}-${id}=${normalized}`)
}

async function isEnabled(page: Page, testId: string): Promise<boolean> {
  const locator = page.getByTestId(testId)
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

async function isFinalVisibleScreeningQuestion(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const text = document.body.innerText
    const labelledMatch = /Question\s+(\d+)\s+of\s+(\d+)/i.exec(text)
    if (labelledMatch?.[1] != null && labelledMatch[2] != null) {
      return labelledMatch[1] === labelledMatch[2]
    }

    const compactMatch = /\b(\d+)\s*\/\s*(\d+)\b/.exec(text)
    if (compactMatch?.[1] != null && compactMatch[2] != null) {
      return compactMatch[1] === compactMatch[2]
    }

    return false
  })
}

async function isScreeningSubmitButton(page: Page): Promise<boolean> {
  const next = page.getByTestId('screening-nav-next')
  if (!(await next.isVisible({ timeout: 500 }).catch(() => false))) return false

  const [ariaLabel, text] = await Promise.all([
    next.getAttribute('aria-label').catch(() => null),
    next.innerText().catch(() => ''),
  ])

  return /submit answers/i.test(`${ariaLabel ?? ''} ${text}`) && await isFinalVisibleScreeningQuestion(page)
}

async function waitForScreeningAdvance(page: Page, previousQuestionId: string, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
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
    await waitForEnabledAndClick(page, 'screening-nav-next')

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

async function answerScreening(page: Page) {
  await expect(page.getByTestId('screening-nav-next')).toBeVisible({ timeout: 60_000 })
  for (let questionIndex = 0; questionIndex < 80; questionIndex += 1) {
    const answer = await currentVisibleScreeningAnswer(page)
    await answerQuestion(page, 'question', answer)

    await expect(
      page.getByTestId('screening-nav-next'),
      `Expected fixture answer ${answer?.id ?? 'unknown'} to enable screening navigation`,
    ).toBeEnabled({ timeout: 30_000 })

    if (await isScreeningSubmitButton(page)) {
      return
    }

    await clickScreeningNextAndWaitForAdvance(page, answer.id)
    await expect(page.getByTestId('emergency-screen')).toBeHidden({ timeout: 500 }).catch(() => undefined)
  }

  throw new Error('Timed out answering screening questions before reaching submit')
}

async function answerVisibleDynamicQuestions(
  page: Page,
  prefix: 'adaptive-question' | 'refinement-question',
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

async function completeAdaptiveIfPresent(page: Page) {
  const adaptiveScreen = page.getByTestId('adaptive-screen')
  let initialStage = await waitForAssessmentStage(page, [
    'adaptive-loading-state',
    'adaptive-screen',
    'adaptive-error-state',
    'refinement-loading-state',
    'refinement-screen',
    'refinement-error-state',
    'review-screen',
  ])
  if (initialStage === 'adaptive-loading-state') {
    initialStage = await waitForAssessmentStage(page, [
      'adaptive-screen',
      'adaptive-error-state',
      'refinement-loading-state',
      'refinement-screen',
      'refinement-error-state',
      'review-screen',
    ])
  }
  if (initialStage !== 'adaptive-screen') return

  await expect(page.getByTestId('adaptive-list')).toBeVisible({ timeout: 30_000 })
  for (let index = 0; index < 20; index += 1) {
    if (!(await adaptiveScreen.isVisible({ timeout: 1000 }).catch(() => false))) return
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
        'refinement-loading-state',
        'refinement-screen',
        'refinement-error-state',
        'review-screen',
      ],
    )
    if (nextStage !== 'adaptive-screen') return
  }

  throw new Error('Adaptive questionnaire did not exit after 20 questions')
}

async function completeRefinementIfPresent(page: Page) {
  const refinementScreen = page.getByTestId('refinement-screen')
  let initialStage = await waitForAssessmentStage(page, [
    'refinement-loading-state',
    'refinement-screen',
    'refinement-error-state',
    'review-screen',
  ])
  if (initialStage === 'refinement-loading-state') {
    initialStage = await waitForAssessmentStage(page, [
      'refinement-screen',
      'refinement-error-state',
      'review-screen',
    ])
  }
  if (initialStage !== 'refinement-screen') return

  for (let index = 0; index < 20; index += 1) {
    if (!(await refinementScreen.isVisible({ timeout: 1000 }).catch(() => false))) return
    await answerVisibleDynamicQuestions(
      page,
      'refinement-question',
      fullAssessmentScenario.refinement,
      fullAssessmentScenario.refinementText,
      'refinement-submit',
    )
    const currentQuestionTestId = await visibleDynamicQuestionTestId(page, 'refinement-question')
    await waitForEnabledAndClick(page, 'refinement-submit')
    const nextStage = await waitForDynamicQuestionAdvance(
      page,
      'refinement-screen',
      'refinement-question',
      currentQuestionTestId,
      'refinement-submit',
      ['refinement-error-state', 'review-screen'],
    )
    if (nextStage !== 'refinement-screen') return
  }

  throw new Error('Refinement questionnaire did not exit after 20 questions')
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

async function expectTreatmentHistoryAfterStorySave(page: Page) {
  await expect(page.getByTestId('medical-history-conditions-none')).toBeVisible({ timeout: 60_000 })
}

async function expectImagingRecordsAfterHistorySave(page: Page) {
  await expect(page.getByTestId('records-continue-btn')).toBeVisible({ timeout: 60_000 })
}

async function clickRecordsContinue(page: Page) {
  if (await page.getByTestId('records-continue-btn').isVisible({ timeout: 1000 }).catch(() => false)) {
    await waitForEnabledAndClick(page, 'records-continue-btn')
    return
  }

  const skip = page.getByRole('button', { name: /skip for now/i })
  await expect(skip).toBeVisible({ timeout: 30_000 })
  await expect(skip).toBeEnabled({ timeout: 30_000 })
  await skip.click({ timeout: 10_000 })
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
  }) => {
    test.setTimeout(FULL_FLOW_TIMEOUT_MS)

    const email = uniqueSyntheticEmail()
    const { registration, onboarding } = fullAssessmentScenario

    await warmCsrfSession(page)
    await gotoWelcome(page)
    await clickByTestId(page, 'welcome-get-started')

    await expect(page.getByTestId('register-screen')).toBeVisible({ timeout: 30_000 })
    await fillByTestId(page, 'register-first-name', registration.firstName)
    await fillByTestId(page, 'register-last-name', registration.lastName)
    await fillByTestId(page, 'register-email', email)
    await fillByTestId(page, 'register-date-of-birth', registration.dateOfBirth)
    await fillByTestId(page, 'register-password', registration.password)
    await fillByTestId(page, 'register-confirm-password', registration.password)
    await clickIfPresent(page, 'register-consent-storage')

    const registerResponse = await clickAndWaitForResponse({
      page,
      testId: 'register-submit',
      retryErrorTestId: 'register-error',
      matches: (response) =>
        response.url().includes('/api/auth/register') &&
        response.request().method() === 'POST',
    })
    expect(registerResponse.ok()).toBeTruthy()
    await expectNoTokenLeak(await registerResponse.text())
    expect(page.url()).not.toContain('verification')

    await expect(page.getByTestId('verify-screen')).toBeVisible({ timeout: 60_000 })
    await expectNoBrowserStorage(page)

    await fillByTestId(page, 'verify-otp-digit-0', registration.verificationCode)
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
    await expectAuthenticatedCookieSession(page)

    await expectConsentScreenAfterVerification(page)
    await acceptConsentIfPresent(page)

    await expect(page.getByTestId('onboarding-layout')).toBeVisible({ timeout: 60_000 })
    await completeProfileIfPresent(page)
    await expect(page.getByTestId('intake-step-chief-complaint')).toBeVisible({ timeout: 60_000 })
    await clickByTestId(page, 'chief-complaint-text-option')
    await expect(page.getByTestId('step-chief-complaint-text')).toBeVisible()
    await fillByTestId(page, 'narrative-input', onboarding.chiefComplaint)
    await waitForEnabledAndClick(page, 'text-save-btn')
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

    await expect(page.locator('[data-testid="home-screen"]:visible')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByTestId('assessment-entry-banner')).toBeHidden()
    await expect(page.locator('[data-testid="clinical-summary-card"]:visible')).toBeVisible()
    await expect(page.locator('[data-testid="summary-headline"]:visible')).toBeVisible()
    await expect(page.locator('[data-testid="active-problems-card"]:visible')).toBeVisible()
    await expectNoBrowserStorage(page)
  })
})
