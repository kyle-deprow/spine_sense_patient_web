import type { NextRequest } from "next/server";

import { readJsonBody } from "@/lib/server/backend";
import { jsonNoStore } from "@/lib/server/responses";
import {
  forwardPatientWebTestSupport,
  getExactSyntheticRunId,
  hasPatientWebTestSupportAccess,
  isExactSyntheticEmail,
  isUuid,
  readExactTestSupportObject,
  testSupportBackendFailure,
  testSupportUnavailableResponse,
} from "@/lib/server/test-support";

const CLEANUP_STATUS = "cleanup_complete" as const;

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  const record = await readExactTestSupportObject(request, ["email", "run_id"]);
  const runId = record?.run_id;
  const email = record?.email;
  const emailRunId = getExactSyntheticRunId(email);
  if (
    !isUuid(runId) ||
    !isExactSyntheticEmail(email) ||
    emailRunId?.toLowerCase() !== runId.toLowerCase()
  ) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  try {
    const backendResponse = await forwardPatientWebTestSupport(
      "/test/e2e-cleanup",
      { run_id: runId, email },
    );
    if (backendResponse === null) return testSupportUnavailableResponse();
    if (!backendResponse.ok) {
      return testSupportBackendFailure(backendResponse.status);
    }

    const backendBody = await readJsonBody<unknown>(backendResponse);
    if (
      backendBody == null ||
      typeof backendBody !== "object" ||
      Array.isArray(backendBody) ||
      (backendBody as Record<string, unknown>).status !== CLEANUP_STATUS
    ) {
      return testSupportUnavailableResponse();
    }
    return jsonNoStore({ status: CLEANUP_STATUS });
  } catch {
    return testSupportUnavailableResponse();
  }
}
