import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@aio-proxy/ui/components/dropdown-menu';
import { toast } from '@aio-proxy/ui/components/toast';
import { CopyIcon, FilterIcon, MoreHorizontalIcon } from 'lucide-react';

import type { SpanAttributeRow as SpanAttributeRowData } from '../../lib/span-attribute-rows';
import type { TraceFilterPatch } from '../../lib/trace-search';

interface SpanAttributeRowProps {
  readonly row: SpanAttributeRowData;
  readonly onFilter: (patch: TraceFilterPatch) => void;
}

export const SpanAttributeRow: React.FC<SpanAttributeRowProps> = ({ row, onFilter }) => {
  const filter = row.filter;
  const copyValue = async () => {
    try {
      await navigator.clipboard.writeText(row.value);
      toast.add({ type: 'success', title: m['dashboard.traces.copy_value_done']() });
    } catch {
      toast.add({ type: 'error', title: m['dashboard.traces.copy_value_failed']() });
    }
  };

  return (
    <div className="group grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)_2rem] items-center gap-2.5 bg-card px-2.5 py-1.5 hover:bg-accent">
      <span className="truncate font-mono text-xs text-muted-foreground" title={row.key}>
        {row.key}
      </span>
      <span className="truncate font-mono text-xs" title={row.value}>
        {row.value}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              // Keyboard users never hover, so focus has to reveal the trigger too.
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
              aria-label={m['dashboard.traces.attribute_actions']()}
            />
          }
        >
          <MoreHorizontalIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => void copyValue()}>
            <CopyIcon />
            {m['dashboard.traces.copy_value']()}
          </DropdownMenuItem>
          {filter === undefined ? null : (
            <DropdownMenuItem onClick={() => onFilter(filter)}>
              <FilterIcon />
              {m['dashboard.traces.add_as_filter']()}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};
