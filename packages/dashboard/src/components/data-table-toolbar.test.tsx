import { describe, expect, test } from "@rstest/core";
import type { ColumnDef } from "@tanstack/react-table";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  test("refreshes visibility checkmarks when stable props retain the table instance", async () => {
    render(<ToolbarHarness />);

    const trigger = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(trigger);
    const visibleItem = await screen.findByRole("menuitem", { name: "Name" });
    expect(visibleItem.querySelector("svg")).not.toBeNull();

    fireEvent.click(visibleItem);
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Name" })).toBeNull());
    fireEvent.click(trigger);

    const hiddenItem = await screen.findByRole("menuitem", { name: "Name" });
    expect(hiddenItem.querySelector("svg")).toBeNull();
  });
});
