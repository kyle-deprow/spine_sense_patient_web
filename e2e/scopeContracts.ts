import type { PatientWebCheckpoint } from "./checkpoints";

export type ScopeName =
  | "legacy-journey"
  | "auth"
  | "consent-onboarding"
  | "documents"
  | "screening"
  | "adaptive"
  | "analysis"
  | "results-report";

export type ScopeEndState = PatientWebCheckpoint | "home_complete";
export type ScopeAnalysisBehavior = "none" | "real" | "named_fixture";

export type ScopeBoundaryContract = Readonly<{
  startCheckpoint: PatientWebCheckpoint;
  endState: ScopeEndState;
  analysisBehavior: ScopeAnalysisBehavior;
  fixture?: "results-report-v1";
}>;

export const SCOPE_BOUNDARY_CONTRACTS: Readonly<
  Record<ScopeName, ScopeBoundaryContract>
> = {
  "legacy-journey": {
    startCheckpoint: "fresh",
    endState: "home_complete",
    analysisBehavior: "real",
  },
  auth: {
    startCheckpoint: "fresh",
    endState: "verified_pending_consent",
    analysisBehavior: "none",
  },
  "consent-onboarding": {
    startCheckpoint: "verified_pending_consent",
    endState: "records_ready",
    analysisBehavior: "none",
  },
  documents: {
    startCheckpoint: "records_ready",
    endState: "screening_ready",
    analysisBehavior: "none",
  },
  screening: {
    startCheckpoint: "screening_ready",
    endState: "adaptive_ready",
    analysisBehavior: "none",
  },
  adaptive: {
    startCheckpoint: "adaptive_ready",
    endState: "review_ready",
    analysisBehavior: "none",
  },
  analysis: {
    startCheckpoint: "review_ready",
    endState: "results_ready",
    analysisBehavior: "real",
  },
  "results-report": {
    startCheckpoint: "results_ready",
    endState: "home_complete",
    analysisBehavior: "named_fixture",
    fixture: "results-report-v1",
  },
};

type ManifestScope = Readonly<{
  start_checkpoint: string;
  end_checkpoint: string;
  real_analysis: boolean;
  fixture?: string;
}>;

export function assertScopeBoundaryManifest(
  manifestScopes: Readonly<Record<string, ManifestScope>>,
): void {
  const contractNames = Object.keys(SCOPE_BOUNDARY_CONTRACTS).sort();
  const manifestNames = Object.keys(manifestScopes).sort();
  if (JSON.stringify(manifestNames) !== JSON.stringify(contractNames)) {
    throw new Error("e2e/scopes.json must declare exactly the approved scopes");
  }

  for (const name of contractNames as ScopeName[]) {
    const contract = SCOPE_BOUNDARY_CONTRACTS[name];
    const manifest = manifestScopes[name];
    if (
      manifest == null ||
      manifest.start_checkpoint !== contract.startCheckpoint ||
      manifest.end_checkpoint !== contract.endState ||
      manifest.real_analysis !== (contract.analysisBehavior === "real") ||
      manifest.fixture !== contract.fixture
    ) {
      throw new Error(
        `Scope ${name} does not match its approved boundary and analysis behavior`,
      );
    }
  }
}
