import { createHash, timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

const TEST_SUPPORT_ENVIRONMENTS = new Set([
  "local",
  "development",
  "dev",
  "test",
  "e2e",
  "staging",
  "production",
  "prod",
]);

export function hasPatientWebTestSupportAccess(request: NextRequest): boolean {
  if (!TEST_SUPPORT_ENVIRONMENTS.has(process.env.ENVIRONMENT?.trim() ?? "")) {
    return false;
  }
  if (process.env.PATIENT_WEB_TEST_SUPPORT_ENABLED !== "true") {
    return false;
  }

  const expectedToken = process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN ?? "";
  if (Buffer.byteLength(expectedToken, "utf8") < 32) {
    return false;
  }

  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer[\t ]+(\S+)$/i.exec(authorization);
  const suppliedToken = match?.[1];
  if (!suppliedToken) {
    return false;
  }

  const expected = createHash("sha256").update(expectedToken, "utf8").digest();
  const actual = createHash("sha256").update(suppliedToken, "utf8").digest();
  return timingSafeEqual(expected, actual);
}
