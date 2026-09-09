import { m } from '@aio-proxy/i18n';
import type { SyncHistoryItem } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@aio-proxy/ui/components/dialog';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table';

import { syncHistoryQueryOptions } from '@/lib/sync/service';

export interface SyncHistoryDialogProps {
  readonly objectId: string | null;
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

export const SyncHistoryDialog: React.FC<SyncHistoryDialogProps> = ({ objectId, open, onOpenChange }) => {
  const query = useQuery(syncHistoryQueryOptions(objectId ?? ''));
  const features = tableFeatures({});
  const helper = createColumnHelper<typeof features, SyncHistoryItem>();
  const columns = helper.columns([
    helper.accessor('operationId', {
      header: () => m['dashboard.sync.history_operation'](),
      cell: (context) => <code className="text-xs">{String(context.getValue())}</code>,
    }),
    helper.accessor('writtenAt', {
      header: () => m['dashboard.sync.history_written'](),
      cell: (context) => new Date(Number(context.getValue())).toLocaleString(),
    }),
    helper.accessor('current', {
      header: () => m['dashboard.sync.history_current'](),
      cell: (context) => (context.getValue() ? m['dashboard.sync.history_yes']() : m['dashboard.sync.history_no']()),
    }),
  ]);
  const table = useTable({
    data: query.data ?? [],
    columns,
    features,
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" closeLabel={m['common.close']()}>
        <DialogHeader>
          <DialogTitle>{m['dashboard.sync.history_title']()}</DialogTitle>
          <DialogDescription>{objectId ?? ''}</DialogDescription>
        </DialogHeader>
        {query.isLoading ? <Skeleton className="h-32 w-full" aria-label={m['dashboard.sync.loading']()} /> : null}
        {query.isError ? <p role="alert">{m['dashboard.sync.load_failed']()}</p> : null}
        {!query.isLoading && !query.isError && query.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m['dashboard.sync.history_empty']()}</p>
        ) : null}
        {!query.isLoading && !query.isError && query.data !== undefined && query.data.length > 0 ? (
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getAllCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {m['common.close']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
