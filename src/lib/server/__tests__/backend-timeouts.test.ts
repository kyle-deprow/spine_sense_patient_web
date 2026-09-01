import { describe, expect, it } from "vitest";

import { LONG_BACKEND_TIMEOUT_MS } from "@/lib/server/backend";
import {
  backendTimeoutOptions,
  isLongRunningBackendCall,
} from "@/lib/server/backend-timeouts";

describe("patient web backend timeouts", () => {
  it.each([
    "/api/v1/patients/me/intake/story/segments",
    "/api/v1/patients/me/miscribe/recordings/10000000-0000-4000-8000-000000000001/process",
  ])("uses the long timeout for STT and MyScribe processing: %s", (path) => {
    expect(isLongRunningBackendCall(path)).toBe(true);
    expect(backendTimeoutOptions(path)).toEqual({
      timeoutMs: LONG_BACKEND_TIMEOUT_MS,
    });
  });

  it.each([
    "/api/v1/patients/me/intake/story/transcriptions",
    "/api/v1/patients/me/intake/story/segments/session",
    "/api/v1/patients/me/intake/story/segments/finalize/",
    "/api/v1/patients/me/miscribe/recordings/not-a-uuid/process",
    "/api/v1/patients/me/miscribe/recordings/10000000-0000-7000-8000-000000000001/process",
    "/api/v1/patients/me/intake/story/segments/unknown",
  ])("keeps retired or malformed paths on the default timeout: %s", (path) => {
    expect(isLongRunningBackendCall(path)).toBe(false);
    expect(backendTimeoutOptions(path)).toEqual({});
  });
});
