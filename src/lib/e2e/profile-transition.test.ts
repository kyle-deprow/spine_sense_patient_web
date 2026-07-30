import { describe, expect, it } from "vitest";

import {
  decideProfileTransition,
  PROFILE_SUBMISSION_MAX_ATTEMPTS,
} from "./profile-transition";

const profileReady = {
  chiefComplaintVisible: false,
  continueEnabled: true,
  errorText: null,
  profileVisible: true,
};

describe("decideProfileTransition", () => {
  it("completes only when chief complaint is visible", () => {
    expect(
      decideProfileTransition(1, {
        ...profileReady,
        chiefComplaintVisible: true,
        profileVisible: false,
      }),
    ).toEqual({ status: "complete" });
  });

  it.each([
    "We could not save your profile details. Please try again.",
    "We could not save your intake. Please try again.",
  ])("retries the acknowledged save error %s", (errorText) => {
    expect(
      decideProfileTransition(1, {
        ...profileReady,
        errorText,
      }),
    ).toEqual({ reason: "acknowledged-error", status: "retry" });
  });

  it("retries an outcome-ambiguous save only while profile remains authoritative", () => {
    expect(decideProfileTransition(2, profileReady)).toEqual({
      reason: "ambiguous",
      status: "retry",
    });
  });

  it("fails closed on an unrecognized error instead of treating it as transport ambiguity", () => {
    expect(() =>
      decideProfileTransition(1, {
        ...profileReady,
        errorText: "Unexpected validation failure",
      }),
    ).toThrow(/unrecognized error state/i);
  });

  it("waits while the current submission is still pending", () => {
    expect(
      decideProfileTransition(1, {
        ...profileReady,
        continueEnabled: false,
      }),
    ).toEqual({ status: "pending" });
  });

  it("fails closed when neither expected stage is visible", () => {
    expect(() =>
      decideProfileTransition(1, {
        ...profileReady,
        profileVisible: false,
      }),
    ).toThrow(/unknown state/i);
  });

  it("stops after the bounded number of submissions", () => {
    expect(() =>
      decideProfileTransition(PROFILE_SUBMISSION_MAX_ATTEMPTS, profileReady),
    ).toThrow(/after 3 submissions/i);
  });
});
