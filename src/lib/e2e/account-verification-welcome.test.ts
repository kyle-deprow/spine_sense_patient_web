import { expect, describe, it, vi } from "vitest";
import type { Page } from "@playwright/test";

const playwrightMocks = vi.hoisted(() => {
  const toBeVisible = vi.fn();
  const playwrightExpect = vi.fn(() => ({ toBeVisible }));
  return { playwrightExpect, toBeVisible };
});

vi.mock("@playwright/test", () => ({
  expect: playwrightMocks.playwrightExpect,
}));

import { gotoWelcome } from "../../../e2e/stages/accountVerification";

describe("account verification welcome readiness", () => {
  it("asserts the screen container when its start button is also visible", async () => {
    const page = {
      goto: vi.fn().mockResolvedValue({ ok: () => true }),
      getByTestId: vi.fn().mockReturnValue({}),
      getByRole: vi.fn(),
    } as unknown as Page;

    await gotoWelcome(page);

    expect(page.getByTestId).toHaveBeenCalledWith("welcome-screen");
    expect(page.getByRole).not.toHaveBeenCalled();
    expect(playwrightMocks.toBeVisible).toHaveBeenCalledWith({
      timeout: expect.any(Number),
    });
  });
});
