# Patient Web Playwright Gates

The patient web package has a local Playwright suite for the exported patient app served by the BFF.

Run it through the root Make targets:

- `make patient-web-up`
- `make patient-web-test`
- `make patient-web-e2e`
- `make patient-web-test-full-assessment`
- `make patient-web-e2e-full-assessment`

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
