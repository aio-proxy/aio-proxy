import { describe, expect, test } from "@rstest/core";
import { render, screen } from "@testing-library/react";
import { DataTableHeaderCell } from "./data-table-header-cell";

describe("data table header cell", () => {
  test("omits aria-sort for non-sortable headers and exposes sortable state", () => {
    const { rerender } = render(
      <table>
        <thead>
          <tr>
            <DataTableHeaderCell label="Actions" canSort={false} sortDirection={false} />
          </tr>
        </thead>
      </table>,
    );

    expect(screen.getByRole("columnheader", { name: "Actions" })).not.toHaveAttribute("aria-sort");

    rerender(
      <table>
        <thead>
          <tr>
            <DataTableHeaderCell label="Name" canSort={true} sortDirection={false} />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "none");

    rerender(
      <table>
        <thead>
          <tr>
            <DataTableHeaderCell label="Name" canSort={true} sortDirection="asc" />
          </tr>
        </thead>
      </table>,
    );
    expect(screen.getByRole("columnheader", { name: "Name" })).toHaveAttribute("aria-sort", "ascending");
  });
});
