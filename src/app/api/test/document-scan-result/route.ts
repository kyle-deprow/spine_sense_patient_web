import type { NextRequest } from "next/server";

import { readJsonBody } from "@/lib/server/backend";
import { jsonNoStore } from "@/lib/server/responses";
import {
  forwardPatientWebTestSupport,
  hasPatientWebTestSupportAccess,
  isExactSyntheticEmail,
  isUuid,
  readExactTestSupportObject,
  testSupportBackendFailure,
  testSupportUnavailableResponse,
} from "@/lib/server/test-support";

const VERDICTS = new Set(["clean", "malicious", "error"]);

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  const record = await readExactTestSupportObject(request, [
    "document_id",
    "email",
    "verdict",
  ]);
  const documentId = record?.document_id;
  const email = record?.email;
  const verdict = record?.verdict;
  if (
    !isUuid(documentId) ||
    !isExactSyntheticEmail(email) ||
    typeof verdict !== "string" ||
    !VERDICTS.has(verdict)
  ) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  try {
    const backendResponse = await forwardPatientWebTestSupport(
      "/test/document-scan-result",
      { document_id: documentId, email, verdict },
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
    if (
      body?.document_id !== documentId &&
      !(
        typeof body?.document_id === "string" &&
        body.document_id.toLowerCase() === documentId.toLowerCase()
      )
    ) {
      return testSupportUnavailableResponse();
    }
    if (body?.scan_status !== verdict) {
      return testSupportUnavailableResponse();
    }

    return jsonNoStore({
      document_id: documentId,
      scan_status: verdict,
    });
  } catch {
    return testSupportUnavailableResponse();
  }
}
