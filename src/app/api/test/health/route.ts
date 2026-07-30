import type { NextRequest } from "next/server";

import { jsonNoStore } from "@/lib/server/responses";
import { hasPatientWebTestSupportAccess } from "@/lib/server/test-support";

export async function POST(request: NextRequest) {
  if (!hasPatientWebTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  return jsonNoStore({ status: "ok" });
}
