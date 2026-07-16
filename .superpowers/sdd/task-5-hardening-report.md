# Review Hardening Task 5 Report

## Status

Implemented account deletion fencing for delete → re-add → delete races.

## RED

Command:

```sh
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/repository.test.ts packages/server/_test/account-removal.test.ts packages/server/_test/plugin-snapshot.test.ts packages/server/_test/dashboard-providers-mutation.test.ts
```

Actual output summary:

```text
5 tests failed:
(fail) final deletion runs through the FIFO and stays pending while a snapshot still references the account
(fail) delete, re-add, and delete again only removes the account after every routed incarnation drains
(fail) Dashboard DELETE returns 409 for an incompatible pending account operation
(fail) a later delete atomically supersedes the stale delete marker
(fail) reports an incompatible pending operation as a named conflict

93 pass
5 fail
329 expect() calls
Ran 98 tests across 4 files. [5.25s]
```

The failures were the expected missing behavior: raw `Error("Account already has a pending operation")`, Dashboard HTTP 500, deletion without the FIFO/snapshot fence, and premature account deletion during re-add.

Test review found two fixture/assertion issues and corrected them before implementation:

- The existing “blocks multiple pending deletes” assertion contradicted the new required delete-marker supersession behavior.
- The end-to-end race fixture did not register an OAuth plugin runtime, so its Router never actually contained the account-backed provider. The fixture now installs a built-in test descriptor and explicitly checks Router membership.

The immediate re-add cancellation assertion was also independently RED-verified by temporarily removing the cancellation call:

```text
Expected: []
Received: [the first pending delete marker]
0 pass, 1 fail
```

## Implementation

- `packages/core/src/plugins/repository.ts`
  - Added `PendingAccountOperationConflictError` with `providerId` and `pendingKind`.
  - Incompatible pending operations now throw the named conflict.
  - A later delete atomically removes/supersedes an earlier delete marker and creates a fresh operation ID.
- `packages/server/src/account-removal.ts`
  - Added successful re-add marker cancellation.
  - Routed live finalization through the shared FIFO.
  - Under the config-file transaction lock, rechecks marker liveness and provider absence, then calls `canDeleteAccount(providerId)` immediately before repository finalization.
  - Retains and schedules recovery when snapshot fencing denies deletion.
- `packages/server/src/server-state.ts`
  - Supplies the shared server FIFO and `snapshotManager.canDeleteAccount` to account removal.
  - Cancels a prior delete marker after the re-added snapshot commits, while the config transaction still owns the shared lock.
- `packages/server/src/dashboard-routes/config.ts`
  - Maps named pending-operation conflicts to HTTP 409.
- Tests cover repository supersession/conflict, FIFO/config-lock fencing, Dashboard 409, immediate re-add cancellation, adversarial lease release order, and Router/account consistency.

## GREEN

Focused command:

```sh
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/repository.test.ts packages/server/_test/account-removal.test.ts packages/server/_test/plugin-snapshot.test.ts packages/server/_test/dashboard-providers-mutation.test.ts
```

Actual output:

```text
100 pass
0 fail
355 expect() calls
Ran 100 tests across 4 files. [5.97s]
```

Related regressions:

```sh
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/account-login.test.ts packages/server/_test/config-store.test.ts packages/server/_test/server-reload.test.ts
```

Actual output:

```text
56 pass
0 fail
231 expect() calls
Ran 56 tests across 3 files. [9.99s]
```

Build/type checks:

```text
@aio-proxy/core build: 65 files generated; exit 0
packages/core TypeScript noEmit: exit 0
Biome on the eight changed source/test files: exit 0 (five pre-existing informational useLiteralKeys notices)
```

The server-wide TypeScript command still exits 2 on 11 pre-existing errors outside this change’s hunks: one `RequestLogsQuery` exact-optional mismatch in `dashboard-routes/config.ts:228` and ten `override`/index-signature errors in `dashboard-routes/provider-mutation.ts`. The Task 5 narrowing error initially found in `account-removal.ts` was fixed; no Task 5 type error remains in the output.

## Self-review

- Repository supersession is atomic because the stale marker removal and replacement insert occur inside the same immediate SQLite transaction.
- Re-add cancellation happens only after the candidate snapshot has built and swapped successfully, and it runs while the config transaction lock is held.
- Physical finalization is serialized after config mutations, re-reads config under the same file lock, and has no async gap between `canDeleteAccount` and the conditional SQLite finalizer.
- A canceled or superseded operation is detected before fencing, preventing an old finalizer from rearming or affecting the current incarnation.
- The end-to-end test proves the current Router contains the account before each delete, excludes it after each delete, and the account survives until all routed incarnations drain.
- No files outside the brief’s source/tests and this required report were changed.

## Post-commit spec review and remediation

The first two-axis review reported no standards findings, but identified three spec gaps. All three were treated as blocking and repaired test-first:

1. Timer-driven recovery could call physical deletion outside the FIFO.
   - Added `scheduled recovery waits behind an in-flight config mutation in the server FIFO`.
   - RED proof with direct `runRecovery`: expected recovery count `2`, received `3` while the mutation was still blocked.
   - The recovery timer now enqueues `runRecovery` on the same server FIFO as config mutations, and both startup recovery passes are also executed through that FIFO.
2. Re-add cancellation occurred before later commit hooks that could reject verification.
   - Added `a failed re-add commit does not cancel the prior delete marker`.
   - RED proof with cancellation before the failing hook: expected the original marker, received `[]`.
   - Cancellation now runs after catalog-job replacement and event publication, so a definite verification rollback retains the marker.
3. The adversarial sequence did not exercise Dashboard deletion.
   - The end-to-end delete → re-add → delete test now performs both deletes through `createDashboardRoutes` and asserts both responses are HTTP 200, while retaining all Router/account fencing assertions.

Targeted remediation GREEN:

```text
3 pass
0 fail
19 expect() calls
```

Final focused GREEN is the 100/100 result above.

Final two-axis review at `76b41b9` reported no actionable standards/code-smell findings and no remaining spec findings. It explicitly rechecked FIFO coverage for scheduled and startup recovery, failed/successful re-add marker behavior, Dashboard delete/re-add/delete responses, and Router snapshot fencing.

## Concerns

- Server-wide `tsc --noEmit` is not clean because of the unrelated existing errors listed above; focused tests, related regressions, core build/typecheck, and changed-file Biome checks are clean.

## Important finding remediation (2026-07-16)

### RED

Added `final deletion stays pending when the provider is present on disk` before changing production code.

```sh
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/server/_test/account-removal.test.ts --test-name-pattern "final deletion stays pending when the provider is present on disk"
```

Actual output:

```text
Expected: []
Received: ["completed"]
0 pass
1 fail
```

This proved the finalizer incorrectly completed the delete marker when the disk-side provider-presence condition was false. The delete → re-add → delete test was also changed before production code to release `readdedLease` first; it passed, demonstrating that the snapshot fence already handled the dangerous order but the test previously did not exercise it.

After the minimal finalizer change, the focused suite exposed one obsolete assertion and one successful-commit edge case:

```text
100 pass
1 fail
```

- `re-adding an invalid OAuth row before drain ... completes its marker` still encoded the forbidden finalizer cleanup and was changed to require the marker to remain pending.
- The related `server reconciliation converges uncommitted bytes after pre-verify uncertainty` test timed out because a successful reconciliation can have the provider in both the previous and next runtime configs. This proved `cancelReadded` must cancel a stale delete marker for every provider present after a successful config commit, rather than only an in-memory absent → present diff.

### GREEN

Minimal regression tests:

```text
2 pass, 0 fail — disk-side provider presence retains and reschedules the marker
1 pass, 0 fail — successful reconciliation cancels the retained stale marker
1 pass, 0 fail — readdedLease-first adversarial release order
```

Task 5 focused command:

```sh
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/repository.test.ts packages/server/_test/account-removal.test.ts packages/server/_test/plugin-snapshot.test.ts packages/server/_test/dashboard-providers-mutation.test.ts
```

Actual output:

```text
101 pass
0 fail
357 expect() calls
Ran 101 tests across 4 files. [5.92s]
```

Related regressions:

```sh
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/core/_test/plugins/account-login.test.ts packages/server/_test/config-store.test.ts packages/server/_test/server-reload.test.ts
```

Actual output:

```text
56 pass
0 fail
231 expect() calls
Ran 56 tests across 3 files. [8.84s]
```

Verification:

```text
Biome on the three changed source/test files: exit 0 (five pre-existing informational useLiteralKeys notices)
git diff --check: exit 0
server TypeScript noEmit: exit 2 on the same unrelated dashboard route/provider-mutation errors; no error references the three changed files
```

### Files and self-review

- `packages/server/src/account-removal.ts`: provider presence now retains and reschedules a live delete marker; marker completion remains exclusively in `cancelReadded`, which runs only after a successful config commit. Successful commits cancel stale delete markers for providers present in the committed next config, including uncertain-delete reconciliation where previous and next runtime configs both contain the provider.
- `packages/server/_test/account-removal.test.ts`: added explicit no-complete/no-delete plus double-schedule coverage for disk presence, and corrected the direct disk-side re-add test to retain its marker.
- `packages/server/_test/plugin-snapshot.test.ts`: releases `readdedLease` before `oldestLease`, asserts the account and second marker survive, then permits physical deletion only after the oldest lease drains.
- Self-review found no async gap between the config presence check, snapshot fence, and repository finalization. A canceled marker is still detected by the pending-operation liveness check, so an old finalizer cannot re-arm or delete after a successful commit cancels it.
