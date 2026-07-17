# Task 8 Report: Split Server Runtime, State, Pipeline, and Integration Tests

## Status

DONE

## Changes

- Replaced `packages/server/src/plugin-runtime.ts` with focused runtime modules for public exports, shared types, identity, catalog state, capabilities, and materialization.
- Replaced `packages/server/src/server-state.ts` with lifecycle modules for public orchestration, types, snapshots, recovery, and probing.
- Replaced `packages/server/src/routes/pipeline.ts` with request validation, candidate attempts, failure mapping, stream handling, and a thin public entry point.
- Preserved the public server interfaces named in the brief, including `materializePluginProvider`, `pluginOptionsIdentityDigest`, `validatePluginProtocolMap`, `createServerState`, `createModelsDevCatalogTask`, and `handleProtocolRequest`.
- Kept the sole provider candidate loop in `packages/server/src/routes/pipeline/attempt.ts`; routing remains capability-based and route registration files contain no provider-kind dispatch or fallback loops.
- Split plugin runtime, plugin snapshot, catalog scheduler, and account removal integration suites by lifecycle boundary.
- Extracted OAuth cases and support code from the oversized config store, provider mutation, pipeline, pipeline-helper, and server reload tests.
- Moved plugin/OAuth schema coverage from the oversized Types schema suite into `packages/types/src/plugin.test.ts` and added that colocated file to the Types unit-test command.
- Excluded colocated `src/**/*.test.ts` files from Types declaration generation so the required Bun tests do not enter the library build.

## Size and Structure Audit

- Every new production, test, and support file is at most 300 lines.
- Largest new production file: `packages/server/src/server-state/index.ts` at 299 lines.
- Largest new test file: `packages/server/_test/plugin-runtime/materialize.test.ts` at 284 lines.
- Modified legacy oversized tests all returned below their pre-task sizes:
  - `config-store.test.ts`: 692 to 75 lines.
  - `dashboard-providers-mutation.test.ts`: 695 to 486 lines.
  - `pipeline.test.ts`: 678 to 619 lines.
  - `server-reload.test.ts`: 309 to 119 lines.
  - `packages/types/_test/schemas.test.ts`: 1002 to 770 lines.
- Repository search found exactly one candidate iteration, in `routes/pipeline/attempt.ts`.
- Repository search found no imports of the removed `.ts` module paths.

## Verification

- Required baseline was run before refactoring and passed.
- `rtk bun run --filter @aio-proxy/server test:unit` — 376 passed, 0 failed, 1,177 assertions across 54 files.
- `rtk bun run --filter @aio-proxy/types test:unit` — 99 passed, 1 skipped, 0 failed, 197 assertions across 7 files. This includes all 32 tests in `src/plugin.test.ts`.
- `rtk bun run --filter @aio-proxy/types build` — passed; Rslib generated declarations and 12 distribution files.
- `rtk bun run check` — exit 0; reported the existing 3 warnings and 51 informational diagnostics outside Task 8.
- `rtk git diff --check` — passed.
- The required line-count command passed; the production split ranges from 6 to 299 lines per file.

## Server Build Command Mismatch

The brief requires `rtk bun run --filter @aio-proxy/server build`, but `@aio-proxy/server` has no `build` script, so Bun reports `No packages matched the filter` and exits 1. As compile evidence, `rtk bun x tsc --noEmit -p packages/server/tsconfig.json` was run after fixing the new Task 8 indexed-access error. Its remaining 13 diagnostics are the pre-existing errors in:

- `packages/server/src/dashboard-routes/config.ts`
- `packages/server/src/dashboard-routes/provider-mutation.ts`

No Task 8 file remains in the TypeScript diagnostic output.

## Self-review

- Spec review: all requested production directories, responsibility splits, interface preservation, test extraction, and line-limit requirements are present.
- Standards review: no new provider-kind routing branch, duplicate fallback loop, obsolete module-path import, or over-300-line new file was found.
- The required colocated Types tests were initially outside the package test glob; the test script was corrected before commit and the complete 99-test suite was rerun.
- No changes were made to the pre-existing `.superpowers/sdd/task-4-report.md` worktree modification.

## Concerns

- The Server package still lacks the build script named by the Task 8 brief. This task does not add a new build system or resolve the unrelated dashboard TypeScript errors.
