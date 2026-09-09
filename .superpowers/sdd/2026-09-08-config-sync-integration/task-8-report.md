# Task 8 implementation report

## Changed files

- `packages/cli/src/upgrade/detect.ts`
- `packages/cli/src/upgrade/package-ownership.ts`
- `packages/cli/src/upgrade/upgrade.test.ts`

## Reasoning

Homebrew classification still uses the resolved real path, but resolved Cellar matches now rebuild the returned `UpgradeTarget` from the caller's launcher spelling. This keeps both `bin` and the sibling `brew` command stable when macOS exposes `/var` and `realpath` returns `/private/var`.

Native package fixtures derive their package directory from `process.platform` and `process.arch`, and native-only tests skip on unsupported targets. Fixture expectations use the host's resolved spelling where the production lookup follows a symlink. Shim ownership checks compare both lexical and resolved launcher directories, preserving package ownership validation while handling macOS path aliases.

## Commit

`2faff3148375523fd7cae1336cb379666e27395e`

## Verification

- `rtk proxy bun test packages/cli/src/upgrade/upgrade.test.ts` — 75 pass, 0 fail, 124 expect() calls.
- `rtk proxy bun run preflight` — formatting and lint checks passed; CLI tests passed (510 pass, 0 fail); the full gate reached completion with 5 unrelated server test failures and 1 unhandled server test error.

## Concerns

The full preflight remains red in `@aio-proxy/server` for existing timing/resource-sensitive tests: `plugin-snapshot/recovery-close.test.ts`, `plugin-snapshot/isolation-diagnostics.test.ts`, `plugin-snapshot/recovery-deadline.test.ts`, `dashboard-routes/plugins/plugins.test.ts`, and `routes/realtime/sideband.test.ts`. The failures include closed-database/SQLite I/O errors, recovery-close scheduling assertions, and a downstream relay close timeout. They are outside the CLI upgrade changes.
