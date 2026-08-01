export type PerformanceMode = "enforce" | "observe" | "off";

export function isPerformanceProfilingEnabled(mode: PerformanceMode): boolean {
  return mode !== "off";
}

export function shouldEnforcePerformanceBudgets(
  mode: PerformanceMode,
): boolean {
  return mode === "enforce";
}

export function readPerformanceMode(
  value = process.env.PATIENT_WEB_E2E_PERFORMANCE_MODE,
): PerformanceMode {
  const mode = value?.trim().toLowerCase() || "observe";
  if (mode !== "enforce" && mode !== "observe" && mode !== "off") {
    throw new Error(
      "PATIENT_WEB_E2E_PERFORMANCE_MODE must be one of enforce, observe, or off",
    );
  }
  return mode;
}
