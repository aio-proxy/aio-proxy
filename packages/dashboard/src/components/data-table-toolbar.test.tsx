import { describe, expect, rs, test } from "@rstest/core";
import type { ColumnDef } from "@tanstack/react-table";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { useDataTable } from "@/hooks/use-data-table";
import { DataTableToolbar } from "./data-table-toolbar";

type Row = { readonly name: string };

const columns: readonly ColumnDef<Row>[] = [{ accessorKey: "name", header: "Name" }];
const data: readonly Row[] = [{ name: "row" }];
const columnLabel = (): string => "Name";
let toolbarTable: ReturnType<typeof useDataTable<Row>>["table"];

const ToolbarHarness: React.FC = () => {
  const { table, columnVisibilityForm } = useDataTable(data, columns);
  toolbarTable = table;
  return (
    <DataTableToolbar
      table={table}
      columnVisibilityForm={columnVisibilityForm}
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

  test("keeps table and checkbox visibility synchronized", async () => {
    render(<ToolbarHarness />);

    act(() => toolbarTable.getColumn("name")?.toggleVisibility(false));
    expect(toolbarTable.getColumn("name")?.getIsVisible()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    const hiddenItem = await screen.findByRole("menuitemcheckbox", { name: "Name" });
    expect(hiddenItem).toHaveAttribute("aria-checked", "false");

    const column = toolbarTable.getColumn("name");
    if (column === undefined) throw new Error("Expected name column");
    const toggleVisibility = rs.spyOn(column, "toggleVisibility");
    fireEvent.click(hiddenItem);
    expect(toggleVisibility).not.toHaveBeenCalled();
    expect(column.getIsVisible()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(await screen.findByRole("menuitemcheckbox", { name: "Name" })).toHaveAttribute("aria-checked", "true");
  });
});
