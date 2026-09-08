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

## Fix round 1

Addressed the scoped review findings:

- Recovery refuses to promote a journaled result while the matching account is `login-required`; invalid output remains quarantined.
- A CAS conflict now rereads and retries a still-ready account at the same generation through `refreshAfterReread`.
- Added behavior coverage for pre-claim validation failure, claim-before-exchange fencing, remote non-ready coordination, journal-write failure, late exchange recovery, journaled-result validation failure, restart recovery, stale epoch replacement, and local confirmation.
- Added `confirm(objectId, operationId)` to the coordinator. Publication leaves the result journal recoverable until the caller confirms local application; only then is the journal completed and cleared. Stale or replaced results are discarded safely.

Exact verification after the fixes:

- `bun test packages/core/src/sync` — 126 passed, 0 failed, 403 expectations.
- `bunx tsc --noEmit -p packages/core/tsconfig.json` — exited 0.
- `bunx oxlint packages/core/src/sync/oauth packages/core/src/sync/repository/repository.ts packages/core/src/sync/repository/repository.test.ts` — exited 0.
- `bunx oxfmt --check packages/core/src/sync/oauth packages/core/src/sync/repository/repository.ts packages/core/src/sync/repository/repository.test.ts` — all matched files formatted.
- `bun run --filter @aio-proxy/core build` — exited 0; 300 files generated.

The initial-read coordination failure mapping remains conservative: raw backend failures are preserved so callers can distinguish cancellation, offline, and unknown outcomes; refresh callers should map those transport failures to their retry/deferred UI state.
