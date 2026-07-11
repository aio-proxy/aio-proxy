# Data Table Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a reusable numbered pagination component that adapts a TanStack Table instance to the dashboard's shadcn pagination UI and use it on the providers page.

**Architecture:** Keep TanStack Table as the sole owner of pagination state. A pure helper computes the compact page-number window, while a generic `DataTablePagination<TData>` component maps the table instance APIs to shadcn pagination structure and native buttons.

**Tech Stack:** React 19, TypeScript, TanStack Table 8, shadcn/ui, Base UI Button, Bun test, Paraglide i18n

## Global Constraints

- The component accepts only `table: Table<TData>` and owns no pagination state.
- Use the existing shadcn pagination primitives without modifying `src/components/ui/pagination.tsx`.
- Pagination controls that mutate client state must render as native buttons, not links.
- All new visible and accessible copy must come from `@aio-proxy/i18n`.
- Do not add dependencies, context, a HOC, page-size selection, URL synchronization, or first/last buttons.

---

### Task 1: Compact Page Window

**Files:**
- Create: `packages/dashboard/src/components/data-table-pagination/pagination-items.ts`
- Test: `packages/dashboard/_test/data-table-pagination.test.ts`

**Interfaces:**
- Consumes: zero-based values returned by `table.getPageOptions()` and `table.getState().pagination.pageIndex`
- Produces: `getPaginationItems(pageOptions: readonly number[], pageIndex: number): PaginationItem[]`
- Produces: `type PaginationItem = number | "ellipsis"`

- [ ] **Step 1: Write the failing page-window test**

```ts
import { describe, expect, test } from "bun:test";
import { getPaginationItems } from "../src/components/data-table-pagination/pagination-items";

describe("data table pagination", () => {
  test("shows every page when the page count fits", () => {
    expect(getPaginationItems([0, 1, 2, 3, 4], 2)).toEqual([0, 1, 2, 3, 4]);
  });

  test("shows the current page and its neighbors between ellipses", () => {
    expect(getPaginationItems(Array.from({ length: 10 }, (_, index) => index), 5)).toEqual([
      0,
      "ellipsis",
      4,
      5,
      6,
      "ellipsis",
      9,
    ]);
  });

  test("expands the window near the beginning", () => {
    expect(getPaginationItems(Array.from({ length: 10 }, (_, index) => index), 1)).toEqual([
      0,
      1,
      2,
      3,
      4,
      "ellipsis",
      9,
    ]);
  });

  test("expands the window near the end", () => {
    expect(getPaginationItems(Array.from({ length: 10 }, (_, index) => index), 8)).toEqual([
      0,
      "ellipsis",
      5,
      6,
      7,
      8,
      9,
    ]);
  });

  test("supports a single page", () => {
    expect(getPaginationItems([0], 0)).toEqual([0]);
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
rtk bun test packages/dashboard/_test/data-table-pagination.test.ts
```

Expected: FAIL because `pagination-items.ts` does not exist.

- [ ] **Step 3: Implement the minimal page-window helper**

```ts
export type PaginationItem = number | "ellipsis";

export function getPaginationItems(pageOptions: readonly number[], pageIndex: number): PaginationItem[] {
  if (pageOptions.length <= 7) return [...pageOptions];

  const lastPage = pageOptions.at(-1);
  if (lastPage === undefined) return [];

  if (pageIndex <= 3) return [...pageOptions.slice(0, 5), "ellipsis", lastPage];
  if (pageIndex >= lastPage - 3) return [pageOptions[0]!, "ellipsis", ...pageOptions.slice(-5)];

  return [pageOptions[0]!, "ellipsis", pageIndex - 1, pageIndex, pageIndex + 1, "ellipsis", lastPage];
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
rtk bun test packages/dashboard/_test/data-table-pagination.test.ts
```

Expected: 5 tests pass and 0 fail.

- [ ] **Step 5: Commit the tested helper**

```bash
git add packages/dashboard/_test/data-table-pagination.test.ts packages/dashboard/src/components/data-table-pagination/pagination-items.ts
git commit -m "feat(dashboard): add pagination page window"
```

Append `Co-authored-by: Codex <noreply@openai.com>` to the commit message footer.

---

### Task 2: TanStack Table Pagination Adapter

**Files:**
- Create: `packages/dashboard/src/components/data-table-pagination/data-table-pagination.tsx`
- Create: `packages/dashboard/src/components/data-table-pagination/index.tsx`
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`
- Regenerate ignored Paraglide output under `packages/i18n/src/paraglide/` through the i18n package build
- Modify: `packages/dashboard/src/modules/providers/templates/providers-page.tsx:9-128`

**Interfaces:**
- Consumes: `getPaginationItems(pageOptions, pageIndex)` from Task 1
- Consumes: `Table<TData>` from `@tanstack/react-table`
- Produces: `DataTablePagination<TData>({ table }: { table: Table<TData> })`
- Produces: barrel export from `@/components/data-table-pagination`

- [ ] **Step 1: Add shared translated pagination labels**

Add under the existing `dashboard` object in `packages/i18n/messages/en.json`:

```json
"pagination": {
  "previous": "Previous",
  "next": "Next",
  "go_to_page": "Go to page {page}"
}
```

Add the matching section in `packages/i18n/messages/zh-Hans.json`:

```json
"pagination": {
  "previous": "上一页",
  "next": "下一页",
  "go_to_page": "前往第 {page} 页"
}
```

Remove the now-unused provider-specific `pagination_previous`, `pagination_next`, and `pagination_summary` keys from both locale files.

- [ ] **Step 2: Compile the i18n messages**

Run:

```bash
rtk bun run --filter @aio-proxy/i18n build
```

Expected: Paraglide compilation exits 0 and exposes `m["dashboard.pagination.previous"]`, `m["dashboard.pagination.next"]`, and `m["dashboard.pagination.go_to_page"]`.

- [ ] **Step 3: Create the generic adapter component**

Create `packages/dashboard/src/components/data-table-pagination/data-table-pagination.tsx`:

```tsx
import { m } from "@aio-proxy/i18n";
import type { Table } from "@tanstack/react-table";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
} from "@/components/ui/pagination";
import { getPaginationItems } from "./pagination-items";

interface DataTablePaginationProps<TData> {
  table: Table<TData>;
}

export function DataTablePagination<TData>({ table }: DataTablePaginationProps<TData>) {
  const pageIndex = table.getState().pagination.pageIndex;
  const items = getPaginationItems(table.getPageOptions(), pageIndex);
  const previousLabel = m["dashboard.pagination.previous"]();
  const nextLabel = m["dashboard.pagination.next"]();

  return (
    <Pagination className="mx-0 w-auto justify-end">
      <PaginationContent>
        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            size="default"
            aria-label={previousLabel}
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeftIcon data-icon="inline-start" />
            <span className="hidden sm:block">{previousLabel}</span>
          </Button>
        </PaginationItem>

        {items.map((item, index) =>
          item === "ellipsis" ? (
            <PaginationItem key={`ellipsis-${index}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={item}>
              <Button
                type="button"
                variant={item === pageIndex ? "outline" : "ghost"}
                size="icon"
                aria-current={item === pageIndex ? "page" : undefined}
                aria-label={m["dashboard.pagination.go_to_page"]({ page: item + 1 })}
                onClick={() => table.setPageIndex(item)}
              >
                {item + 1}
              </Button>
            </PaginationItem>
          ),
        )}

        <PaginationItem>
          <Button
            type="button"
            variant="ghost"
            size="default"
            aria-label={nextLabel}
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <span className="hidden sm:block">{nextLabel}</span>
            <ChevronRightIcon data-icon="inline-end" />
          </Button>
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
```

- [ ] **Step 4: Add the component barrel export**

Create `packages/dashboard/src/components/data-table-pagination/index.tsx`:

```ts
export { DataTablePagination } from "./data-table-pagination";
```

- [ ] **Step 5: Replace the providers page's one-off pagination**

Import the adapter:

```tsx
import { DataTablePagination } from "@/components/data-table-pagination";
```

Remove the `Button` import only if no other provider-page control uses it; the New Provider trigger still uses `Button`, so retain it. Replace the summary and previous/next block with:

```tsx
<DataTablePagination table={table} />
```

- [ ] **Step 6: Run the focused and package tests**

Run:

```bash
rtk bun test packages/dashboard/_test/data-table-pagination.test.ts
rtk bun run --filter @aio-proxy/dashboard test:unit
```

Expected: all dashboard tests pass with 0 failures.

- [ ] **Step 7: Run the production build**

Run:

```bash
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: TypeScript and Rsbuild complete with exit code 0.

- [ ] **Step 8: Check formatting and the final diff**

Run:

```bash
rtk bun run check
rtk git diff --check
rtk git diff --stat
```

Expected: checks exit 0, no whitespace errors, and the diff is limited to the pagination component, test, providers page, and i18n outputs.

- [ ] **Step 9: Commit the adapter and integration**

```bash
git add packages/dashboard/src/components/data-table-pagination packages/dashboard/src/modules/providers/templates/providers-page.tsx packages/i18n/messages
git commit -m "feat(dashboard): reuse table pagination component"
```

Append `Co-authored-by: Codex <noreply@openai.com>` to the commit message footer.
