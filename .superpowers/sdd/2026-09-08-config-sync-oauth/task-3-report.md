# Task 3 implementation report

## Status

Implemented the shared credential caller routing described by Task 3.

## Changes

- Moved the credential port implementation into `plugins/credential-port/` with an export-only entry point.
- Added dynamic `resolveShared` dispatch for both reads and refreshes. Shared refreshes bypass local SQLite refresh leases; local-only ports retain the existing lease, single-flight, CAS, diagnostics, and redaction behavior.
- Added `createSharedCredentialPort`, which recovers the current shared account at use time, refuses deleted or unresolved ownership, imports newer cloud credentials, maps coordinator results to the public `CredentialPort` result shape, and confirms durable coordinator journals after local application.
- Added `applySyncedAccount` and the sync account-import entry point. It reuses account staging/finalization inside `withAccountTransaction`, then updates `LocalEntity.oauth` generation and local revision on the same SQLite connection. Catalog state is preserved during credential-only imports.
- Wired the dynamic resolver through runtime materialization and control-plane OAuth account contexts (catalog, quota, and manual refresh callers), including a blocking port while a configured shared coordinator is disconnected.
- Added the coordinator lifecycle callback and startup rebuild hook so existing cached credential ports adopt shared ownership dynamically after synchronization connects.

## Tests

- `rtk proxy bun test packages/core/src/plugins/credential-port packages/core/src/sync/oauth/account-import` — 35 passed.
- `rtk proxy bun test --preload=./__tests__/setup.ts src/credential-refresh` from `packages/server` — 11 passed.
- `rtk proxy bun run check` — passed; existing lint warnings remain in dashboard/logger files.
- `rtk proxy bun run lint:types` — repository still has pre-existing errors in dashboard provider-editor code and cloudkit signing scripts; no errors remain in the changed core/server files.

## Recovery notes

- The first server test run used a stale `@aio-proxy/core/dist` after the credential-port move. I rebuilt the core package after cleaning its generated `dist` directory so the explicit `credential-port/index` export is available to server tests.
- No built-in adapter transport retry loop was found on the rotating credential exchange paths; the coordinator-owned exchange remains the only refresh attempt path.
- Shared credential reads now reject `detach-pending` before coordinator access, preserve `login-required`, and refuse purged or incompatible local snapshots without attempting an exchange.
- Remote imports compare epoch, ownership metadata, account metadata, and payload fields, so replacements with unchanged credential bytes still advance the local snapshot. Successful imports clear stale refresh diagnostics and notify rebuild callbacks; coordinator confirmation failures are recoverable after the local import is durable.
- Resolver callbacks now flow through runtime materialization and OAuth control-plane contexts so shared imports rebuild summaries and catalog jobs with the updated local revision.

## Concerns

- A shared account whose sync binding exists but whose coordinator is disconnected is intentionally blocked and cannot fall back to a stale local credential. A provider with no OAuth ownership metadata or positively independent ownership continues using the legacy local path.
- The full monorepo `bun run test` reaches the existing core artifact smoke failure because generated declaration imports such as `sync/repository/index.d.ts: ./repository.js` match that test's unresolved moved-directory pattern; focused core/server suites and `bun run check` pass.

## Final fix note

- Shared refresh failures now pass through the existing credential diagnostics/redaction path while coordinator-deferred and outcome-uncertain errors remain retryable and do not trigger permanent re-login diagnostics.
