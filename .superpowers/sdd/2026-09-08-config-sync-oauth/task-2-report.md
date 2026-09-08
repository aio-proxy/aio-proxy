# Task 2 report

Status: implemented.

The shared OAuth coordinator now performs one account CAS claim, records a durable started journal before exchange, records the validated JSON result before publication, and publishes only an identical object/epoch/operation/base-generation claim. Unknown claim and publication outcomes reread the account before deciding; uncertain exchanges retain their fence and never replay the old refresh token. Recovery handles journaled results, newer generations, stale epochs/deletions, and completed journal cleanup. SQLite OAuth journal writes retain `synchronous=FULL`.

Added two-device, unknown-claim, exchange-fence, publication-recovery, epoch-replacement, journal reopen, and current-result durability coverage. Test fixtures use independent SQLite repositories over one memory sync backend.

Checks:

- `bun test packages/core/src/sync` — 120 passed.
- `bunx tsc --noEmit -p packages/core/tsconfig.json` — passed.
- `bunx oxlint packages/core/src/sync/oauth packages/core/src/sync/repository/repository.ts packages/core/src/sync/repository/repository.test.ts` — passed.
- `bunx oxfmt --check packages/core/src/sync/oauth packages/core/src/sync/repository/repository.ts packages/core/src/sync/repository/repository.test.ts` — passed.
- `bun run --filter @aio-proxy/core build` — passed.

Concerns: an exchange that succeeds after its caller aborts is durably retained and can be recovered while the database remains open; if the process exits before any result journal is durable, the account remains fenced and requires recovery/login rather than replaying the old token. Recovery without a live adapter validator can validate JSON durability and account identity, but adapter-specific credential validation remains the caller's responsibility during refresh.
