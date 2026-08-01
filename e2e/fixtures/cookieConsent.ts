/**
 * The patient app gates the first page load behind a cookie consent modal.
 *
 * Every spec other than `cookie-consent.spec.ts` is about something else, so
 * the Playwright config seeds an already-accepted record into each context —
 * the same thing a returning patient's browser sends. Nothing in the shipped
 * app knows or cares that a test wrote it; there is no test-only branch.
 *
 * Kept in step with `spine_sense_app/src/services/cookieConsent.ts` by hand. If
 * the format or policy version there moves and this does not, the seed stops
 * parsing and every spec starts failing at the modal — loudly, which is the
 * point.
 */

export const COOKIE_CONSENT_COOKIE = "spine_patient_cookie_consent";
export const COOKIE_CONSENT_POLICY_VERSION = 1;
export const COOKIE_CONSENT_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export function consentCookieValue(
  granted: readonly string[] = ["essential"],
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return encodeURIComponent(
    `v${COOKIE_CONSENT_POLICY_VERSION}|${nowSeconds}|${granted.join(",")}`,
  );
}

export function acceptedConsentStorageState(baseURL: string): {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax";
  }>;
  origins: [];
} {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(baseURL);
  return {
    cookies: [
      {
        name: COOKIE_CONSENT_COOKIE,
        value: consentCookieValue(["essential"], now),
        domain: url.hostname,
        path: "/",
        expires: now + COOKIE_CONSENT_MAX_AGE_SECONDS,
        httpOnly: false,
        secure: url.protocol === "https:",
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}
