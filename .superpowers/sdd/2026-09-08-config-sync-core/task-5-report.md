# Task 5 implementation report

## Result

Implemented recoverable publication of reserved entity revisions with conditional head and revision writes. Publication reuses the outbox operation ID across retries, treats confirmed CAS conflicts as retryable reads, preserves outcome-unknown failures for a later exact retry, and never replaces a tombstone or an erased revision marker.

## Files

- `packages/core/src/sync/publication/publication.ts`: backend-neutral object-store adapter, head creation and identity checks, reservation, immutable payload staging, publication CAS loop, duplicate receipt resolution, quota checks, and outcome-unknown recovery boundaries.
- `packages/core/src/sync/publication/receipts.ts`: idempotent receipt finalization that preserves the body and original storage-assigned payload timestamp.
- `packages/core/src/sync/publication/index.ts`: export-only publication barrel.
- `packages/core/src/sync/publication/publication.test.ts`: unknown CAS acknowledgement recovery at every publication write, independent and same-entity ordering, paused older writers, out-of-order acknowledgements, retained erased receipts, tombstones, identity/epoch/state fencing, advanced-clock timestamps, quota/offline failures, unresolved dependencies, cleanup completion races, and namespace isolation. Interleavings pause after reservation and payload CAS, before publication and receipt CAS, then let newer writers or cleanup proceed before resuming the old continuation.
- `packages/core/src/sync/test-support.ts`: adds deterministic post-CAS gates alongside the existing pre-CAS gates.
- `packages/core/src/sync/test-support.test.ts`: verifies post-CAS pauses observe persisted bytes before releasing the caller.
- `packages/core/src/sync/index.ts`: exports the publication API.

## State-machine behavior

`publishEntity` first validates a put operation and creates the entity head with create-only CAS when needed. It validates the stable object and logical identity on every read, resolves an existing payload or erased publication receipt before reserving, and uses the protocol reducer to register the operation. The revision payload is written with create-only CAS and its body, object ID, epoch, and operation ID remain immutable. Existing matching payloads are reused; conflicting payloads and abandoned markers fail with protocol errors.

Publication rereads both the head and revision before every head CAS. A confirmed conflict repeats the reads with the same operation ID and intended body, so the head sequence determines the winner. A successful head CAS records the sequence and moves the prior current operation into history. The subsequent receipt CAS adds the sequence and the payload write's original `modifiedAt` without changing the body. An outcome-unknown failure is returned to the caller; rerunning the same operation discovers the persisted head, payload, or receipt and does not allocate another revision.

Reservations listed as cancelling are rejected by the protocol reducer, and a deleted, purging, or purged head cannot be replaced. Dependency references remain valid before their dependency payloads arrive. Config revisions use revision keys only; account keys are never touched.

## Verification

- `rtk proxy bun test packages/core/src/sync/publication/publication.test.ts packages/core/src/sync/test-support.test.ts` — 23 passed, 0 failed.
- `rtk proxy bun test packages/core/src/sync` — 50 passed, 0 failed.
- `rtk proxy bunx tsc -p packages/core/tsconfig.json --noEmit` — passed.
- `rtk proxy bunx oxlint packages/core/src/sync/publication packages/core/src/sync/index.ts` — passed.
- `rtk proxy bunx oxfmt --check packages/core/src/sync/publication packages/core/src/sync/index.ts` — passed.
- `rtk proxy bun run --filter @aio-proxy/core build` — passed.
- `rtk git diff --check` — passed.
- `rtk proxy bun run preflight` — blocked by two pre-existing dashboard type errors in `packages/dashboard/src/modules/providers/templates/provider-editor-page/use-oauth-editor-session.ts` (TS2322 and TS2589); the Task 5 checks above pass independently.

## Concerns

The publication API intentionally surfaces `outcome-unknown` to the outbox drainer rather than spinning in an unbounded retry loop. The caller must retain the same outbox operation and invoke `publishEntity` again. Delete cleanup, reservation cancellation transitions, history retention, and purge completion remain Task 6 responsibilities.
