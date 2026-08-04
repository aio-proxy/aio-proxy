# Task 5 Report: Plugins Dashboard page

## Outcome

Implemented the `/plugins` Dashboard page against the typed, secret-safe Plugin control plane. The page includes Plugin inventory, install, options editing, and uninstall flows, plus navigation, generated route registration, localized copy, and interaction/service coverage.

## Files

- Added `packages/dashboard/src/modules/plugins/` with typed query services, mutations, forms, table/drawer/dialog UI, and tests.
- Added `packages/dashboard/src/routes/plugins/index.tsx`.
- Updated `packages/dashboard/src/components/side-menu/side-menu.tsx` and generated `packages/dashboard/src/route-tree.gen.ts`.
- Updated Plugin copy in `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`.

## Verification

- `bun run i18n:compile` — passed.
- Plugin service and interaction tests — 8 passed, 0 failed.
- Provider and Plugin Dashboard slice — 158 passed, 0 failed.
- Full Dashboard unit suite — 342 passed, 1 skipped, 0 failed.
- `bun run build:dashboard` — passed.
- Scoped formatting, lint, and type-aware checks — passed.
- Impeccable detector audit — no findings.
- `git diff --check` — passed.

`bun run preflight` remains blocked by two pre-existing, unrelated type errors in `packages/dashboard/src/modules/traces/components/traces-filter-rail/traces-filter-rail.tsx`: TS2554 at line 46 and TS2322 at line 56. The affected Plugin and Provider slices and the Dashboard build pass.

## Commit

This report is included in the Task 5 implementation commit. The final commit SHA is recorded in the task handoff because embedding it here would change that SHA.

## Fix round 1

### Findings addressed

1. Options close paths now synchronously reset the form to the safe edit-view and reset mutation state before clearing the selected Plugin. Regression: `clears unsaved replacement secrets and mutation errors before options can reopen` enters a replacement secret, cancels, immediately reopens, and verifies neither the secret nor stale error survives.
2. Plugin install now sends an unconfirmed typed request first, renders trust consent only after `confirmation_required`, and sends `confirmed: true` only for the exact challenged package/registry. Package, registry, and drawer lifecycle changes clear consent and mutation state. Regressions: `keeps Add Plugin in the page header and confirms the exact request after the typed trust challenge` and `clears challenged trust when the package, registry, or drawer lifecycle changes`.
3. Conditional option visibility now evaluates effective values by merging schema defaults with explicit public/secret form values. Regression: `uses effective defaults when evaluating conditional option fields`.
4. Boolean, select, JSON, secret, text, and number controls now retain descriptions through `aria-describedby`; select triggers have matching IDs and labels. Regression: `associates descriptions with boolean, select, JSON, and secret option controls`.

### Files changed

- `packages/dashboard/src/modules/plugins/components/plugin-install-drawer.tsx`
- `packages/dashboard/src/modules/plugins/components/plugin-options-drawer.tsx`
- `packages/dashboard/src/modules/plugins/components/plugin-options-field.tsx`
- `packages/dashboard/src/modules/plugins/components/plugin-secret-options-field.tsx`
- `packages/dashboard/src/modules/plugins/templates/plugins-page/plugins-page.test.tsx`

The original amended brief was not modified.

### Verification

- Red proof: focused interaction test run reported 4 expected failures and 5 passes before implementation; the split default/accessibility regressions independently failed 2/2 before their fixes.
- `bun run test:unit -- src/modules/plugins/templates/plugins-page/plugins-page.test.tsx src/modules/plugins/services/plugins-service/plugins-service.test.ts` — 12 passed, 0 failed.
- Scoped `oxfmt`, `oxlint`, and type-aware/type-check `oxlint` over the changed Plugin files — passed with no findings.
- `bun run build:dashboard` — passed.
- Impeccable detector over the changed Plugin UI — `[]`.
- `bun run preflight` — stopped at the same unrelated Trace type errors: TS2554 at `traces-filter-rail.tsx:46` and TS2322 at `traces-filter-rail.tsx:56`.

### Commit and concerns

- Base Task 5 commit: `163834b58f48ee99a16a00ffedc6affdb5f1b9d7`.
- The fix-round commit SHA is recorded in the handoff because embedding it in this report would change that SHA.
- Concern: repository-wide preflight remains blocked only by the pre-existing Trace type errors above; the focused Plugin checks and Dashboard build pass.
