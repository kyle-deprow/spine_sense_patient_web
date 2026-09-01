import type { NextRequest } from "next/server";

import { validatePatientWebConfiguration } from "@/lib/auth/route-guards";
import {
  googleOAuthConfigurationFailure,
  startGoogleOAuth,
} from "@/lib/server/google-oauth";

export async function GET(request: NextRequest) {
  const failure = validatePatientWebConfiguration();
  if (failure) return failure;
  try {
    return await startGoogleOAuth(request);
  } catch {
    return googleOAuthConfigurationFailure();
  }
}
