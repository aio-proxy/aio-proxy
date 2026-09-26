import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import type React from 'react';
import { Fragment, useMemo } from 'react';

import { DataTableControls } from '@/components/data-table/data-table-controls';
import { Pagination } from '@/components/data-table/pagination';
import { useDataTable } from '@/hooks/use-data-table';

import { modelRisks } from '../lib/routing-risk';
import { labOf } from '../lib/routing-rows';
import type { RoutingTrafficIndex } from '../lib/routing-traffic';
import { RoutingLabGroupRow } from './routing-lab-group-row';
import { createRoutingColumns } from './routing-table-columns';

interface RoutingTableProps {
  readonly models: readonly DashboardRoutingModel[];
  readonly traffic?: RoutingTrafficIndex | undefined;
  readonly onEdit: (model: DashboardRoutingModel) => void;
}

export const RoutingTable: React.FC<RoutingTableProps> = ({ models, onEdit, traffic = undefined }) => {
  'use no memo';

  const columns = useMemo(() => createRoutingColumns({ onEdit, traffic }), [onEdit, traffic]);
  const { table } = useDataTable(models, columns, { getRowId: (model) => model.modelId });

  const labStats = useMemo(() => {
    const stats = new Map<string, { modelCount: number; riskCount: number }>();
    for (const model of models) {
      const lab = labOf(model);
      const current = stats.get(lab) ?? { modelCount: 0, riskCount: 0 };
      current.modelCount += 1;
      if (modelRisks(model, traffic?.get(model.modelId)).length > 0) {
        current.riskCount += 1;
      }
      stats.set(lab, current);
    }
    return stats;
  }, [models, traffic]);

  if (models.length === 0) return <Empty>{m['dashboard.routing.empty']()}</Empty>;

  const showLabGroups = table.state.sorting.length === 0;
  const columnCount = table.getVisibleLeafColumns().length;

  return (
    <div className="flex flex-col gap-4">
      <DataTableControls
        table={table}
        filterLabel={m['dashboard.routing.table.filter']()}
        filterPlaceholder={m['dashboard.routing.table.filter_placeholder']()}
        columnsLabel={m['dashboard.routing.table.columns']()}
      />
      <div className="overflow-x-auto">
        <Table aria-label={m['dashboard.routing.table.label']()} data-testid="routing-table">
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <Fragment key={header.id}>
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </Fragment>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.flatMap((row, rowIndex, rowModel) => {
              const lab = labOf(row.original);
              const previousLab = rowIndex > 0 ? labOf(rowModel[rowIndex - 1].original) : undefined;
              const groupRow =
                showLabGroups && lab !== previousLab
                  ? [
                      <RoutingLabGroupRow
                        key={`lab-${lab}-${row.id}`}
                        lab={lab}
                        modelCount={labStats.get(lab)?.modelCount ?? 0}
                        riskCount={labStats.get(lab)?.riskCount ?? 0}
                        columnCount={columnCount}
                      />,
                    ]
                  : [];
              return [
                ...groupRow,
                <TableRow key={row.id} data-testid={`routing-row-${row.original.modelId}`}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cell.column.id === 'actions' ? 'text-right' : undefined}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>,
              ];
            })}
          </TableBody>
        </Table>
      </div>
      {table.getPageCount() > 1 ? (
        <Pagination
          pageSize={table.state.pagination.pageSize}
          canPrevious={table.getCanPreviousPage()}
          canNext={table.getCanNextPage()}
          onShowSizeChange={table.setPageSize}
          onPrevious={table.previousPage}
          onNext={table.nextPage}
        />
      ) : null}
    </div>
  );
};
