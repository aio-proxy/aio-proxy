### Task 8: Split Server Runtime, State, Pipeline, and Integration Tests

**Files:**
- Replace `packages/server/src/plugin-runtime.ts` with `packages/server/src/plugin-runtime/`.
- Replace `packages/server/src/server-state.ts` with `packages/server/src/server-state/`.
- Replace `packages/server/src/routes/pipeline.ts` with `packages/server/src/routes/pipeline/`.
- Split `packages/server/_test/plugin-runtime.test.ts`.
- Split `packages/server/_test/plugin-snapshot.test.ts`.
- Split `packages/server/_test/catalog-scheduler.test.ts`.
- Split `packages/server/_test/account-removal.test.ts`.
- Extract PR-added cases from oversized modified server test files.

**Interfaces:**
- Preserves: `materializePluginProvider`, `pluginOptionsIdentityDigest`, `validatePluginProtocolMap`, `createServerState`, `createModelsDevCatalogTask`, and `handleProtocolRequest`.
- Preserves: the single candidate loop in `routes/pipeline` and capability-based routing required by root `AGENTS.md`.

- [ ] **Step 1: Run the server baseline**

```bash
rtk bun test packages/server/_test/plugin-runtime.test.ts packages/server/_test/plugin-snapshot.test.ts packages/server/_test/catalog-scheduler.test.ts packages/server/_test/account-removal.test.ts packages/server/_test/pipeline.test.ts packages/server/_test/config-store.test.ts
```

Expected: PASS.

- [ ] **Step 2: Split plugin runtime by pure concern**

Create:

```text
plugin-runtime/index.ts
plugin-runtime/types.ts
plugin-runtime/identity.ts
plugin-runtime/catalog.ts
plugin-runtime/capabilities.ts
plugin-runtime/materialize.ts
```

- `identity.ts`: stable serialization, digests, runtime identity.
- `catalog.ts`: catalog diagnostics/freshness/metadata.
- `capabilities.ts`: raw/model capability wrapping and routing config.
- `materialize.ts`: provider materialization state machine.
- `index.ts`: public exports and protocol-map validation.

- [ ] **Step 3: Split server state by lifecycle**

Create:

```text
server-state/index.ts
server-state/types.ts
server-state/snapshot.ts
server-state/recovery.ts
server-state/probe.ts
```

- `snapshot.ts`: `Snapshot`, provider summaries, `buildSnapshot`, `buildSnapshotWithProviders`, empty plugin snapshot.
- `recovery.ts`: recovery scheduler/timer and pending-operation scheduling.
- `probe.ts`: status merge and provider probe.
- `index.ts`: `createServerState`, DB opening, public types, and lightweight orchestration.

- [ ] **Step 4: Split the protocol pipeline without creating a second candidate loop**

Create:

```text
routes/pipeline/index.ts
routes/pipeline/attempt.ts
routes/pipeline/failure.ts
routes/pipeline/stream.ts
routes/pipeline/request.ts
```

- `index.ts`: `handleProtocolRequest` and the only call into `attemptCandidates`.
- `attempt.ts`: the sole candidate loop and attempt base construction.
- `failure.ts`: fallback status and final protocol-shaped failures.
- `stream.ts`: response retention and stream preflight.
- `request.ts`: content-length validation.

Do not move candidate iteration into adapters or route registration files.

- [ ] **Step 5: Split new server tests by lifecycle boundary**

Create files at most 300 lines:

```text
plugin-runtime/identity.test.ts
plugin-runtime/catalog.test.ts
plugin-runtime/capabilities.test.ts
plugin-runtime/diagnostics.test.ts
plugin-runtime/materialize.test.ts
plugin-snapshot/test-support.ts
plugin-snapshot/lease.test.ts
plugin-snapshot/reload.test.ts
plugin-snapshot/isolation.test.ts
plugin-snapshot/catalog.test.ts
plugin-snapshot/recovery.test.ts
catalog-scheduler/lifecycle.test.ts
catalog-scheduler/failure.test.ts
account-removal/staging.test.ts
account-removal/finalize.test.ts
account-removal/races.test.ts
```

For existing oversized test files modified by this PR, move only the PR-added cases into focused colocated files so the original file returns to its pre-PR size or smaller:

```text
server-reload.oauth.test.ts
dashboard-providers-mutation.oauth.test.ts
config-store.oauth.test.ts
pipeline.oauth.test.ts
pipeline-helpers.oauth.test.ts
```

Apply the same rule to `packages/types/_test/schemas.test.ts`: move OAuth plugin schema cases to `packages/types/src/plugin.test.ts` instead of splitting unrelated legacy schema coverage.

- [ ] **Step 6: Verify server behavior and line limits**

```bash
rtk bun run --filter @aio-proxy/server test:unit
rtk bun x tsc --noEmit -p packages/server/tsconfig.json
rtk bun run --filter @aio-proxy/types test:unit
rtk proxy sh -c 'find packages/server/src/plugin-runtime packages/server/src/server-state packages/server/src/routes/pipeline -name "*.ts" -exec wc -l {} +'
```

Expected: all tests/typechecks pass; every new file is at most 300 lines; route files still contain no provider-kind branching or fallback loops.

- [ ] **Step 7: Commit**

```bash
rtk git add packages/server packages/types
rtk git commit -m "refactor(server): split plugin runtime lifecycle" -m "Co-authored-by: Codex <noreply@openai.com>"
```
