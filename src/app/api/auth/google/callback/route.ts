import type { NextRequest } from "next/server";

import { validatePatientWebConfiguration } from "@/lib/auth/route-guards";
import {
  completeGoogleOAuth,
  googleOAuthConfigurationFailure,
} from "@/lib/server/google-oauth";

export async function GET(request: NextRequest) {
  const failure = validatePatientWebConfiguration();
  if (failure) return failure;
  try {
    return await completeGoogleOAuth(request);
  } catch {
    return googleOAuthConfigurationFailure();
  }
}
