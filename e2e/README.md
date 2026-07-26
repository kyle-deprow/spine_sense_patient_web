# Patient Web Playwright Gates

The patient web package has local Playwright suites for the exported patient
app served by the BFF. Run them through the root Make targets:

- `make patient-web-up`
- `make patient-web-test`
- `make patient-web-e2e`
- `make patient-web-test-full-assessment`
- `make patient-web-e2e-full-assessment`
- `make patient-web-test-fhir-oauth`
- `make patient-web-e2e-fhir-oauth`

The FHIR OAuth suite is tagged `@fhir-oauth` and is opt-in because it requires
the BFF to start with the FHIR OAuth runtime gate enabled. It fails closed if
that gate is disabled, then validates browser-observable BFF behavior for raw
callback-code scrubbing, state mismatch, cross-site starts, HttpOnly
state-cookie cleanup, redirect `no-store`, and durable browser storage leakage.
Server-side “do not call backend before validation” assertions remain in the
route-level FHIR tests. This suite does not replace the live Epic shared-sandbox
evidence gate; success and provider-denial exchanges still require the Phase 6
operator runbook and redacted receipts.

The voice transcription suite is production-only by policy. From the
orchestration repo, use the focused target or the complete production run:

- `make patient-web-test-prod-voice CONFIRM_PROD_E2E=run-prod-e2e`
- `make patient-web-e2e-prod CONFIRM_PROD_E2E=run-prod-e2e`

Do not treat the package-level `pnpm test:e2e:voice` script as a supported local
MinIO HTTP contract. The suite requires deployed production and asserts that
Azure issues an HTTPS object-upload URL; keep that assertion strict.

The suite is tagged `@voice-transcription`. It uses
`e2e/fixtures/synthetic-voice.wav` as a deterministic, non-PHI browser
microphone source and verifies both onboarding My Story completed-file
upload/transcription and assessment question-note live streaming. Production
routes the returned
`/ws/patients/me/assessments/{assessmentId}/questions/{questionId}/note/live-transcription`
path through the same patient web origin.

The opt-in full assessment suite runs with deterministic stress enabled by
default. It reloads mid-screening, backtracks across an already-saved screening
answer, checks that no emergency/error state appears on the non-interruptive
happy path, and fails fast with the server failure reason if final analysis
fails. Set `PATIENT_WEB_FULL_ASSESSMENT_STRESS=false` only when isolating a
separate failure.

The legacy evidence verifier remains available as `pnpm test:e2e:verify` for externally hosted PHI-capable environments that publish Playwright evidence JSON.

Required suites to port from `external/spine_sense_provider/e2e`:

- CSP/security headers with nonce and no `unsafe-inline` or `unsafe-eval`
- XSS payloads for assessment story, OCR/document text, symptoms, and results
- PHI-free browser console output
- Idle/session expiry with in-memory PHI clearing
- Refresh rotation without token exposure to browser JavaScript
- CSRF missing/mismatch/wrong-origin/wrong-referer/wrong-content-type failures
- Cookie flags and path scoping
- Proxy allowlist traversal, URL smuggling, prefix confusion, and method mismatch
- `Cache-Control: no-store` for app shell, auth/session, proxy, and PHI responses
- Object URL revocation after document/media preview
- Browser autocomplete, bfcache, and page restore behavior after logout
- Direct backend URL calls blocked in PHI-capable browser configuration
