export type ScreeningVisualTiming = {
  durationMs: number;
  wallDurationMs: number;
  excludedScreeningSyncMs: number;
};

type SplitScreeningVisualTimingInput = {
  visualStartedAt: number;
  visualEndedAt: number;
  responseObservedAt?: number | undefined;
  responseOk: boolean;
  maxSyncMs: number;
};

/**
 * Split a screening transition into exact-answer persistence and the
 * post-response visual settle. This is profiling-only and never changes
 * answers, requests, retries, or server-authored clinical routing.
 */
export function splitScreeningVisualTiming(
  input: SplitScreeningVisualTimingInput,
): ScreeningVisualTiming {
  const wallDurationMs = Math.max(
    0,
    input.visualEndedAt - input.visualStartedAt,
  );
  if (
    !input.responseOk ||
    input.responseObservedAt == null ||
    input.responseObservedAt < input.visualStartedAt ||
    input.responseObservedAt > input.visualEndedAt
  ) {
    return {
      durationMs: wallDurationMs,
      wallDurationMs,
      excludedScreeningSyncMs: 0,
    };
  }

  const excludedScreeningSyncMs = Math.min(
    wallDurationMs,
    input.maxSyncMs,
    input.responseObservedAt - input.visualStartedAt,
  );
  return {
    durationMs: Math.max(0, wallDurationMs - excludedScreeningSyncMs),
    wallDurationMs,
    excludedScreeningSyncMs,
  };
}
