import { Button } from '@aio-proxy/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@aio-proxy/ui/components/dropdown-menu';
import { Input } from '@aio-proxy/ui/components/input';
import { useForm } from '@tanstack/react-form';
import type React from 'react';

interface DataTableColumn {
  readonly id: string;
  readonly columnDef: { readonly meta?: { readonly label?: () => string } };
  readonly getCanHide: () => boolean;
  readonly getIsVisible: () => boolean;
  readonly toggleVisibility: (value?: boolean) => void;
}

interface DataTableControlsProps {
  readonly table: {
    readonly getAllLeafColumns: () => readonly DataTableColumn[];
    readonly setGlobalFilter: (value: string) => void;
  };
  readonly filterLabel: string;
  readonly filterPlaceholder: string;
  readonly columnsLabel: string;
}

export const DataTableControls: React.FC<DataTableControlsProps> = ({
  table,
  filterLabel,
  filterPlaceholder,
  columnsLabel,
}) => {
  const form = useForm({ defaultValues: { globalFilter: '' } });
  const columns = table
    .getAllLeafColumns()
    .filter((column) => column.getCanHide() && column.columnDef.meta?.label !== undefined);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form.Field name="globalFilter">
        {(field) => (
          <Input
            className="w-full sm:w-64"
            aria-label={filterLabel}
            placeholder={filterPlaceholder}
            value={field.state.value}
            onChange={(event) => {
              field.handleChange(event.target.value);
              table.setGlobalFilter(event.target.value);
            }}
          />
        )}
      </form.Field>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>{columnsLabel}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {columns.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={column.getIsVisible()}
              onCheckedChange={(visible) => column.toggleVisibility(visible)}
            >
              {column.columnDef.meta?.label?.()}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
