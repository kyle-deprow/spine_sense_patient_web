import { describe, expect, it } from "vitest";

import { splitScreeningVisualTiming } from "./screening-timing";

const MAX_SYNC_MS = 30_000;

describe("splitScreeningVisualTiming", () => {
  it("separates exact in-window persistence from post-response visual settle", () => {
    const result = splitScreeningVisualTiming({
      visualStartedAt: 0,
      visualEndedAt: 6_253.1,
      responseObservedAt: 4_843.7,
      responseOk: true,
      maxSyncMs: MAX_SYNC_MS,
    });

    expect(result.durationMs).toBeCloseTo(1_409.4, 5);
    expect(result.wallDurationMs).toBe(6_253.1);
    expect(result.excludedScreeningSyncMs).toBe(4_843.7);
  });

  it("keeps full visual latency when optimistic UI wins the response race", () => {
    expect(
      splitScreeningVisualTiming({
        visualStartedAt: 0,
        visualEndedAt: 6_000,
        responseObservedAt: 22_000,
        responseOk: true,
        maxSyncMs: MAX_SYNC_MS,
      }),
    ).toEqual({
      durationMs: 6_000,
      wallDurationMs: 6_000,
      excludedScreeningSyncMs: 0,
    });
  });

  it.each([
    { responseOk: false, responseObservedAt: 400 },
    { responseOk: true, responseObservedAt: undefined },
    { responseOk: true, responseObservedAt: -1 },
  ])(
    "does not exclude failed, missing, or pre-start responses: %o",
    ({ responseOk, responseObservedAt }) => {
      expect(
        splitScreeningVisualTiming({
          visualStartedAt: 0,
          visualEndedAt: 500,
          responseObservedAt,
          responseOk,
          maxSyncMs: MAX_SYNC_MS,
        }),
      ).toEqual({
        durationMs: 500,
        wallDurationMs: 500,
        excludedScreeningSyncMs: 0,
      });
    },
  );

  it("clamps excluded sync time to the wall duration and sync ceiling", () => {
    expect(
      splitScreeningVisualTiming({
        visualStartedAt: 0,
        visualEndedAt: 40_000,
        responseObservedAt: 35_000,
        responseOk: true,
        maxSyncMs: MAX_SYNC_MS,
      }),
    ).toEqual({
      durationMs: 10_000,
      wallDurationMs: 40_000,
      excludedScreeningSyncMs: 30_000,
    });
  });
});
