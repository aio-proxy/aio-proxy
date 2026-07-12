# Dashboard Request Logs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a URL-filtered, server-paginated Dashboard request-log table with usage columns, a provider-attempt detail drawer, and page-1 polling.

**Architecture:** Extend the existing `RequestLogStore` with one typed terminal-log query that joins `usage`, add a validated read-only Dashboard API endpoint, then build a `/logs` feature module around TanStack Query and TanStack Router search state. Reuse the existing pagination, table, Drawer, i18n, and formatting primitives; add no dependencies and no second detail endpoint.

**Tech Stack:** Bun SQLite, Drizzle ORM, Zod 4, Hono, React 19, TanStack Query, TanStack Router, TanStack Table, Rstest, Testing Library, Paraglide i18n

## Global Constraints

- One `request_log` row remains one terminal inbound request; attempts never become list rows.
- Do not record or expose request bodies, response bodies, headers, API keys, streamed content, or process logs.
- Filters cover terminal columns only; never query inside `attempts_json`.
- Default range is an explicit rolling 24-hour interval; retained history remains 45 days.
- Default page size is 50; allowed sizes are exactly 10, 20, 50, and 100.
- Sort by `completed_at DESC, request_id DESC` for deterministic pages.
- The logs page contains no aggregate statistics, charts, exports, configurable columns, or new authentication.
- Missing usage or price values render as missing, never as zero.
- Page 1 polls every five seconds by default; later pages never poll; manual refresh is always available.
- Add no new runtime or test dependency.

---

### Task 1: Typed Request-Log Query and Index Migration

**Files:**
- Modify: `packages/types/src/dashboard.ts`
- Modify: `packages/core/src/db/schema/request-log.ts`
- Modify: `packages/core/src/db/request-log.ts`
- Modify: `packages/core/src/db/index.ts`
- Modify: `packages/core/_test/request-log.test.ts`
- Generate: `packages/core/src/db/migrations/0003_*.sql`
- Regenerate: `packages/core/src/db/migrations.manifest.ts`

**Interfaces:**
- Produces: `DashboardRequestAttemptSchema` / `DashboardRequestAttempt`
- Produces: `DashboardRequestLogSchema` / `DashboardRequestLog`
- Produces: `DashboardRequestLogsResponseSchema` / `DashboardRequestLogsResponse`
- Produces: `RequestLogsQuery`
- Produces: `RequestLogStore.list(query: RequestLogsQuery): DashboardRequestLogsResponse`

- [ ] **Step 1: Write failing store tests for deterministic pagination and the usage join**

Append focused tests to `packages/core/_test/request-log.test.ts` using the existing `seedBase()` fixture. Add a fourth row sharing a completion timestamp so the secondary `requestId` order is observable, then assert:

```ts
const result = store.list({
  page: 1,
  pageSize: 2,
  startedAfter: new Date("2026-07-11T06:00:00.000Z"),
  completedBefore: new Date("2026-07-11T08:00:00.000Z"),
});

expect(result).toMatchObject({ page: 1, pageSize: 2, total: 4, pageCount: 2 });
expect(result.items.map((item) => item.requestId)).toEqual(["request-same-time-z", "request-cancelled"]);
expect(result.items[0]?.usage).toBeUndefined();

const success = store.list({
  page: 1,
  pageSize: 10,
  requestId: "request-success-a",
});
expect(success.items[0]).toMatchObject({
  requestId: "request-success-a",
  completedAt: "2026-07-11T07:00:00.100Z",
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, estimatedCostUsd: 0.25 },
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk bun test packages/core/_test/request-log.test.ts
```

Expected: FAIL because `RequestLogStore` has no `list` method.

- [ ] **Step 3: Add failing table-driven filter and out-of-range tests**

Use `test.each` to cover exact `outcome`, `inboundProtocol`, `requestedModelId`, `finalProviderId`, `finalModelId`, and `finalStatusCode` filters. Add combined time/outcome filtering and assert an out-of-range page returns empty `items` with unchanged `total` and `pageCount`.

```ts
expect(store.list({ page: 99, pageSize: 10 })).toEqual({
  items: [],
  page: 99,
  pageSize: 10,
  total: 3,
  pageCount: 1,
});
```

- [ ] **Step 4: Define response schemas in `packages/types/src/dashboard.ts`**

Reuse `ProviderKind`, `ProviderProtocolSchema`, `RequestOutcomeSchema`, and `UsageRowSchema`. Define attempts with optional protocol/status/error fields, define request rows with ISO datetime strings and optional final-route/usage fields, and define the paginated response:

```ts
export const DashboardRequestLogsPageSizeSchema = z.union([
  z.literal(10),
  z.literal(20),
  z.literal(50),
  z.literal(100),
]);

export const DashboardRequestLogsResponseSchema = z.object({
  items: z.array(DashboardRequestLogSchema),
  page: z.number().int().min(1),
  pageSize: DashboardRequestLogsPageSizeSchema,
  total: z.number().int().min(0),
  pageCount: z.number().int().min(0),
});
```

Export the corresponding input/output types beside the existing Dashboard types.

- [ ] **Step 5: Add the minimal query interface and implementation**

In `packages/core/src/db/request-log.ts`, define:

```ts
export type RequestLogsQuery = {
  readonly page: number;
  readonly pageSize: 10 | 20 | 50 | 100;
  readonly startedAfter?: Date;
  readonly completedBefore?: Date;
  readonly requestId?: string;
  readonly outcome?: RequestOutcome;
  readonly inboundProtocol?: string;
  readonly requestedModelId?: string;
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly finalStatusCode?: number;
};
```

Build one shared `and(...)` predicate from present filters, run a count query and a paged left join to `usage`, order by `desc(requestLog.completedAt), desc(requestLog.requestId)`, and map dates to ISO strings. Preserve `usage: undefined` when the left join is absent. Export `RequestLogsQuery` from `packages/core/src/db/index.ts`.

- [ ] **Step 6: Verify the store tests are GREEN**

Run:

```bash
rtk bun test packages/core/_test/request-log.test.ts
```

Expected: all request-log tests pass with 0 failures.

- [ ] **Step 7: Add terminal-filter indexes and generate the migration**

Add Drizzle indexes for `(finalProviderId, completedAt)`, `(requestedModelId, completedAt)`, `(finalModelId, completedAt)`, `(inboundProtocol, completedAt)`, and `(finalStatusCode, completedAt)` in `packages/core/src/db/schema/request-log.ts`.

Run:

```bash
rtk bun run build:migrations
```

Expected: a new `0003_*.sql` containing only the five `CREATE INDEX` statements, and an updated migration manifest.

- [ ] **Step 8: Verify core type/build behavior and commit**

Run:

```bash
rtk bun test packages/core/_test/request-log.test.ts
rtk bun run --filter @aio-proxy/types build
rtk bun run --filter @aio-proxy/core build
```

Expected: all commands exit 0.

Commit:

```bash
rtk git add packages/types/src/dashboard.ts packages/core/src/db packages/core/_test/request-log.test.ts
rtk git commit -m "feat(core): query request logs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 2: Validated Dashboard Logs API

**Files:**
- Modify: `packages/server/src/dashboard-routes/config.ts`
- Create: `packages/server/_test/dashboard-request-logs.test.ts`

**Interfaces:**
- Consumes: `state.requestLog.list(query)` from Task 1
- Produces: typed `GET /dashboard/api/logs`
- Produces query fields: `page`, `pageSize`, `startedAfter`, `completedBefore`, `requestId`, `outcome`, `inboundProtocol`, `requestedModelId`, `finalProviderId`, `finalModelId`, `finalStatusCode`

- [ ] **Step 1: Write a failing endpoint success test**

Follow `packages/server/_test/usage-dashboard.test.ts`: create a temporary server/database, seed one success with usage and one failure, request `/dashboard/api/logs`, and assert status 200, default pagination, newest-first rows, attempts, and `DashboardRequestLogsResponseSchema.parse(body)`.

- [ ] **Step 2: Run the endpoint test and verify RED**

Run:

```bash
rtk bun test packages/server/_test/dashboard-request-logs.test.ts
```

Expected: FAIL with 404 because the route does not exist.

- [ ] **Step 3: Add failing validation tests**

Use `test.each` for:

```ts
[
  "page=0",
  "page=1.5",
  "pageSize=25",
  "finalStatusCode=abc",
  "finalStatusCode=99",
  "outcome=unknown",
  "startedAfter=not-a-date",
  "completedBefore=not-a-date",
]
```

Expect status 400 with `{ error: "validation failed", details: expect.any(Array) }`. Add a valid combined-filter test and assert only the matching row is returned.

- [ ] **Step 4: Implement the query schema and route**

In `packages/server/src/dashboard-routes/config.ts`, add a strict Zod query schema using coercion at the HTTP boundary:

```ts
const RequestLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().pipe(DashboardRequestLogsPageSizeSchema).default(50),
  startedAfter: z.iso.datetime().transform((value) => new Date(value)).optional(),
  completedBefore: z.iso.datetime().transform((value) => new Date(value)).optional(),
  requestId: z.string().trim().min(1).optional(),
  outcome: RequestOutcomeSchema.optional(),
  inboundProtocol: z.string().trim().min(1).optional(),
  requestedModelId: z.string().trim().min(1).optional(),
  finalProviderId: z.string().trim().min(1).optional(),
  finalModelId: z.string().trim().min(1).optional(),
  finalStatusCode: z.coerce.number().int().min(100).max(599).optional(),
});
```

Use the same validation-error response shape as `/usage`, then add `.get("/logs", requestLogsValidator, ...)` adjacent to the usage route.

- [ ] **Step 5: Verify server tests and commit**

Run:

```bash
rtk bun test packages/server/_test/dashboard-request-logs.test.ts
rtk bun test packages/server/_test/usage-dashboard.test.ts packages/server/_test/dashboard-static.test.ts
```

Expected: all selected server tests pass.

Commit:

```bash
rtk git add packages/server/src/dashboard-routes/config.ts packages/server/_test/dashboard-request-logs.test.ts
rtk git commit -m "feat(server): expose dashboard request logs" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 3: URL Search State and Query Service

**Files:**
- Create: `packages/dashboard/src/modules/logs/logs-search.ts`
- Create: `packages/dashboard/src/modules/logs/logs-search.test.ts`
- Create: `packages/dashboard/src/modules/logs/services/logs-service.ts`
- Create: `packages/dashboard/src/modules/logs/services/logs-service.test.ts`
- Create: `packages/dashboard/src/modules/logs/hooks/use-logs-query.ts`

**Interfaces:**
- Produces: `LogsSearch`
- Produces: `createDefaultLogsSearch(now?: Date): LogsSearch`
- Produces: `parseLogsSearch(raw: Record<string, unknown>, now?: Date): LogsSearch`
- Produces: `logsQueryOptions(search: LogsSearch, autoRefresh: boolean)`
- Produces: `useLogsQuery(search, autoRefresh)`

- [ ] **Step 1: Write failing search-parser tests**

Assert that a pinned `now` creates explicit `startedAfter` and `completedBefore` ISO strings 24 hours apart, valid URL strings parse into typed page/page-size/filter values, malformed values fall back safely, and a helper that changes filters resets `page` to 1.

```ts
expect(createDefaultLogsSearch(new Date("2026-07-12T12:00:00.000Z"))).toMatchObject({
  page: 1,
  pageSize: 50,
  startedAfter: "2026-07-11T12:00:00.000Z",
  completedBefore: "2026-07-12T12:00:00.000Z",
});
```

- [ ] **Step 2: Run search tests and verify RED**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/logs/logs-search.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal parser and updater**

Use plain TypeScript and the existing Zod dependency; do not add a router adapter. Preserve explicit time instants, omit empty optional strings, accept only allowed page sizes/outcomes/status codes, and export one `withLogsFilters(search, patch)` helper that applies a patch and returns `page: 1`.

- [ ] **Step 4: Write failing query-option tests**

Assert the full search object is represented in the query key, page 1 plus enabled auto-refresh yields `refetchInterval: 5_000`, page 2 yields `false`, disabled auto-refresh yields `false`, and background polling is off.

- [ ] **Step 5: Implement the API service and hook**

Use `dashboardClient.dashboard.api.logs.$get({ query })` and `InferResponseType` like the usage service. Convert `page` and numeric filters to strings for Hono's generated client query shape. Throw `DashboardLogsRequestError` on non-OK responses.

- [ ] **Step 6: Verify focused Dashboard tests and commit**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/logs/logs-search.test.ts src/modules/logs/services/logs-service.test.ts
```

Expected: all focused tests pass.

Commit:

```bash
rtk git add packages/dashboard/src/modules/logs
rtk git commit -m "feat(dashboard): add request log query state" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 4: Logs Table, Filters, Drawer, Refresh, and Navigation

**Files:**
- Create: `packages/dashboard/src/routes/logs.tsx`
- Create: `packages/dashboard/src/modules/logs/templates/logs-page.tsx`
- Create: `packages/dashboard/src/modules/logs/templates/logs-page.test.tsx`
- Create: `packages/dashboard/src/modules/logs/components/logs-filters.tsx`
- Create: `packages/dashboard/src/modules/logs/components/logs-table.tsx`
- Create: `packages/dashboard/src/modules/logs/components/log-detail-drawer.tsx`
- Create: `packages/dashboard/src/modules/logs/log-formatters.ts`
- Create: `packages/dashboard/src/modules/logs/log-formatters.test.ts`
- Modify: `packages/dashboard/src/components/side-menu/side-menu.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Regenerate: `packages/i18n/src/paraglide/`
- Regenerate: `packages/dashboard/src/route-tree.gen.ts`

**Interfaces:**
- Consumes: Task 3 URL state and query hook
- Produces: Dashboard route `/logs`
- Produces: `displayTotalTokens(log)` and duration/cost/time formatters
- Produces: keyboard-accessible row selection and a right-side detail Drawer

- [ ] **Step 1: Write failing formatter tests**

Cover the exact token policy:

```ts
expect(displayTotalTokens({ totalTokens: 9, inputTokens: 3, outputTokens: 4 })).toBe(9);
expect(displayTotalTokens({ inputTokens: 3, outputTokens: 4 })).toBe(7);
expect(displayTotalTokens({ inputTokens: 3 })).toBeUndefined();
expect(displayTotalTokens(undefined)).toBeUndefined();
```

Also assert missing cost formats as an em dash and present USD cost preserves meaningful precision using the existing usage formatter convention.

- [ ] **Step 2: Run formatter tests and verify RED, then implement GREEN**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/logs/log-formatters.test.ts
```

Expected RED: module missing. Implement only the tested pure helpers, rerun, and expect all tests to pass.

- [ ] **Step 3: Write failing page interaction tests**

Mock `@aio-proxy/i18n`, `useLogsQuery`, and router navigation. Test these user-visible behaviors with Testing Library:

- rows render completion, outcome text, protocol, requested model, final route, status, duration, total tokens, and cost;
- absent status/usage/cost render em dashes;
- clicking a row opens a drawer containing request ID, all usage buckets, and ordered attempts;
- Enter and Space on a focused row open the same drawer;
- changing a filter navigates with `page: 1` and explicit times preserved;
- page controls write the selected page to URL state;
- manual refresh calls the query refetch without changing search state;
- page 1 shows the auto-refresh switch; page 2 does not permit polling;
- loading skeleton, empty state/reset, and error/retry states render.

- [ ] **Step 4: Add i18n messages before implementing visible UI**

Add a `dashboard.logs` message tree in both locale files containing the page/menu title, column labels, filter labels/options, time presets, actions, states, outcome labels, drawer sections, and field labels. Add `dashboard.menus.logs`.

Run:

```bash
rtk bun run --filter @aio-proxy/i18n build
```

Expected: Paraglide compilation exits 0 with no missing message declarations.

- [ ] **Step 5: Implement the route and page shell**

Define `packages/dashboard/src/routes/logs.tsx` with `validateSearch: (raw) => parseLogsSearch(raw)` and render `<LogsPage search={Route.useSearch()} navigate={Route.useNavigate()} />`. On the first render, replace an empty/non-canonical search string with the validated search object so the explicit 24-hour start/end instants appear in the URL; guard the replacement by comparing the current raw search keys so it cannot loop. Keep router coupling in the route/template boundary; components receive typed values and callbacks.

Add the Logs navigation item with a list/history icon under the existing overview group and active matching for `/logs`.

- [ ] **Step 6: Implement filters with native controls**

Use existing `Input`, `Select`, `Button`, and `Switch`. Use native `datetime-local` inputs for custom start/end rather than adding a date-picker dependency. Provide 24h/7d/14d/30d/45d presets, request-ID/model/provider text inputs, outcome/protocol selects, numeric status input, reset, refresh, and page-1 auto-refresh toggle.

Every filter change calls the Task 3 updater so page resets to 1. Reset creates a fresh rolling 24-hour explicit range.

- [ ] **Step 7: Implement the server-paginated table**

Use the existing `Table` primitives and `DataTablePagination`. Configure TanStack Table with `manualPagination: true`, controlled zero-based pagination derived from URL page/pageSize, `pageCount` from the API, and no client pagination row model. Wrap the table in `overflow-x-auto` for narrow screens.

Each row uses `tabIndex={0}`, `role="button"`, an accessible label containing request ID, click handling, and Enter/Space key handling. Outcome/status include translated text, not color alone.

- [ ] **Step 8: Implement the detail Drawer from the selected row snapshot**

Use `Drawer swipeDirection="right"`, `DrawerContent`, `DrawerHeader`, `DrawerTitle`, `DrawerDescription`, `ScrollArea`, and `DrawerClose`. Render request summary, every stored usage bucket, and attempts sorted by `index`. Use `navigator.clipboard.writeText(requestId)` for the copy action and preserve the selected object until the drawer closes.

- [ ] **Step 9: Implement refresh behavior**

Keep `autoRefresh` local to the page and default it to `true`. Pass it to `useLogsQuery`; Task 3 controls the five-second interval only on page 1. Manual refresh calls the query result's `refetch()`. Set `placeholderData: (previous) => previous` in the query options so the table does not blank during refetch.

- [ ] **Step 10: Run page tests and regenerate the route tree**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard test:unit -- src/modules/logs
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: logs tests pass; the Dashboard build exits 0 and regenerates `route-tree.gen.ts` with `/logs`.

- [ ] **Step 11: Commit the Dashboard feature**

```bash
rtk git add packages/dashboard/src packages/i18n/messages packages/i18n/src/paraglide
rtk git commit -m "feat(dashboard): add request log viewer" -m "Co-authored-by: Codex <noreply@openai.com>"
```

---

### Task 5: Full Verification and Focused Code Review

**Files:**
- Modify only files required to fix verification or review findings within the approved scope

**Interfaces:**
- Verifies the complete path: SQLite query -> Hono endpoint -> generated client -> URL state -> table/drawer

- [ ] **Step 1: Run formatting and static checks**

Run:

```bash
rtk bun run check
```

Expected: exit 0 with no Biome errors.

- [ ] **Step 2: Run package-focused tests**

Run:

```bash
rtk bun test packages/core/_test/request-log.test.ts
rtk bun test packages/server/_test/dashboard-request-logs.test.ts packages/server/_test/usage-dashboard.test.ts
rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: all commands report 0 failures.

- [ ] **Step 3: Run repository-wide tests and builds**

Run:

```bash
rtk bun run test:unit
rtk bun run build
```

Expected: all workspace tests and builds exit 0.

- [ ] **Step 4: Review the diff against both standards and the approved spec**

Invoke the `/code-review` workflow against the commit before Task 1 (currently `694a42f`) and inspect both standards and spec findings. Fix only actionable correctness, accessibility, security, or scope-conformance issues. Do not add excluded features.

- [ ] **Step 5: Re-run verification after review fixes**

Repeat:

```bash
rtk bun run check
rtk bun run test:unit
rtk bun run build
```

Expected: all commands exit 0 after the final diff.

- [ ] **Step 6: Commit review fixes if any**

```bash
rtk git add packages
rtk git commit -m "fix(dashboard): address request log review" -m "Co-authored-by: Codex <noreply@openai.com>"
```

Skip this commit when the review produces no code changes. Preserve the user's existing `.gitignore` modification throughout every task.
