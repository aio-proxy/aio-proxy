# Task 11 Report: Atomic OAuth Plugin Runtime Snapshots

## Status

Implemented the structured OAuth plugin cutover and immutable server runtime
snapshot. Operational config parsing now degrades invalid provider rows without
rejecting valid siblings, while authoring/schema generation remains strict.
The server materializes embedded and third-party plugin accounts into
capability-based raw/model runtimes, swaps snapshots atomically, leases retired
snapshots for in-flight requests, schedules catalog refreshes, and defers OAuth
account deletion until every retired runtime containing that provider drains.

The legacy server-private OAuth runtime, ChatGPT runtime, and alias modules and
their tests were removed. Provider login now delegates to the generic plugin
account flow.

## TDD Evidence

Initial focused tests were added before the implementation for:

- strict authoring versus tolerant operational config parsing;
- embedded built-ins and ProviderV4 validation/invocation;
- plugin runtime materialization, snapshot leases, catalog scheduling, raw
  capability resolution, and cross-protocol fallback.

The initial run failed because per-provider degradation, embedded descriptors,
ProviderV4 bridging, plugin snapshot materialization, and catalog scheduling did
not yet exist. During completion, focused RED/GREEN regressions also proved:

- an overdue TTL catalog was incorrectly reported `fresh` before any stored
  diagnostic;
- disabling then re-enabling a provider discarded its reusable runtime and
  recreated ProviderV4;
- CLI `serve` failed to reach `/health` because it did not await asynchronous
  `createServer()`;
- legacy config-validation tests incorrectly expected an invalid provider row
  to reject the whole root config.
- startup credential diagnostics could return a briefly routable provider;
- deletion could outpace an older leased snapshot after an intermediate
  unavailable snapshot;
- close during recovery could re-arm a timer, and final raw error bodies could
  release their lease before EOF/cancellation.
- ConfigStore and server reload could deadlock by acquiring their independent
  FIFOs and the atomic config lock in opposite order;
- invalid and legacy OAuth rows could be removed without staging account
  cleanup, because tolerant parsing discarded their safe deletion eligibility;
- a committed delete marker and a failed drain finalizer did not arm the
  guarded recovery timer;
- uncertain config commits could either compensate a marker after the config
  and snapshot had committed, or preserve it without arming runtime recovery;
- a ConfigStore commit that became uncertain before verification could leave
  committed disk bytes, the old runtime snapshot, and a permanently drain-gated
  marker divergent when config watching was disabled;
- a failed reconciliation could compensate the retained uncertainty marker and
  never retry, leaving committed disk bytes and the old snapshot divergent;
- Dashboard deletion of a valid OAuth row no longer preserved the typed
  cleanup-pending preflight for missing or mismatched account identity;
- a rejected recovery used an unrelated credential-refresh log code, and its
  close fence was not directly exercised while the rejection was in flight.

All regressions now pass after the minimal production or test migration.

## Step 3–4 Acceptance Matrix

Every brief bullet has a direct named regression; no item relies only on an
implementation inference.

| Step 3 runtime/snapshot bullet | Direct test coverage |
| --- | --- |
| Provider record key becomes runtime ID | `plugin-runtime.test.ts` — `the provider config key becomes the materialized runtime provider ID` |
| Catalog routes, aliases, and display metadata | `plugin-runtime.test.ts` — `plugin raw capability receives catalog metadata and rejects malformed transports`; `a materialized OAuth provider obeys real Router self, rename, and preserve aliases` |
| Invalid/legacy summaries never enter Router | `plugin-snapshot.test.ts` — `invalid and legacy provider summaries remain visible but never enter Router candidates` |
| Stable diagnostics matrix | `plugin-runtime.test.ts` — `maps plugin, capability, account, options, credential, catalog, and runtime failures to stable diagnostics` |
| Five-second runtime timeout and isolation | `plugin-runtime.test.ts` — `runtime creation timeout isolates a hung provider from another provider materialization` |
| Malformed discovered/stored catalogs | `catalog-scheduler.test.ts` — `a malformed discovered catalog is diagnosed without overwriting stored catalog data`; `plugin-runtime.test.ts` — `a malformed stored catalog becomes unavailable and schedules safe rediscovery` |
| Bad plugin does not block API/AI SDK routing | `plugin-snapshot.test.ts` — `failed plugin setup remains snapshot data and does not block API or AI SDK providers` |
| API/AI SDK state omits catalog; OAuth sets freshness | `provider-ordering.test.ts` — `preserves weight and config order across OAuth, AI SDK, and API providers` |
| Setup reruns; descriptor import is cached | `plugin-runtime.test.ts` — `plugin descriptor import is cached while setup runs for every registry snapshot` |
| `createRuntime()` runs once per successful identity | `plugin-runtime.test.ts` — `diagnostic-only rebuild reuses the runtime and credential port` |
| Diagnostic-only rebuild reuses runtime | `plugin-runtime.test.ts` — `diagnostic-only rebuild reuses the runtime and credential port` |
| Disabled provider performs no runtime/catalog work | `plugin-runtime.test.ts` — `an initially disabled provider validates state without creating runtime or catalog work` |
| Plugin/options/re-login/catalog changes rebuild identity | `plugin-runtime.test.ts` — `an identity change creates a new credential port with the new plugin generation`; `plugin options, account re-login revision, and catalog refresh each rebuild the affected runtime` |
| Credential revision alone reuses runtime/port | `plugin-runtime.test.ts` — `credential revision refresh stays visible without rebuilding the runtime` |
| Plugin removal drops capability, preserves account | `plugin-runtime.test.ts` — `plugin removal drops the runtime capability without deleting the account` |
| In-flight request retains old snapshot | `plugin-snapshot.test.ts` — `an in-flight protocol response retains its old provider snapshot until the body completes`; `an in-flight model stream retains its old provider snapshot until response EOF`; `... until response cancel`; `a final raw error response retains its old provider snapshot until the body completes` |
| Deletion drains before physical cascade | `plugin-snapshot.test.ts` — `OAuth deletion cascades account data only after the retired snapshot drains`; `OAuth deletion waits for every older retired snapshot containing the provider` |
| Recovery gated by current/retired snapshots | `plugin-snapshot.test.ts` — `pending deletion recovery is gated by current and undrained retired snapshots` |
| Overlapping reloads preserve serialized file order | `plugin-snapshot.test.ts` — `overlapping slow and fast reloads commit in serialized file-read order` |
| Root/Router candidate failures preserve prior snapshot | `plugin-snapshot.test.ts` — `a root config parse failure preserves the prior snapshot`; `a failed candidate preserves the prior snapshot and never starts its catalog job` |
| Failed candidate never replaces/starts catalog jobs | `plugin-snapshot.test.ts` — `a failed candidate preserves the prior snapshot and never starts its catalog job` |
| Pending/orphan recovery returns earliest retry and honors drain | `plugin-snapshot.test.ts` — `server recovery schedules the earliest competing orphan and pending deadlines and close clears the later one`; `pending deletion recovery is gated by current and undrained retired snapshots` |
| Failed setup remains data in a successful snapshot | `plugin-snapshot.test.ts` — `failed plugin setup remains snapshot data and does not block API or AI SDK providers` |

| Step 4 dispatch/scheduler bullet | Direct test coverage |
| --- | --- |
| Exhaustive internal-to-SDK protocol map | `plugin-runtime.test.ts` — `maps every internal provider protocol to the plugin SDK protocol` |
| Same-protocol raw capability wins | `pipeline.test.ts` — `prefers same-protocol raw capability when the provider also has model capability` |
| Catalog metadata reaches RawResolver | `plugin-runtime.test.ts` — raw capability metadata test |
| Resolver `undefined` falls back to model | `pipeline.test.ts` — `uses model capability when the raw resolver returns undefined for a protocol mismatch` |
| Malformed resolver/response advances fallback | `pipeline.test.ts` — `falls back after a malformed plugin raw resolver/response failure` |
| Cross-protocol never invokes raw | `cross-protocol-routing.test.ts` — all 16 inbound/provider protocol matrix cases |
| API, AI SDK, and plugin share weight/config order | `provider-ordering.test.ts` — cross-kind ordering test |
| Plugin/raw attempt failure advances candidate | `pipeline.test.ts` — raw status/network fallback tests |
| Stream preflight prevents replay after output | `pipeline.test.ts` — first-event fallback and post-first-event no-fallback tests |
| Static stored catalog does not schedule | `catalog-scheduler.test.ts` — `static catalogs with a stored first result do not schedule discovery` |
| TTL success persists and rebuilds | `catalog-scheduler.test.ts` — `an overdue TTL catalog persists discovery and rebuilds the runtime snapshot` |
| TTL failure with old catalog stays last-known-good | `catalog-scheduler.test.ts` — `a failed TTL refresh preserves last-known-good and waits the host retry interval` |
| Failure without catalog stays unavailable | `plugin-runtime.test.ts` — diagnostics matrix missing-catalog case; scheduler deadline failure test |
| Discovery receives abort and hard deadline | `catalog-scheduler.test.ts` — close-abort, ignored-abort deadline, and late-result tests |
| Failure retry waits five minutes/no immediate loop | `catalog-scheduler.test.ts` — failed TTL refresh retry-interval test; production default remains `CATALOG_RETRY_MS` |
| Close cancels timers/in-flight work/rebuild retry | `catalog-scheduler.test.ts` — close-abort and post-persistence retry cancellation tests |
| Plugin/account removal discards in-flight discovery | `plugin-snapshot.test.ts` — `removing an OAuth account during discovery discards the late catalog and cannot resurrect the provider` |

## Implementation Summary

- Added `ConfigAuthoringSchema` and tolerant `ConfigSchema.invalidProviders`,
  with safe diagnostic paths and no rejected values in runtime output.
- Activated structured `OAuthProviderSchema` using plugin/capability identity.
- Bound localized GitHub Copilot and ChatGPT descriptors through
  `createEmbeddedBuiltIns()` and ensured reserved names bypass npm lookup.
- Added ProviderV4 runtime validation and the AI SDK streaming bridge.
- Generalized Router/runtime dispatch to capability-based `raw.resolve()` and
  `model` transports; the pipeline remains the only provider candidate loop.
- Added plugin runtime identity hashing, stable credential-port reuse, raw
  metadata forwarding, redacted transport validation, TTL freshness, and
  enable/disable cache reuse without reconstructing ProviderV4.
- Added reference-counted immutable snapshots, serialized asynchronous rebuilds,
  atomic config verification/swap, safe retirement, and account-deletion fences
  across every older retired snapshot containing the provider.
- Added host-owned catalog timers with generation replacement, timeout, abort,
  retry, last-known-good behavior, and close cleanup.
- Added deferred account deletion and recovery gating for current and retired
  snapshots, with terminally handled drain callbacks.
- Reused one FIFO queue helper for both ConfigStore mutation ordering and the
  server snapshot rebuild chain; the server injects its single shared queue,
  while standalone ConfigStore instances retain a private default queue.
- Made `createServerState()` and `createServer()` asynchronous and migrated CLI
  and server callers without a compatibility wrapper.
- Buffered startup credential diagnostics now converge through the serialized
  snapshot queue before `createServerState()` returns; recovery uses a closed
  generation fence, and final raw error bodies retain their snapshot lease
  through EOF, error, or cancellation.
- Unified valid, invalid, and legacy OAuth removal through the same
  runtime-revision CAS coordinator, retained only the safe OAuth kind marker in
  parsed snapshots, and armed the earliest guarded recovery deadline whenever
  a committed marker starts draining or finalization fails.
- Preserved the valid structured OAuth account-identity preflight for Dashboard
  deletion, while invalid and legacy rows continue through kind-only CAS
  cleanup. Uncertain ConfigStore and reload commits retain their marker and
  invoke the same drain/recheck path. Pre-verification ConfigStore uncertainty
  also queues a serialized disk-to-snapshot reconciliation behind the current
  mutation, reusing the live marker without a nested FIFO wait or duplicate
  staging. Retained markers are never compensated by a failed reconciliation;
  retries use a guarded five-second backoff and are canceled on server close.
- Replaced live vendor login dispatch with generic optional capability selection
  and explicit `--provider` re-login.

## Verification

Task 11 Step 14 gates:

```text
bun install: exit 0; 775 installs across 899 packages, no changes
i18n compile: exit 0
types: 90 pass, 0 fail, 1 conditional local-config skip
core: 442 pass, 0 fail, 1114 expectations
server: 351 pass, 0 fail, 1060 expectations
CLI full suite: 126 pass, 0 fail, 339 expectations
CLI changed suites: 64 pass, 0 fail, 177 expectations
CLI Step 14 provider-login/commands subset: 18 pass, 0 fail, 48 expectations
```

Additional checks:

```text
CLI async serve smoke: 1 pass, 0 fail
types Rslib build: exit 0
core Rslib build: exit 0 (fresh after the recovery log-code type addition)
GitHub Copilot plugin build: exit 0
ChatGPT plugin build: exit 0
CLI TypeScript: exit 0
scoped Biome: exit 0 on the 11 current changed TypeScript files (8 informational literal-key notices)
git diff --check: exit 0
legacy server OAuth source/reference searches: no matches
```

The server TypeScript project still reports the existing dashboard
`exactOptionalPropertyTypes`/index-signature errors in
`dashboard-routes/config.ts` and `provider-mutation.ts`. The latter is outside
the Task 11 diff, and the checkpoint already identified this repository debt;
Task 11's new runtime/snapshot files have no reported TypeScript errors.

Fresh final standards and spec re-reviews each reported zero Critical and zero
Important findings after inspecting the full reconciliation retry diff.

## Independent Review Fix Pass

Each independent-review finding was reproduced or covered at its public seam,
then verified after the minimal fix.

| Finding | Regression test file and direct test | Command and result |
| --- | --- | --- |
| ConfigStore/server FIFO lock inversion | `packages/server/_test/config-store.test.ts` — `a config mutation and concurrent reload share one FIFO without lock inversion` | RED: `bun test packages/server/_test/config-store.test.ts -t "share one FIFO"` → 500 ms wall-clock watchdog timed out, 1 fail. GREEN: same command → 1 pass, 0 fail; the retained CI watchdog is now 2 seconds. |
| Invalid/legacy OAuth removal skipped account cleanup | `packages/server/_test/account-removal.test.ts` — `stages a runtime-revision CAS marker for a removed invalid OAuth row`; legacy variant; API/AI SDK exclusion; re-add-before-drain; superseded revision | RED: `bun test packages/server/_test/account-removal.test.ts` → invalid and legacy marker cases each received length 0. GREEN: same command → 9 pass, 0 fail, 21 expectations. |
| Dashboard invalid/legacy deletion did not prove cascade | `packages/server/_test/dashboard-providers-mutation.test.ts` — `Dashboard DELETE of an invalid OAuth row cascades account state through its CAS marker`; vendor-only and hybrid-own-vendor legacy variants | `bun test packages/server/_test/dashboard-providers-mutation.test.ts -t "cascades account state"` → 3 pass, 0 fail, verifying config/account/catalog/diagnostics/marker cleanup, including a hybrid legacy row whose account identity intentionally mismatches its plugin/capability fields. |
| Reload snapshots lost invalid/legacy deletion eligibility | `packages/server/_test/server-reload.test.ts` — manual invalid removal and watcher legacy removal CAS variants | RED: `bun test packages/server/_test/server-reload.test.ts -t "account cleanup uses a CAS marker"` → account retained and watcher timed out, 2 fail. GREEN: same command → 2 pass, 0 fail. Full file after the uncertain-commit regression → 6 pass, 0 fail, 19 expectations. |
| Marker creation/finalizer failure did not arm recovery | `packages/server/_test/account-removal.test.ts` — `a committed delete marker schedules recovery before its retired snapshot drains`; `a failed delete finalizer re-arms recovery at the marker deadline`; `packages/server/_test/plugin-snapshot.test.ts` — `a failed delete finalizer is retried by the marker recovery deadline`; `a committed delete marker arms the server recovery timer` | Coordinator RED scheduled `[]`; server RED recoveries stayed 2 instead of 3. GREEN: account-removal file → 9 pass, 0 fail, 21 expectations; the four named marker/finalizer tests across both files → 4 pass, 0 fail, 13 expectations. |
| Recovery itself could reject, escape fire-and-forget, and disarm the timer | `packages/server/_test/plugin-snapshot.test.ts` — `a rejected recovery run is logged with a fixed payload and retried`; `close prevents an in-flight rejected recovery from logging or rearming` | RED: injected recovery rejection escaped as an unhandled error and no log/retry occurred; the log-code regression then received `CREDENTIAL_REFRESH_FAILED`. GREEN: focused rejected-recovery subset → 2 pass, 0 fail, 8 expectations, with fixed redacted payload and direct in-flight close fencing. |
| Uncertain ConfigStore commit lost runtime recovery | `packages/server/_test/config-store.test.ts` — `preserves a staged delete marker when the config commit outcome is uncertain`; `an uncertain commit before verify only arms recovery until the old snapshot is safe`; definite-failure compensation companion | Post-verify RED: config bytes and verified snapshot omitted the provider, but scheduled deadlines were `[]`. Pre-verify RED: the account was immediately deleted while verify had not run. GREEN: post-verify 10 expectations drain/recheck and cascade; pre-verify 6 expectations retain account+marker, arm TTL, then cascade only after recovery reports deletion safe. |
| Pre-verify uncertainty could permanently diverge disk and runtime snapshot | `packages/server/_test/config-store.test.ts` — `server reconciliation converges committed bytes after pre-verify uncertainty`; uncommitted-bytes variant; notification-failure assertion in the pre-verify unit regression | RED: the server-side uncertain file was not shared with ConfigStore, so deletion unexpectedly resolved and no reconciliation ran. GREEN: 2 parameterized cases, 14 expectations; committed bytes remove the provider from the runtime snapshot and cascade only after the old lease drains, while uncommitted bytes retain the provider/account and safely complete the original marker. A throwing notification hook cannot mask `AtomicConfigCommitUncertainError`. |
| Failed reconciliation destroyed the retained marker and did not retry | `packages/server/_test/config-store.test.ts` — `server reconciliation preserves its marker and retries after a failed snapshot build`; `server close cancels a delayed reconciliation retry without an immediate failure loop` | RED: both tests observed zero pending markers after the first Router failure. GREEN: 2 pass, 0 fail, 18 expectations; retained and newly staged operations are separated, the default retry is a non-busy five-second backoff, repeated failure does not spin, a successful retry swaps before drain/cascade, and close/generation fencing cancels a pending retry. Full ConfigStore file: 12 pass, 0 fail, 64 expectations. |
| Uncertain reload compensated after snapshot swap | `packages/server/_test/server-reload.test.ts` — `an uncertain reload commit keeps cleanup recoverable after the snapshot swaps` | RED: explicit injection first returned `ok: true`; the real-shape generic post-mutate `Config lock ownership lost` then timed out with the account orphaned after compensation. GREEN: 1 pass, 0 fail, 3 expectations; `retired !== undefined` identifies the completed swap independently of error class, preserves/finalizes the marker, and reports reload failure. |
| Dashboard valid OAuth deletion lost cleanup-pending identity preflight | `packages/server/_test/dashboard-providers-mutation.test.ts` — missing-account and plugin/capability-mismatch variants | RED: both returned 200 and removed config/account state. GREEN: focused subset → 2 pass, 0 fail, 9 expectations; both return typed 409 and preserve config/account/markers. |
| Superseding runtime-revision test removed its marker too early | `packages/server/_test/account-removal.test.ts` — `a live delete marker cannot remove an account with a superseding runtime revision` | The revised test keeps the marker present, advances `runtime_revision`, then proves finalization returns through the live CAS without deleting the newer account: 1 pass, 0 fail, 3 expectations. |
| Provider key → runtime ID lacked a direct test | `packages/server/_test/plugin-runtime.test.ts` — `the provider config key becomes the materialized runtime provider ID` | `bun test packages/server/_test/plugin-runtime.test.ts -t "config key becomes"` → 1 pass, 0 fail. |
| Real Router self/rename/preserve behavior lacked direct materialized-runtime coverage | `packages/server/_test/plugin-runtime.test.ts` — `a materialized OAuth provider obeys real Router self, rename, and preserve aliases` | `bun test packages/server/_test/plugin-runtime.test.ts -t "real Router"` → 1 pass, 0 fail. |
| Bad plugin isolation covered API only | `packages/server/_test/plugin-snapshot.test.ts` — `failed plugin setup remains snapshot data and does not block API or AI SDK providers` | `bun test packages/server/_test/plugin-snapshot.test.ts -t "does not block API or AI SDK"` → 1 pass, 0 fail. |
| Model stream snapshot lease lacked direct EOF/cancel coverage | `packages/server/_test/plugin-snapshot.test.ts` — model stream EOF and cancel variants | `bun test packages/server/_test/plugin-snapshot.test.ts -t "in-flight model stream"` → 2 pass, 0 fail. |
| Unused plugin runtime symbols | `pluginMetadata()` and its `JsonValue` import removed | `rg -n "pluginMetadata\|type JsonValue" packages/server/src packages/server/_test` → no matches. |

Fix-pass verification:

```text
affected server files: 100 pass, 0 fail, 343 expectations
full server: 351 pass, 0 fail, 1060 expectations
full core: 442 pass, 0 fail, 1114 expectations
full CLI: 126 pass, 0 fail, 339 expectations
CLI TypeScript: exit 0
core Rslib build: exit 0
scoped Biome: exit 0 (eight informational literal-key notices; index-signature accesses remain bracketed for TypeScript)
git diff --check: exit 0
server TypeScript: only the previously documented dashboard config/provider-mutation errors remain
```

## Coverage Notes

- `pipeline.test.ts` covers same-protocol raw preference, cross-protocol model
  fallback, raw status/network fallback, stream preflight, cancellation, and
  terminal request recording. Plugin runtime coverage additionally verifies
  catalog metadata forwarding and malformed resolver/response rejection.
- `diagnostic.test.ts` covers OAuth and arbitrary secret redaction, malicious
  error accessors, and safe loader diagnostics. Server diagnostics are built
  from localized i18n copy and invalid provider summaries never contain raw
  rejected values.
- `example-config.test.ts` now validates a present local config with both the
  strict authoring schema and tolerant operational schema; it remains skipped
  on clean machines where the gitignored file is absent.
- Generic login coverage includes optional/short/canonical capability
  selection, explicit target inference, mismatch errors, duplicate guidance,
  cleanup-pending behavior, and fingerprint mismatch localization. Core account
  tests verify fingerprint mismatch rollback preserves the old revision.

## Self-Review

- Provider selection remains model-first and weight/config-order preserving.
- Same-protocol raw capability wins; cross-protocol calls use materialized model
  capability; no route file contains its own candidate loop.
- Runtime identity excludes credential revision, diagnostics, enabled, weight,
  name, and alias, while including plugin/options/login/catalog changes.
- Disabled providers validate stored state but do not create a new credential
  port, invoke `createRuntime()`, enter Router, or schedule catalog work. A
  matching previous runtime is retained privately for later re-enable.
- Catalog refresh and diagnostic rebuilds use the latest serialized snapshot;
  failed candidates do not replace active timers or routing state.
- Raw plugin/account secrets are hashed before identity composition and runtime
  errors log fixed redacted messages.
- Config deletion removes new routing immediately and physical account data only
  after every older retired snapshot containing that provider drains and the raw
  config is rechecked under lock.
- The async CLI serve path awaits server creation before binding Bun's listener.

## Concerns

- Repository-wide server TypeScript remains red on the pre-existing dashboard
  issues described above; scoped Task 11 lint, builds, and tests are green.
- The example-config test is intentionally conditional because `aio-proxy.json`
  is gitignored and may contain real credentials.
