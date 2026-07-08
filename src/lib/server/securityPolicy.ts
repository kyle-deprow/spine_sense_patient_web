/**
 * Permissions-Policy header value for the patient web BFF.
 *
 * The microphone is disabled by default — patient web voice is a documented
 * HIPAA launch blocker (PW-HIPAA-010: BAA-covered STT, no durable browser PHI
 * storage). It is relaxed for LOCAL DEV/TEST ONLY when
 * EXPO_PUBLIC_ENABLE_WEB_VOICE=true, so developers can exercise the browser
 * MediaRecorder path.
 *
 * This flag is the single web-microphone gate: it covers BOTH the assessment
 * voice-story capture AND MyScribe visit recording (the app checks the same
 * var via features.enableWebVoiceRecording and blocks web capture when it is
 * unset). Set it for both the Expo web export build and this BFF process, and
 * rebuild (next build) — header changes need a build + restart.
 *
 * The local patient web runs as a production-mode standalone build
 * (NODE_ENV=production), so we gate on the var's PRESENCE rather than NODE_ENV
 * — mirroring the repo's PATIENT_WEB_E2E_ALLOW_INSECURE_COOKIES toggle. NEVER
 * set this var in real production deploys.
 *
 * This is the single source of truth for the header. Both middleware.ts
 * (runtime) and next.config.ts (static) consume it so the two values cannot
 * drift apart.
 */
export function isWebVoiceDevEnabled(): boolean {
  return process.env.EXPO_PUBLIC_ENABLE_WEB_VOICE === 'true'
}

export function buildPermissionsPolicyHeader(): string {
  const microphone = isWebVoiceDevEnabled() ? 'microphone=(self)' : 'microphone=()'
  return `camera=(), ${microphone}, geolocation=(), payment=(), usb=(), browsing-topics=()`
}
