import type { APIRequestContext, Page, TestInfo } from "@playwright/test";

import type { fullAssessmentScenario } from "../fixtures/fullAssessmentScenario";
import type { E2ERunIdentity } from "../support/runIdentity";

export type StageStep = <T>(name: string, body: () => Promise<T>) => Promise<T>;

export type TransitionProfileKind =
  | "page"
  | "question"
  | "sync"
  | "recovery"
  | "stage"
  | "analysis"
  | "report";

export type TransitionProfiler = {
  measure<T>(
    label: string,
    kind: TransitionProfileKind,
    action: () => Promise<T>,
  ): Promise<T>;
  recordElapsed(
    label: string,
    kind: TransitionProfileKind,
    startedAt: number,
    options?: { assertBudget?: boolean },
  ): void;
  recordDuration(
    label: string,
    kind: TransitionProfileKind,
    rawDurationMs: number,
    options?: {
      assertBudget?: boolean;
      wallDurationMs?: number;
      excludedScreeningSyncMs?: number;
    },
  ): void;
};

export type BaseStageContext = {
  page: Page;
  request: APIRequestContext;
  testInfo: TestInfo;
  identity: E2ERunIdentity;
  email: string;
  scenario: typeof fullAssessmentScenario;
  profiler: TransitionProfiler;
  step: StageStep;
};
