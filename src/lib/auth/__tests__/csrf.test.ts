import { describe, expect, it } from "vitest";
import {
  createCsrfToken,
  validateJsonContentType,
  validateOriginHeaders,
  validateUnsafeRequest,
  verifyCsrfToken,
} from "@/lib/auth/csrf";

const secret = "test-csrf-secret";
const sameOrigin = "https://patient.example.test";

function makeRequest(init: { headers?: Record<string, string> } = {}) {
  return new Request(`${sameOrigin}/api/auth/login`, {
    method: "POST",
    ...init,
    headers: {
      Origin: sameOrigin,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

describe("csrf helpers", () => {
  it("creates signed csrf tokens that verify with the same secret", () => {
    const token = createCsrfToken(secret, "nonce");

    expect(verifyCsrfToken(secret, token)).toBe(true);
    expect(verifyCsrfToken("wrong-secret", token)).toBe(false);
  });

  it("accepts same-origin unsafe json requests with matching signed cookie and header", () => {
    const token = createCsrfToken(secret);
    const request = makeRequest({
      headers: {
        Origin: sameOrigin,
        "Content-Type": "application/json; charset=utf-8",
        "X-CSRF-Token": token,
      },
    });

    expect(
      validateUnsafeRequest(request, token, {
        csrfSecret: secret,
        allowedOrigins: [sameOrigin],
      }),
    ).toEqual({
      ok: true,
    });
  });

  it("blocks missing csrf headers before backend forwarding", () => {
    const token = createCsrfToken(secret);

    expect(
      validateUnsafeRequest(makeRequest(), token, {
        csrfSecret: secret,
        allowedOrigins: [sameOrigin],
      }),
    ).toEqual({
      ok: false,
      status: 403,
      code: "csrf_missing",
    });
  });

  it("allows a bodyless DELETE without Content-Type when CSRF proof is valid", () => {
    const token = createCsrfToken(secret);
    const request = new Request(
      `${sameOrigin}/api/v1/patients/me/documents/id`,
      {
        method: "DELETE",
        headers: {
          Origin: sameOrigin,
          "X-CSRF-Token": token,
        },
      },
    );

    expect(
      validateUnsafeRequest(request, token, {
        csrfSecret: secret,
        allowedOrigins: [sameOrigin],
        allowBodylessDelete: true,
      }),
    ).toEqual({ ok: true });

    expect(
      validateUnsafeRequest(request, token, {
        csrfSecret: secret,
        allowedOrigins: [sameOrigin],
      }),
    ).toEqual({
      ok: false,
      status: 415,
      code: "content_type_required",
    });

    const unsupportedContentTypeRequest = new Request(
      `${sameOrigin}/api/v1/patients/me/documents/id`,
      {
        method: "DELETE",
        headers: {
          Origin: sameOrigin,
          "Content-Type": "text/plain",
          "X-CSRF-Token": token,
        },
      },
    );
    expect(
      validateUnsafeRequest(unsupportedContentTypeRequest, token, {
        csrfSecret: secret,
        allowedOrigins: [sameOrigin],
        allowBodylessDelete: true,
      }),
    ).toEqual({
      ok: false,
      status: 415,
      code: "content_type_unsupported",
    });

    const postRequest = new Request(
      `${sameOrigin}/api/v1/patients/me/documents/id`,
      {
        method: "POST",
        headers: {
          Origin: sameOrigin,
          "X-CSRF-Token": token,
        },
      },
    );
    expect(
      validateUnsafeRequest(postRequest, token, {
        csrfSecret: secret,
        allowedOrigins: [sameOrigin],
        allowBodylessDelete: true,
      }),
    ).toEqual({
      ok: false,
      status: 415,
      code: "content_type_required",
    });
  });

  it("blocks wrong-origin and wrong-content-type unsafe requests", () => {
    expect(
      validateOriginHeaders(
        makeRequest({
          headers: {
            Origin: "https://evil.example.test",
            "Content-Type": "application/json",
          },
        }),
        // Pass an explicit allowed origin so validation is active (empty list skips validation)
        [sameOrigin],
      ),
    ).toEqual({ ok: false, status: 403, code: "origin_forbidden" });

    expect(validateJsonContentType("text/plain")).toEqual({
      ok: false,
      status: 415,
      code: "content_type_unsupported",
    });
  });

  it("denies an empty origin policy instead of skipping validation", () => {
    expect(validateOriginHeaders(makeRequest(), [])).toEqual({
      ok: false,
      status: 403,
      code: "origin_forbidden",
    });
  });

  it.each([
    [{ Origin: "" }, "origin_forbidden"],
    [{ Origin: "https://evil.example.test" }, "origin_forbidden"],
    [{ Referer: "not a URL" }, "referer_forbidden"],
    [{ Referer: "https://evil.example.test/path" }, "referer_forbidden"],
  ])("fails closed for invalid request origin metadata", (headers, code) => {
    expect(
      validateOriginHeaders(makeRequest({ headers }), [sameOrigin]),
    ).toEqual({
      ok: false,
      status: 403,
      code,
    });
  });
});
