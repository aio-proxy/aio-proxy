import { describe, expect, test } from "@rstest/core";
import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import { useDataTable } from "@/hooks/use-data-table";
import { DataTableToolbar } from "./data-table-toolbar";

type Row = { readonly name: string };

const columns: readonly ColumnDef<Row>[] = [{ accessorKey: "name", header: "Name" }];
const data: readonly Row[] = [{ name: "row" }];
const columnLabel = (): string => "Name";

const ToolbarHarness = () => {
  const { table, columnVisibility } = useDataTable(data, columns);
  return (
    <DataTableToolbar
      table={table}
      columnVisibility={columnVisibility}
      filterId="table-filter"
      filterLabel="Filter"
      columnsLabel="Columns"
      columnLabel={columnLabel}
    />
  );
};

describe("data table toolbar", () => {
  test("exposes and refreshes checkbox state when stable props retain the table instance", async () => {
    render(<ToolbarHarness />);

    const trigger = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(trigger);
    const visibleItem = await screen.findByRole("menuitemcheckbox", { name: "Name", checked: true });
    expect(visibleItem).toHaveAttribute("aria-checked", "true");

    fireEvent.click(visibleItem);
    const hiddenItem = await screen.findByRole("menuitemcheckbox", { name: "Name", checked: false });
    expect(hiddenItem).toHaveAttribute("aria-checked", "false");
  });
});
