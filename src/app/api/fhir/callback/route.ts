import type { NextRequest } from "next/server";

import { validatePatientWebConfiguration } from "@/lib/auth/route-guards";
import { completeFhirOAuth } from "@/lib/server/fhir-oauth";

export async function GET(request: NextRequest) {
  const failure = validatePatientWebConfiguration();
  if (failure) return failure;
  return completeFhirOAuth(request);
}
