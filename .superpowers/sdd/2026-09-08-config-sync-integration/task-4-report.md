# Task 4 report: Dashboard sync controls and previews

## Delivered

- Added typed Dashboard sync service wrappers for status, backend metadata, preview/apply, range, detach/cancel, history, retry, and disconnect routes. React Query hooks invalidate sync status plus Provider and Settings data after successful mutations.
- Added Settings sync controls with localized backend metadata forms. Secret fields are disclosure-only, saved authorization values are never sent, and missing CloudKit links to the existing Plugins page with the exact package name `@aio-proxy/plugin-cloudkit`.
- Added redacted preview, per-entity decisions, same-ID rename input, retained shared-plugin disclosure, stale retry, pending submit state, history table, purge preview, and a TanStack Form local-option override editor.
- Added Provider sync range control with distinct exclusion and purge paths, credential verification/detachment states, and preview-driven enablement. New local Providers remain local until explicitly included.
- Added sync copy to all five supported locales and focused service, Provider control, Settings, and preview tests.

## Verification

- `rtk proxy bun run i18n:compile` — passed.
- `rtk proxy bun run check` — passed; existing oxlint warnings only, formatting clean.
- `rtk proxy bun run --filter @aio-proxy/dashboard test` — 974 passed, 1 skipped, 0 failed across 160 files.
- `rtk proxy bun run --filter @aio-proxy/dashboard build` — passed.
- Focused sync suite — 7 passed across service, Provider control, preview, and Settings tests.
- `rtk proxy bun run lint:types` — the new sync files are clean; the repository command remains blocked by unrelated existing diagnostics in OAuth editor and CloudKit script files.

Generated `route-tree.gen.ts` was not edited.

## Fix round 1

- Provider purge previews now target the selected Provider ID, while override edits use replacement previews and preserve the newest preview for apply/retry.
- Added validation for Provider IDs, override paths, and decisions, including localized same-ID conflict errors; secret disclosure now covers secret changes as well as dependencies.
- Provider detach handles missing login sessions and pending/excluded states with localized errors and cloud-copy disclosure. Preview mutations invalidate sync, Provider, and Settings queries.
- History now supports filtering, sorting, pagination, column visibility, and semantic timestamps through TanStack Table features.
- `rtk proxy bun run i18n:compile` — passed.
- `rtk proxy bun run check` — passed; existing oxlint warnings only, formatting clean.
- Focused Dashboard sync tests — 12 passed.
- `rtk proxy bun run --filter @aio-proxy/dashboard test` — 982 passed, 1 skipped, 0 failed across 163 files.
- `rtk proxy bun run --filter @aio-proxy/dashboard build` — passed.
- Root `rtk proxy bun run test` reached 50 successful tasks; the repository run remains blocked by the existing `@aio-proxy/core` artifact smoke failure for unresolved `./repository.js` imports in `sync/repository` declaration/output files.
- `rtk proxy bun run lint:types` remains blocked by unrelated existing diagnostics in the OAuth editor and CloudKit scripts.
- Fresh `rtk proxy bun run lint:types` — failed only on the known baseline diagnostics: `use-oauth-editor-session.ts` TS2322/TS2589 and CloudKit `sign-native.ts` TS2322 plus `artifact.ts` TS18048 (three occurrences).

## Fix round 2

- Purge previews stay purge-only: Settings no longer supplies the override-preview callback for purge operations, and the preview dialog hides local override controls for purge previews.
- Override pin changes now request replacement previews for both additions and removals with the exact current path set. The dialog preserves the path set across replacement renders, validates that replacement previews have the expected kind and ID, and keeps Apply disabled while refresh is pending or invalid.
- `bunx rstest run` focused sync suite — 11 passed across the preview and Settings sync tests.
- `rtk proxy bun run --filter @aio-proxy/dashboard test` — 985 passed, 1 skipped, 0 failed across 163 files.
- `rtk proxy bun run --filter @aio-proxy/dashboard build` — passed.
- `rtk proxy bun run i18n:compile` — passed.
- `rtk proxy bun run check` — passed; existing oxlint warnings only, formatting clean.
- Fresh `rtk proxy bun run lint:types` — remains blocked only by the baseline OAuth editor TS2322/TS2589 and CloudKit script TS2322/TS18048 diagnostics.
