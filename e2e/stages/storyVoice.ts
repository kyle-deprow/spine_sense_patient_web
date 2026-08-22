import {
  expect,
  type Page,
  type Response as PlaywrightResponse,
} from "@playwright/test";

import type { JourneyContext } from "../journey/context";
import {
  clickChiefComplaintSave,
  completeProfileIfPresent,
  continueWelcomeIntroIfPresent,
  expectChiefComplaintAfterProfileSave,
  expectImagingRecordsAfterHistorySave,
  expectTreatmentHistoryAfterStorySave,
  acceptConsentIfPresent,
  fillTreatmentHistoryWithNoAnswers,
} from "./consentOnboarding";
import { waitForEnabledAndClick } from "../journey/selectors";

const VOICE_CAPTURE_TIMEOUT_MS = 60_000;
const VOICE_TRANSCRIPTION_TIMEOUT_MS = 120_000;
const MINIMUM_CAPTURE_WALL_CLOCK_MS = 15_000;
const TRANSCRIPT_KEYWORDS = ["back", "boxes", "lumbar", "ibuprofen"] as const;

async function visibleVoiceFailure(page: Page): Promise<string> {
  const storySaveError = page.getByTestId("story-save-error");
  if (await storySaveError.isVisible({ timeout: 500 }).catch(() => false)) {
    const text = (await storySaveError.innerText().catch(() => "")).trim();
    if (text.length > 0) return `story-save-error: ${text}`;
  }

  const voiceStep = page.getByTestId("step-chief-complaint-voice");
  if (await voiceStep.isVisible({ timeout: 500 }).catch(() => false)) {
    const text = (await voiceStep.innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    const errorText = text
      .split(/(?<=[.!?])\s+/)
      .find((part) =>
        /failed|error|interrupted|too short|taking too long|unavailable|microphone access needed|try again/i.test(
          part,
        ),
      );
    if (errorText != null && errorText.length > 0) {
      return `recorder error: ${errorText}`;
    }
    if (text.length > 0) return `voice step: ${text.slice(0, 1200)}`;
  }

  return "no visible voice error state";
}

async function withVoiceFailureSurface<T>(
  page: Page,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${message}; visible voice failure: ${await visibleVoiceFailure(page)}`,
    );
  }
}

async function readServerStoryResponse(
  response: PlaywrightResponse | null,
): Promise<{ narrative: string; inputMethod: string }> {
  if (response == null) {
    throw new Error(
      "The server-backed intake story status response did not arrive after recording",
    );
  }
  expect(response.ok(), "server-backed intake story status response").toBe(
    true,
  );
  const body = (await response.json()) as Record<string, unknown>;
  const narrative =
    typeof body.narrative === "string"
      ? body.narrative
      : typeof body.story_narrative === "string"
        ? body.story_narrative
        : "";
  const inputMethod =
    typeof body.input_method === "string"
      ? body.input_method
      : typeof body.inputMethod === "string"
        ? body.inputMethod
        : "";
  return { narrative, inputMethod };
}

async function captureAndReviewVoiceStory(page: Page): Promise<void> {
  await expect(page.getByTestId("step-chief-complaint-select")).toBeVisible({
    timeout: VOICE_CAPTURE_TIMEOUT_MS,
  });
  await waitForEnabledAndClick(
    page,
    "chief-complaint-voice-option",
    VOICE_CAPTURE_TIMEOUT_MS,
  );
  await expect(page.getByTestId("voice-recorder-sheet")).toBeVisible({
    timeout: VOICE_CAPTURE_TIMEOUT_MS,
  });

  await waitForEnabledAndClick(
    page,
    "voice-mic-button",
    VOICE_CAPTURE_TIMEOUT_MS,
  );
  const statusLabel = page.getByTestId("voice-status-pill-label");
  await expect(statusLabel).toHaveText(/We're listening/i, {
    timeout: VOICE_CAPTURE_TIMEOUT_MS,
  });

  const timer = page
    .locator(
      '[data-testid="voice-timer-block"]:visible, [data-testid="voice-timer-inline"]:visible',
    )
    .first();
  await expect(timer).toBeVisible({ timeout: VOICE_CAPTURE_TIMEOUT_MS });
  const initialTimer = await timer.innerText();
  const captureStartedAt = Date.now();
  await expect
    .poll(
      async () => {
        const [status, timerText] = await Promise.all([
          statusLabel.innerText().catch(() => ""),
          timer.innerText().catch(() => ""),
        ]);
        return (
          Date.now() - captureStartedAt >= MINIMUM_CAPTURE_WALL_CLOCK_MS &&
          /We're listening/i.test(status) &&
          timerText !== initialTimer
        );
      },
      {
        timeout: VOICE_CAPTURE_TIMEOUT_MS,
        intervals: [250, 500, 1_000],
        message:
          "fake audio capture should run for about 15 seconds while the visible recording status and timer advance",
      },
    )
    .toBe(true);

  const serverStoryResponsePromise = page
    .waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.pathname === "/api/proxy/api/v1/patients/me/intake/story"
        );
      },
      { timeout: VOICE_TRANSCRIPTION_TIMEOUT_MS },
    )
    .catch(() => null);

  await waitForEnabledAndClick(
    page,
    "voice-done-btn",
    VOICE_CAPTURE_TIMEOUT_MS,
  );

  const review = page.getByTestId("narrative-input");
  await expect
    .poll(
      async () =>
        (await review.isVisible().catch(() => false)) ||
        /Finishing your story/i.test(
          await statusLabel.innerText().catch(() => ""),
        ),
      {
        timeout: VOICE_TRANSCRIPTION_TIMEOUT_MS,
        message:
          "voice flow should expose its transcribing state or reach the transcript review UI",
      },
    )
    .toBe(true);
  await expect(review).toBeVisible({ timeout: VOICE_TRANSCRIPTION_TIMEOUT_MS });

  const transcript = (await review.inputValue()).trim();
  const serverStory = await readServerStoryResponse(
    await serverStoryResponsePromise,
  );
  const matchedKeywords = TRANSCRIPT_KEYWORDS.filter((keyword) =>
    transcript.toLocaleLowerCase().includes(keyword),
  );
  const visibleFailure = await visibleVoiceFailure(page);

  expect(
    serverStory.inputMethod,
    `voice transcription response should identify server story input; ${visibleFailure}`,
  ).toBe("voice");
  expect(
    serverStory.narrative.trim(),
    `server transcription should be non-empty; ${visibleFailure}`,
  ).not.toBe("");
  expect(
    transcript,
    `review transcript should equal the server transcript; ${visibleFailure}`,
  ).toBe(serverStory.narrative.trim());
  expect(
    matchedKeywords.length,
    `server transcript should contain at least two fixture keywords; matched=${matchedKeywords.join(", ") || "none"}; ${visibleFailure}`,
  ).toBeGreaterThanOrEqual(2);
}

export async function runStoryVoiceStage(
  context: JourneyContext,
): Promise<void> {
  const { page, profiler } = context;
  await context.step("consent and onboarding voice story", async () => {
    await profiler.measure("consent.to_onboarding", "page", async () => {
      await acceptConsentIfPresent(page);
      await continueWelcomeIntroIfPresent(page);
      await expect(page.getByTestId("onboarding-layout")).toBeVisible({
        timeout: 60_000,
      });
    });

    await profiler.measure(
      "onboarding.profile_to_chief_complaint",
      "page",
      async () => {
        await completeProfileIfPresent(page);
        await expectChiefComplaintAfterProfileSave(page);
      },
    );

    await withVoiceFailureSurface(page, async () => {
      await profiler.measure("onboarding.chief_complaint_voice", "page", () =>
        captureAndReviewVoiceStory(page),
      );
      await profiler.measure(
        "onboarding.chief_complaint_to_history",
        "page",
        async () => {
          await clickChiefComplaintSave(page);
          await expectTreatmentHistoryAfterStorySave(page);
        },
      );
    });

    await fillTreatmentHistoryWithNoAnswers(page);
    await profiler.measure(
      "onboarding.history_to_records",
      "page",
      async () => {
        await waitForEnabledAndClick(page, "medical-history-continue-btn");
        await expectImagingRecordsAfterHistorySave(page);
      },
    );
  });
}
