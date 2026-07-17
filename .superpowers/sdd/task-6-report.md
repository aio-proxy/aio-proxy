# Task 6 Report: Split Core OAuth Account, Repository, and Loader Modules

## Outcome

Split the three oversized Core plugin modules into responsibility-focused private directories, moved the four legacy plugin test monoliths into the 15 required colocated test files, and preserved the public API and behavior.

The final implementation keeps every handwritten production and test file below 300 lines. The largest target test is `repository/pending-operations.test.ts` at 280 lines; the largest target production file is `account-login/login.ts` at 273 lines.

## Baseline and TDD evidence

### Baseline

Command:

```bash
rtk bun test packages/core/_test/plugins/account-login.test.ts packages/core/_test/plugins/repository.test.ts packages/core/_test/plugins/loader.test.ts packages/core/_test/plugins/credential-port.test.ts
```

Result before the split:

- 102 pass
- 0 fail
- 359 assertions
- 4 test files

### Structural RED

After moving the tests and deleting the three production monoliths, the focused command against the new directories failed to load all 15 colocated test files because the new `account-login`, `repository`, and `loader` entry points did not yet exist. This established the intended structural RED before implementing the directory modules.

### GREEN

Command:

```bash
rtk bun test packages/core/src/plugins/account-login packages/core/src/plugins/repository packages/core/src/plugins/loader packages/core/src/plugins/credential-port
```

Final result:

- 102 pass
- 0 fail
- 359 assertions
- 15 test files

The test and assertion counts exactly match the baseline.

## Production split

### Account login

- `account-login/index.ts`: public surface only
- `account-login/errors.ts`: exported errors and the private adapter error
- `account-login/deadline.ts`: abort/deadline and authorization error handling
- `account-login/validation.ts`: config/provider parsing, validation, preflight, and in-memory credential behavior
- `account-login/login.ts`: login and re-login orchestration
- `account-login/recovery.ts`: delete staging, pending-operation recovery, and orphan cleanup

### Repository

- `repository/types.ts`: existing public repository types and conflict error
- `repository/rows.ts`: SQLite row shapes, JSON encoding, and row-to-domain conversion
- `repository/accounts.ts`: account reads, writes, revision checks, and credential CAS
- `repository/pending-operations.ts`: stage, complete, compensate, finalize-delete, and pending-operation listing
- `repository/plugin-state.ts`: catalogs, diagnostics, plugin secrets, and refresh leases
- `repository/index.ts`: object-spread composition of three `Pick<PluginRepository, ...>` implementations

Rollback restoration now passes a stored-account snapshot to a narrowly typed private row writer. It does not fabricate a catalog write or use an unchecked cast.

### Loader

- `loader/descriptor.ts`: descriptor validation/cache, import deadlines, and third-party loading
- `loader/candidates.ts`: candidate enumeration, options/secrets preparation, and failed-state construction
- `loader/index.ts`: public types and the registry loading loop

## Test split

Created the exact required colocated files:

```text
account-login/constants-and-validation.test.ts
account-login/abort.test.ts
account-login/create.test.ts
account-login/relogin.test.ts
account-login/compensation.test.ts
account-login/recovery.test.ts
repository/accounts.test.ts
repository/pending-operations.test.ts
repository/plugin-state.test.ts
loader/descriptor.test.ts
loader/options-and-secrets.test.ts
loader/isolation.test.ts
credential-port/concurrency.test.ts
credential-port/lease-loss.test.ts
credential-port/redaction.test.ts
```

Directory-local `test-support.ts` files hold fixtures shared by at least two colocated tests. Shared support does not install cross-file cleanup hooks because Bun runs the files concurrently and one file could otherwise close another file's SQLite or timer resources. Each fixture uses a unique temporary directory; `lease-loss.test.ts` owns its fake-timer reset.

The credential refresh child-process helper remains at `packages/core/_test/plugins/refresh-lease-child.ts` and is referenced by the colocated credential-port support.

## Public API audit

Compared the old monolith exports at base commit `c3069f2f7a5a24de4535850ee2a24919e69fd416` with the new directory entry points.

- `account-login/index.ts` preserves both timeout constants, recovery constants, all public types and errors, and `loginOAuthAccount`, `deleteOAuthAccount`, and `recoverPendingAccountOperations`.
- `repository/index.ts` preserves all public repository types, `PendingAccountOperationConflictError`, and `createPluginRepository(sqlite): PluginRepository`.
- `loader/index.ts` preserves both timeout constants, all public loader types, `observedPromiseDeadline`, and `loadPluginRegistry`.
- No private collaborator is re-exported from a public directory entry point.
- `packages/core/src/plugins/index.ts` required no import or export changes; directory resolution replaces the deleted monolith files.

## Final verification

### Focused behavior

```bash
rtk bun test packages/core/src/plugins/account-login packages/core/src/plugins/repository packages/core/src/plugins/loader packages/core/src/plugins/credential-port
```

Result: 102 pass, 0 fail, 359 assertions across 15 files.

### Core build and declarations

```bash
rtk bun run --filter @aio-proxy/core build
```

Result: exit 0; declaration generation succeeded; 89 library files generated.

### Full Core suite

```bash
rtk bun test --reporter=dot packages/core
```

Result: 461 pass, 0 fail, 1,169 assertions across 63 files.

### Focused Biome

```bash
rtk proxy sh -c 'bunx biome check --max-diagnostics 500 packages/core/src/plugins/account-login packages/core/src/plugins/repository packages/core/src/plugins/loader packages/core/src/plugins/credential-port'
```

Result: exit 0; no errors or warnings. Biome reports 28 informational `useLiteralKeys` suggestions inherited from the moved code style.

### Repository check

```bash
rtk bun run check
```

Result: exit 0; no errors, with 3 warnings and 75 informational diagnostics elsewhere in the repository.

### File limits and whitespace

```bash
rtk proxy sh -c 'find packages/core/src/plugins/account-login packages/core/src/plugins/repository packages/core/src/plugins/loader packages/core/src/plugins/credential-port -name "*.ts" -exec wc -l {} + | sort -nr'
rtk git diff --check
```

Results:

- Every target TypeScript file is at most 300 lines.
- Largest test: 280 lines.
- Largest production file: 273 lines.
- `git diff --check`: exit 0.

## Worktree hygiene

The pre-existing modification to `.superpowers/sdd/task-4-report.md` was preserved and excluded from this task. Accidental edits to five `config-file` tests were restored exactly to base before final verification.
