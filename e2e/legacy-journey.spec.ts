import { test } from "@playwright/test";

import {
  FULL_FLOW_TIMEOUT_MS,
  runFullAssessmentJourney,
} from "./fullAssessmentJourney";
import { withAuthorizedE2eLifecycle } from "./support/lifecycle";
import { createE2ERunIdentity } from "./support/runIdentity";

test.describe("patient web legacy assessment journey", () => {
  test("registers a new patient and completes assessment to home @legacy-journey", async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(FULL_FLOW_TIMEOUT_MS);
    const identity = createE2ERunIdentity();

    await withAuthorizedE2eLifecycle({
      identity,
      action: () =>
        runFullAssessmentJourney({
          page,
          request,
          testInfo,
          identity,
          step: (name, body) => test.step(name, body),
        }),
    });
  });
});
