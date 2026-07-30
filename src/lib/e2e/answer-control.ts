export type AnswerControlSelectionAttributes = {
  ariaChecked: string | null;
  ariaPressed: string | null;
  ariaSelected: string | null;
};

export function answerControlIsSelected(
  attributes: AnswerControlSelectionAttributes,
): boolean {
  return (
    attributes.ariaChecked === "true" ||
    attributes.ariaPressed === "true" ||
    attributes.ariaSelected === "true"
  );
}
