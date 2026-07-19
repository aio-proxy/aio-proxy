import type React from "react";

import { useForm } from "@tanstack/react-form";

import type { ColumnVisibilityForm } from "@/hooks/use-data-table";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type VisibilityColumn = {
  readonly id: string;
};

type TableControls = {
  readonly getAllLeafColumns: () => readonly VisibilityColumn[];
  readonly setGlobalFilter: (value: string) => void;
};

type Props = {
  readonly table: TableControls;
  readonly columnVisibilityForm: ColumnVisibilityForm;
  readonly filterId: string;
  readonly filterLabel: string;
  readonly columnsLabel: string;
  readonly columnLabel: (columnId: string) => string;
};

export const DataTableToolbar: React.FC<Props> = ({
  table,
  columnVisibilityForm,
  filterId,
  filterLabel,
  columnsLabel,
  columnLabel,
}) => {
  const filterForm = useForm({ defaultValues: { tableFilter: "" } });

  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <filterForm.Field name="tableFilter">
        {(field) => (
          <Field className="max-w-xs">
            <FieldLabel htmlFor={filterId}>{filterLabel}</FieldLabel>
            <Input
              id={filterId}
              value={field.state.value}
              onChange={(event) => {
                field.handleChange(event.target.value);
                table.setGlobalFilter(event.target.value);
              }}
            />
          </Field>
        )}
      </filterForm.Field>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>{columnsLabel}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <columnVisibilityForm.Field name="columnVisibility">
            {(field) =>
              table.getAllLeafColumns().map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={field.state.value[column.id] !== false}
                  onCheckedChange={(checked) => field.handleChange({ ...field.state.value, [column.id]: checked })}
                >
                  {columnLabel(column.id)}
                </DropdownMenuCheckboxItem>
              ))
            }
          </columnVisibilityForm.Field>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
