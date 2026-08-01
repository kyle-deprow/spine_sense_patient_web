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

const RESULTS_FIXTURE = "results-report-v1";

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  const record = await readExactTestSupportObject(request, [
    "email",
    "fixture",
    "run_id",
  ]);
  const runId = record?.run_id;
  const email = record?.email;
  const fixture = record?.fixture;
  if (
    !isUuid(runId) ||
    !isExactSyntheticEmail(email) ||
    getExactSyntheticRunId(email)?.toLowerCase() !== runId.toLowerCase() ||
    fixture !== RESULTS_FIXTURE
  ) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  try {
    const backendResponse = await forwardPatientWebTestSupport(
      "/test/results-fixture",
      { run_id: runId, email, fixture },
    );
    if (backendResponse === null) return testSupportUnavailableResponse();
    if (!backendResponse.ok) {
      return testSupportBackendFailure(backendResponse.status);
    }

    const backendBody = await readJsonBody<unknown>(backendResponse);
    const body =
      backendBody != null &&
      typeof backendBody === "object" &&
      !Array.isArray(backendBody)
        ? (backendBody as Record<string, unknown>)
        : null;
    if (body?.status !== "fixture_ready" || body.fixture !== RESULTS_FIXTURE) {
      return testSupportUnavailableResponse();
    }
    return jsonNoStore({ status: "fixture_ready", fixture: RESULTS_FIXTURE });
  } catch {
    return testSupportUnavailableResponse();
  }
}
