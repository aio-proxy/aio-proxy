# Task 12 Report: Read-Only OAuth Plugin Diagnostics

## Status

Implemented read-only OAuth plugin and provider diagnostics across shared types,
the dashboard API, dashboard UI, and CLI provider listing. The dashboard now
shows plugin load state, provider availability, capability/account/catalog
metadata, and safe recovery guidance without exposing credentials, secrets, or
original error stacks.

OAuth and invalid provider rows retain diagnostics and delete only. Existing API
and AI SDK edit/delete behavior remains available for both ready and unavailable
rows.

## TDD Evidence

The initial RED runs established that:

- shared dashboard plugin schemas did not exist;
- `GET /dashboard/api/plugins` returned the pre-route 404 response;
- the plugin table and provider state cell did not exist;
- CLI provider output omitted availability and safe recovery metadata.

The completion review added direct interaction regressions for the repository's
table defaults. Before implementation, the focused plugin table run reported
one pass and three failures because it could not find a package sorting button,
plugin filter input, or column visibility menu. After adding the controls and a
reactive TanStack Form store subscription, the same run passed all four tests.

## Implementation Summary

- Added `DashboardPluginSummarySchema` and `DashboardPluginsResponseSchema`,
  extended provider summaries with availability/plugin/capability/account/
  expiry/catalog metadata, and allowed dashboard-only `kind: "invalid"` rows.
- Centralized provider-targeted credential recovery in
  `dashboardProviderSuggestedCommand()`, producing exactly
  `aio-proxy provider login --provider <provider-id>` for credential failures.
- Added `GET /dashboard/api/plugins` and built plugin/provider diagnostics from
  the immutable runtime snapshot. Responses contain only safe account/catalog
  metadata and fixed diagnostic fields.
- Added a typed Hono client and TanStack Query plugin service.
- Added `PluginsTable` with TanStack Table and shadcn Table. Sorting, filtering,
  pagination, and column visibility all have user-operable controls and local
  state; filtered empty results preserve the table empty-state semantics.
- Added `ProviderStateCell` and a shared `DiagnosticDetails` component used by
  both plugin and provider rendering.
- Added capability, account, expiry, catalog freshness, and catalog last-success
  columns to the provider diagnostics table.
- Kept OAuth/plugin diagnostics read-only: no install, configuration, OAuth
  login, credential, or secret controls were added.
- Extended English and Simplified Chinese copy and ARIA labels through i18n.
- Extended CLI provider listing with availability, catalog freshness,
  plugin/capability, account, expiry, catalog success, diagnostic, and suggested
  command columns while keeping probe output separate.

## Verification

Required Task 12 gates:

```text
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run i18n:compile
  exit 0

PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun test packages/types/_test packages/server/_test/dashboard-static.test.ts packages/server/_test/dashboard-providers-mutation.test.ts packages/cli/_test/provider-commands.test.ts
  140 pass, 1 skip, 0 fail, 356 expectations across 8 files

PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/dashboard test:unit
  107 pass, 0 fail across 15 files
```

Focused table RED/GREEN evidence:

```text
plugins-table.test.tsx before controls:
  1 pass, 3 fail (sorting button, filter input, and column menu absent)

plugins-table.test.tsx after controls:
  4 pass, 0 fail
```

Additional gates:

```text
PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run check
  exit 0; only existing informational useLiteralKeys diagnostics and one warning

PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run build
  7 successful tasks, 0 failed

PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk git diff --check
  exit 0
```

During implementation, the full server regression suite also passed 352 tests
with zero failures before the final dashboard-only interaction refactor.

Fresh fix-pass re-review reported zero Critical or Important spec findings and
zero Critical, Important, or hard standards findings. The reviewers verified
the executable command path, shell argv round-trip, snapshot source invariant,
edit-action matrix, and both tables' four user-operable controls. Their minor
report-count and toolbar reactivity findings were resolved before commit.

## Self-Review

- The dashboard route serializes snapshot summaries, not raw configuration or
  credential repositories.
- Route tests assert that stored secrets, credential JSON, and original error
  stacks do not appear in plugin/provider payloads.
- The shared diagnostic renderer is limited to summary, stable code, and the
  already-sanitized suggested command.
- OAuth and invalid rows do not expose edit or login actions. API and AI SDK
  rows retain edit/delete controls even when unavailable.
- Probe health remains distinct from runtime availability and catalog
  freshness in CLI output.
- No shadcn-managed component file was modified.

## Concerns

No unresolved Task 12 product concerns. Repository checks still print
pre-existing informational `useLiteralKeys` diagnostics, but the check exits
successfully. One standalone i18n spike remains environment-dependent as noted
in the fix-pass verification below.

## Formal Review Fix Pass

This fix pass addresses every finding from the formal Task 12 review:

1. Configured plugin load and setup failures now carry an executable
   `aio-proxy plugin config <package>` command. Unconfigured built-ins do not
   claim to be configurable. A route integration test builds a real failed
   configured built-in snapshot and verifies the exact command through
   `GET /dashboard/api/plugins`.
2. Provider and plugin diagnostics tables share sortable header and toolbar
   controls for sorting, global filtering, pagination, and column visibility.
   Because TanStack Table exposes a stable mutable table instance, row and
   pagination consumers opt out of React Compiler memoization, while the shared
   toolbar receives explicit reactive visibility state. Interaction tests cover
   all four controls for both tables and stable-prop toolbar checkmarks.
3. Inferred invalid API and AI SDK summary rows hide edit actions when their
   diagnostic is `PROVIDER_CONFIG_INVALID` or
   `LEGACY_OAUTH_CONFIG_UNSUPPORTED`. Ordinary unavailable API and AI SDK rows
   retain edit and delete actions.
4. The plugin table pagination regression now renders eleven rows, advances to
   the second page, and returns to the first page. The provider table has the
   same forward/backward regression coverage.
5. Shared shell-safe command builders now own provider login and plugin config
   commands. Safe identifiers remain readable; metacharacters and embedded
   single quotes are POSIX-quoted. `suggestedCommand` contains commands only;
   the legacy OAuth removal instruction moved into localized English and
   Simplified Chinese summaries.
6. Provider summaries are the authoritative snapshot source. `providerStates`
   is derived from the final summaries, and an invariant test verifies that an
   injected snapshot exposes the exact same state object through both views.

### Fix-Pass RED/GREEN Evidence

The focused RED runs failed for the intended missing behavior:

```text
types command tests:
  failed because packages/types/src/commands.ts did not exist

core loader/account command tests:
  4 fail (unsafe provider id; configured third-party and built-in plugin
  failures lacked commands; unconfigured built-in policy was not enforced)

server diagnostics tests:
  3 fail (real route command missing; legacy suggestedCommand was prose;
  providerStates did not share the summary state source)

dashboard interaction/action tests:
  7 initial fail, then 8 table-state fail after shared-control extraction
  (sorting, filtering, visibility, pagination, and inferred-invalid edit rules)

fresh shell-safety review:
  1 pass, 3 fail (`~` expanded in bash/zsh and `=ls` was left unquoted)

fresh toolbar boundary review:
  1 fail (a stable caller left the visibility checkmark stale)
```

The fix-pass GREEN verification is:

```text
types full unit:      97 pass, 1 skip, 0 fail
core full unit:       445 pass, 0 fail
server full unit:     352 pass, 0 fail
dashboard full unit:  107 pass, 0 fail
CLI full unit:        127 pass, 0 fail
dashboard focused:    24 pass, 0 fail
shell argv focused:   4 pass, 0 fail, 62 expectations (bash and zsh)
i18n compile:         exit 0
full build:           7 successful tasks, 0 failed
full biome check:     exit 0
git diff --check:     exit 0
```

The standalone i18n unit suite has one environment-only failure in the existing
tree-shaking spike: its temporary directory runs an unpinned `bunx
@inlang/paraglide-js`, which attempts a registry manifest download and fails
with `FailedToOpenSocket`. The repository-local i18n compile succeeds, and the
remaining i18n unit tests pass (14 pass, 1 environment failure).

The first fresh spec review found one Important shell-expansion gap: `~` and
`=` were treated as unquoted. The whitelist now excludes both, and fake
`aio-proxy` functions in bash and zsh verify exact provider/plugin argv for
tilde, leading equals, spaces, semicolons, single quotes, command substitution,
and backticks. Fresh spec re-review then reported 0 Critical / 0 Important.

The fresh standards review reported 0 Critical / 0 Important / 0 hard findings
and identified a minor implicit toolbar rerender contract. A stable-prop RED
test reproduced the stale checkmark. `useDataTable()` now exposes its reactive
column-visibility state explicitly to `DataTableToolbar`, making the shared
component independent of callback identity; the focused dashboard run is 24/24.
