import { describe, expect, it } from "vitest";

import { ScreeningRouteTracker } from "./screening-route";

describe("ScreeningRouteTracker", () => {
  it("records new server-issued questions in exact order", () => {
    const tracker = new ScreeningRouteTracker();

    expect(tracker.observe("T01")).toBe("new");
    tracker.recordSaveResult("T01", true);
    expect(tracker.observe("T06_Q1")).toBe("new");
    tracker.recordSaveResult("T06_Q1", true);
    expect(tracker.observe("G04")).toBe("new");

    expect(tracker.observedQuestionIds).toEqual(["T01", "T06_Q1", "G04"]);
  });

  it("does not add an exact rollback replay to the clinical route", () => {
    const tracker = new ScreeningRouteTracker();

    tracker.observe("T06_Q1");
    tracker.recordSaveResult("T06_Q1", false);

    expect(tracker.observe("T06_Q1")).toBe("transport-replay");
    expect(tracker.observedQuestionIds).toEqual(["T06_Q1"]);
  });

  it("rejects repetition after a confirmed save or without a retry marker", () => {
    const confirmed = new ScreeningRouteTracker();
    confirmed.observe("T06_Q1");
    confirmed.recordSaveResult("T06_Q1", true);

    expect(() => confirmed.observe("T06_Q1")).toThrow(
      "repeated without an unconfirmed save",
    );

    const unmarked = new ScreeningRouteTracker();
    unmarked.observe("T06_Q1");
    expect(() => unmarked.observe("T06_Q1")).toThrow(
      "repeated without an unconfirmed save",
    );
  });

  it("fails after two consecutive transport replays", () => {
    const tracker = new ScreeningRouteTracker();
    tracker.observe("T06_Q1");

    for (let replay = 0; replay < 2; replay += 1) {
      tracker.recordSaveResult("T06_Q1", false);
      expect(tracker.observe("T06_Q1")).toBe("transport-replay");
    }

    tracker.recordSaveResult("T06_Q1", false);
    expect(() => tracker.observe("T06_Q1")).toThrow(
      "exceeded the bounded transport replay limit",
    );
  });

  it("clears a stale retry marker when the server advances", () => {
    const tracker = new ScreeningRouteTracker();
    tracker.observe("T06_Q1");
    tracker.recordSaveResult("T06_Q1", false);

    expect(tracker.observe("G04")).toBe("new");
    expect(tracker.observedQuestionIds).toEqual(["T06_Q1", "G04"]);
    expect(() => tracker.observe("G04")).toThrow(
      "repeated without an unconfirmed save",
    );
  });
});
