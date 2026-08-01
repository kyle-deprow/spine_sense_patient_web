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

The default `E2E_SCOPES=full` invocation remains the sole canonical journey.
For focused validation, the manifest also exposes opt-in checkpoint scopes in
`e2e/scoped-assessment.spec.ts`; those scopes prepare their start checkpoint
through the same BFF/product APIs and reuse the canonical stage actions. A
scope cannot fabricate the server-authored results checkpoint.

Each invocation creates a UUID-backed synthetic email and sends the exact
`{run_id, email}` identity to the guarded backend support endpoints. The
canonical Make lifecycle owns disposal by running the journey in an isolated
stack and removing its database/object-storage volumes on success or failure.
The compatibility cleanup endpoint still validates the identity and records
the control-plane event, but does not perform broad application-data deletion.
Missing or mismatched identities are rejected; no global patient deletion,
cache flush, or BFF rate-limit reset is permitted. Direct `pnpm test:e2e`
invocations therefore require an operator-managed disposable stack when
residue-free cleanup is needed.

Performance behavior is explicit through `PATIENT_WEB_E2E_PERFORMANCE_MODE`:
`observe` is the intentional default, `enforce` fails on configured budgets,
and `off` omits measurements. Performance JSON attachments remain opt-in via
`PATIENT_WEB_E2E_PERFORMANCE_ARTIFACTS=true`; traces, screenshots, and videos
remain off by default.

Transient recovery is bounded and classified. Network-change and 502/503/504
transport failures may recover within their stage budget; application,
authorization, schema, clinical, and assertion failures fail fast.

FHIR route behavior, browser security headers, session handling, and other
functional contracts remain covered by the package's Vitest tests and the
backend's pytest suite. Production support enablement, cleanup, and
verify-disabled checks remain owned by the orchestration production runner.
