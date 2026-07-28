# Trace List Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show session identity, detailed token usage, and streaming TTFT in the trace list while simplifying translated table headers.

**Architecture:** Persist the existing request-stream flag and final-attempt TTFT on the root span, then project both into `DashboardTraceSummary`. Render them with existing Tooltip, TokenCount, and duration formatting primitives; no schema migration or child-span list query.

**Tech Stack:** TypeScript, Bun, OpenTelemetry spans, Drizzle SQLite, Zod, React, TanStack Table, shadcn/Base UI Tooltip, Rstest.

## Global Constraints

- Non-streaming requests do not render a TTFT line.
- Streaming requests with missing TTFT render muted `N/A`.
- Cache read and cache write remain distinct values.
- Do not add dependencies, database columns, migrations, or color tokens.
- Preserve unrelated worktree edits.

---

### Task 1: Root trace stream and TTFT summary

**Files:**
- Modify: `packages/types/src/trace.ts`
- Modify: `packages/server/src/request-tracing/request-trace-recorder/types.ts`
- Modify: `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.ts`
- Modify: `packages/server/src/request-tracing/request-trace-recorder/completion.ts`
- Modify: `packages/server/src/routes/pipeline/index.ts`
- Modify: `packages/server/src/routes/pipeline/attempt/emit.ts`
- Modify: `packages/core/src/db/trace-store/trace-queries.ts`
- Test: `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts`
- Test: `packages/core/src/db/trace-store/trace-store.test.ts`

**Interfaces:**
- Consumes: existing `attributeName.stream` and `attributeName.ttftMs` attributes.
- Produces: optional `DashboardTraceSummary.stream: boolean` and `DashboardTraceSummary.ttftMs: number`.

- [ ] **Step 1: Write failing recorder and store tests**

Add a recorder expectation that `identify({ ..., streamRequested: true })` plus `finish({ outcome: 'success', ttftMs: 42 })` stores both root attributes. Add a trace-store expectation that root attributes `{ 'aio_proxy.request.stream': true, 'aio_proxy.response.ttft_ms': 42 }` project to summary `{ stream: true, ttftMs: 42 }`.

- [ ] **Step 2: Run tests to verify RED**

Run: `bun test packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.test.ts packages/core/src/db/trace-store/trace-store.test.ts`

Expected: type/runtime assertions fail because finish/identity and summary do not expose stream/TTFT.

- [ ] **Step 3: Implement the minimal data flow**

Add optional `streamRequested` to identity input and optional `ttftMs` to the finish base. Set `aio_proxy.request.stream` during `identify`, set `aio_proxy.response.ttft_ms` during terminal completion, return TTFT from `settleSuccess`, pass stream intent from the parsed protocol request, and project finite boolean/number root attributes in `rowToSummary`.

- [ ] **Step 4: Run tests to verify GREEN**

Run the Step 2 command and require zero failures.

### Task 2: Trace list rendering and translations

**Files:**
- Modify: `packages/dashboard/src/modules/traces/components/traces-table.tsx`
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.test.tsx`
- Modify: `packages/dashboard/src/components/token-count/token-count.test.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Consumes: `DashboardTraceSummary.stream`, `ttftMs`, and existing usage token fields.
- Produces: Session ID tooltip, detailed token cell, and conditional TTFT row.

- [ ] **Step 1: Write failing UI expectations**

Update the trace fixture with input/output/cache read/cache write, `stream: true`, and `ttftMs: 42`. Assert Session ID is visible, source appears through tooltip interaction, token directions and cache values render, TTFT renders for the streaming row, and no TTFT appears for the non-streaming row. Update the TokenCount unavailable assertion to `N/A`.

- [ ] **Step 2: Run tests to verify RED**

Run: `cd packages/dashboard && bun run test:unit -- src/modules/traces/templates/traces-page/traces-page.test.tsx src/components/token-count/token-count.test.tsx`

Expected: trace-list expectations fail while the corrected TokenCount expectation passes.

- [ ] **Step 3: Implement minimal rendering**

Reuse the detail-page Tooltip pattern for Session ID. Render input/output on the first token line and cache read/write on the muted second line using `TokenCount`. Render duration plus a muted TTFT line only when `stream === true`. Change translated header values to remove “Final” / “最终”, and add only the short labels needed for TTFT and cache read/write inline display.

- [ ] **Step 4: Compile i18n and verify GREEN**

Run: `bun run i18n:compile`

Run the Step 2 test command and require zero failures.

### Task 3: Provider-only column and token empty state

**Files:**
- Modify: `packages/dashboard/src/modules/traces/components/traces-table.tsx`
- Modify: `packages/dashboard/src/modules/traces/templates/traces-page/traces-page.test.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Consumes: `DashboardTraceSummary.finalProviderId` and the four displayed usage fields: `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`.
- Produces: a provider-only column and one `—` token empty state when all four fields are absent.

- [ ] **Step 1: Write failing UI expectations**

Assert that the provider header is “Provider” / “提供商”, the final model is absent from the row, a row with token values still shows the detailed breakdown, and a row with all four displayed token values missing contains only `—` in its token cell.

- [ ] **Step 2: Run the focused dashboard test to verify RED**

Run: `cd packages/dashboard && bun run test:unit -- src/modules/traces/templates/traces-page/traces-page.test.tsx`

Expected: the provider/model and token empty-state assertions fail against the current two-line provider and four-`N/A` token cells. If Rstest is sandbox-blocked before execution by `listen EPERM`, record that environment limitation and continue with build/type verification.

- [ ] **Step 3: Implement the minimal rendering change**

Replace the provider/model cell with `finalProviderId ?? not_available`. Before rendering token details, check whether any of the four displayed fields is defined; when none are defined, return `not_available` directly. Replace the temporary `provider_model` translation key with `provider` in both locales.

- [ ] **Step 4: Compile i18n and verify GREEN**

Run: `bun run i18n:compile`

Run the Step 2 command and require zero failures when the environment permits Rstest to start.

### Task 4: Verification

**Files:**
- Verify all files above; do not modify generated route files.

- [ ] **Step 1: Run focused checks**

Run the affected core/server tests, dashboard tests, `bun run check`, and `bun run --filter @aio-proxy/dashboard build`.

- [ ] **Step 2: Inspect diff and working tree**

Confirm `packages/dashboard/src/styles.css` has no diff, no dependency/schema migration was added, and unrelated existing changes remain intact.

- [ ] **Step 3: Attempt commit only after verification**

Stage only this task’s files and commit with `Co-authored-by: Codex <noreply@openai.com>`. If the worktree git lock remains sandbox-blocked, report it without altering `.git` permissions.
