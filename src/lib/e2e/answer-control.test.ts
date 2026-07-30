import { describe, expect, it } from "vitest";

import { answerControlIsSelected } from "./answer-control";

describe("answerControlIsSelected", () => {
  it.each([
    { ariaChecked: "true", ariaPressed: null, ariaSelected: null },
    { ariaChecked: null, ariaPressed: "true", ariaSelected: null },
    { ariaChecked: null, ariaPressed: null, ariaSelected: "true" },
  ])("recognizes an affirmative accessible selection state", (attributes) => {
    expect(answerControlIsSelected(attributes)).toBe(true);
  });

  it.each([
    { ariaChecked: "false", ariaPressed: null, ariaSelected: null },
    { ariaChecked: null, ariaPressed: "false", ariaSelected: null },
    { ariaChecked: null, ariaPressed: null, ariaSelected: "false" },
    { ariaChecked: null, ariaPressed: null, ariaSelected: null },
  ])("does not treat an absent or negative state as selected", (attributes) => {
    expect(answerControlIsSelected(attributes)).toBe(false);
  });
});
