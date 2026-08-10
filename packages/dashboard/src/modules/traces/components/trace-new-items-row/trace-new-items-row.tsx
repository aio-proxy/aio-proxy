import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { TableCell, TableRow } from '@aio-proxy/ui/components/table';

interface TraceNewItemsRowProps {
  readonly columnCount: number;
  readonly count: number;
  readonly onAccept: () => void;
}

export const TraceNewItemsRow: React.FC<TraceNewItemsRowProps> = ({ columnCount, count, onAccept }) => (
  <TableRow className="hover:bg-transparent">
    <TableCell className="p-0" colSpan={columnCount}>
      <Button
        type="button"
        variant="ghost"
        className="h-auto w-full rounded-none py-2.5 text-primary"
        onClick={onAccept}
      >
        {m['dashboard.traces.new_traces_available']({ count })}
      </Button>
    </TableCell>
  </TableRow>
);
