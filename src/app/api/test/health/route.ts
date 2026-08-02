import type { NextRequest } from "next/server";

import { readJsonBody } from "@/lib/server/backend";
import { jsonNoStore } from "@/lib/server/responses";
import {
  forwardPatientWebTestSupport,
  hasPatientWebTestSupportAccess,
  testSupportBackendFailure,
  testSupportUnavailableResponse,
} from "@/lib/server/test-support";

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  try {
    const backendResponse = await forwardPatientWebTestSupport(
      "/test/health",
      {},
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
      (backendBody as Record<string, unknown>).status !== "ok"
    ) {
      return testSupportUnavailableResponse();
    }
    return jsonNoStore({ status: "ok" });
  } catch {
    return testSupportUnavailableResponse();
  }
}
