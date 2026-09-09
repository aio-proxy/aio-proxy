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
