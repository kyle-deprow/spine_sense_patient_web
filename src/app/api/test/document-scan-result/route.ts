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
    if (backendResponse === null) {
      return testSupportUnavailableResponse("backend_token_unavailable");
    }
    if (!backendResponse.ok) {
      // Read the backend's PHI-free fault code so the failure identifies
      // itself instead of arriving as an opaque 503.
      let upstreamCode: string | null = null;
      try {
        const errorBody = await readJsonBody<unknown>(backendResponse);
        if (
          errorBody != null &&
          typeof errorBody === "object" &&
          !Array.isArray(errorBody)
        ) {
          const raw = (errorBody as Record<string, unknown>).code;
          if (typeof raw === "string" && /^[A-Za-z0-9_:.=-]{1,120}$/.test(raw)) {
            upstreamCode = raw;
          }
        }
      } catch {
        // A missing or unreadable body leaves the status alone as the signal.
      }
      return testSupportBackendFailure(backendResponse.status, upstreamCode);
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
      return testSupportUnavailableResponse("document_id_mismatch");
    }
    if (body?.scan_status !== verdict) {
      return testSupportUnavailableResponse("scan_status_mismatch");
    }

    return jsonNoStore({
      document_id: documentId,
      scan_status: verdict,
    });
  } catch {
    return testSupportUnavailableResponse("scan_forward_exception");
  }
}
