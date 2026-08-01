# Patient Web Playwright Journey

The package contains one Playwright journey for the exported patient app served
through the patient-web BFF: `e2e/full-assessment.spec.ts`. Run it through the
root Make lifecycle so the API, BFF, and synthetic support state are configured
consistently:

- `make patient-web-up`
- `make patient-web-test`
- `make patient-web-e2e`

The package runner is intentionally explicit:

```bash
pnpm test:e2e
```

It collects only the canonical full-assessment spec in the Chromium project.
The journey uses synthetic identities, server-owned clinical state, BFF-only
browser traffic, and in-memory browser sessions. It does not use Playwright
`storageState`, durable browser storage, backend bearer tokens in JavaScript, or
arbitrary route mocks.

FHIR route behavior, browser security headers, session handling, and other
functional contracts remain covered by the package's Vitest tests and the
backend's pytest suite. Production support enablement, cleanup, and
verify-disabled checks remain owned by the orchestration production runner.
