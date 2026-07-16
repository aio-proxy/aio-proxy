import { describe, expect, rs, test } from "@rstest/core";
import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useDataTable } from "@/hooks/use-data-table";
import { DataTableToolbar } from "./data-table-toolbar";

type Row = { readonly name: string };

const columns: readonly ColumnDef<Row>[] = [{ accessorKey: "name", header: "Name" }];
const data: readonly Row[] = [{ name: "row" }];
const columnLabel = (): string => "Name";
let toolbarTable: ReturnType<typeof useDataTable<Row>>["table"];

const ToolbarHarness: React.FC = () => {
  const { table, columnVisibility } = useDataTable(data, columns);
  toolbarTable = table;
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
  test("passes the form-owned text filter to the table", () => {
    render(<ToolbarHarness />);
    const setGlobalFilter = rs.spyOn(toolbarTable, "setGlobalFilter");

    fireEvent.change(screen.getByRole("textbox", { name: "Filter" }), { target: { value: "row" } });

    expect(setGlobalFilter).toHaveBeenCalledWith("row");
  });

  test("exposes and refreshes checkbox state when stable props retain the table instance", async () => {
    render(<ToolbarHarness />);

    const trigger = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(trigger);
    const visibleItem = await screen.findByRole("menuitemcheckbox", { name: "Name", checked: true });
    expect(visibleItem).toHaveAttribute("aria-checked", "true");

    fireEvent.click(visibleItem);
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Name" })).toHaveAttribute("aria-checked", "false");
  });
});
