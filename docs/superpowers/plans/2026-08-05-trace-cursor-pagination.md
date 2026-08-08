# Trace Cursor Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Trace offset pagination with stable previous/next cursor pages and a URL-driven page-replacement table.

**Architecture:** Core owns the versioned opaque token codec and bidirectional keyset query. Server validates the token and exposes `items`, `nextPageToken`, and `prevPageToken`. Dashboard Router owns filters plus optional `pageToken`, React Query fetches one page with `keepPreviousData`, and the table navigates with previous/next tokens.

**Tech Stack:** Bun SQLite, Drizzle ORM, Hono, Zod 4, TanStack Router, TanStack Query, TanStack Table, Rstest.

## Global Constraints

- Preserve unrelated user edits in `oxlint.config.ts`, `PageContainer`, `TracesFilters`, Accordion, prototypes, and existing untracked plans.
- The ordering contract is exactly `startedAt DESC, traceId DESC`.
- Tokens are opaque versioned Base64URL values and malformed tokens produce HTTP 400.
- The response contains `items`, optional `nextPageToken`, and optional `prevPageToken`; it does not contain `page`, `pageCount`, `pageSize`, or `total`.
- Omitting `pageToken` returns the latest page. Changing filters or `pageSize` removes `pageToken`.
- Use ordinary `useQuery`; do not use `useInfiniteQuery` or TanStack Table manual pagination.
- User-facing copy comes from `@aio-proxy/i18n`.
- Do not stage or commit files outside each task's explicit scope.

---

### Task 1: Core cursor codec and keyset query

**Files:**
- Modify: `packages/core/src/db/trace-store/types.ts`
- Modify: `packages/core/src/db/trace-store/trace-queries.ts`
- Modify: `packages/core/src/db/trace-store/trace-store.test.ts`
- Modify exports under `packages/core/src/db/` only if required by the existing public barrel pattern.

**Interfaces:**
- `TracesQuery` consumes `pageSize`, optional decoded cursor, and existing filters; it no longer consumes `page`.
- Core produces a page result containing `items`, optional next cursor, and optional previous cursor.
- Core exports narrowly scoped encode/decode functions if the server must translate opaque tokens at its validation boundary.

- [ ] **Step 1: Write failing traversal tests**

Add behavior tests with hand-authored rows proving latest-page order, next traversal, previous traversal, equal-timestamp Trace ID tie-breaking, terminal cursors, and stability after a newer row is inserted.

- [ ] **Step 2: Verify RED**

Run: `bun run --filter @aio-proxy/core test:unit -- src/db/trace-store/trace-store.test.ts`

Expected: failures because cursor inputs and token traversal do not exist.

- [ ] **Step 3: Implement codec and keyset predicates**

Use `limit(pageSize + 1)`. Older queries apply `(startedAt < boundary) OR (startedAt = boundary AND traceId < boundaryTraceId)` in descending order. Newer queries apply the inverse predicate in ascending order, take the nearest page, then reverse results for the response. Generate adjacent-page tokens from the first and last returned rows, omitting terminal directions.

- [ ] **Step 4: Verify GREEN**

Run the focused core test and require zero failures.

### Task 2: Server and shared response contract

**Files:**
- Modify: `packages/types/src/trace.ts`
- Modify: `packages/server/src/dashboard-routes/traces/traces.ts`
- Modify: `packages/server/src/dashboard-routes/traces/traces.test.ts`
- Update affected core/server test fixtures that construct the old `page` response.

**Interfaces:**
- Query accepts `pageSize` defaulting to 50 and optional `pageToken`.
- Response validates `{ items, nextPageToken?, prevPageToken? }`.

- [ ] **Step 1: Write failing API tests**

Cover a no-token latest request, following `nextPageToken`, returning with `prevPageToken`, terminal token omission, and malformed token HTTP 400. Assert literal response fields and absence of offset metadata.

- [ ] **Step 2: Verify RED**

Run: `bun run --filter server test:unit -- src/dashboard-routes/traces/traces.test.ts`

- [ ] **Step 3: Implement request validation and response mapping**

Remove `page`, decode `pageToken`, call the core keyset query, and encode returned cursors. Update the shared Zod response schema.

- [ ] **Step 4: Verify GREEN**

Run the focused server tests and affected type/core tests.

### Task 3: Dashboard URL search and service

**Files:**
- Modify: `packages/dashboard/src/modules/traces/lib/trace-search/trace-search.ts`
- Modify: `packages/dashboard/src/modules/traces/lib/trace-search/trace-search.test.ts`
- Modify: `packages/dashboard/src/routes/traces/index.tsx`
- Modify: `packages/dashboard/src/modules/traces/services/traces-service/traces-service.ts`
- Modify: `packages/dashboard/src/modules/traces/services/traces-service/traces-service.test.ts`

**Interfaces:**
- Validated search has `pageSize`, optional `pageToken`, optional date bounds, and existing filters; it has no `page`.
- `withTraceFilters` always removes `pageToken`.
- `tracesQueryOptions` uses `keepPreviousData`, includes the full search in its key, and polls only when `pageToken` is absent.

- [ ] **Step 1: Write failing URL and service tests**

Cover independent malformed-field fallback, optional token parsing, token removal on filter change, token forwarding to Hono, and polling disabled for token pages.

- [ ] **Step 2: Verify RED**

Run the Trace search and service tests.

- [ ] **Step 3: Implement TanStack Router and Query integration**

Use the Zod schema directly as `validateSearch`, strip only the default `pageSize`, remove mount-time canonicalization, and use functional navigation. Do not place response tokens inside filter helpers.

- [ ] **Step 4: Verify GREEN**

Run the focused dashboard tests.

### Task 4: Page-replacement table and realtime latest buffer

**Files:**
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.tsx`
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.test.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/traces-table/traces-table.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/traces-table/traces-table.test.tsx`
- Replace or remove: `packages/dashboard/src/modules/traces/components/trace-load-older-row/`
- Add/update i18n keys in `packages/i18n/messages/*.json` when previous/next or invalid-token copy is not already available.

**Interfaces:**
- `TracesTable` receives one page, token navigation callbacks, loading state, buffered-new count, and selection callback.
- Previous and next availability derive only from response tokens.

- [ ] **Step 1: Write failing interaction tests**

Cover previous/next controls, no numeric pagination state, placeholder page retention, latest-page-only polling, unseen latest response buffering, accepting the latest response as a full-page replacement, and token reset recovery.

- [ ] **Step 2: Verify RED**

Run the Trace page/table tests.

- [ ] **Step 3: Implement page replacement**

Remove `manualPagination`, `pageIndex`, `pageCount`, load-older accumulation, and offset comparisons. Keep the in-table new-Trace row only on the latest page. Use token navigation to replace the page.

- [ ] **Step 4: Verify GREEN**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces`

### Task 5: Repository verification

**Files:**
- No production files unless verification exposes an in-scope defect.

- [ ] **Step 1: Compile i18n if messages changed**

Run: `bun run i18n:compile`.

- [ ] **Step 2: Run static and format checks**

Run: `bun run lint:types` and `bun run format:check`.

- [ ] **Step 3: Run affected tests and build**

Run: `bun run --filter @aio-proxy/core test:unit`, `bun run --filter server test:unit`, `bun run --filter @aio-proxy/dashboard test:unit -- src/modules/traces`, and `bun run build:dashboard`.
