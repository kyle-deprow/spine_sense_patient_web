# Patient Web Playwright Scopes

The package defaults to the seven-scope checkpoint suite for
the exported patient app served through the patient-web BFF. Run them through
the root Make lifecycle so the API, BFF, and synthetic support state are
configured consistently:

- `make patient-web-e2e`
- `make patient-web-e2e-plan E2E_BASE=<base> E2E_HEAD=<head>`
- `make patient-web-e2e-changed E2E_BASE=<base> E2E_HEAD=<head>`
- `uv run ss local patient-web run --scopes screening`

`patient-web-test` and the package runner are inner lifecycle commands. Use
them locally only when an operator owns an equivalent disposable stack and
explicitly sets the disposable-stack contract:

```bash
PATIENT_WEB_E2E_STACK_DISPOSABLE=true pnpm test:e2e
```

`pnpm test:e2e` is the supported package entrypoint. Its Node wrapper sets the
failure-snapshot suppression before Playwright loads. Raw
`pnpm exec playwright test` is unsupported unless the process is explicitly
started with `PLAYWRIGHT_NO_COPY_PROMPT=1`; global setup rejects a missing or
non-exact gate before browser execution.

The package runner resolves approved manifest scopes to exact spec arguments;
the Playwright configuration does not use title filtering as a scope API.
Without an explicit scope, the runner selects exactly `auth`,
`consent-onboarding`, `documents`, `screening`, `adaptive`, `analysis`, and
`results-report` in manifest order. The specs own their checkpoint setup and
are independent; browser execution order is not part of the contract.
Canonical Make runs allocate a unique runtime directory, Compose project,
claimed host-port set, PID/log/env files, staged standalone build, and
Playwright output. A locked ownership registry prevents supported concurrent
runs from claiming each other's ports, and cleanup uses the exact owner record
instead of shared filenames or port discovery. The shared build workspace is
locked only while producing each run's independent staged copy.
The journey uses synthetic identities, server-owned clinical state, BFF-only
browser traffic, and in-memory browser sessions. It does not use Playwright
`storageState`, durable browser storage, backend bearer tokens in JavaScript, or
arbitrary route mocks.

The checkpoint specs in `e2e/scopes/` are the canonical default. They prepare
their start checkpoint through the shared
`e2e/scopedAssessment.ts` runner, use the same BFF/product APIs, and reuse the
canonical stage actions. A
`results_ready` is prepared only through the strict `results-report-v1` named
server fixture; the analysis scope still invokes real server analysis.
The analysis scope validates the completed server schema and correlates the
returned assessment ID to its same-origin BFF route. The results-report scope
then exercises report generation and the shared return-Home stage; it does not
claim to validate clinical analysis.
The `legacy-journey` scope remains available only as an explicit diagnostic
selection and is not included by default or by conservative changed-file
selection.

Scope timing logs contain only the approved scope name, phase, and duration.
They measure checkpoint setup, stage action, and browser finalization. Isolated
stack disposal timing and exact cleanup evidence remain owned by the outer Make
lifecycle. Forced failures selected with
`PATIENT_WEB_E2E_FORCE_FAILURE_AFTER_STAGE=<scope>` fire at deterministic
milestones inside the shared canonical stage actions, before their end-state
transitions; stack cleanup remains owned by the outer lifecycle.

The root lifecycle allocates `PATIENT_WEB_E2E_RUN_ID` as the isolated stack and
runtime owner. Each checkpoint scope deterministically derives a distinct UUIDv5
child identity from that root UUID and its scope name, then sends the exact
child `{run_id, email}` pair to guarded backend support endpoints. Reusing a
checkpoint inside one scope therefore reuses its identity, while independent
scopes cannot register the same patient. The unscoped legacy journey continues
to use the root identity directly.

The canonical Make lifecycle disposes the entire isolated stack by removing its
database/object-storage volumes on success or failure. A future exact-run
database, cache, and object-store cleanup implementation must derive or
enumerate every deterministic scope child from the root run before claiming
complete deletion. The current deployed dev and production modes deliberately
retain those child-tagged synthetic records. The cleanup endpoint validates one
exact child identity but returns conflict until that reviewed multi-child
capability exists; it never reports stack disposal as application-data
deletion. Browser tests do not call it. Before any journey mutation,
the browser lifecycle requires `PATIENT_WEB_E2E_STACK_DISPOSABLE=true`; the root
Make lifecycle supplies that marker only for its isolated Compose stack. Direct
`pnpm test:e2e` invocations therefore fail closed unless an operator explicitly
owns an equivalent disposable stack. The protected `infra-dev.yml` workflow
may instead authorize a retained synthetic run with
`PATIENT_WEB_E2E_DEPLOYED_DEV=true` and
`PATIENT_WEB_E2E_RETAIN_SYNTHETIC_RUN=true`. That mode accepts only the root
HTTPS `fde-patient-...-dev-....azurefd.net` endpoint emitted by the dev
deployment, retains its UUID-tagged synthetic records under the dev
environment's policies, and rejects production-shaped Front Door endpoints.
An administrator may explicitly authorize the same retained-synthetic lifecycle
against production with `PATIENT_WEB_E2E_DEPLOYED_PROD=true` and
`PATIENT_WEB_E2E_RETAIN_SYNTHETIC_RUN=true`. Production authorization accepts
only the exact root `https://app.spinesense.ai/` URL: alternate hosts, direct
Front Door endpoints, ports, paths, queries, fragments, and URL credentials are
rejected. Disposable, dev, and production lifecycle markers are mutually
exclusive, and every mode still requires the exact UUID-backed synthetic run
identity.

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

The legacy journey timeout is derived from the bounded OCR, analysis,
document-summary, and report deadlines plus an explicit interactive/lifecycle
allowance. `PATIENT_WEB_E2E_FULL_FLOW_TIMEOUT_MS` may raise that cap, but a
value below the computed critical path is rejected before browser execution.
Checkpoint scopes retain their shorter independent timeout.

FHIR route behavior, browser security headers, session handling, and other
functional contracts remain covered by the package's Vitest tests and the
backend's pytest suite. Production journey execution is an explicit
administrator-authorized retained-synthetic run because retention-safe
exact-run cleanup is unavailable. Emergency support disablement and
verify-disabled checks remain owned by the orchestration production runner.
