# Task 2 report

## Status

Implemented and committed the versioned sync head/revision protocol and pure transitions.

## Files

- `packages/core/src/sync/protocol/protocol.ts`: protocol types, deterministic namespace keys, JSON encoding/decoding, and `SyncProtocolError`.
- `packages/core/src/sync/protocol/schemas.ts`: Zod schemas and parsers for protocol 1 entity heads and revision records.
- `packages/core/src/sync/protocol/transitions.ts`: pure `newHead`, `reserve`, `publish`, and `beginPurge` transitions.
- `packages/core/src/sync/protocol/protocol.test.ts`: reducer, version fencing, byte preservation, idempotency, and JSON validation tests.
- `packages/core/src/sync/protocol/index.ts`: export-only protocol barrel.
- `packages/core/src/sync/index.ts`: export-only sync barrel.
- `packages/core/src/index.ts`: public core sync export.

## Verification

- `rtk proxy bun test packages/core/src/sync`: 8 passed, 0 failed.
- `rtk proxy bunx tsc -p packages/core/tsconfig.json --noEmit`: passed.
- `rtk proxy bunx oxlint packages/core/src/sync packages/core/src/index.ts`: passed.
- `rtk proxy bunx oxfmt --check packages/core/src/sync packages/core/src/index.ts`: passed.
- `rtk proxy git diff --check`: passed.

## Self-review

- Namespace keys match the protocol-1 `s/v1/default/{entity|revision|account}` contract.
- Unknown protocol versions fail with `upgrade-required` before schema parsing; decoding never mutates the input bytes.
- Purge preserves current/history/reserved/cancelling IDs and blocks publication through the deleted-state guard.
- Duplicate reservation/publication is idempotent, and publication sequence is the ordering source.
- Encoding rejects non-finite numbers, non-JSON values, and cycles; no clock participates in reducers.
- The core sync barrel contains exports only.

## Concerns

The protocol layer does not validate UUID shape because the task contract assigns UUID validation to external boundaries. Repository, publication, cleanup, and durable persistence behavior remain subsequent tasks.
