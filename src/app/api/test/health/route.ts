import type { NextRequest } from "next/server";

import { jsonNoStore } from "@/lib/server/responses";
import { hasTestSupportAccess } from "@/lib/server/test-support-access";

export async function POST(request: NextRequest) {
  if (!hasTestSupportAccess(request)) {
    return jsonNoStore({ detail: "Not found" }, { status: 404 });
  }

  return jsonNoStore({ status: "ok" });
}
