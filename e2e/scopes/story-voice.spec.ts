import path from "node:path";

import { test } from "@playwright/test";

import { defineScopedAssessment } from "../scopedAssessment";

const storyVoiceFixture = path.resolve(
  __dirname,
  "../fixtures/audio/story-voice-fixture.wav",
);

test.use({
  // The launch flags provide the fake capture device; the Playwright-managed
  // context must additionally grant the microphone permission or getUserMedia
  // rejects before the fake device is ever consulted.
  permissions: ["microphone"],
  launchOptions: {
    args: [
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${storyVoiceFixture}`,
    ],
  },
});

defineScopedAssessment("story-voice");
