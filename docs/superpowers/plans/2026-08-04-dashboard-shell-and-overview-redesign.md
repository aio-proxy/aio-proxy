# Dashboard Shell and Overview Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the shared Dashboard shell and a real-data overview page matching the approved control-tower layout: breadcrumb header, shared time window, six KPIs, model trend, Provider diagnostics, top model costs, and a full-year activity heatmap.

**Architecture:** Keep the existing `GET /dashboard/api/usage` contract for its focused chart use; add one typed `GET /dashboard/api/overview` contract that returns every aggregate required by the approved overview in a single request. The core trace store owns aggregation; the server only validates query input and exposes the typed response; Dashboard consumes it through TanStack Query and shared `@aio-proxy/ui` controls.

**Tech Stack:** Bun, TypeScript, Zod 4, Hono, Drizzle/Bun SQLite, React 19, TanStack Query/Router, Recharts, shadcn Base UI from `@aio-proxy/ui`, Paraglide i18n, Rstest.

## Global Constraints

- Do not copy demo code from `/tmp/aio-proxy-dashboard-design-demo`; treat it as the approved interaction reference only.
- All user-facing natural-language copy is an `m[...]()` message in `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`; run `bun run i18n:compile` after message changes.
- Use `@aio-proxy/ui/components/*` for controls and `@aio-proxy/ui/lib/utils` for `cn`; Dashboard owns only composition and layout classes.
- Dashboard requests use the typed Hono client and TanStack Query; no component calls `fetch` and no mock response is introduced.
- `UsageOverviewRangeSchema` becomes exactly `24h | 7d | 30d | 90d`; `24h` alone auto-refreshes.
- The overview window drives only the six KPIs and model trend. Calendar activity is selected by full year and remains independent.
- User-visible overview order is fixed: Requests, Token, Cache hit rate, Cost, RPM, TPM; model trend is `requests | tokens | cost`, defaulting to requests.
- Keep handwritten non-test files below 300 lines and use the conditional-spread pattern required by `exactOptionalPropertyTypes`.
- Any server/type behavior change gets a changeset targeting `aio-proxy`, `@aio-proxy/types`, `@aio-proxy/core`, and `@aio-proxy/server` at the same bump level.

---

## File Map

- `packages/types/src/usage.ts`, `packages/types/src/dashboard.ts`: overview request/response schemas and exported types.
- `packages/core/src/db/trace-store/overview/`: a small aggregate-query collaborator; `trace-store.ts` delegates to it.
- `packages/server/src/dashboard-routes/config.ts`: `GET /overview` validator and route registration.
- `packages/server/src/dashboard-routes/overview.test.ts`: route-level contract and validation tests.
- `packages/dashboard/src/components/page-container/page-container.tsx`: breadcrumb-aware page header; no appearance switch or redundant back button.
- `packages/dashboard/src/components/side-menu/side-menu.tsx`: approved “观测” group and Configuration entries.
- `packages/dashboard/src/modules/overview/{services,hooks,components,templates}/`: all overview client composition, each React component in its own file.
- `packages/dashboard/src/routes/index.tsx`: renders the new overview template.

### Task 1: Define the typed overview contract

**Files:**
- Modify: `packages/types/src/usage.ts`, `packages/types/src/dashboard.ts`
- Test: `packages/types/src/dashboard.test.ts` (create)

**Interfaces:**
- Produces `UsageOverviewRangeSchema`, `DashboardOverviewResponseSchema`, and `DashboardOverviewResponse`.
- `DashboardOverviewResponse` has `{ range, summary, modelTrend, providerHealth, topModelCosts, activity }`; `activity` is `{ year, days: readonly { date: string; requestCount: string }[] }` with exactly the dates present in that year.

- [ ] **Step 1: Write failing schema tests.**

```ts
test('accepts an overview with a 90-day window and a complete yearly activity series', () => {
  const value = DashboardOverviewResponseSchema.parse({
    range: '90d',
    summary: { requestCount: '1', totalTokens: '2', cacheReadTokens: '1', estimatedCostNanoUsd: '0', averageRpm: 1, averageTpm: 2 },
    modelTrend: { buckets: [], series: [] },
    providerHealth: [{ providerId: 'openai-main', successRate: 1, p95LatencyMs: 42 }],
    topModelCosts: [{ modelId: 'gpt-4.1', estimatedCostNanoUsd: '4' }],
    activity: { year: 2026, days: [{ date: '2026-01-01', requestCount: '1' }] },
  });
  expect(value.range).toBe('90d');
});
```

- [ ] **Step 2: Run the test and verify it fails.** Run: `cd packages/types && bun test src/dashboard.test.ts`. Expected: FAIL because the overview schema does not exist and `90d` is rejected.
- [ ] **Step 3: Implement the smallest public schema.** Extend `UsageOverviewRangeSchema`; add nonnegative integer-string summary fields for `cacheReadTokens` and `cacheWriteTokens`; define the five response sections above with finite nonnegative rates/latencies; export the new types from the existing public barrel.
- [ ] **Step 4: Run the test and verify it passes.** Run: `cd packages/types && bun test src/dashboard.test.ts`.
- [ ] **Step 5: Commit.** `git add packages/types/src && git commit -m "feat(types): define dashboard overview response"`

### Task 2: Aggregate overview data in the trace store

**Files:**
- Create: `packages/core/src/db/trace-store/overview/overview.ts`, `packages/core/src/db/trace-store/overview/overview.test.ts`, `packages/core/src/db/trace-store/overview/index.ts`
- Modify: `packages/core/src/db/trace-store/trace-store.ts`, `packages/core/src/db/trace-store/types.ts`, `packages/core/src/db/trace-store/usage-overview/usage-overview.ts`

**Interfaces:**
- Consumes `DashboardOverviewResponse` and a new `DashboardOverviewQuery { range: UsageOverviewRange; year: number; now?: Date }`.
- Produces `TraceStore.overviewDashboard(query): DashboardOverviewResponse`.

- [ ] **Step 1: Write failing database-backed tests.** Seed root spans for two providers/models and assert: cache rate uses `cacheReadTokens / (inputTokens + cacheReadTokens)` with `null` for a zero denominator; P95 uses the nearest-rank 95th duration for each Provider; top costs are descending; and `activity.days` carries only dates in the selected year, including zero-count calendar days.

```ts
expect(store.overviewDashboard({ range: '24h', year: 2026, now: NOW }).providerHealth).toEqual([
  { providerId: 'a', successRate: 1, p95LatencyMs: 900 },
  { providerId: 'b', successRate: 0, p95LatencyMs: 300 },
]);
```

- [ ] **Step 2: Run the test and verify it fails.** Run: `cd packages/core && bun test src/db/trace-store/overview/overview.test.ts`. Expected: FAIL because `overviewDashboard` is absent.
- [ ] **Step 3: Implement aggregation without N+1 queries.** Reuse root-span criteria from `usage-overview.ts`; make one query for range summary/trend, one grouped query for Provider health, one grouped query for model cost, and one daily count query. Materialize the calendar in TypeScript from Jan 1 through Dec 31; do not create a calendar table. Keep `GET /usage` behavior unchanged except for its new cache summary fields.
- [ ] **Step 4: Run focused tests and verify pass.** Run: `cd packages/core && bun test src/db/trace-store/overview src/db/trace-store/usage-overview`.
- [ ] **Step 5: Commit.** `git add packages/core/src/db/trace-store && git commit -m "feat(core): aggregate dashboard overview data"`

### Task 3: Expose the overview route and typed client service

**Files:**
- Create: `packages/server/src/dashboard-routes/overview.test.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts`, `packages/dashboard/src/modules/overview/services/overview-service.ts` (create), `packages/dashboard/src/modules/overview/hooks/use-overview-query.ts` (create)

**Interfaces:**
- Consumes `TraceStore.overviewDashboard({ range, year })`.
- Produces `GET /dashboard/api/overview?range=24h&year=2026` and `overviewQueryOptions({ range, year })` with a five-second refetch only for `24h`.

- [ ] **Step 1: Write a route test for valid and invalid input.**

```ts
const ok = await routes.request('/overview?range=90d&year=2026');
expect(ok.status).toBe(200);
expect((await ok.json()).range).toBe('90d');
expect((await routes.request('/overview?range=14d&year=2026')).status).toBe(400);
```

- [ ] **Step 2: Run it and verify it fails.** Run: `cd packages/server && bun test src/dashboard-routes/overview.test.ts`. Expected: FAIL with 404.
- [ ] **Step 3: Add `OverviewQuerySchema` in `config.ts` and register `.get('/overview', …)`.** Parse `year` as an integer between 2000 and 2100; call `state.traceStore.overviewDashboard`; in Dashboard decode integer strings to `bigint` alongside the existing usage decoder and make a TanStack Query key `['dashboard', 'overview', range, year]`.
- [ ] **Step 4: Run server and Dashboard service tests.** Run: `cd packages/server && bun test src/dashboard-routes/overview.test.ts && cd ../../dashboard && bun test src/modules/overview`.
- [ ] **Step 5: Commit.** `git add packages/server/src/dashboard-routes packages/dashboard/src/modules/overview && git commit -m "feat(dashboard): load typed overview aggregates"`

### Task 4: Build the shared shell and overview composition

**Files:**
- Create: `packages/dashboard/src/components/breadcrumbs/breadcrumbs.tsx`, `packages/dashboard/src/components/breadcrumbs/breadcrumbs.test.tsx`; `packages/dashboard/src/modules/overview/components/{overview-time-window,overview-kpi-grid,model-usage-trend,provider-health-table,top-model-costs,request-activity-heatmap}.tsx`; `packages/dashboard/src/modules/overview/templates/overview-page.tsx`, `overview-page.test.tsx`
- Modify: `packages/dashboard/src/components/page-container/page-container.tsx`, `packages/dashboard/src/components/side-menu/side-menu.tsx`, `packages/dashboard/src/routes/index.tsx`, `packages/dashboard/src/styles.css`, `packages/i18n/messages/*.json`

**Interfaces:**
- Consumes `useOverviewQuery`, `PageContainerProps.breadcrumbs?: readonly BreadcrumbItem[]`, and `OverviewPage` local state `{ range, year, metric }`.
- Produces the `/` page with 6/3/2 KPI grid and 2/1 lower grid; `PageContainer` renders breadcrumbs plus `h1`, while `extra` holds page actions.

- [ ] **Step 1: Write component tests before layout work.** Assert that the overview renders six KPI labels in fixed order; switching the trend tab calls the query with `requests`, `tokens`, and `cost`; clicking a heatmap day exposes only its date/count; `PageContainer` renders `观测 / Dashboard` before the title; and the sidebar has a `观测` group containing Dashboard and Traces.
- [ ] **Step 2: Run and verify failure.** Run: `cd packages/dashboard && bun test src/components/breadcrumbs src/modules/overview/templates/overview-page.test.tsx`. Expected: FAIL because the components do not exist.
- [ ] **Step 3: Implement the approved layout.** Use shared `Tabs`, `Table`, `Tooltip`, `Card`, and `Button`; keep the refresh button immediately left of range tabs; retain no appearance switch in headers; render model trend as Top 4 plus Other stacked areas; give cards semantic classes only for responsive grids, not custom control styling. On narrow screens retain the complete heatmap in a horizontal scroller.
- [ ] **Step 4: Run focused tests and inspect both breakpoints.** Run: `cd packages/dashboard && bun test src/components/breadcrumbs src/modules/overview && bun run build`. Verify at desktop that KPIs are six columns and the lower pair is two columns, then at `max-width: 720px` that they are two and one columns respectively.
- [ ] **Step 5: Commit.** `git add packages/dashboard/src packages/i18n/messages && git commit -m "feat(dashboard): redesign shared shell and overview"`

### Task 5: Add i18n, release notes, and full verification

**Files:**
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Create: `.changeset/dashboard-overview-redesign.md`

- [ ] **Step 1: Add message keys for every overview/breadcrumb/empty-state string.** Include no-provider and no-request-within-window states separately; use ICU parameters for the selected range and date count.
- [ ] **Step 2: Compile i18n and verify a missing-key failure cannot occur.** Run: `bun run i18n:compile && cd packages/dashboard && bun test src/modules/overview`.
- [ ] **Step 3: Author the changeset.** Target `aio-proxy`, `@aio-proxy/types`, `@aio-proxy/core`, and `@aio-proxy/server` at `minor`; explain that Dashboard now exposes a real overview control plane.
- [ ] **Step 4: Run repository verification.** Run: `bun run preflight && bun run build:dashboard`.
- [ ] **Step 5: Commit.** `git add packages/i18n .changeset && git commit -m "docs: release dashboard overview redesign"`

## Self-Review Notes

- The single `/overview` route prevents six independently refreshing cards from drifting, while the existing `/usage` route remains a focused API.
- No-data behavior is covered by the overview template and the server schema preserves a valid zero-result response rather than treating it as an error.
- Full-year activity is deliberately a separate parameter from the shared range; it cannot silently change when the user switches KPI windows.

## Review Amendments

The following corrections supersede earlier references in this plan.

- Keep UsageOverviewRangeSchema unchanged, including 14d, for the existing usage route. Create the separate DashboardOverviewRangeSchema with 24h, 7d, 30d, and 90d for the new overview route.
- DashboardOverviewResponse.summary includes explicit cacheHitRate and providerCount. Cache-hit rate is calculated by the capture path from normalized cached/uncached token fields; it is null when a row cannot establish a denominator. Tests cover both inclusive AI SDK input accounting and additive passthrough accounting.
- Overview returns modelTrendByMetric for requests, tokens, and cost in the same response. The local metric Tab selects a returned series; it does not refetch. Overview aggregation uses Top 4 plus Other independently of the existing Top 5 usage helper.
- Provider health queries aio_proxy.provider.attempt child spans, not root spans. Its tests include a failed first candidate followed by a successful fallback. Root spans remain the source for client-visible request KPI and model-cost aggregation.
- Every SQL sum is cast to text and accumulated through parseSqliteInteger/BigInt. Tests include values above Number.MAX_SAFE_INTEGER, zero-result years, and both 365/366-day calendar boundaries.
- The overview route enriches core aggregate data with state.currentConfig().providers.length. The template uses providerCount to distinguish no configured Provider from no requests in the chosen window.
- Before Task 4, add i18n messages and run bun run i18n:compile; add the missing shared Breadcrumb through the packages/ui shadcn command. PageContainer owns its breadcrumb regression test. Provider health uses TanStack Table plus shared Table.
- New components and tests use same-name directories, for example modules/overview/components/overview-kpi-grid/index.tsx and overview-kpi-grid.test.tsx. Dashboard focused tests run from repo root with bun run --filter @aio-proxy/dashboard test:unit -- <path>; server/core tests run after their workspace dependencies are built through Turbo.
- The final changeset is authored with bun changeset and lists aio-proxy, @aio-proxy/types, @aio-proxy/core, @aio-proxy/server, @aio-proxy/dashboard, @aio-proxy/i18n, and @aio-proxy/ui when Breadcrumb is added, all at the same minor level.
