import { useForm } from "@tanstack/react-form";
import type React from "react";
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
  readonly toggleVisibility: (value?: boolean) => void;
};

type TableControls = {
  readonly getAllLeafColumns: () => readonly VisibilityColumn[];
  readonly setGlobalFilter: (value: string) => void;
};

type Props = {
  readonly table: TableControls;
  readonly columnVisibility: Readonly<Record<string, boolean>>;
  readonly filterId: string;
  readonly filterLabel: string;
  readonly columnsLabel: string;
  readonly columnLabel: (columnId: string) => string;
};

export const DataTableToolbar: React.FC<Props> = ({
  table,
  columnVisibility,
  filterId,
  filterLabel,
  columnsLabel,
  columnLabel,
}) => {
  const form = useForm({ defaultValues: { tableFilter: "" } });

  return (
    <div className="flex flex-wrap items-end justify-between gap-2">
      <form.Field name="tableFilter">
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
      </form.Field>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" />}>{columnsLabel}</DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {table.getAllLeafColumns().map((column) => (
            <DropdownMenuCheckboxItem
              key={column.id}
              checked={columnVisibility[column.id] !== false}
              onCheckedChange={(checked) => column.toggleVisibility(checked)}
            >
              {columnLabel(column.id)}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
