import type { Table } from "@tanstack/react-table";
import type React from "react";

import { m } from "@aio-proxy/i18n";
import { useForm } from "@tanstack/react-form";

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { getPaginationItems } from "./pagination-items";

type PaginationTable = Pick<
  Table<unknown>,
  | "getState"
  | "getPageOptions"
  | "getCanPreviousPage"
  | "getCanNextPage"
  | "previousPage"
  | "nextPage"
  | "setPageIndex"
  | "setPageSize"
>;

interface DataTablePaginationProps {
  table: PaginationTable;
  pageSizeOptions?: readonly number[];
}

export const DataTablePagination: React.FC<DataTablePaginationProps> = ({ table, pageSizeOptions }) => {
  "use no memo";

  // TanStack exposes changing state through a stable mutable table instance.
  const { pageIndex, pageSize } = table.getState().pagination;
  const form = useForm({ defaultValues: { pageSize } });
  const items = getPaginationItems(table.getPageOptions(), pageIndex);
  const previousLabel = m["dashboard.pagination.previous"]();
  const nextLabel = m["dashboard.pagination.next"]();
  const canPreviousPage = table.getCanPreviousPage();
  const canNextPage = table.getCanNextPage();

  return (
    <Pagination className="mx-0 w-auto flex-wrap justify-end gap-2">
      {pageSizeOptions && (
        <form.Field name="pageSize">
          {(field) => (
            <Select
              value={String(pageSize)}
              onValueChange={(value) => {
                if (value === null) return;
                const next = Number(value);
                field.handleChange(next);
                table.setPageSize(next);
              }}
            >
              <SelectTrigger aria-label={m["dashboard.pagination.page_size"]()} className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {pageSizeOptions.map((size) => (
                  <SelectItem key={size} value={String(size)}>
                    {size}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </form.Field>
      )}
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            text={previousLabel}
            aria-label={previousLabel}
            aria-disabled={!canPreviousPage || undefined}
            tabIndex={canPreviousPage ? undefined : -1}
            disabled={!canPreviousPage}
            onClick={(event) => {
              event.preventDefault();
              if (canPreviousPage) table.previousPage();
            }}
          />
        </PaginationItem>

        {items.map((item, index) =>
          item === "ellipsis" ? (
            <PaginationItem key={`ellipsis-${index}`}>
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={item}>
              <PaginationLink
                isActive={item === pageIndex}
                aria-label={m["dashboard.pagination.go_to_page"]({ page: item + 1 })}
                onClick={(event) => {
                  event.preventDefault();
                  table.setPageIndex(item);
                }}
              >
                {item + 1}
              </PaginationLink>
            </PaginationItem>
          ),
        )}

        <PaginationItem>
          <PaginationNext
            text={nextLabel}
            aria-label={nextLabel}
            aria-disabled={!canNextPage || undefined}
            disabled={!canNextPage}
            tabIndex={canNextPage ? undefined : -1}
            onClick={(event) => {
              event.preventDefault();
              if (canNextPage) table.nextPage();
            }}
          />
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
};
