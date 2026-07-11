import { m } from "@aio-proxy/i18n";
import type { Table } from "@tanstack/react-table";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem } from "@/components/ui/pagination";
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
            <PaginationItem
              // biome-ignore lint/suspicious/noArrayIndexKey: ellipses are stateless separators
              key={`ellipsis-${index}`}
            >
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
