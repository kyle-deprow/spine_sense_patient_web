import { describe, expect, it } from "vitest";

import {
  classifyApiErrorCode,
  classifyRequestFailure,
  isSafeApiErrorCode,
  isSafeErrorCode,
  safeErrorName,
} from "../../../e2e/support/diagnostics";

describe("classifyApiErrorCode", () => {
  it.each([
    ["idempotency_in_progress", '{"code":"idempotency_in_progress","detail":"x"}'],
    ["idempotency_unavailable", '{"code":"idempotency_unavailable","detail":"x"}'],
    ["screening_incomplete", '{"error":{"code":"screening_incomplete"}}'],
  ])("extracts %s", (expected, body) => {
    expect(classifyApiErrorCode(body)).toBe(expected);
  });

  it("distinguishes the two 503 families, which share a status code", () => {
    // This is the whole point: a duplicate of an in-flight mutation is working
    // as designed, a downed coordination store is not, and both are HTTP 503.
    expect(classifyApiErrorCode('{"code":"idempotency_in_progress"}')).not.toBe(
      classifyApiErrorCode('{"code":"idempotency_unavailable"}'),
    );
  });

  it("never echoes free-text detail, which can carry patient-derived text", () => {
    // DomainError bodies (including the LLM 503s) carry only `detail`.
    const body = JSON.stringify({
      detail: "Patient Jane Doe reported severe lower back pain since 2019",
    });
    expect(classifyApiErrorCode(body)).toBe("unknown");
  });

  it("never returns an unrecognized code, even a well-formed one", () => {
    expect(classifyApiErrorCode('{"code":"some_new_server_code"}')).toBe("unknown");
  });

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["not json", "<html>502 Bad Gateway</html>"],
    ["json but not an object", '"a string"'],
    ["null", "null"],
    ["code is not a string", '{"code":{"nested":true}}'],
  ])("returns unknown for %s", (_label, body) => {
    expect(classifyApiErrorCode(body as string | undefined)).toBe("unknown");
  });

  it("refuses to parse an oversized body rather than reading it into the log", () => {
    const oversized = `{"code":"idempotency_in_progress","pad":"${"x".repeat(4096)}"}`;
    expect(classifyApiErrorCode(oversized)).toBe("unknown");
  });

  it("only ever emits values that are safe to log", () => {
    for (const body of [
      '{"code":"idempotency_in_progress"}',
      '{"detail":"free text"}',
      "not json",
      '{"code":"unrecognized"}',
    ]) {
      expect(isSafeApiErrorCode(classifyApiErrorCode(body))).toBe(true);
    }
  });
});

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
