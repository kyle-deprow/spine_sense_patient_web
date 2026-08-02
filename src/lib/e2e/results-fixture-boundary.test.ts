import type { APIRequestContext } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";

const PATIENT_WEB_BASE_URL = "http://127.0.0.1:43101";
const RESULTS_FIXTURE_URL = `${PATIENT_WEB_BASE_URL}/api/test/results-fixture`;
const RUN_ID = "123e4567-e89b-42d3-a456-426614174010";

describe("results-report fixture boundary", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("posts only the named fixture through the patient-web BFF", async () => {
    vi.stubEnv("PATIENT_WEB_BASE_URL", PATIENT_WEB_BASE_URL);
    vi.stubEnv("PATIENT_WEB_BACKEND_RESULTS_FIXTURE_URL", RESULTS_FIXTURE_URL);
    vi.stubEnv("PATIENT_WEB_TEST_SUPPORT_TOKEN", "synthetic-support-token");
    vi.resetModules();

    const posts: Array<{
      url: string;
      options: Record<string, unknown>;
    }> = [];
    const request = {
      post: async (url: string, options: Record<string, unknown>) => {
        posts.push({ url, options });
        return {
          status: () => 200,
          json: async () => ({
            status: "fixture_ready",
            fixture: "results-report-v1",
          }),
        };
      },
    } as unknown as APIRequestContext;
    const { prepareResultsReportFixture } =
      await import("../../../e2e/journey/context");

    await prepareResultsReportFixture(request, {
      runId: RUN_ID,
      email: `casey.assessment.${RUN_ID}@e2e.example.com`,
    });

    expect(posts).toEqual([
      {
        url: RESULTS_FIXTURE_URL,
        options: {
          timeout: 90_000,
          headers: {
            authorization: "Bearer synthetic-support-token",
            "content-type": "application/json",
          },
          data: {
            run_id: RUN_ID,
            email: `casey.assessment.${RUN_ID}@e2e.example.com`,
            fixture: "results-report-v1",
          },
        },
      },
    ]);
    expect(posts.some(({ url }) => url.includes("/analysis"))).toBe(false);
  });
});
