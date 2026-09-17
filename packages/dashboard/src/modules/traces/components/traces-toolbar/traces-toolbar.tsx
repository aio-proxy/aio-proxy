import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { SidebarTrigger, useSidebar } from '@aio-proxy/ui/components/sidebar';
import { cn } from '@aio-proxy/ui/lib/utils';
import { endOfDay, startOfDay } from 'date-fns';

import { DateTimeRangePicker } from '@/components/date-time-range-picker';

import { createTraceDateTimeRangePresets, toPickerRange, toQueryRange } from '../../lib/trace-date-range';
import { type TraceSearch, withTraceFilters } from '../../lib/trace-search';

interface TracesToolbarProps {
  readonly search: TraceSearch;
  readonly autoRefresh: boolean;
  readonly onChange: (search: TraceSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
}

// 调用链保留 45 天，选到更早的时间只会得到空表。
const RETENTION_DAYS = 45;

export const TracesToolbar: React.FC<TracesToolbarProps> = ({ search, autoRefresh, onChange, onAutoRefresh }) => {
  const { open, isMobile, openMobile } = useSidebar();
  const now = new Date();
  const retentionStart = startOfDay(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <SidebarTrigger
        aria-label={m['dashboard.traces.filters']()}
        aria-controls="traces-filters"
        aria-expanded={isMobile ? openMobile : open}
      />
      <DateTimeRangePicker
        value={toPickerRange(search)}
        presets={createTraceDateTimeRangePresets()}
        min={retentionStart}
        max={endOfDay(now)}
        onChange={(value) => onChange(withTraceFilters(search, toQueryRange(value)))}
      />
      <div className="flex-1" />
      {search.pageToken === undefined && (
        <Button
          type="button"
          size="sm"
          variant={autoRefresh ? 'secondary' : 'outline'}
          aria-pressed={autoRefresh}
          title={autoRefresh ? undefined : m['dashboard.traces.live_off']()}
          onClick={() => onAutoRefresh(!autoRefresh)}
        >
          <span className={cn('size-1.5 rounded-full bg-current', autoRefresh && 'animate-pulse')} />
          {m['dashboard.traces.live']()}
        </Button>
      )}
    </div>
  );
};
