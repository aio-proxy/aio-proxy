# Traces Observability Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Traces into the approved filter workbench and independent detail page without losing server pagination, safe diagnostics, keyboard access, or the existing trace query contract.

**Architecture:** Preserve the current URL-owned `TraceSearch` and server pagination. The list template owns the collapsible filter-rail and first-page new-trace buffer; table cells remain pure presenters. Detail adds one allowlisted diagnostics payload to the existing trace response, then composes an unbordered context rail with `详情 / 请求 / 响应` Tabs.

**Tech Stack:** Bun, TypeScript, Zod 4, Hono, React 19, TanStack Query/Router/Table/Form, shadcn Base UI, Rstest.

## Global Constraints

- Traces remain server-paginated: no client sorting, client page filtering, or column visibility controls.
- The list uses a complete start timestamp and a separate Trace ID; session exists only in Trace detail.
- The table shows model request status and final HTTP status separately; protocol is plain text, never a badge.
- The Duration cell contains duration and TTFT as aligned rows with a performance dot only when a value exists; fast requests use the compact marker in that cell.
- New Trace notice is one centered, fully clickable table row. Loading older traces replaces numbered pagination.
- Request/response diagnostics are allowlisted and redacted at capture time; never serialize credentials, authorization headers, cookies, prompt content, generated text, or arbitrary raw bodies.
- All natural-language UI copy is i18n; use shared UI primitives and preserve visible keyboard focus.

---

## File Map

- `packages/types/src/dashboard.ts`: diagnostics schema added to `DashboardTraceDetail`.
- `packages/server/src/request-tracing/semantic.ts` and trace persistence helpers: allowlisted diagnostic capture.
- `packages/server/src/dashboard-routes/traces/traces.ts`: response projection only.
- `packages/dashboard/src/modules/traces/components/`: filter rail, table cell presenters, buffered notice, detail rail, request/response diagnostic panel.
- `packages/dashboard/src/modules/traces/templates/{traces-page,trace-detail-page}/`: page-level assembly and responsive layout.

### Task 1: Add a safe diagnostics contract

**Files:**
- Modify: `packages/types/src/dashboard.ts`, `packages/server/src/request-tracing/semantic.ts`, `packages/server/src/dashboard-routes/traces/traces.ts`
- Test: `packages/server/src/dashboard-routes/traces/traces.test.ts`

**Interfaces:**
- Produces `DashboardTraceDiagnostics = { request?: { headers: Record<string, string>; body?: Record<string, unknown> }; response?: { headers: Record<string, string>; body?: Record<string, unknown> } }` with each optional section absent when unavailable.

- [ ] **Step 1: Write failing security tests.** Record an inbound request with `authorization`, `cookie`, an arbitrary prompt body, and allowed `content-type`/`user-agent` headers. Assert the detail response exposes only allowed headers and no prompt, response text, or secret value.
- [ ] **Step 2: Run the test and verify it fails.** Run: `cd packages/server && bun test src/dashboard-routes/traces/traces.test.ts`. Expected: FAIL because diagnostics are not projected.
- [ ] **Step 3: Implement a narrow allowlist.** Add `captureTraceDiagnostics` beside existing semantic capture; retain protocol, content type, request/response byte metadata, and explicitly approved non-sensitive scalar fields only. Store sanitized JSON in existing span attributes or a dedicated typed field; do not add a raw request log.
- [ ] **Step 4: Run the test and verify pass.** Run: `cd packages/server && bun test src/dashboard-routes/traces/traces.test.ts`.
- [ ] **Step 5: Commit.** `git add packages/types/src/dashboard.ts packages/server/src/request-tracing packages/server/src/dashboard-routes/traces && git commit -m "feat(traces): expose allowlisted request diagnostics"`

### Task 2: Build the collapsible filter workbench

**Files:**
- Create: `packages/dashboard/src/modules/traces/components/traces-filter-rail.tsx`, `traces-filter-rail.test.tsx`, `traces-search-bar.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/traces-filters.tsx`, `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.tsx`, `packages/dashboard/src/styles.css`

**Interfaces:**
- Consumes `TraceSearch`, `onSearchChange(next: TraceSearch)`, and `autoRefresh`.
- Produces `TracesFilterRail` with local `collapsed` state; when collapsed, `TracesSearchBar` owns the one `高级筛选` trigger.

- [ ] **Step 1: Write failing interaction tests.** Assert clicking “收起” removes the rail and shows one advanced-filter action inside the search bar; clicking it restores the rail; the action is absent while the rail is open; a narrow viewport exposes the rail through its header rather than duplicating controls.
- [ ] **Step 2: Run and verify failure.** Run: `cd packages/dashboard && bun test src/modules/traces/components/traces-filter-rail.test.tsx`.
- [ ] **Step 3: Compose, do not duplicate, filter fields.** Move existing `TracesFilters` fields under `TracesFilterRail`; preserve `TraceSearch` URL ownership and reset pagination to page 1 through its existing parser/update path. Use CSS grid for desktop rail/results and one narrow-layout header disclosure.
- [ ] **Step 4: Run tests and build.** Run: `cd packages/dashboard && bun test src/modules/traces/components/traces-filter-rail.test.tsx src/modules/traces/templates/traces-page/traces-page.test.tsx && bun run build`.
- [ ] **Step 5: Commit.** `git add packages/dashboard/src/modules/traces packages/dashboard/src/styles.css && git commit -m "feat(dashboard): add trace filter workbench"`

### Task 3: Redesign the server-paginated Trace table

**Files:**
- Create: `packages/dashboard/src/modules/traces/components/{trace-latency-cell,trace-token-cell,trace-new-items-row,trace-load-older-row}.tsx` and colocated tests
- Modify: `packages/dashboard/src/modules/traces/components/traces-table.tsx`, `traces-table.test.tsx`, `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.tsx`

**Interfaces:**
- Consumes `DashboardTraceSummary` and `TraceSearch`.
- Produces columns `[startedAt, traceId, requestStatus, inboundProtocol, requestedModel, finalProviderId, finalHttpStatus, latency, tokens, cost]` plus `onLoadOlder()`.

- [ ] **Step 1: Write failing table tests.** Assert complete `startedAt` precedes Trace ID; no Session column; requested/final model render as two lines only when different; protocol has no Badge; `TraceNewItemsRow` is a single button spanning all columns; and `TraceLoadOlderRow` increments `search.page`.
- [ ] **Step 2: Run and verify failure.** Run: `cd packages/dashboard && bun test src/modules/traces/components/traces-table.test.tsx`.
- [ ] **Step 3: Implement table presenters.** Keep TanStack Table with `manualPagination`; replace `DataTablePagination` with the centered older-row action. On a five-second first-page refresh, compare IDs against the currently rendered first-page IDs, buffer unseen entries, and merge only when the user clicks the row. Never buffer while viewing page two or later.
- [ ] **Step 4: Run tests and verify pass.** Run: `cd packages/dashboard && bun test src/modules/traces/components/traces-table.test.tsx src/modules/traces/templates/traces-page/traces-page.test.tsx`.
- [ ] **Step 5: Commit.** `git add packages/dashboard/src/modules/traces && git commit -m "feat(dashboard): redesign trace list table"`

### Task 4: Recompose Trace detail into a context rail and tabs

**Files:**
- Create: `packages/dashboard/src/modules/traces/components/{trace-context-rail,trace-detail-tabs,trace-http-diagnostics}.tsx` and colocated tests
- Modify: `packages/dashboard/src/modules/traces/components/trace-summary.tsx`, `packages/dashboard/src/modules/traces/templates/trace-detail-page/trace-detail-page.tsx`, `trace-detail-page.test.tsx`, `packages/dashboard/src/components/page-container/page-container.tsx`

**Interfaces:**
- Consumes `DashboardTraceDetail` and `DashboardTraceDiagnostics` from Task 1.
- Produces a header breadcrumb `观测 / Traces`, header Trace ID/status/copy action, left `TraceContextRail`, and right `TraceDetailTabs` whose values are `detail | request | response`.

- [ ] **Step 1: Write failing tests.** Assert the trace header has no extra return button; the rail contains Trace ID, Request ID, Session ID, start/end, routing, result, and usage; `detail` initially renders waterfall plus selected span detail; request and response tabs show Headers and Body, or a precise unavailable state.
- [ ] **Step 2: Run and verify failure.** Run: `cd packages/dashboard && bun test src/modules/traces/templates/trace-detail-page/trace-detail-page.test.tsx`.
- [ ] **Step 3: Implement desktop/touch layout.** Keep `SpanWaterfall` and `SpanDetailPanel` in Detail. Put all identifiers/routing into the unbordered rail; collapse it above Tabs below the large breakpoint. Use a copy button in PageContainer extra; link the `Traces` breadcrumb to `/traces`.
- [ ] **Step 4: Run focused tests and responsive build.** Run: `cd packages/dashboard && bun test src/modules/traces/templates/trace-detail-page src/modules/traces/components && bun run build`.
- [ ] **Step 5: Commit.** `git add packages/dashboard/src/modules/traces packages/dashboard/src/components/page-container && git commit -m "feat(dashboard): redesign trace detail"`

### Task 5: Localize and verify the observability flow

**Files:**
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Create: `.changeset/dashboard-traces-redesign.md`

- [ ] **Step 1: Add exact messages.** Include filter expand/collapse, load older traces, buffered trace count, fast latency, diagnostics unavailable, Request, Response, and Detail tab labels.
- [ ] **Step 2: Compile i18n and run all Traces tests.** Run: `bun run i18n:compile && cd packages/dashboard && bun test src/modules/traces`.
- [ ] **Step 3: Add the changeset.** Target `aio-proxy`, `@aio-proxy/types`, and `@aio-proxy/server` at `minor`; describe safe diagnostic inspection and the observability redesign.
- [ ] **Step 4: Run full verification.** Run: `bun run preflight && bun run build:dashboard`.
- [ ] **Step 5: Commit.** `git add packages/i18n .changeset && git commit -m "docs: release trace observability redesign"`

## Self-Review Notes

- The new diagnostics contract is explicitly sanitised before persistence, so visual inspection cannot turn the dashboard into a secret or prompt viewer.
- Filtering and loading preserve the server as the source of truth; the new-trace buffer is only a client presentation affordance for page one.

## Review Amendments

The following corrections supersede earlier references in this plan.

- The diagnostics contract belongs in packages/types/src/trace.ts, not dashboard.ts. Task 1 also changes RequestTraceRecorder begin/finish inputs, request-tracing semantic capture, and pipeline attempt raw/model call sites. The implementation defines whether each field is inbound client-facing or final upstream-facing before capture.
- Diagnostics contain named allowlisted scalar fields only; they never expose arbitrary body records. Capture-boundary tests inspect persisted completion/store data before route projection and explicitly reject authorization, API-key variants, cookie/set-cookie, prompt content, and generated content.
- Page-one buffering keeps a frozen snapshot while the notice is visible. On acceptance it replaces that snapshot with the latest server page; it never concatenates lists under offset pagination. Tests cover repeated polls, running-to-completed same-ID updates, filter resets, page-size changes, and page two behavior.
- The older-trace row receives pageCount, page, isFetching, and isPlaceholderData. It is hidden on the last page and disabled during a transition, so repeated clicks cannot skip pages. The DOM is TableRow > TableCell colSpan={columnCount} > full-width Button.
- The shared Breadcrumb is added through packages/ui before the detail task. PageContainer receives a breadcrumb contract and test; i18n messages for observability, copy/copy-result, tabs, filters, latency, and diagnostics are authored and compiled before affected components build.
- The rail/search wrapper owns collapsed state and continues to pass autoRefresh, onAutoRefresh, refreshing, and onRefresh to the existing filters. Its test includes keyboard focus transfer when the active control unmounts.
- New trace components follow same-name directory layout. Dashboard focused tests use bun run --filter @aio-proxy/dashboard test:unit -- <path>; server tests use their package script with required preload/dependency build.
- The changeset is created with bun changeset and contains aio-proxy plus every changed internal package: types, core when diagnostics persistence changes, server, dashboard, i18n, and ui when Breadcrumb is added.
