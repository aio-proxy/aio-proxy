# Task 4 Report: Dashboard Shell and Overview Composition

## Status

Implemented the shared Dashboard shell and real-data overview composition for `/`. The change is ready as the Task 4 commit; release notes and the lockstep Changeset remain intentionally deferred to Task 5.

## Delivered behavior

- Added a shared shadcn/Base UI Breadcrumb primitive and a Dashboard `Breadcrumbs` adapter.
- Made `PageContainer` breadcrumb-aware and kept page actions in `extra`; actions stack below the heading on narrow screens and return to the header row from `sm` upward.
- Added the Observability sidebar group containing Dashboard and Traces.
- Replaced the `/` route's former usage-only view with `OverviewPage`.
- Added the six KPIs in the required order: Requests, Token, Cache hit rate, Cost, RPM, TPM.
- Added a model usage trend with local Requests/Tokens/Cost switching. The complete metric payload is already in the query response, so switching metrics does not refetch.
- Added Provider health using TanStack Table plus the shared shadcn Table, including sorting, pagination, an accessible table name, and an empty state.
- Added cost-only top-model bars.
- Added a complete calendar-year activity heatmap with independent previous/next-year controls, horizontal scrolling, tooltips, keyboard-operable day buttons, and a selected-day status readout.
- Added distinct no-configured-Provider, no-requests-in-range, loading, and request-error states.
- Added responsive composition: KPI grid is 2 columns by default, 3 from 721px, and 6 from 1280px; the lower grid is 1 column by default and 2 from 1024px.
- Added all new user-facing copy in English, Japanese, Korean, Simplified Chinese, and Traditional Chinese.

## Files

### Shared shell

- `packages/ui/src/components/breadcrumb.tsx`
- `packages/dashboard/src/components/breadcrumbs/index.ts`
- `packages/dashboard/src/components/breadcrumbs/breadcrumbs.tsx`
- `packages/dashboard/src/components/page-container/page-container.tsx`
- `packages/dashboard/src/components/page-container/page-container.test.tsx`
- `packages/dashboard/src/components/side-menu/side-menu.tsx`
- `packages/dashboard/src/components/side-menu/side-menu.test.tsx`
- `packages/dashboard/src/routes/index.tsx`
- `packages/dashboard/src/styles.css`

### Overview

- `packages/dashboard/src/modules/overview/components/model-usage-trend/{index.ts,model-usage-trend.tsx}`
- `packages/dashboard/src/modules/overview/components/overview-kpi-grid/{index.ts,overview-kpi-grid.tsx}`
- `packages/dashboard/src/modules/overview/components/overview-time-window/{index.ts,overview-time-window.tsx}`
- `packages/dashboard/src/modules/overview/components/provider-health-table/{index.ts,provider-health-table.tsx}`
- `packages/dashboard/src/modules/overview/components/request-activity-heatmap/{index.ts,request-activity-heatmap.tsx}`
- `packages/dashboard/src/modules/overview/components/top-model-costs/{index.ts,top-model-costs.tsx}`
- `packages/dashboard/src/modules/overview/templates/overview-page/{index.ts,overview-page.tsx,overview-page.test.tsx}`

### i18n and report

- `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`
- `.superpowers/sdd/2026-08-04-dashboard-shell-and-overview-redesign/task-4-report.md`

## TDD evidence

1. RED: the focused PageContainer, sidebar, and overview tests were run before implementation. All three target files failed for the expected missing breadcrumb, Observability navigation, and overview composition behavior.
2. GREEN: the focused Task 4 suite passed 9/9 after implementation.
3. EXPANDED GREEN: the PageContainer, complete side-menu area, overview template, and overview service suite passed 17/17 across 6 files.

The behavior-level tests protect:

- breadcrumb order relative to the page title;
- the Observability grouping and destinations;
- fixed KPI order;
- local trend switching without query-key/refetch changes;
- range/year query ownership and refresh placement;
- selected heatmap date/count disclosure;
- distinct no-Provider and no-request states;
- overview wire-to-`bigint` decoding and 24-hour-only polling.

## Command and result log

| Command                                                                                                                          | Result                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd packages/ui && bun x --bun --no-install shadcn add breadcrumb --overwrite`                                                   | Passed; generated the shared Breadcrumb component from the repository's pinned shadcn configuration.                                                                                                                                        |
| Focused Task 4 test command before implementation                                                                                | Expected RED; 3 target files failed on the missing Task 4 behavior.                                                                                                                                                                         |
| `bun install --frozen-lockfile`                                                                                                  | Passed; repaired missing worktree workspace links that initially made shared UI exports appear absent.                                                                                                                                      |
| Full Dashboard unit baseline after link repair                                                                                   | Passed: 249 tests, 1 skipped.                                                                                                                                                                                                               |
| Dashboard baseline build after link repair                                                                                       | Passed.                                                                                                                                                                                                                                     |
| Focused Task 4 tests after implementation                                                                                        | Passed: 9/9.                                                                                                                                                                                                                                |
| Expanded PageContainer/side-menu/overview tests                                                                                  | Passed: 17/17 across 6 files.                                                                                                                                                                                                               |
| `bun run i18n:compile`                                                                                                           | Passed; Paraglide compiled successfully and the i18n package build generated 706 files.                                                                                                                                                     |
| `bun run lint:types`                                                                                                             | Exit 0; only pre-existing repository max-line and filename warnings were reported.                                                                                                                                                          |
| Targeted `oxlint` over Task 4 source and tests                                                                                   | Exit 0 with no findings.                                                                                                                                                                                                                    |
| Targeted `oxfmt --check` over the 30 Task 4 source/message files                                                                 | Passed; all matched files use the correct format.                                                                                                                                                                                           |
| `node /Users/bytedance/.agents/skills/impeccable/scripts/detect.mjs --json <Task 4 UI targets>`                                  | Exit 0 with `[]`; no deterministic design-quality findings.                                                                                                                                                                                 |
| `bun run --filter @aio-proxy/dashboard test:unit -- src/components/page-container src/components/side-menu src/modules/overview` | Final fresh run passed: 17 tests, 0 failures, 0 skipped across 6 files.                                                                                                                                                                     |
| `bun run build:dashboard`                                                                                                        | Final fresh run passed: 11/11 Turbo tasks; Rsbuild completed successfully.                                                                                                                                                                  |
| `bun run preflight`                                                                                                              | Type-aware lint completed with pre-existing warnings; preflight then stopped at formatting because unrelated untracked `packages/dashboard/prototypes/trace-list.html` is not formatted. No Task 4 file remained in the formatter findings. |
| `git diff --check`                                                                                                               | Passed with no whitespace errors before staging.                                                                                                                                                                                            |

## Baseline/worktree diagnosis

The first focused test/build attempt reported missing exports from shared UI packages. Those exports existed in source; the worktree's dependency links were incomplete. Running `bun install --frozen-lockfile` restored the links. The unchanged Dashboard baseline then passed 249 tests with 1 skip and built successfully, confirming this was worktree setup rather than a source defect. No compatibility shim or source workaround was added.

## Visual and interaction QA

The real Dashboard dev route was opened successfully, but the existing authentication gate prevented reaching the overview surface. No mock data, preview fallback, or authentication bypass was introduced because the Dashboard rules require real routes and the scope did not authorize weakening authentication. The dev server was stopped after the check.

The source-level responsive review confirmed the requested grids at the defined breakpoints, complete heatmap preservation through horizontal scrolling, wrap-safe breadcrumbs, and narrow-screen stacking of header actions. Component tests exercised keyboard-accessible roles and names for the main interactive surfaces.

## Self-review

- Provider health uses the shared Table and TanStack Table path rather than a custom table.
- Its locale-sensitive percentage formatter is created inside a `useMemo` keyed by locale, so columns remain stable between unrelated renders.
- Table and chart surfaces have accessible names; heatmap cells and year controls have localized labels.
- Natural-language copy is routed through i18n messages; domain literals such as Provider IDs, Token, RPM, and TPM remain intentional.
- The overview time range owns only KPI/trend data. The heatmap year is independent, matching the contract amendment.
- No new implementation file exceeds 300 lines, and each `.tsx` file declares one component.
- No mock service responses, direct `fetch`, appearance switch, duplicate provider-kind routing, or custom control lookalikes were introduced.
- Unrelated plans, `.reference`, and Dashboard prototypes were preserved and excluded from the Task 4 commit.

## Concerns and deferrals

- Full browser visual inspection of the authenticated overview was not possible with the available session. Automated behavior, build, format, type-aware lint, targeted lint, and the Impeccable detector are green for Task 4.
- Repository preflight is blocked only by the unrelated untracked `packages/dashboard/prototypes/trace-list.html` formatting issue; that file is outside Task 4 and was not modified.
- The Task 5 Changeset and release note are intentionally not part of this commit.
