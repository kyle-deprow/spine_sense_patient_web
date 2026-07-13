# Patient Web Playwright Gates

The patient web package has a local Playwright suite for the exported patient app served by the BFF.

Run it through the root Make targets:

- `make patient-web-up`
- `make patient-web-test`
- `make patient-web-e2e`
- `PATIENT_WEB_INCLUDE_VOICE_TRANSCRIPTION=true pnpm test:e2e:voice`
- `make patient-web-test-full-assessment`
- `make patient-web-e2e-full-assessment`

The opt-in voice transcription suite is tagged `@voice-transcription`. It uses
`e2e/fixtures/synthetic-voice.wav` as a deterministic, non-PHI browser
microphone source and verifies both live story transcription and MiScribe bulk
upload contracts. Deployed environments should route the returned `/ws/...`
live-transcription path through the same patient web origin; local runs that do
not proxy WebSockets through the BFF can set
`PATIENT_WEB_LIVE_TRANSCRIPTION_WS_ORIGIN` to the API origin.

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
