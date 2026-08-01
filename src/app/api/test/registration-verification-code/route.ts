import type { NextRequest } from "next/server";

import { readJsonBody } from "@/lib/server/backend";
import { jsonNoStore } from "@/lib/server/responses";
import {
  forwardPatientWebTestSupport,
  hasPatientWebTestSupportAccess,
  isExactSyntheticEmail,
  readExactTestSupportObject,
  testSupportBackendFailure,
  testSupportUnavailableResponse,
} from "@/lib/server/test-support";

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  const record = await readExactTestSupportObject(request, ["email"]);
  const email = record?.email;
  if (!isExactSyntheticEmail(email)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  try {
    const backendResponse = await forwardPatientWebTestSupport(
      "/test/registration-verification-code",
      { email },
    );
    if (backendResponse === null) return testSupportUnavailableResponse();
    if (!backendResponse.ok) {
      return testSupportBackendFailure(backendResponse.status);
    }

    const backendBody = await readJsonBody<unknown>(backendResponse);
    const code =
      backendBody != null &&
      typeof backendBody === "object" &&
      !Array.isArray(backendBody)
        ? (backendBody as Record<string, unknown>).code
        : undefined;
    if (typeof code !== "string" || !/^\d{6}$/u.test(code)) {
      return testSupportUnavailableResponse();
    }
    return jsonNoStore({ code });
  } catch {
    return testSupportUnavailableResponse();
  }
}
