import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { TableCell, TableRow } from '@aio-proxy/ui/components/table';

interface TraceLoadOlderRowProps {
  readonly columnCount: number;
  readonly page: number;
  readonly pageCount: number;
  readonly isFetching: boolean;
  readonly isPlaceholderData: boolean;
  readonly onLoadOlder: () => void;
}

export const TraceLoadOlderRow: React.FC<TraceLoadOlderRowProps> = ({
  columnCount,
  page,
  pageCount,
  isFetching,
  isPlaceholderData,
  onLoadOlder,
}) => {
  if (page >= pageCount) return null;

  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="p-0" colSpan={columnCount}>
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full rounded-none py-2.5 text-muted-foreground"
          disabled={isFetching || isPlaceholderData}
          onClick={onLoadOlder}
        >
          {m['dashboard.traces.load_older_traces']()}
        </Button>
      </TableCell>
    </TableRow>
  );
};
