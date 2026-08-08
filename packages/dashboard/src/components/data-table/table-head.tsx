import { Button } from '@aio-proxy/ui/components/button';
import { TableHead as TableHeadRoot } from '@aio-proxy/ui/components/table';
import { cn } from '@aio-proxy/ui/lib/utils';
import type { SortDirection } from '@tanstack/react-table';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type React from 'react';

interface SortableTableColumn {
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

export const TableHead: React.FC<TableHeadProps> = ({ className, column, label, sortDirection }) => {
  const canSort = column.getCanSort();
  return (
    <TableHeadRoot
      {...(className === undefined ? {} : { className })}
      aria-sort={
        canSort ? (sortDirection === false ? 'none' : sortDirection === 'asc' ? 'ascending' : 'descending') : undefined
      }
    >
      {canSort ? (
        <Button
          className={cn('-mx-3', className === 'text-center' && 'justify-center')}
          variant="ghost"
          size="sm"
          onClick={column.getToggleSortingHandler()}
        >
          {label}
          {sortDirection === 'asc' ? <ArrowUp /> : sortDirection === 'desc' ? <ArrowDown /> : null}
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
      {...(className === undefined ? {} : { className })}
      column={column}
      label={label()}
      sortDirection={column.getIsSorted()}
    />
  );
