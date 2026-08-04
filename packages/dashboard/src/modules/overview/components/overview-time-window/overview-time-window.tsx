import { m } from '@aio-proxy/i18n';
import type { DashboardOverviewRange } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Tabs, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import { RefreshCw } from 'lucide-react';

interface OverviewTimeWindowProps {
  readonly isFetching: boolean;
  readonly range: DashboardOverviewRange;
  readonly onRangeChange: (range: DashboardOverviewRange) => void;
  readonly onRefresh: () => void;
}

const ranges: readonly DashboardOverviewRange[] = ['24h', '7d', '30d', '90d'];

export const OverviewTimeWindow: React.FC<OverviewTimeWindowProps> = ({
  isFetching,
  range,
  onRangeChange,
  onRefresh,
}) => {
  const labels: Record<DashboardOverviewRange, string> = {
    '24h': m['dashboard.overview.range_24h'](),
    '7d': m['dashboard.overview.range_7d'](),
    '30d': m['dashboard.overview.range_30d'](),
    '90d': m['dashboard.overview.range_90d'](),
  };

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label={m['dashboard.overview.refresh']()}
              disabled={isFetching}
              onClick={onRefresh}
            />
          }
        >
          <RefreshCw className={isFetching ? 'animate-spin' : undefined} />
        </TooltipTrigger>
        <TooltipContent>{m['dashboard.overview.refresh']()}</TooltipContent>
      </Tooltip>
      <Tabs value={range} onValueChange={(value) => onRangeChange(value as DashboardOverviewRange)}>
        <div className="min-w-0 overflow-x-auto pb-1">
          <TabsList className="shrink-0" aria-label={m['dashboard.overview.range_label']()}>
            {ranges.map((value) => (
              <TabsTrigger key={value} value={value}>
                {labels[value]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>
    </div>
  );
};
