# Provider List Aggregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show exact rolling-24-hour per-Provider usage in the Provider list while improving grouped OAuth row layout and interaction.

**Architecture:** Add an optional `maxResults` usage-query limit. Explicitly limited dashboard-usage charts retain their current top-five behavior; an omitted limit returns every dimension. A Provider-owned dashboard service makes three unlimited Provider-grouped queries, decodes each chart key, and totals bucket values before the table renders rows or OAuth aggregates.

**Tech Stack:** Bun, TypeScript, Hono, Drizzle/SQLite, React, TanStack Query/Table, shadcn UI, i18n, Rstest.

## Global Constraints

- `maxResults` is a positive integer when present; omitted means unlimited and is an intentional API-contract change.
- The existing Usage page always requests `maxResults=5`; Provider-list usage requests omit it.
- Unlimited Provider request counts include successful, failed, and cancelled requests exactly once under their Provider ID.
- Provider list code must not import a service from `modules/usage`.
- User-facing labels and accessible names use `@aio-proxy/i18n`; update every supported locale and compile messages.
- Reuse existing token and nano-USD formatters; add no dependencies.

---

### Task 1: Make usage result limits explicit and preserve chart behavior

**Files:**
- Modify: `packages/core/src/db/trace-store/types.ts:125-129`
- Modify: `packages/core/src/db/trace-store/usage-overview/usage-overview.ts:32-45`
- Modify: `packages/core/src/db/trace-store/usage-overview/aggregation.ts:27-139`
- Modify: `packages/core/src/db/trace-store/usage-overview/aggregation.test.ts`
- Modify: `packages/server/src/dashboard-routes/config.ts:21-44`
- Modify: `packages/server/src/dashboard-routes/config.test.ts`

**Interfaces:**
- Consumes: `UsageOverviewQuery`, `/dashboard/api/usage` query parsing, and `aggregateRows` chart construction.
- Produces: `UsageOverviewQuery.maxResults?: number`; an omitted limit retains every dimension, while `maxResults=5` retains five plus `__other__`.

- [ ] **Step 1: Write failing core and route tests**

```ts
test('returns every provider when maxResults is omitted', () => {
  const overview = traceStore.overview({ range: '24h', metric: 'requests', groupBy: 'provider', now });
  expect(overview.series.map(({ key }) => key)).toEqual(['alpha', 'beta', 'gamma', 'zulu']);
});

test('keeps five dimensions and Other when maxResults is 5', () => {
  const overview = traceStore.overview({ range: '24h', metric: 'requests', groupBy: 'provider', maxResults: 5, now });
  expect(overview.series.at(-1)).toEqual({ key: '__other__', kind: 'other' });
});

test.each(['0', '-1', '1.5'])('rejects invalid maxResults %s', async (maxResults) => {
  const response = await app.request(`/dashboard/api/usage?maxResults=${maxResults}`);
  expect(response.status).toBe(400);
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `bun run --filter @aio-proxy/core test:unit -- usage-overview/aggregation` and the dashboard-routes focused test command used by that package.

Expected: FAIL because `maxResults` is neither typed nor parsed.

- [ ] **Step 3: Add the optional limit and outcome attribution**

```ts
export type UsageOverviewQuery = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly maxResults?: number;
  readonly now?: Date;
};

const usageOverviewQuerySchema = z.object({
  range: UsageOverviewRangeSchema.default('24h'),
  metric: UsageOverviewMetricSchema.default('cost'),
  groupBy: UsageOverviewGroupBySchema.default('model'),
  maxResults: z.coerce.number().int().positive().optional(),
});
```

Pass `query.maxResults` to aggregation. Let an undefined retained count include every dimension and omit `__other__`; retain the current `__other__` behavior only for a supplied limit. For unlimited `groupBy: 'provider'`, put success, failure, and cancellation counts into dimension buckets and do not create global outcome series, so the table can total exact per-Provider request counts.

- [ ] **Step 4: Add encoded-ID and outcome regression coverage**

```ts
expect(overview.series.map(({ key }) => key)).toContain('dimension:openai%2Emain');
expect(sumBuckets(overview, 'dimension:openai%2Emain')).toBe(3n); // success + failure + cancellation
```

Exercise `__proto__`, dots, brackets, and multiple buckets in the same test group.

- [ ] **Step 5: Run focused tests and commit**

Run: the focused Core and Server test commands from Step 2.

Expected: PASS.

```bash
git add packages/core/src/db/trace-store packages/server/src/dashboard-routes/config.ts packages/server/src/dashboard-routes/config.test.ts
git commit -m "feat(usage): support unlimited grouped results"
```

### Task 2: Keep limited dashboard Usage queries isolated

**Files:**
- Modify: `packages/dashboard/src/lib/query-keys.ts:26`
- Modify: `packages/dashboard/src/modules/usage/services/usage-service.ts:40-64`
- Modify: `packages/dashboard/src/modules/usage/services/usage-service.test.ts`
- Modify: `packages/dashboard/src/modules/usage/templates/usage-overview.tsx:15-20`
- Modify: `packages/dashboard/src/modules/usage/templates/usage-overview.test.tsx`

**Interfaces:**
- Consumes: `maxResults?: number` on the dashboard usage route.
- Produces: `UsageQueryInput.maxResults?: number`; cache keys include the exact limit state.

- [ ] **Step 1: Write failing dashboard query tests**

```ts
expect(queryKeys.usage('24h', 'requests', 'provider', 5)).not.toEqual(
  queryKeys.usage('24h', 'requests', 'provider', undefined),
);
expect(usageQueryOptions({ range: '24h', metric: 'cost', groupBy: 'model', maxResults: 5 }).queryKey).toContain(5);
```

- [ ] **Step 2: Run the service test and confirm failure**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- usage-service`

Expected: FAIL because the input and query key lack `maxResults`.

- [ ] **Step 3: Thread the limit through the existing service**

```ts
export type UsageQueryInput = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
  readonly maxResults?: number;
};

query: { range: input.range, metric: input.metric, groupBy: input.groupBy, ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }) }
```

Update `queryKeys.usage` to take and store `maxResults`. Have `UsageOverview` pass `{ ...filters, maxResults: 5 }` to `useUsageQuery`.

- [ ] **Step 4: Run the focused dashboard tests and commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- usage-service usage-overview`

Expected: PASS.

```bash
git add packages/dashboard/src/lib/query-keys.ts packages/dashboard/src/modules/usage
git commit -m "fix(dashboard): preserve limited usage chart queries"
```

### Task 3: Add a Provider-owned 24h usage query and aggregation

**Files:**
- Create: `packages/dashboard/src/modules/providers/services/provider-usage-service/provider-usage-service.ts`
- Create: `packages/dashboard/src/modules/providers/services/provider-usage-service/provider-usage-service.test.ts`
- Create: `packages/dashboard/src/modules/providers/services/provider-usage-service/index.ts`

**Interfaces:**
- Consumes: typed `dashboardClient.dashboard.api.usage.$get`, `queryKeys`, `formatCompactTokenCount`, and `formatNanoUsd` consumers.
- Produces: `ProviderUsage { requestCount: bigint; totalTokens: bigint; estimatedCostNanoUsd: bigint }`, `providerUsageQueryOptions()`, and a `ReadonlyMap<string, ProviderUsage>` keyed by decoded Provider ID.

- [ ] **Step 1: Write failing aggregation and request tests**

```ts
expect(await getProviderUsage()).toEqual(
  new Map([['openai.main', { requestCount: 3n, totalTokens: 120n, estimatedCostNanoUsd: 9n }]]),
);
expect(usageGet).toHaveBeenCalledWith({ query: { range: '24h', metric: 'requests', groupBy: 'provider' } });
expect(usageGet).toHaveBeenCalledTimes(3);
```

Provide two buckets for the encoded `dimension:openai%2Emain` key and one malformed response assertion through the existing request-error pattern.

- [ ] **Step 2: Run the new service test and confirm failure**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- provider-usage-service`

Expected: FAIL because the Provider-owned service does not exist.

- [ ] **Step 3: Implement the smallest provider service**

```ts
const metrics = ['requests', 'tokens', 'cost'] as const;
const responses = await Promise.all(metrics.map((metric) => dashboardClient.dashboard.api.usage.$get({
  query: { range: '24h', metric, groupBy: 'provider' },
})));
```

Reject non-OK responses with the existing `DashboardUsageRequestError` pattern. Decode `dimension:` keys with `decodeURIComponent` before summing all bucket values. Initialize missing metrics to `0n`; never import from `modules/usage`.

- [ ] **Step 4: Run the focused service test and commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- provider-usage-service`

Expected: PASS.

```bash
git add packages/dashboard/src/modules/providers/services/provider-usage-service
git commit -m "feat(dashboard): query provider usage totals"
```

### Task 4: Render the new columns and accessible aggregate interaction

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/providers-table-columns.tsx:31-161`
- Modify: `packages/dashboard/src/modules/providers/components/providers-table/providers-table.tsx:27-124`
- Modify: `packages/dashboard/src/modules/providers/components/oauth-provider-group-row/oauth-provider-group-row.tsx:13-43`
- Modify: `packages/dashboard/src/modules/providers/components/providers-table/providers-table.test.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Modify: `packages/i18n/messages/zh-Hant.json`
- Modify: `packages/i18n/messages/ja.json`
- Modify: `packages/i18n/messages/ko.json`

**Interfaces:**
- Consumes: `useQuery(providerUsageQueryOptions())` and the `ReadonlyMap<string, ProviderUsage>` from Task 3.
- Produces: an unlabeled aggregate-marker column, a combined Type cell, a compact 24h Usage cell, and keyboard-accessible grouped OAuth rows.

- [ ] **Step 1: Write failing table tests**

```tsx
expect(screen.getByRole('columnheader', { name: /24h usage|24 小时用量/u })).toBeInTheDocument();
expect(within(screen.getByTestId('provider-row-openai-main')).getByText('API · openai-response')).toBeTruthy();
expect(within(group).getByRole('button', { name: /Expand provider group|展开提供商分组/u })).toHaveAttribute('aria-expanded', 'false');

fireEvent.click(group);
expect(screen.getByTestId('provider-row-copilot-one')).toBeTruthy();
fireEvent.keyDown(within(group).getByRole('button'), { key: 'Enter' });
expect(screen.queryByTestId('provider-row-copilot-one')).toBeNull();
```

Mock the three Provider usage queries and assert a group with two accounts shows the element-wise sum of requests, tokens, and cost.

- [ ] **Step 2: Run the table test and confirm failure**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- providers-table`

Expected: FAIL because no usage column, marker column, or row-level toggle exists.

- [ ] **Step 3: Implement the minimal table changes**

Add an empty-header `aggregate` column first; concrete cells return `null`. Delete `protocolColumn`; have the Type cell render `API · ${provider.protocol ?? 'N/A'}` for API Providers. Add a non-sortable `usage` column that renders stacked tabular request, compact token, and compact nano-USD values using existing formatters.

Have `ProvidersTable` query Provider usage once and pass it to both `createProviderColumns` and `OAuthProviderGroupRow`. Render the group as one cell per column. Add `onClick` to the group row, a labeled chevron button that calls `event.stopPropagation()`, and Enter/Space handling on the focused row. Preserve normal Provider links, switches, and action controls.

- [ ] **Step 4: Add translations and compile messages**

Add `col_usage_24h`, `expand_group`, and `collapse_group` under `dashboard.providers.table` in every locale, then run:

```bash
bun run i18n:compile
```

- [ ] **Step 5: Run focused dashboard tests and commit**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- providers-table provider-usage-service`

Expected: PASS.

```bash
git add packages/dashboard/src/modules/providers packages/i18n/messages
git commit -m "feat(dashboard): show provider 24h usage"
```

### Task 5: Verify the integrated change

**Files:**
- Modify: none unless verification exposes a defect.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: evidence that formatting, linting, and the complete test suite accept the change.

- [ ] **Step 1: Run focused test suites**

Run:

```bash
bun run --filter @aio-proxy/core test:unit -- usage-overview
bun run --filter @aio-proxy/server test:unit -- dashboard-routes
bun run --filter @aio-proxy/dashboard test:unit -- provider-usage-service providers-table usage-service
```

Expected: PASS.

- [ ] **Step 2: Run required repository verification**

Run:

```bash
bun run preflight
```

Expected: PASS with formatting, linting, and unit tests clean.

- [ ] **Step 3: Inspect the final diff**

Run:

```bash
git diff --check HEAD~5..HEAD
git status --short
```

Expected: no whitespace errors and no uncommitted generated files.
