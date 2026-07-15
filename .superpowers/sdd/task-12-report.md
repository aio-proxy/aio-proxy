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
  136 pass, 1 skip, 0 fail, 293 expectations across 7 files

PATH="$HOME/.cargo/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH" rtk bun run --filter @aio-proxy/dashboard test:unit
  99 pass, 0 fail across 14 files
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

Fresh spec review reported no missing behavior, scope creep, or incorrect
behavior. Fresh standards review reported zero critical, important, or hard
findings after verifying that all four table capabilities are user-operable and
that plugin/provider diagnostic rendering shares one component.

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

No unresolved Task 12 concerns. Repository checks still print pre-existing
informational `useLiteralKeys` diagnostics, but the check exits successfully.
