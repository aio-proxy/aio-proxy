import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { useNavigate } from '@tanstack/react-router';
import { countBy } from 'es-toolkit/array';
import type React from 'react';
import { Fragment, useMemo } from 'react';

import { DataTableControls } from '@/components/data-table/data-table-controls';
import { Pagination } from '@/components/data-table/pagination';
import { useDataTable } from '@/hooks/use-data-table';

import { labOf } from '../lib/routing-rows';
import type { RoutingTrafficIndex } from '../lib/routing-traffic';
import { RoutingLabFilter } from './routing-lab-filter';
import { RoutingLabGroupRow } from './routing-lab-group-row';
import { createRoutingColumns } from './routing-table-columns';

interface RoutingTableProps {
  readonly models: readonly DashboardRoutingModel[];
  /** Every model, before the vendor filter, so the vendor selector keeps offering the other vendors. */
  readonly vendorModels?: readonly DashboardRoutingModel[];
  readonly traffic: RoutingTrafficIndex | undefined;
  readonly lab?: string;
  readonly onLabChange?: (lab: string | undefined) => void;
}

export const RoutingTable: React.FC<RoutingTableProps> = ({
  models,
  vendorModels = models,
  traffic,
  lab,
  onLabChange,
}) => {
  'use no memo';

  const navigate = useNavigate();
  const columns = useMemo(() => createRoutingColumns({ traffic }), [traffic]);
  const { table } = useDataTable(models, columns, { getRowId: (model) => model.modelId });

  if (models.length === 0) return <Empty>{m['dashboard.routing.empty']()}</Empty>;

  const showLabGroups = table.state.sorting.length === 0;
  // Counted from the filtered rows before pagination, so a heading matches what the filter left.
  const labModelCounts = countBy(table.getPrePaginatedRowModel().rows, (row) => labOf(row.original));
  const columnCount = table.getVisibleLeafColumns().length;

  return (
    <div className="flex flex-col gap-4">
      <DataTableControls
        table={table}
        filterLabel={m['dashboard.routing.table.filter']()}
        filterPlaceholder={m['dashboard.routing.table.filter_placeholder']()}
      >
        {onLabChange === undefined ? null : (
          <RoutingLabFilter models={vendorModels} value={lab} onChange={onLabChange} />
        )}
      </DataTableControls>
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
              const previousRow = rowIndex > 0 ? rowModel[rowIndex - 1] : undefined;
              const previousLab = previousRow === undefined ? undefined : labOf(previousRow.original);
              const groupRow =
                showLabGroups && lab !== previousLab
                  ? [
                      <RoutingLabGroupRow
                        key={`lab-${lab}-${row.id}`}
                        lab={lab}
                        modelCount={labModelCounts[lab] ?? 0}
                        columnCount={columnCount}
                      />,
                    ]
                  : [];
              return [
                ...groupRow,
                <TableRow
                  key={row.id}
                  data-testid={`routing-row-${row.original.modelId}`}
                  role="link"
                  tabIndex={0}
                  aria-label={row.original.modelId}
                  className="cursor-pointer"
                  onClick={() => void navigate({ to: '/routing/$', params: { _splat: row.original.modelId } })}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' && event.key !== ' ') return;
                    event.preventDefault();
                    void navigate({ to: '/routing/$', params: { _splat: row.original.modelId } });
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
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
