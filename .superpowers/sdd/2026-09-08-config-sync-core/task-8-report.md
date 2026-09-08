# Task 8 report: reconcile selective configuration sync

## Files

- Added `packages/core/src/sync/engine/engine.ts` with the backend-neutral reconciliation loop and lifecycle.
- Added `packages/core/src/sync/engine/remote.ts` to isolate remote discovery, revision validation, conflict handling, and local activation from lifecycle and outbox orchestration.
- Added `packages/core/src/sync/engine/incoming.ts` with activation and pending-state contracts.
- Added `packages/core/src/sync/engine/scheduler.ts` with polling/backoff constants and bounded jitter.
- Added `packages/core/src/sync/engine/index.ts` and exported the engine from `packages/core/src/sync/index.ts`.
- Added `packages/core/src/sync/engine/engine.test.ts` covering two-device publication/import, selective exclusion, and no-watch lifecycle use.
- Added `packages/core/src/sync/engine/test-support.ts` with deterministic two-device SQLite repositories, real `AtomicConfigFile` local commit capture, remote-origin application, lifecycle gates, and a shared in-memory backend whose logical space is `default`; the core test-support barrel re-exports it.

## Lifecycle and reconciliation behavior

The engine verifies the active binding, identity, space, and session generation before work and again before local application or outbox acknowledgement. Local commit recovery also checks the binding fence after every awaited local read and before repository mutations, preventing a generation switch from discarding or confirming stale work. It recovers prepared local commits, drains the durable outbox using publication/deletion recovery, paginates cloud entity heads, validates current revisions, persists desired state and exclusions, and applies included compatible entities through `LocalSyncPort.applyRemote`. Remote application never creates an outgoing commit.

Active heads with no current revision are treated as transient publication state and left untouched. Current revisions are checked against the head object ID, operation ID, epoch, protocol, state, and logical identity before they can become a baseline. Conflicting object IDs are discovered before activation and all involved identities are excluded and disabled deterministically. Local puts targeting deleted heads use the explicit restore path and advance the remote epoch.

Newly discovered entities are included by default, while an existing local exclusion is retained. A same logical identity with another object ID is kept excluded with `provider-id-conflict`; pending activation keeps desired data and retries on later reconciliation. Unknown or unsupported records remain read-only with `upgrade-required` where an existing local identity can be retained. Deletion and purge heads deliver a null remote application, including excluded identities so the local OAuth coordinator can observe account deletion signals.

`start()` installs an unreliable watch hint when available and always schedules polling. Offline and quota failures use bounded exponential backoff with jitter up to five minutes. `stop()` aborts owned work, cancels timers and watch callbacks, awaits the active reconcile, disposes the session once, and is idempotent.

## Tests and verification

- `bun test packages/core/src/sync`: 100 passed.
- `bun run --filter @aio-proxy/core test`: passed (1,939 tests).
- `bun run --filter @aio-proxy/plugin-sdk test`: passed (92 tests); TypeScript test declarations passed.
- `bun run check`: passed (repository warnings only).
- `bun run --filter @aio-proxy/core build`: passed, including declaration generation.
- Engine coverage also verifies actual polling recovery after offline and quota failures, polling without watch hints, failed watch initialization cleanup, and recreated-engine recovery over persisted local work.

The repository-wide type-aware lint command still reports two pre-existing dashboard TypeScript errors in `use-oauth-editor-session.ts`; they are outside this task. Native CloudKit and live OAuth gates remain outside the backend-neutral core task.

## Concerns

The core engine intentionally delegates prerequisite and credential validation to the host-provided `LocalSyncPort`; it does not refresh OAuth or make runtime/plugin decisions. Unknown cloud data with no existing local identity is preserved remotely and left undiscovered locally until a compatible protocol decoder is available. Plugin snapshot rebuilding and host session reuse remain integration-task coverage; this task includes an engine-level recreated-session assertion only. Native CloudKit and live OAuth gates remain outside the backend-neutral core task.
