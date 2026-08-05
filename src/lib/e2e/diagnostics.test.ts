import { describe, expect, it } from "vitest";

import {
  classifyRequestFailure,
  isSafeErrorCode,
  safeErrorName,
} from "../../../e2e/support/diagnostics";

describe("classifyRequestFailure", () => {
  it.each([
    ["network_changed", "net::ERR_NETWORK_CHANGED"],
    ["network_changed", "net::ERR_NETWORK_IO_SUSPENDED"],
    ["network_changed", "net::ERR_INTERNET_DISCONNECTED"],
    ["connection_failed", "net::ERR_CONNECTION_RESET"],
    ["connection_failed", "net::ERR_CONNECTION_CLOSED"],
    ["connection_failed", "net::ERR_CONNECTION_REFUSED"],
    ["connection_failed", "net::ERR_CONNECTION_ABORTED"],
    ["dns", "net::ERR_NAME_NOT_RESOLVED"],
    ["dns", "net::ERR_ADDRESS_UNREACHABLE"],
    ["timeout", "net::ERR_TIMED_OUT"],
    ["aborted", "net::ERR_ABORTED"],
  ])("classifies %s for %s", (expectedCode, errorText) => {
    expect(classifyRequestFailure(errorText)).toBe(expectedCode);
  });

  it("classifies an unrecognized error text as unknown", () => {
    expect(classifyRequestFailure("Patient diagnosis: net::ERR_FAILED")).toBe(
      "unknown",
    );
  });

  it("classifies undefined and non-string input as unknown", () => {
    expect(classifyRequestFailure(undefined)).toBe("unknown");
    expect(classifyRequestFailure(123 as never)).toBe("unknown");
  });

  it("always returns a code from the PHI-safe allowlist", () => {
    const errorTexts = [
      "net::ERR_NETWORK_CHANGED",
      "net::ERR_NETWORK_IO_SUSPENDED",
      "net::ERR_INTERNET_DISCONNECTED",
      "net::ERR_CONNECTION_RESET",
      "net::ERR_CONNECTION_CLOSED",
      "net::ERR_CONNECTION_REFUSED",
      "net::ERR_CONNECTION_ABORTED",
      "net::ERR_NAME_NOT_RESOLVED",
      "net::ERR_ADDRESS_UNREACHABLE",
      "net::ERR_TIMED_OUT",
      "net::ERR_ABORTED",
      "net::ERR_FAILED",
      "Patient diagnosis: connection details",
      "",
    ];

    for (const errorText of errorTexts) {
      expect(isSafeErrorCode(classifyRequestFailure(errorText))).toBe(true);
    }
  });
});

describe("safeErrorName", () => {
  it.each([
    "Error",
    "TypeError",
    "ReferenceError",
    "RangeError",
    "SyntaxError",
    "EvalError",
    "URIError",
  ])("classifies %s", (name) => {
    expect(safeErrorName(name)).toBe(name.toLowerCase());
  });

  it("classifies an unrecognized or custom error name as unknown", () => {
    expect(safeErrorName("PatientRecordError")).toBe("unknown");
    expect(safeErrorName("AggregateError")).toBe("unknown");
  });

  it("classifies undefined input as unknown", () => {
    expect(safeErrorName(undefined)).toBe("unknown");
  });
});
