# Provider redesign final fix report

## Status

Implemented all three final review findings while preserving the earlier secret-restoration boundary. The existing `.changeset/wide-plums-pay.md` already covers the unreleased Provider redesign across the affected product and internal packages, so this fix wave does not add another changeset.

## Changes

### Safe changed-connection draft testing

- Same-identity edits continue through `replaceProvider`, preserving omitted and redacted persisted secrets in memory for the saved target only.
- Changed API or AI SDK identity takes a separate sanitize-only path. It recursively removes standalone and embedded `****`/`sk-****` masks, never merges the persisted Provider, and materializes only explicitly authored draft values.
- When the persisted Provider had credentials but the changed draft has no fresh value at a persisted credential path, resolution fails before materialization with the recoverable `fresh_credentials_required` result. An unrelated new header cannot satisfy this guard.
- Integration coverage proves fresh API credentials/headers and fresh AI SDK options reach the changed target while saved credentials, headers, and options do not. Missing fresh credentials contact neither a changed destination nor a changed proxy.

### Validate-step query ownership

- Added a Provider-domain TanStack Query mutation hook that owns draft normalization, validation, request execution, pending state, data, and errors.
- Mutation results carry the tested model. The component renders a result only for the currently selected model, disables model selection and testing while pending, and announces failures as alerts.
- Save remains non-gating.

### Provider table capabilities

- Migrated the Provider table to the existing `useDataTable`, `DataTableToolbar`, and `DataTableHeaderCell` primitives.
- Added functional sorting with `aria-sort` and the standard column-visibility menu.
- Wrapped global filtering to preserve OAuth child auto-expansion. Existing pagination, focus handling, row actions, model tooltips, and horizontally accessible shared table rendering remain intact.

## TDD evidence

- Before the fix, changed API and AI SDK drafts returned `persisted_provider_identity_mismatch` instead of safely using fresh credentials or returning the new recoverable failure.
- Before the table migration, the Provider header was not sortable and no column-visibility control existed.
- Before the mutation migration, model selection remained enabled during a request, stale success stayed visible after selecting another model, and request failures were not alerts.
- Independent review then exposed two additional red cases: an embedded AI SDK mask survived sanitization, and an unrelated API header allowed a changed destination to bypass `fresh_credentials_required`. Both regressions failed before the security correction and pass afterward.
- The focused regression suites listed below pass after the implementation.

## Verification

- `packages/server`: `bun test --preload=./__tests__/setup.ts` for Provider draft, mutation, secrets, and OAuth edit routes — 29 passed, 0 failed across 4 files.
- `packages/core`: `bun test src/provider` — 69 passed, 0 failed across 22 files.
- `packages/types`: `bun run test:unit` — 171 passed, 1 skipped, 0 failed across 20 files.
- `packages/dashboard`: `bun run test:unit -- src/modules/providers` — 150 passed, 0 failed across 33 files.
- Dashboard build: `bun run --filter @aio-proxy/dashboard build` — exited 0.
- Scoped `oxlint` over all 13 changed implementation/test files — exited 0 with only existing file/function-length warnings in test files.
- Scoped type-aware `oxlint` over changed non-test files — exited 0.
- Scoped `oxfmt --check` over all 13 changed implementation/test files — all files correctly formatted.
- `git diff --check` — exited 0.
- `bun run preflight` was attempted and stopped in `lint:types` on two unrelated existing errors in unchanged `packages/dashboard/src/modules/traces/components/traces-filter-rail/traces-filter-rail.tsx`: TS2554 at line 46 and TS2322 at line 56. Because the first preflight command failed, its repository-wide format and test phases did not run.
- No user-facing copy changed, so `i18n:compile` was not required.

## Risks

- Changed-identity ambiguity intentionally fails closed. In particular, changing AI SDK options can require re-entering fresh credentials even when the user considers the edited option non-sensitive; this is the confirmed security tradeoff that prevents persisted secrets from reaching a changed target.
- Fresh credentials for a changed identity must occupy a credential path that existed on the persisted Provider. Switching to a different authentication channel requires saving the new configuration first; this conservative path match prevents unrelated sensitive-looking values from unlocking persisted credential assumptions.
- Independent review noted a non-blocking visual minor: moving Provider headers to the shared sortable header primitive dropped the table's prior per-column header alignment classes. Sorting, `aria-sort`, column visibility, cell alignment, and horizontal access remain functional; aligning the shared header primitive can be handled separately.
- Repository-wide preflight remains blocked by the unrelated Trace filter type errors above. Provider-scoped type checks, affected tests, and the Dashboard production build are green.
