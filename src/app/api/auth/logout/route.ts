import type { NextRequest } from "next/server";

import { COOKIE_NAMES } from "@/lib/auth/cookies";
import { validateAuthMutation } from "@/lib/auth/route-guards";
import { logoutWithCookie } from "@/lib/server/auth";
import {
  auditLog,
  createRequestAuditContext,
  isRoutineAuditEnabled,
} from "@/lib/server/audit";

export async function POST(request: NextRequest) {
  const auditContext = createRequestAuditContext(
    request,
    request.cookies.get(COOKIE_NAMES.access)?.value,
  );
  const failure = validateAuthMutation(request);
  if (failure) {
    auditLog({
      ts: new Date().toISOString(),
      event: "auth.logout.failure",
      method: "POST",
      status: failure.status,
      reason: "request_policy_denied",
      ...auditContext,
    });
    return failure;
  }

  const response = await logoutWithCookie(request);
  if (response.ok) {
    if (isRoutineAuditEnabled()) {
      auditLog({
        ts: new Date().toISOString(),
        event: "auth.logout.success",
        method: "POST",
        status: response.status,
        ...auditContext,
      });
    }
  } else {
    auditLog({
      ts: new Date().toISOString(),
      event: "auth.logout.failure",
      method: "POST",
      status: response.status,
      ...auditContext,
    });
  }
  return response;
}
