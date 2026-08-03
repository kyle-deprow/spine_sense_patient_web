import { describe, expect, it } from "vitest";

import scopeManifest from "../../../e2e/scopes.json";
import {
  assertScopeBoundaryManifest,
  SCOPE_BOUNDARY_CONTRACTS,
} from "../../../e2e/scopeContracts";

describe("patient web narrow scope contracts", () => {
  it("keeps every operator-facing manifest boundary aligned", () => {
    expect(() =>
      assertScopeBoundaryManifest(scopeManifest.scopes),
    ).not.toThrow();
  });

  it("separates real analysis from the named rendering fixture", () => {
    expect(SCOPE_BOUNDARY_CONTRACTS.analysis).toEqual({
      startCheckpoint: "review_ready",
      endState: "results_ready",
      analysisBehavior: "real",
    });
    expect(SCOPE_BOUNDARY_CONTRACTS["results-report"]).toEqual({
      startCheckpoint: "results_ready",
      endState: "home_complete",
      analysisBehavior: "named_fixture",
      fixture: "results-report-v1",
    });
  });

  it("represents legacy-journey and results-report completion after returning Home", () => {
    expect(SCOPE_BOUNDARY_CONTRACTS["legacy-journey"].endState).toBe(
      "home_complete",
    );
    expect(SCOPE_BOUNDARY_CONTRACTS["results-report"].endState).toBe(
      "home_complete",
    );
  });

  it("fails closed when manifest fixture behavior drifts", () => {
    const { fixture: _fixture, ...withoutFixture } =
      scopeManifest.scopes["results-report"];
    const drifted = {
      ...scopeManifest.scopes,
      "results-report": withoutFixture,
    };
    expect(() => assertScopeBoundaryManifest(drifted)).toThrow(
      "results-report",
    );
  });
});
