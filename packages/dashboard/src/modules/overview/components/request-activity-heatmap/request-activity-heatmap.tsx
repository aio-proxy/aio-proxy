import { getLocale, m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@aio-proxy/ui/components/tooltip';
import { cn } from '@aio-proxy/ui/lib/utils';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { type Dispatch, type SetStateAction, useState } from 'react';

import type { OverviewData } from '../../services/overview-service';

interface RequestActivityHeatmapProps {
  readonly activity: OverviewData['activity'];
  readonly onYearChange: (year: number) => void;
}

const intensityClasses = [
  'bg-muted/70 hover:bg-muted',
  'bg-primary/15 hover:bg-primary/25',
  'bg-primary/35 hover:bg-primary/45',
  'bg-primary/60 hover:bg-primary/70',
  'bg-primary hover:bg-primary/80',
] as const;

const createHeatmapLayout = (days: OverviewData['activity']['days']) => {
  const firstWeekday = days[0] ? new Date(`${days[0].date}T00:00:00.000Z`).getUTCDay() : 0;
  return {
    firstWeekday,
    maxCount: days.reduce((maximum, day) => (day.requestCount > maximum ? day.requestCount : maximum), 0n),
    weekCount: Math.max(1, Math.ceil((firstWeekday + days.length) / 7)),
  };
};

const createFormatters = (locale: string) => ({
  date: new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'UTC' }),
  month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
  number: new Intl.NumberFormat(locale),
});

const activityIntensity = (requestCount: bigint, maxCount: bigint) =>
  requestCount === 0n || maxCount === 0n ? 0 : Math.min(4, Number((requestCount * 4n + maxCount - 1n) / maxCount));

const selectActivityYear = (
  year: number,
  setSelectedDate: Dispatch<SetStateAction<string | undefined>>,
  onYearChange: (year: number) => void,
) => {
  setSelectedDate(undefined);
  onYearChange(year);
};

export const RequestActivityHeatmap: React.FC<RequestActivityHeatmapProps> = ({ activity, onYearChange }) => {
  const [selectedDate, setSelectedDate] = useState<string>();
  const locale = getLocale();
  const formatters = createFormatters(locale);
  const { firstWeekday, maxCount, weekCount } = createHeatmapLayout(activity.days);
  const selectedDay = activity.days.find((day) => day.date === selectedDate);

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.overview.activity_title']()}
        </CardTitle>
        <CardAction>
          <div className="flex items-center gap-1" role="group" aria-label={m['dashboard.overview.activity_year']()}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m['dashboard.overview.previous_year']()}
                    disabled={activity.year <= 2000}
                    onClick={() => selectActivityYear(activity.year - 1, setSelectedDate, onYearChange)}
                  />
                }
              >
                <ChevronLeft />
              </TooltipTrigger>
              <TooltipContent>{m['dashboard.overview.previous_year']()}</TooltipContent>
            </Tooltip>
            <span className="min-w-12 text-center font-medium tabular-nums">{activity.year}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={m['dashboard.overview.next_year']()}
                    disabled={activity.year >= 2100}
                    onClick={() => selectActivityYear(activity.year + 1, setSelectedDate, onYearChange)}
                  />
                }
              >
                <ChevronRight />
              </TooltipTrigger>
              <TooltipContent>{m['dashboard.overview.next_year']()}</TooltipContent>
            </Tooltip>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="overflow-x-auto pb-2">
          <div className="grid w-max gap-1">
            <div
              className="grid h-5 gap-1 text-xs text-muted-foreground"
              style={{ gridTemplateColumns: `repeat(${weekCount}, 1.5rem)` }}
            >
              {activity.days.flatMap((day, index) =>
                day.date.endsWith('-01')
                  ? [
                      <span
                        key={day.date}
                        className="whitespace-nowrap"
                        style={{ gridColumn: `${Math.floor((firstWeekday + index) / 7) + 1} / span 4` }}
                      >
                        {formatters.month.format(new Date(`${day.date}T00:00:00.000Z`))}
                      </span>,
                    ]
                  : [],
              )}
            </div>
            <div className="grid grid-rows-7 gap-1" style={{ gridTemplateColumns: `repeat(${weekCount}, 1.5rem)` }}>
              {activity.days.map((day, index) => {
                const date = new Date(`${day.date}T00:00:00.000Z`);
                const count = formatters.number.format(day.requestCount);
                const label = m['dashboard.overview.activity_day_label']({
                  date: formatters.date.format(date),
                  count,
                });
                const intensity = activityIntensity(day.requestCount, maxCount);
                return (
                  <Tooltip key={day.date}>
                    <TooltipTrigger
                      render={
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={label}
                          aria-pressed={selectedDate === day.date}
                          className={cn(intensityClasses[intensity], selectedDate === day.date && 'ring-2 ring-ring')}
                          style={{
                            gridColumn: Math.floor((firstWeekday + index) / 7) + 1,
                            gridRow: ((firstWeekday + index) % 7) + 1,
                          }}
                          onClick={() => setSelectedDate(day.date)}
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
              {m['dashboard.overview.activity_count']({ count: formatters.number.format(selectedDay.requestCount) })}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
