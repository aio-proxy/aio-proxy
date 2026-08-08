import { Button } from '@aio-proxy/ui/components/button';
import { TableHead as TableHeadRoot } from '@aio-proxy/ui/components/table';
import { cn } from '@aio-proxy/ui/lib/utils';
import type { SortDirection } from '@tanstack/react-table';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type React from 'react';

interface SortableTableColumn {
  readonly columnDef: { readonly meta?: { readonly className?: string } };
  readonly getCanSort: () => boolean;
  readonly getIsSorted: () => false | SortDirection;
  readonly getToggleSortingHandler: () => undefined | ((event: unknown) => void);
}

interface TableHeadProps {
  readonly className?: string;
  readonly column: SortableTableColumn;
  readonly label: string;
  readonly sortDirection: false | SortDirection;
}

const ariaSort = (sortDirection: false | SortDirection): 'ascending' | 'descending' | 'none' => {
  if (sortDirection === false) return 'none';
  return sortDirection === 'asc' ? 'ascending' : 'descending';
};

export const TableHead: React.FC<TableHeadProps> = ({ className, column, label, sortDirection }) => {
  const canSort = column.getCanSort();
  return (
    <TableHeadRoot
      {...(className === undefined ? {} : { className })}
      aria-sort={canSort ? ariaSort(sortDirection) : undefined}
    >
      {canSort ? (
        <Button
          className={cn('-mx-3', className?.includes('text-center') && 'justify-center')}
          variant="ghost"
          size="sm"
          onClick={column.getToggleSortingHandler()}
        >
          {label}
          {sortDirection === 'asc' ? <ArrowUp /> : (sortDirection === 'desc' ? <ArrowDown /> : null)}
        </Button>
      ) : (
        label
      )}
    </TableHeadRoot>
  );
};

export const tableHead =
  (label: () => string, className?: string) =>
  ({ column }: { readonly column: SortableTableColumn }) => (
    <TableHead
      className={className ?? column.columnDef.meta?.className}
      column={column}
      label={label()}
      sortDirection={column.getIsSorted()}
    />
  );
