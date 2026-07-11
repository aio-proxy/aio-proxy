# Data Table Pagination Design

## Goal

Provide one reusable dashboard pagination component that adapts a TanStack Table instance to the existing shadcn pagination primitives. Replace the providers page's one-off previous/next controls with complete numbered pagination.

## Public API

Add a generic component with a deliberately small interface:

```tsx
<DataTablePagination table={table} />
```

The only required prop is `table: Table<TData>`. TanStack Table remains the source of truth for the current page, page count, and navigation actions. The component owns no pagination state.

The component lives at `packages/dashboard/src/components/data-table-pagination/data-table-pagination.tsx` because it is reusable across dashboard modules rather than specific to providers.

## Rendering and Behavior

The component composes the existing shadcn `Pagination`, `PaginationContent`, `PaginationItem`, and `PaginationEllipsis` primitives.

Controls use real buttons because pagination changes local table state rather than navigating to another URL. The shadcn link-based primitives remain unchanged.

The adapter reads and invokes these TanStack Table APIs:

- `table.getState().pagination.pageIndex`
- `table.getPageCount()`
- `table.getPageOptions()`
- `table.getCanPreviousPage()` and `table.getCanNextPage()`
- `table.previousPage()` and `table.nextPage()`
- `table.setPageIndex(index)`

The current page is visually active and exposes `aria-current="page"`. Previous and next controls use native disabled behavior. All labels and ARIA text come from the dashboard i18n messages.

## Page Window

When every page fits, render every page number. For larger page counts, render the first and last pages, the current page and its immediate neighbors, and ellipses for omitted ranges. Example:

```text
1 … 4 5 6 … 20
```

Near either edge, expand the visible range so the control does not produce isolated or redundant ellipses. Page values are represented internally as zero-based TanStack page indexes and displayed as one-based labels.

## Providers Integration

Replace the providers page's pagination summary and one-off buttons with `DataTablePagination`. The existing `useProvidersTable` hook and its pagination row model remain unchanged.

No HOC, new context, or duplicated pagination state is introduced.

## Testing and Verification

Develop the page-window behavior test-first with focused cases for:

- a small page count with no ellipsis;
- a middle page with ellipses on both sides;
- pages near the beginning and end;
- a single page.

Then verify the dashboard unit tests and production build. The build supplies the TypeScript and JSX integration check for the generic component and providers-page usage.

## Non-goals

- Server-side pagination orchestration
- Page-size selection
- URL-synchronized pagination
- First/last navigation buttons
- Modifying the existing shadcn pagination primitives
