import { Button } from '@aio-proxy/ui/components/button';
import { TableHead } from '@aio-proxy/ui/components/table';
import type { SortDirection } from '@tanstack/react-table';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type React from 'react';

interface SortableTableColumn {
  readonly getCanSort: () => boolean;
  readonly getIsSorted: () => false | SortDirection;
  readonly getToggleSortingHandler: () => undefined | ((event: unknown) => void);
}

interface SortableTableHeadProps {
  readonly column: SortableTableColumn;
  readonly label: string;
  readonly sortDirection: false | SortDirection;
}

export const SortableTableHead: React.FC<SortableTableHeadProps> = ({ column, label, sortDirection }) => {
  const canSort = column.getCanSort();
  return (
    <TableHead
      aria-sort={
        canSort ? (sortDirection === false ? 'none' : sortDirection === 'asc' ? 'ascending' : 'descending') : undefined
      }
    >
      {canSort ? (
        <Button variant="ghost" size="sm" onClick={column.getToggleSortingHandler()}>
          {label}
          {sortDirection === 'asc' ? <ArrowUp /> : sortDirection === 'desc' ? <ArrowDown /> : null}
        </Button>
      ) : (
        label
      )}
    </TableHead>
  );
};

export const sortableTableHeader =
  (label: () => string) =>
  ({ column }: { readonly column: SortableTableColumn }) => (
    <SortableTableHead column={column} label={label()} sortDirection={column.getIsSorted()} />
  );
