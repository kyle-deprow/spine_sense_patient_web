# Patient Web Playwright Journey

The package contains one Playwright journey for the exported patient app served
through the patient-web BFF: `e2e/full-assessment.spec.ts`. Run it through the
root Make lifecycle so the API, BFF, and synthetic support state are configured
consistently:

- `make patient-web-e2e`
- `make patient-web-e2e-changed E2E_BASE=<base> E2E_HEAD=<head>`

`patient-web-test` and the package runner are inner lifecycle commands. Use
them only when an operator owns an equivalent disposable stack and explicitly
sets the disposable-stack contract:

```bash
PATIENT_WEB_E2E_STACK_DISPOSABLE=true pnpm test:e2e
```

`pnpm test:e2e` is the supported package entrypoint. Its Node wrapper sets the
failure-snapshot suppression before Playwright loads. Raw
`pnpm exec playwright test` is unsupported unless the process is explicitly
started with `PLAYWRIGHT_NO_COPY_PROMPT=1`; global setup rejects a missing or
non-exact gate before browser execution.

It collects only the canonical full-assessment spec in the Chromium project.
The journey uses synthetic identities, server-owned clinical state, BFF-only
browser traffic, and in-memory browser sessions. It does not use Playwright
`storageState`, durable browser storage, backend bearer tokens in JavaScript, or
arbitrary route mocks.

The default `E2E_SCOPES=full` invocation remains the sole canonical journey.
For focused validation, the manifest also exposes opt-in checkpoint scopes in
`e2e/scoped-assessment.spec.ts`; those scopes prepare their start checkpoint
through the same BFF/product APIs and reuse the canonical stage actions. A
`results_ready` is prepared only through the strict `results-report-v1` named
server fixture; the analysis scope still invokes real server analysis.
The analysis scope validates the completed server schema and correlates the
returned assessment ID to its same-origin BFF route. The results-report scope
then exercises report generation and the shared return-Home stage; it does not
claim to validate clinical analysis.

Scope timing logs contain only the approved scope name, phase, and duration.
They measure checkpoint setup, stage action, and browser finalization. Isolated
stack disposal timing and exact cleanup evidence remain owned by the outer Make
lifecycle. Forced failures selected with
`PATIENT_WEB_E2E_FORCE_FAILURE_AFTER_STAGE=<scope>` fire at deterministic
milestones inside the shared canonical stage actions, before their end-state
transitions; stack cleanup remains owned by the outer lifecycle.

Each invocation creates a UUID-backed synthetic email and sends the exact
`{run_id, email}` identity to the guarded backend support endpoints. The
canonical Make lifecycle owns disposal by running the journey in an isolated
stack and removing its database/object-storage volumes on success or failure.
The cleanup endpoint validates the identity but returns conflict until a
reviewed exact-run database, cache, and object-store deletion capability exists;
it never reports stack disposal as application-data deletion. Browser tests do
not call it. Before any journey mutation,
the browser lifecycle requires `PATIENT_WEB_E2E_STACK_DISPOSABLE=true`; the root
Make lifecycle supplies that marker only for its isolated Compose stack. Direct
`pnpm test:e2e` invocations therefore fail closed unless an operator explicitly
owns an equivalent disposable stack.

Performance behavior is explicit through `PATIENT_WEB_E2E_PERFORMANCE_MODE`:
`observe` is the intentional default, `enforce` fails on configured budgets,
and `off` omits measurements. Performance JSON attachments remain opt-in via
`PATIENT_WEB_E2E_PERFORMANCE_ARTIFACTS=true`; traces, screenshots, and videos
remain off. The suite also forces Playwright failure-page accessibility
snapshots off, preventing `error-context.md` from capturing clinical UI text.
A pre-browser global setup checks every resolved project and rejects effective
CLI overrides that enable trace, video, or screenshot capture. Playwright UI
mode is rejected during config loading because the pinned version can enable
live tracing after global setup. Debug mode does not enable capture in the
pinned Playwright version and remains subject to the effective-project check.
Do not re-enable browser-state artifacts for this journey.

Transient recovery is bounded and classified. Network-change and 502/503/504
transport failures may recover within their stage budget; application,
authorization, schema, clinical, and assertion failures fail fast.

FHIR route behavior, browser security headers, session handling, and other
functional contracts remain covered by the package's Vitest tests and the
backend's pytest suite. Production support enablement, cleanup, and
verify-disabled checks remain owned by the orchestration production runner.
