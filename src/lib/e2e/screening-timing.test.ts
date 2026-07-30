import { describe, expect, it } from "vitest";

import { splitScreeningVisualTiming } from "./screening-timing";

describe("splitScreeningVisualTiming", () => {
  it("separates exact in-window persistence from post-response visual settle", () => {
    const result = splitScreeningVisualTiming({
      visualStartedAt: 0,
      visualEndedAt: 6_253.1,
      requestObservedAt: 10,
      responseObservedAt: 4_843.7,
      responseOk: true,
    });

    expect(result.durationMs).toBeCloseTo(1_419.4, 5);
    expect(result.wallDurationMs).toBe(6_253.1);
    expect(result.excludedScreeningSyncMs).toBe(4_833.7);
  });

  it("keeps full visual latency when optimistic UI wins the response race", () => {
    expect(
      splitScreeningVisualTiming({
        visualStartedAt: 0,
        visualEndedAt: 6_000,
        requestObservedAt: 100,
        responseObservedAt: 22_000,
        responseOk: true,
      }),
    ).toEqual({
      durationMs: 6_000,
      wallDurationMs: 6_000,
      excludedScreeningSyncMs: 0,
    });
  });

  it.each([
    { requestObservedAt: 100, responseOk: false, responseObservedAt: 400 },
    {
      requestObservedAt: 100,
      responseOk: true,
      responseObservedAt: undefined,
    },
    { requestObservedAt: undefined, responseOk: true, responseObservedAt: 400 },
    { requestObservedAt: -1, responseOk: true, responseObservedAt: 400 },
  ])(
    "does not exclude failed, missing, or pre-start request/response pairs: %o",
    ({ requestObservedAt, responseOk, responseObservedAt }) => {
      expect(
        splitScreeningVisualTiming({
          visualStartedAt: 0,
          visualEndedAt: 500,
          requestObservedAt,
          responseObservedAt,
          responseOk,
        }),
      ).toEqual({
        durationMs: 500,
        wallDurationMs: 500,
        excludedScreeningSyncMs: 0,
      });
    },
  );

  it("excludes a correlated late request-to-response interval beyond the sync observation window", () => {
    expect(
      splitScreeningVisualTiming({
        visualStartedAt: 0,
        visualEndedAt: 43_084,
        requestObservedAt: 100,
        responseObservedAt: 42_900,
        responseOk: true,
      }),
    ).toEqual({
      durationMs: 284,
      wallDurationMs: 43_084,
      excludedScreeningSyncMs: 42_800,
    });
  });

  it("keeps a late pre-dispatch delay in the visual budget", () => {
    expect(
      splitScreeningVisualTiming({
        visualStartedAt: 0,
        visualEndedAt: 43_084,
        requestObservedAt: 40_000,
        responseObservedAt: 42_900,
        responseOk: true,
      }),
    ).toEqual({
      durationMs: 40_184,
      wallDurationMs: 43_084,
      excludedScreeningSyncMs: 2_900,
    });
  });
});
