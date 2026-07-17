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
- Largest new production file: `packages/server/src/server-state/snapshot.ts` at 299 lines.
- Largest new test file: `packages/server/_test/plugin-runtime/materialize.test.ts` at 284 lines.
- Modified legacy oversized tests all returned below their pre-task sizes:
  - `config-store.test.ts`: 692 to 74 lines, matching its actual pre-PR size.
  - `dashboard-providers-mutation.test.ts`: 695 to 486 lines.
  - `pipeline.test.ts`: 678 to 619 lines.
  - `server-reload.test.ts`: 309 to 119 lines.
  - `packages/types/_test/schemas.test.ts`: 1002 to 770 lines.
- Repository search found exactly one candidate iteration, in `routes/pipeline/attempt.ts`.
- Repository search found no imports of the removed `.ts` module paths.

## Verification

- Required baseline was run before refactoring and passed.
- `rtk bun run --filter @aio-proxy/server test:unit` — 378 passed, 0 failed, 1,179 assertions across 54 files.
- `rtk bun x tsc --noEmit -p packages/server/tsconfig.json` — passed with no diagnostics.
- `rtk bun run --filter @aio-proxy/types test:unit` — 99 passed, 1 skipped, 0 failed, 197 assertions across 7 files. This includes all 32 tests in `src/plugin.test.ts`.
- `rtk bun run --filter @aio-proxy/types build` — passed; Rslib generated declarations and 12 distribution files.
- `rtk bun run check` — exit 0; reported 3 warnings and 61 informational diagnostics.
- `rtk git diff --check` — passed.
- The required line-count command passed; the production split ranges from 6 to 299 lines per file.

## Server Typecheck Gate

The Server package has no `build` script. The authoritative plan and generated Task 8 brief now use the valid compile gate:

```text
rtk bun x tsc --noEmit -p packages/server/tsconfig.json
```

The dashboard request-log query now constructs exact optional properties, and provider mutation errors/indexed records satisfy the Server compiler options. The gate passes with no diagnostics.

## Self-review

- Spec review: all requested production directories, responsibility splits, interface preservation, test extraction, and line-limit requirements are present.
- Standards review: no new provider-kind routing branch, duplicate fallback loop, obsolete module-path import, or over-300-line new file was found.
- The required colocated Types tests were initially outside the package test glob; the test script was corrected before commit and the complete 99-test suite was rerun.
- No changes were made to the pre-existing `.superpowers/sdd/task-4-report.md` worktree modification.

## Concerns

- None.

## Review Fixes

- Restored plugin boundary record validation for both runtime results and raw transports. Arrays carrying forged `provider` or `invoke` properties are rejected.
- Added two focused regression tests for those array-shaped boundary values.
- Moved reload transaction staging, compensation, finalization, and failure mapping out of `server-state/index.ts` into `server-state/snapshot.ts`.
- Moved provider summary/probe orchestration and status caching into `server-state/probe.ts`.
- Moved private `Snapshot` type ownership from `server-state/types.ts` to `server-state/snapshot.ts`.
- Reduced `server-state/index.ts` to 254 lines while keeping orchestration and public exports there; `snapshot.ts` remains within the limit at 299 lines.
- Restored `packages/server/_test/config-store.test.ts` to 74 lines without removing a test or assertion.
- Corrected the Task 8 command in both `docs/superpowers/plans/2026-07-17-oauth-plugin-main-compliance.md` and `.superpowers/sdd/task-8-brief.md`.

## Review RED/GREEN Evidence

- RED: the new focused capability tests reported 2 passed and 2 failed because arrays carrying `provider` and `invoke` properties crossed the plugin boundary.
- GREEN: the focused capability suite passed 4 tests after adding record guards.
- The Server no-emit gate initially reproduced 13 diagnostics in dashboard request-log and provider-mutation code. After the minimal typing fixes it passed with no diagnostics, and the 40 focused dashboard tests passed.
- The state/reload/probe focused verification passed 86 tests after extraction.
- One concurrent verification attempt ran Server no-emit while the Types build was cleaning/regenerating declarations and produced `TS6305` dependency-output errors. That raced result was discarded; after Types build completed, the same Server no-emit command passed in isolation.
