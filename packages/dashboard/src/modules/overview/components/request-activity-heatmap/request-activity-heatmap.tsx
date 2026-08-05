import { getLocale, m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useState } from 'react';

import type { OverviewActivityData } from '../../services/overview-service';

interface RequestActivityHeatmapProps {
  readonly activity: OverviewActivityData;
}

const intensityClasses = [
  'bg-muted/70 hover:bg-muted',
  'bg-primary/15 hover:bg-primary/25',
  'bg-primary/35 hover:bg-primary/45',
  'bg-primary/60 hover:bg-primary/70',
  'bg-primary hover:bg-primary/80',
] as const;

const createHeatmapLayout = (items: OverviewActivityData['items']) => {
  const firstWeekday = items[0] ? new Date(`${items[0].date}T00:00:00.000Z`).getUTCDay() : 0;
  return {
    firstWeekday,
    maxCount: items.reduce((maximum, item) => (item.totalTokens > maximum ? item.totalTokens : maximum), 0n),
    weekCount: Math.max(1, Math.ceil((firstWeekday + items.length) / 7)),
  };
};

const createFormatters = (locale: string) => ({
  date: new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }),
  month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
  number: new Intl.NumberFormat(locale),
});

const activityIntensity = (totalTokens: bigint, maxCount: bigint) =>
  totalTokens === 0n || maxCount === 0n ? 0 : Math.min(4, Number((totalTokens * 4n + maxCount - 1n) / maxCount));

export const RequestActivityHeatmap: React.FC<RequestActivityHeatmapProps> = ({ activity }) => {
  const [selectedDate, setSelectedDate] = useState<string>();
  const locale = getLocale();
  const formatters = createFormatters(locale);
  const { firstWeekday, maxCount, weekCount } = createHeatmapLayout(activity.items);
  const selectedDay = activity.items.find((item) => item.date === selectedDate);

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.overview.activity_title']()}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="overflow-x-auto pb-2">
          <div className="grid w-max gap-1">
            <div
              className="grid h-5 gap-1 text-xs text-muted-foreground"
              style={{ gridTemplateColumns: `repeat(${weekCount}, 1.5rem)` }}
            >
              {activity.items.flatMap((item, index) =>
                item.date.endsWith('-01')
                  ? [
                      <span
                        key={item.date}
                        className="whitespace-nowrap"
                        style={{ gridColumn: `${Math.floor((firstWeekday + index) / 7) + 1} / span 4` }}
                      >
                        {formatters.month.format(new Date(`${item.date}T00:00:00.000Z`))}
                      </span>,
                    ]
                  : [],
              )}
            </div>
            <div className="grid grid-rows-7 gap-1" style={{ gridTemplateColumns: `repeat(${weekCount}, 1.5rem)` }}>
              {activity.items.map((item, index) => {
                const date = new Date(`${item.date}T00:00:00.000Z`);
                const count = formatters.number.format(item.totalTokens);
                const label = m['dashboard.overview.activity_day_label']({
                  date: formatters.date.format(date),
                  count: Number(item.totalTokens),
                  formattedCount: count,
                });
                const intensity = activityIntensity(item.totalTokens, maxCount);
                return (
                  <Tooltip key={item.date}>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={label}
                          aria-pressed={selectedDate === item.date}
                          className={cn(intensityClasses[intensity], selectedDate === item.date && 'ring-2 ring-ring')}
                          style={{
                            gridColumn: Math.floor((firstWeekday + index) / 7) + 1,
                            gridRow: ((firstWeekday + index) % 7) + 1,
                          }}
                          onClick={() => setSelectedDate(item.date)}
                        />
                      }
                    />
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        </div>
        {selectedDay === undefined ? null : (
          <div className="flex items-center gap-3 text-sm" role="status">
            <time dateTime={selectedDay.date}>
              {formatters.date.format(new Date(`${selectedDay.date}T00:00:00.000Z`))}
            </time>
            <span className="text-muted-foreground">
              {m['dashboard.overview.activity_count']({
                count: Number(selectedDay.totalTokens),
                formattedCount: formatters.number.format(selectedDay.totalTokens),
              })}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
