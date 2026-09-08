# Task 6 implementation report

## Status

Implemented history retention, ordinary deletion, purge fencing, restore, and server-time maintenance for the core sync protocol.

## Files

- `packages/core/src/sync/cleanup/cleanup.ts`: shared CAS/head helpers, deterministic account tombstones, revision erasure markers, ordinary deletion, restore, and server-time maintenance.
- `packages/core/src/sync/cleanup/purge.ts`: resumable purge state machine and final marker verification.
- `packages/core/src/sync/cleanup/history.ts`: receipt finalization, abandoned reservation cancellation, and 30-day history collection.
- `packages/core/src/sync/cleanup/index.ts`: cleanup exports.
- `packages/core/src/sync/cleanup/cleanup.test.ts`: paused-writer races, deletion, purge, retention, restore, account scrubbing, independent plugin data, and server-time recovery coverage.
- `packages/core/src/sync/index.ts`: public cleanup exports.

## Lifecycle and fencing behavior

- All cleanup writes use conditional CAS and retry conflicts or unknown write outcomes by rereading the affected key. No protocol key is physically removed.
- Ordinary deletion first changes the head to `deleted`, immediately replaces the deterministic account key with a secret-free tombstone, moves reservations to `cancelling`, and replaces reserved payloads or absent keys with permanent `abandoned` markers before setting `cleanupComplete`.
- Purge resumes from any `purging` head, freezes current/history/reserved/cancelling/receipt operation IDs, replaces every revision with a secret-free `purged` marker, scrubs the account key even when absent, rereads all markers, and only then writes `purged` with cleanup complete.
- History cleanup finalizes publication receipts before using their original payload `writtenAt`, cancels abandoned reservations, excludes current and pending references, expires only confirmed history older than 30 days, removes expired references and head receipts, and retains permanent revision markers for retry fencing.
- Restore requires a completed deleted or purged head, increments the epoch, moves the prior current operation into retained history, and publishes a new explicit operation in the new epoch. Purge uses each retained revision's own object/epoch identity when writing markers across a restore boundary.
- Cleanup receipt finalization retries outcome-unknown writes by rereading the same revision and operation.
- Publication retries that encounter an erased abandoned or purged marker now surface the protocol's `deleted` fence error, preserving the reason in the diagnostic while preventing republish.
- Server time comes from the confirmed `modifiedAt` of a non-secret maintenance nonce stored at `s/v1/default/space`; it is not used for merge ordering or locking.

## Verification

- `rtk proxy bun test packages/core/src/sync` — 65 passed, 0 failed.
- `rtk proxy bunx tsc -p packages/core/tsconfig.json --noEmit` — passed.
- `rtk proxy bunx oxlint packages/core/src/sync/cleanup packages/core/src/sync/index.ts` — passed.
- `rtk proxy bunx oxfmt --check packages/core/src/sync/cleanup packages/core/src/sync/index.ts` — passed.
- `rtk proxy bun run check` — passed; repository lint emitted existing warnings only and format checks passed.
- `rtk proxy bun run --filter @aio-proxy/core build` — passed.
- `rtk proxy bun run preflight` — blocked by existing dashboard type errors in `use-oauth-editor-session.ts` (`TS2322`, `TS2589`); no Task 6 file was implicated.

## Concerns

The full preflight remains red because of the pre-existing dashboard type errors described above. Core sync tests, type checking, lint, formatting, and the core build pass.
