import { m } from "@aio-proxy/i18n";
import type { Table } from "@tanstack/react-table";
import type React from "react";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { getPaginationItems } from "./pagination-items";

type PaginationTable = Pick<
  Table<unknown>,
  "getState" | "getPageOptions" | "getCanPreviousPage" | "getCanNextPage" | "previousPage" | "nextPage" | "setPageIndex"
>;

interface DataTablePaginationProps {
  table: PaginationTable;
}

export const DataTablePagination: React.FC<DataTablePaginationProps> = ({ table }) => {
  const pageIndex = table.getState().pagination.pageIndex;
  const items = getPaginationItems(table.getPageOptions(), pageIndex);
  const previousLabel = m["dashboard.pagination.previous"]();
  const nextLabel = m["dashboard.pagination.next"]();
  const canPreviousPage = table.getCanPreviousPage();
  const canNextPage = table.getCanNextPage();

  return (
    <Pagination className="mx-0 w-auto justify-end">
      <PaginationContent>
        <PaginationItem>
          <PaginationPrevious
            href="#"
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
            <PaginationItem
              // biome-ignore lint/suspicious/noArrayIndexKey: ellipses are stateless separators
              key={`ellipsis-${index}`}
            >
              <PaginationEllipsis />
            </PaginationItem>
          ) : (
            <PaginationItem key={item}>
              <PaginationLink
                href="#"
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
            href="#"
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
