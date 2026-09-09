# Whole-branch final-fix report

## Review findings addressed

The final-fix pass addresses the four cross-task defects identified by the whole-branch review of `review-ef5f8fb5..20e774d4`:

- Remote imports now prepare recoverable remote commit journals, retain the remote operation ID as the baseline, and confirm remote commits without creating outbox operations. Tombstones use an epoch-scoped revision marker and skip repeated local deletion after the marker is already applied.
- Plugin secrets are written before remote runtime validation and materialization. Failed imports restore the prior secret, while plugin tombstones delete the local secret row. Secret-only changes still rebuild the runtime snapshot.
- Remote config writes carry a digest and operation fence through the watcher reload path. A watcher reload matching the remote digest skips sync capture, while a later local edit follows the normal local capture path.
- Control-plane remote entities expose the current protocol revision separately from backend storage version. Manual applies persist the revision operation ID as the local baseline.

The sync repository’s binding and entity persistence is split into `repository/local-state.ts`; the main repository implementation is now below the 500-line limit. Regression tests cover secret ordering and rollback, tombstone cleanup, revision baselines, watcher-enabled no-echo imports, and repository behavior.

## Validation

- `rtk bun run check` — passed; existing oxlint warnings only, formatting clean.
- Touched-file type-aware oxlint — passed.
- `rtk bun run --filter @aio-proxy/core build` — passed.
- `rtk bun run --filter @aio-proxy/core test` — 2,008 passed, 0 failed.
- Core repository/local-commit tests — 28 passed, 0 failed.
- Server sync-control-plane and server-state tests — 68 passed, 0 failed.
- Focused server sync-control-plane tests — 26 passed, 0 failed.
- `rtk git diff --check` — passed.

The repository-wide `rtk bun run lint:types` command remains blocked by existing diagnostics in `packages/server/src/sync-control-plane/operations.ts`, the dashboard OAuth editor, and CloudKit artifact/signing scripts; no touched-file diagnostic remains. The existing `preflight` baseline therefore remains documented rather than claimed green.

## Unavailable live gates

Live CloudKit signing, installed-path/launchd, two-Mac, and provider OAuth gates were unavailable in this workspace because the required signing material, macOS production environment, isolated test home, accounts, and provider-specific upstream credentials were not available. Existing redacted evidence remains blocked, and this report makes no production-readiness claim.

## Final fix wave after scoped re-review

- Tombstone secret deletion now checks the repository CAS result. A failed delete returns `secret-conflict`, preserves the local secret, and leaves the entity baseline and prepared remote journal untouched.
- Commit intents now durably record plugin-secret before/after values. Recovery confirms a secret-only remote commit only when the current secret matches the intended value; an unknown concurrent value remains pending across reopen.
- Remote config application passes the local digest into a lock-held transaction. A stale digest rejects the candidate without overwriting an external edit. Lock-release uncertainty keeps the remote watcher fence and recoverable commit pending until a later reconciliation completes it.

## Final fix validation

- Focused core/config/local-commit/repository/engine tests: 62 passed, 0 failed.
- Focused server sync-control-plane/server-state/acceptance tests: 20 passed, 0 failed; the watcher lock-release acceptance and stale-digest integration regressions passed.
- `bun run check`, touched-file type-aware oxlint, core build, and `git diff --check` passed. Repository-wide type diagnostics remain the documented baseline outside touched files.

## Residual prepared-remote retry ruling

The prepared journal for `remote:${objectId}:${operationId}` is authoritative across retries. A retry now uses its stored raw config and plugin-secret before/after intent instead of recomputing or discarding the journal from live state. A current raw digest or secret outside the stored before/after pair returns a stable pending result, preserving the external edit, entity baseline, and prepared journal. A before-state side is retried with the stored target and the current CAS revision; an after-state side is skipped, and confirmation occurs only after both sides match the stored after-state.

Regression evidence: the same-operation retry after an external plugin-secret edit resolves to `secret-conflict` without throwing or overwriting the secret; a config-changing retry resolves to `invalid-config` (and then `secret-conflict` when the secret also changes) while preserving the external config, unknown secret, and durable journal. The focused server/core suite passed 47 tests, `bun run check` passed with existing warnings only, and `git diff --check` passed.
