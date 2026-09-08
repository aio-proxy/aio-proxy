# Whole-branch final-fix report

## Review findings addressed

The final-fix pass addresses every Critical, Important, and Minor finding from `review-ef5f8fb5..5e18dd8d`:

- Epoch-fenced account tombstone writes prevent a stale paused purge from overwriting a newer restore. Restore writes an explicit epoch fence marker, and the cleanup regression test covers the paused purge/resume interleaving.
- Local authored deletion of an included entity now creates an explicit `kind: 'delete'` outbox operation. Dependency-filtered and excluded entities remain out of the outbox; local commit and engine tests cover both paths.
- Head identity validation checks the decoded `head.objectId` against the entity key in object-store publication, engine reads, and remote listing. Invalid remote records remain read-only and receive `invalid-config` handling.
- OAuth journal cleanup now has a repository operation that removes only completed rows. Credential retention and idempotent cleanup are covered by repository tests.
- Binding updates reject changes to backend, capability, or remote identity for an existing binding ID while allowing same-identity generation and option updates.
- OAuth journal persistence moved into `repository/oauth-journal.ts`, keeping the repository implementation below the 500-line limit.
- The public plugin SDK conformance helper accepts an optional deterministic outcome-unknown fault hook, and core exercises that hook.

No changeset was added: the task brief assigns user-facing Changesets to the later release task.

## Validation

- `bun test packages/core/src/sync` — 107 passed, 0 failed.
- `bun run --filter @aio-proxy/plugin-sdk test` — 92 passed, 0 failed; type tests passed.
- `bun run --filter @aio-proxy/plugin-sdk build` — passed.
- `bun run --filter @aio-proxy/core build` — passed when run sequentially after the SDK declarations were built.
- `bunx tsc -p packages/core/tsconfig.json --noEmit` — passed.
- `bunx tsc -p packages/plugin-sdk/tsconfig.json --noEmit` — passed.
- `bun run check` — passed; only existing lint warnings remain.
- Targeted `oxlint` checks — passed.
- `oxfmt --check` — passed.
- `git diff --check` — passed.

The full `bun test packages/core` run reports 1,945 passed and 2 failures in pre-existing npm/file-lock recovery timing tests:

- `acquireNpmInstallLock > Given concurrent stale-lock recovery When owners run Then only one lock is active`
- `concurrent recovery acquisitions serialize without timing out`

These failures are outside the sync changes and were not reproduced in the sync or plugin-sdk test suites.
