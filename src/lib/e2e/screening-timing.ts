export type ScreeningVisualTiming = {
  durationMs: number;
  wallDurationMs: number;
  excludedScreeningSyncMs: number;
};

type SplitScreeningVisualTimingInput = {
  visualStartedAt: number;
  visualEndedAt: number;
  requestObservedAt?: number | undefined;
  responseObservedAt?: number | undefined;
  responseOk: boolean;
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
    input.requestObservedAt == null ||
    input.responseObservedAt == null ||
    input.requestObservedAt < input.visualStartedAt ||
    input.responseObservedAt < input.requestObservedAt ||
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
    input.responseObservedAt - input.requestObservedAt,
  );
  return {
    durationMs: Math.max(0, wallDurationMs - excludedScreeningSyncMs),
    wallDurationMs,
    excludedScreeningSyncMs,
  };
}
