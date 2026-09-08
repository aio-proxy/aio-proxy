# Task 3 implementation report

## Files changed

- Added `packages/core/src/db/schema/sync.ts` with the five durable sync tables and constraints for one active binding, entity mode, commit origin/phase, outbox kind, and OAuth journal phase.
- Exported the sync tables from `packages/core/src/db/schema/index.ts`.
- Added `packages/core/src/sync/repository/repository.ts`, `rows.ts`, `index.ts`, and `repository.test.ts`.
- Extended `packages/core/src/sync/test-support.ts` with `migrateSyncTestDb`, which applies the real migration manifest and verifies each migration hash before advancing `user_version`.
- Generated `packages/core/src/db/migrations/0008_config_sync.sql`, `meta/0008_snapshot.json`, `meta/_journal.json`, and regenerated `packages/core/src/db/migrations.manifest.ts`.

## Interface behavior

`createSyncRepository` persists active binding metadata, per-binding entities and JSON pointer overrides, prepared/confirmed commit intents, local source revisions, outbox operations, remote baseline advancement, and OAuth result journal rows. Binding switches deactivate the prior binding while preserving its rows and journals. JSON columns are parsed through Zod schemas when read.

Commit confirmation runs in one SQLite transaction. It preserves remote origin rules, rejects remote outbox operations, assigns a local confirmed order, persists source revisions, inserts idempotent operations, and advances recorded remote baselines. A failed operation rolls the transaction back. Repeated prepare/confirm/outbox/journal writes are idempotent by their compound binding and operation/commit identifiers.

## Tests and commands

- `rtk proxy bun test packages/core/src/sync/repository/repository.test.ts packages/core/src/db/migrations/migrations.test.ts` — 11 passed, 0 failed.
- `rtk proxy bun run --filter @aio-proxy/core build` — passed; declarations and migration manifest generated.
- `rtk proxy bunx oxlint packages/core/src/db/schema/sync.ts packages/core/src/db/schema/index.ts packages/core/src/sync/repository/repository.ts packages/core/src/sync/repository/rows.ts packages/core/src/sync/test-support.ts` — passed.
- `rtk proxy bunx oxfmt --check packages/core/src/db/schema/sync.ts packages/core/src/db/schema/index.ts packages/core/src/sync/repository packages/core/src/sync/test-support.ts packages/core/src/db/migrations.manifest.ts` — passed.
- `rtk proxy bun test packages/core` — 1,851 passed and 2 failed in pre-existing npm/file-lock recovery timing tests (`npm-lock.race.test.ts` and `recovery-fence.test.ts`); the new sync tests passed.
- Full `bun run lint:types` remains blocked by two pre-existing dashboard type errors in `use-oauth-editor-session.ts`; the core package build passed with the new implementation.

## Migration verification

Drizzle generated migration `0008_config_sync.sql` from the schema and the repository migration manifest generator registered it as runtime version 9 (migration filename ordinal 0008). Migration hash/journal consistency and fresh database application passed in `migrations.test.ts`.

## Concerns

The full core suite retains two unrelated lock timing failures under concurrent test load. No sync-specific failures were observed.
