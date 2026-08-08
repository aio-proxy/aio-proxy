import { TableCell } from '@aio-proxy/ui/components/table';
import type { Row } from '@tanstack/react-table';
import type React from 'react';

import type { DataTableFeatures } from '@/hooks/use-data-table';

import type { ProviderTableRow } from './provider-table-row';

type ProviderTableCell = ReturnType<Row<DataTableFeatures, ProviderTableRow>['getAllCells']>[number];

interface ProviderTableCellProps {
  readonly cell: ProviderTableCell;
  readonly children: React.ReactNode;
}

export const ProviderTableCell: React.FC<ProviderTableCellProps> = ({ cell, children }) => (
  <TableCell className={cell.column.columnDef.meta?.cellClassName}>{children}</TableCell>
);
