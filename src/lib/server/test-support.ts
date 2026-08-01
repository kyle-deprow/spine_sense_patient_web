import { createHash, timingSafeEqual } from "node:crypto";

import type { NextRequest } from "next/server";

import { backendFetch } from "@/lib/server/backend";
import { jsonNoStore } from "@/lib/server/responses";

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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXACT_RUN_EMAIL_RE =
  /^casey\.assessment\.([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})@e2e\.example\.com$/i;
const TEST_SUPPORT_TOKEN_MIN_BYTES = 32;

export type TestSupportJsonObject = Record<string, unknown>;

export function hasPatientWebTestSupportAccess(request: NextRequest): boolean {
  if (!TEST_SUPPORT_ENVIRONMENTS.has(process.env.ENVIRONMENT?.trim() ?? "")) {
    return false;
  }
  if (process.env.PATIENT_WEB_TEST_SUPPORT_ENABLED !== "true") {
    return false;
  }

  const expectedToken = process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN ?? "";
  if (Buffer.byteLength(expectedToken, "utf8") < TEST_SUPPORT_TOKEN_MIN_BYTES) {
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

export async function readExactTestSupportObject(
  request: NextRequest,
  expectedKeys: readonly string[],
): Promise<TestSupportJsonObject | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  const record = body as TestSupportJsonObject;
  const actualKeys = Object.keys(record).sort();
  const requiredKeys = [...expectedKeys].sort();
  return actualKeys.length === requiredKeys.length &&
    actualKeys.every((key, index) => key === requiredKeys[index])
    ? record
    : null;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function getExactSyntheticRunId(email: unknown): string | null {
  if (typeof email !== "string") return null;
  return EXACT_RUN_EMAIL_RE.exec(email)?.[1] ?? null;
}

export function isExactSyntheticEmail(value: unknown): value is string {
  return getExactSyntheticRunId(value) !== null;
}

export async function forwardPatientWebTestSupport(
  path: `/test/${string}`,
  body: TestSupportJsonObject,
): Promise<Response | null> {
  const token = process.env.PATIENT_WEB_TEST_SUPPORT_TOKEN ?? "";
  if (Buffer.byteLength(token, "utf8") < TEST_SUPPORT_TOKEN_MIN_BYTES) {
    return null;
  }

  return backendFetch(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

export function testSupportBackendFailure(status: number) {
  if (status === 404) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }
  if (status === 409) {
    return jsonNoStore({ error: "support_conflict" }, { status: 409 });
  }
  return jsonNoStore({ error: "service_unavailable" }, { status: 503 });
}

export function testSupportUnavailableResponse() {
  return jsonNoStore({ error: "service_unavailable" }, { status: 503 });
}
