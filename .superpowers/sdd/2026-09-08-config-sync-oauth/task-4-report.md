# Task 4 implementation report

## Status

Implemented the OAuth sharing service surface for first share, shared replacement, verified local detachment, and cancellation of an in-memory detach candidate.

## Changes

- Added `OAuthSharingService` and `createOAuthSharingService` under `packages/core/src/sync/oauth/sharing`.
- First share reads the exact local account under the provider gate, validates the adapter sync format, creates the remote account with generation zero using CAS, and records local shared ownership only after the remote write succeeds.
- Existing remote accounts are reconciled by payload comparison and never overwritten by first share.
- Shared replacement advances the remote generation with CAS and stages the local account update before publishing shared ownership metadata.
- Detachment requires the adapter's `credentialSync.canDetach` proof. Failed or unsupported proof leaves shared ownership intact; successful proof stages the candidate account and marks the local entity independent atomically within the account transaction.

## Verification

- `bunx tsc --noEmit -p packages/core/tsconfig.json` — passed.

## Concerns

- The current task branch does not contain the task brief's `withOAuthSharingFixture`; focused behavioral coverage for the new service could not be added without duplicating the repository fixture and backend harness.
- The service currently keeps a pending detach candidate in process memory. Durable pending-journal recovery and server lifecycle wiring remain to be completed by the coordinating agent.

## Fix round 1

Added durable OAuth journal entries around first-share and detach, persisted `detach-pending` ownership before asynchronous verification, cancellation generation fencing, evidence validation, unknown remote record handling, and replacement epoch/plugin metadata preservation.

Verification: `bunx tsc --noEmit -p packages/core/tsconfig.json` — exit 0 (no diagnostics).

## Fix round 2

Corrected OAuth journal identity to use the remote epoch and generation for detach, fenced unknown first-share outcomes against exact object/plugin/capability/version/format/phase/payload identity before recording ownership, and retained cancellation generation fencing while clearing the detach marker and journal on cancellation.

Verification: `bunx tsc --noEmit -p packages/core/tsconfig.json` — exit 0; pre-commit `oxfmt`, `oxlint`, and `commitlint` — all passed.

## Fix round 3

Stored the original detach journal epoch and generation in the pending token so cancellation cleanup remains valid even if local ownership changes while verification is suspended. Unknown first-share outcomes now also require generation zero, no claim, and no completed operation before reconciliation.

Verification: `bunx tsc --noEmit -p packages/core/tsconfig.json` — exit 0; pre-commit `oxfmt`, `oxlint`, and `commitlint` — all passed.

## Fix round 4

Completed the durable OAuth sharing lifecycle. Share, replacement, and detachment now use typed journal envelopes and exact remote identity reconciliation; first-share and replacement recover unknown backend outcomes without duplicating generation changes; detachment survives restart and fences cancellation or ownership changes. Adapter sync evidence and credential schemas are validated before publication, active remote refresh claims block replacement and detachment, purged or incompatible remote state stays fail-closed, and a backend switch cannot seed a credential that is already shared elsewhere.

Added a reentrant per-Provider gate and routed local/shared refresh, runtime and control-plane account preparation, catalog and quota work, login/relogin, account recovery, and removal finalization through it. Server sync startup now creates the sharing service and runs durable recovery. Login synchronizes the staged account with shared state before completing the account operation, leaving the staged operation recoverable if remote synchronization fails. Added behavior coverage for gate serialization, share races, unknown acknowledgements, replacement recovery, restart/cancellation fencing, remote claims, purge, backend switching, and shared relogin. Added `.changeset/green-bobcats-boil.md` for `@aio-proxy/core` and `aio-proxy` as a minor release.

Implementation commit: `68f7489` (`feat(core): complete OAuth sharing lifecycle`).

### Verification

- `rtk proxy bunx oxfmt --write packages/core/src/plugins/account-login/login.ts packages/core/src/plugins/account-login/recovery.ts packages/core/src/plugins/account-login/relogin.test.ts packages/core/src/plugins/credential-port/credential-port.ts packages/core/src/plugins/credential-port/shared.test.ts packages/core/src/sync/oauth/index.ts packages/core/src/sync/oauth/sharing/index.ts packages/core/src/sync/oauth/sharing/sharing.ts packages/core/src/sync/oauth/sharing/gate.ts packages/core/src/sync/oauth/sharing/journal.ts packages/core/src/sync/oauth/sharing/sharing.test.ts packages/core/src/sync/oauth/test-support.ts packages/core/src/sync/repository/oauth-journal.ts packages/server/src/account-removal.ts packages/server/src/oauth-account-context/oauth-account-context.ts packages/server/src/oauth-login-session/manager.test.ts packages/server/src/oauth-login-session/manager.ts packages/server/src/plugin-account.ts packages/server/src/plugin-runtime/materialize.ts packages/server/src/plugin-runtime/types.ts packages/server/src/server-state/index.ts packages/server/src/server-state/lifecycle.ts packages/server/src/server-state/recovery.ts packages/server/src/server-state/snapshot.ts packages/server/src/server-state/startup-recovery.ts packages/server/src/sync-control-plane/lifecycle.ts .changeset/green-bobcats-boil.md` — exit 0; 27 files formatted.
- `rtk proxy bun test packages/core/src/sync/oauth/sharing packages/core/src/plugins/credential-port packages/core/src/plugins/account-login` — exit 0; 127 passed, 0 failed, 457 assertions across 15 files.
- `rtk proxy bun test packages/server/src/oauth-login-session packages/server/src/plugin-account.test.ts packages/server/src/plugin-account-control-plane.test.ts packages/server/src/credential-refresh packages/server/src/plugin-quota packages/server/src/sync-control-plane packages/server/src/server-state packages/server/src/oauth-account-context packages/server/src/plugin-runtime` — exit 0; 222 passed, 0 failed, 735 assertions across 31 files.
- `rtk proxy bun run --filter @aio-proxy/core test:unit` — exit 0; 1,994 passed, 0 failed, 5,004 assertions across 222 files.
- `rtk proxy bunx tsc --noEmit -p packages/core/tsconfig.json` — exit 0 with no diagnostics.
- `rtk proxy bun run check` — exit 0; oxlint completed with five existing warnings and oxfmt verified all 2,867 matched files.
- `rtk git diff --cached --check` — exit 0 before the implementation commit.

### Repository-wide limitations

## Fix round 4 follow-up

Removed the final lint blockers from the accumulated round-4 implementation: an unused runtime-config import and an unused CAS result in the unknown-acknowledgement test. The durable first-share fence, backend-switch provenance protection, adapter/version/evidence revalidation, activation evidence path, and shared-login failure recovery remain covered by the existing implementation and focused tests.

### Verification

- `bun run check` — exit 0; oxfmt verified all 2,873 matched files and oxlint reported six pre-existing warnings.
- `bun test packages/core/src/sync/oauth/sharing packages/server/src/sync-control-plane/activation.test.ts` — exit 0; 28 passed, 0 failed, 89 assertions.

- `rtk proxy bun run preflight` — exit 1 in `lint:types`, before formatting or tests ran. The six errors are outside this change: two dashboard errors in `use-oauth-editor-session.ts` (`TS2322`, `TS2589`) and four CloudKit script errors in `artifact.ts` and `sign-native.ts` (`TS18048`, `TS2322`).
- `rtk proxy bun run test` — exit 1 in the existing `@aio-proxy/core#test:artifact` smoke test. Its regex treats valid emitted `./repository.js` imports as unresolved; both the matcher and the source barrel imports are unchanged from the starting commit. The full test command stopped after 50 of 55 tasks, so the core and server unit suites were run directly.
- `rtk proxy bun run --filter @aio-proxy/server test:unit` — exit 1 with 1,858 passed and 2 failed across 294 files. The failures are unchanged baseline tests: the post-close credential-port test reads the already-closed sync database, and the unrelated realtime frame-ceiling test timed out after 2 seconds. The focused server suite above passed all 222 tests.
- `rtk proxy bunx tsc --noEmit -p packages/server/tsconfig.json` — exit 1 on existing project-boundary and stale test-support errors under `packages/server/__tests__` and unrelated test-support modules; no task implementation file was reported.

The initial report concerns are resolved: durable journal recovery, server lifecycle wiring, and focused behavioral coverage are included in the implementation.
