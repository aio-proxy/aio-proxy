# Provider Table Cell Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Provider column definitions the single source of body-cell sizing and alignment for both concrete and OAuth aggregate rows.

**Architecture:** TanStack column metadata will carry the body-cell class for every layout-constrained Provider column. Both row renderers will consume the same metadata through one small `ProviderTableCell` component, leaving each row responsible only for its content.

**Tech Stack:** React, TanStack Table, Tailwind CSS, Rstest, Testing Library.

## Global Constraints

- Keep the current Provider table behavior and visual layout unchanged.
- Do not alter the unrelated `packages/dashboard/src/components/data-table/table-head.tsx` working-tree change.
- Do not add dependencies or new public APIs.

---

### Task 1: Centralize Provider table body-cell layout

**Files:**
- Modify: `packages/dashboard/src/modules/providers/components/providers-table/providers-table.test.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/providers-table/providers-table.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/providers-table-columns.tsx`
- Modify: `packages/dashboard/src/modules/providers/components/oauth-provider-group-row/oauth-provider-group-row.tsx`

**Interfaces:**
- Consumes: TanStack `ColumnDef.meta.cellClassName` and each rendered `cell.column.columnDef.meta`.
- Produces: one shared Provider table cell wrapper used by concrete and OAuth aggregate row renderers.

- [ ] **Step 1: Write the failing regression test**

  In the existing OAuth aggregate-row test, locate the Weight, Enabled, and Actions header indexes, then assert the matching aggregate cells and an expanded account row carry the same layout classes. The initial assertion for the aggregate Weight cell should be:

  ```tsx
  expect(group.getAllByRole('cell')[weightColumnIndex]).toHaveClass('w-20', 'text-center');
  ```

- [ ] **Step 2: Run the focused test to verify it fails**

  Run:

  ```bash
  bun --filter @aio-proxy/dashboard test:unit -- providers-table
  ```

  Expected: the OAuth aggregate Weight cell does not have `w-20 text-center`.

- [ ] **Step 3: Implement the minimal shared layout path**

  Add `meta.cellClassName` to every constrained Provider column (`aggregate`, `type`, `models`, `weight`, `state`, `usage`, `enabled`, `actions`). Replace the concrete row's ID-based `cn(...)` list with a local `ProviderTableCell` that reads the metadata; have the OAuth aggregate row use that same component. Keep each row's existing content branches unchanged.

- [ ] **Step 4: Run focused verification**

  Run:

  ```bash
  bun --filter @aio-proxy/dashboard test:unit -- providers-table
  bun run format:check
  ```

  Expected: Provider table tests and formatting check pass.

- [ ] **Step 5: Run the UI detector and commit the scoped change**

  Run:

  ```bash
  node /Users/baran/.codex/plugins/cache/impeccable/impeccable/4.0.4/skills/impeccable/scripts/detect.mjs --json packages/dashboard/src/modules/providers/components/providers-table/providers-table.tsx packages/dashboard/src/modules/providers/components/providers-table-columns.tsx packages/dashboard/src/modules/providers/components/oauth-provider-group-row/oauth-provider-group-row.tsx
  ```

  Stage only the files above and this plan, then commit with `refactor(dashboard): unify provider table cell layout`.
