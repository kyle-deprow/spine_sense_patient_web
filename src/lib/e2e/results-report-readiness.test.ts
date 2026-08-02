import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Locator } from "@playwright/test";

const playwrightMocks = vi.hoisted(() => {
  const toBeHidden = vi.fn().mockResolvedValue(undefined);
  const playwrightExpect = vi.fn(() => ({ toBeHidden }));
  return { playwrightExpect, toBeHidden };
});

vi.mock("@playwright/test", () => ({
  expect: playwrightMocks.playwrightExpect,
}));

import { expectReportOptionsDismissed } from "../../../e2e/stages/resultsReport";

describe("results report readiness", () => {
  it("uses stable result IDs without a global treatment strategy text locator", () => {
    const source = readFileSync(
      resolve(process.cwd(), "e2e/stages/resultsReport.ts"),
      "utf8",
    );

    expect(source).not.toContain('page.getByText("Treatment Strategy")');
    expect(source).toContain('page.getByTestId("results-treatment")');
    expect(source).toContain('page.getByTestId("results-self-care")');
  });

  it("requires the real report options sheet and its error state to be hidden", async () => {
    const error = {};
    const options = {
      getByTestId: vi.fn().mockReturnValue(error),
    } as unknown as Locator;

    await expectReportOptionsDismissed(options);

    expect(playwrightMocks.playwrightExpect).toHaveBeenNthCalledWith(
      1,
      options,
    );
    expect(playwrightMocks.toBeHidden).toHaveBeenNthCalledWith(1, {
      timeout: 30_000,
    });
    expect(options.getByTestId).toHaveBeenCalledWith(
      "results-report-options-error",
    );
    expect(playwrightMocks.playwrightExpect).toHaveBeenNthCalledWith(2, error);
    expect(playwrightMocks.toBeHidden).toHaveBeenNthCalledWith(2);
  });
});
