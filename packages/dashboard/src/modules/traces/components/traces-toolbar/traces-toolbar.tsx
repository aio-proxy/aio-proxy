import { m } from '@aio-proxy/i18n';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { useSidebar } from '@aio-proxy/ui/components/sidebar';
import { cn } from '@aio-proxy/ui/lib/utils';
import { endOfDay, startOfDay } from 'date-fns';
import { CalendarIcon, ChevronDownIcon, ListFilterIcon } from 'lucide-react';

import { DateTimeRangePicker } from '@/components/date-time-range-picker';

import {
  createTraceDateTimeRangePresets,
  formatTraceRangeLabel,
  toPickerRange,
  toQueryRange,
} from '../../lib/trace-date-range';
import { countTraceFilters, type TraceSearch, withTraceFilters } from '../../lib/trace-search';

interface TracesToolbarProps {
  readonly search: TraceSearch;
  readonly autoRefresh: boolean;
  readonly onChange: (search: TraceSearch) => void;
  readonly onAutoRefresh: (value: boolean) => void;
}

// 调用链保留 45 天，选到更早的时间只会得到空表。
const RETENTION_DAYS = 45;

export const TracesToolbar: React.FC<TracesToolbarProps> = ({ search, autoRefresh, onChange, onAutoRefresh }) => {
  const { open, isMobile, openMobile, toggleSidebar } = useSidebar();
  const now = new Date();
  const retentionStart = startOfDay(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
  const filterCount = countTraceFilters(search);

  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      {/* 抽屉收起来之后没有别的地方能看出筛选还开着，所以按钮自己要报数。
          SidebarTrigger 只渲染图标，带不了文案和角标，改成普通按钮直接 toggle。 */}
      <Button
        type="button"
        size="sm"
        variant="outline"
        // 移动端那份抽屉是 Dialog，收起时整块不在 DOM 里，那会儿不能声称控制一个不存在的元素。
        aria-controls={isMobile && !openMobile ? undefined : 'traces-filters'}
        aria-expanded={isMobile ? openMobile : open}
        onClick={toggleSidebar}
      >
        <ListFilterIcon />
        {m['dashboard.traces.filters']()}
        {filterCount > 0 && <Badge variant="secondary">{filterCount}</Badge>}
      </Button>
      <DateTimeRangePicker
        value={toPickerRange(search)}
        presets={createTraceDateTimeRangePresets()}
        min={retentionStart}
        max={endOfDay(now)}
        trigger={
          <Button type="button" size="sm" variant="outline" aria-label={m['dashboard.date_time_range_picker.title']()}>
            <CalendarIcon />
            {formatTraceRangeLabel(search)}
            <ChevronDownIcon className="text-muted-foreground" />
          </Button>
        }
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
          {/* 开着的时候用成功色，跟图上的绿是同一支，关着的时候跟文字同色，不抢眼。 */}
          <span className={cn('size-1.5 rounded-full bg-current', autoRefresh && 'animate-pulse bg-chart-success')} />
          {m['dashboard.traces.live']()}
        </Button>
      )}
    </div>
  );
};
