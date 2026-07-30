const MAX_TRANSPORT_REPLAYS = 2;

export type ScreeningQuestionObservation = "new" | "transport-replay";

/**
 * Separates a bounded transport replay from the server-issued clinical route.
 *
 * A repeated question is accepted only after that exact question's immediately
 * preceding save could not be confirmed. Any unmarked repetition still fails,
 * so this cannot hide a successful server transition that loops backward.
 */
export class ScreeningRouteTracker {
  private readonly questionIds: string[] = [];
  private replayQuestionId: string | null = null;
  private replayCount = 0;

  get observedQuestionIds(): readonly string[] {
    return this.questionIds;
  }

  observe(questionId: string): ScreeningQuestionObservation {
    const previousQuestionId = this.questionIds[this.questionIds.length - 1];
    if (previousQuestionId !== questionId) {
      this.questionIds.push(questionId);
      this.replayQuestionId = null;
      this.replayCount = 0;
      return "new";
    }

    if (this.replayQuestionId !== questionId) {
      throw new Error(
        `Screening question ${questionId} repeated without an unconfirmed save`,
      );
    }

    this.replayCount += 1;
    this.replayQuestionId = null;
    if (this.replayCount > MAX_TRANSPORT_REPLAYS) {
      throw new Error(
        `Screening question ${questionId} exceeded the bounded transport replay limit`,
      );
    }
    return "transport-replay";
  }

  recordSaveResult(questionId: string, confirmed: boolean): void {
    this.replayQuestionId = confirmed ? null : questionId;
    if (confirmed) {
      this.replayCount = 0;
    }
  }
}
