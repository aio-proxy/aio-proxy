import type React from "react";

import { ArrowDown, ArrowUp } from "lucide-react";

import { Button } from "@/components/ui/button";
import { TableHead } from "@/components/ui/table";

type Props = {
  readonly label: React.ReactNode;
  readonly canSort: boolean;
  readonly sortDirection: false | "asc" | "desc";
  readonly onToggleSorting?: React.MouseEventHandler<HTMLButtonElement>;
};

export const DataTableHeaderCell: React.FC<Props> = ({ label, canSort, sortDirection, onToggleSorting }) => (
  <TableHead
    aria-sort={
      canSort ? (sortDirection === "asc" ? "ascending" : sortDirection === "desc" ? "descending" : "none") : undefined
    }
  >
    {canSort ? (
      <Button variant="ghost" size="sm" onClick={onToggleSorting}>
        {label}
        {sortDirection === "asc" ? <ArrowUp /> : sortDirection === "desc" ? <ArrowDown /> : null}
      </Button>
    ) : (
      label
    )}
  </TableHead>
);
