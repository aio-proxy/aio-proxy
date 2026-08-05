import { m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useEffect, useMemo, useRef } from 'react';

import type { OverviewActivityData } from '../../services/overview-service';
import { activityIntensityLevels } from './activity-intensity';
import { buildHeatmapWeeks } from './heatmap-layout';
import { TokenActivityDayCell } from './token-activity-day-cell';

interface TokenActivityHeatmapProps {
  readonly activity: OverviewActivityData;
}

const intensityClasses = ['bg-muted/70', 'bg-primary/15', 'bg-primary/35', 'bg-primary/60', 'bg-primary'] as const;

export const TokenActivityHeatmap: React.FC<TokenActivityHeatmapProps> = ({ activity }) => {
  const scrollContainer = useRef<HTMLDivElement>(null);
  const { weeks, monthMarkers } = useMemo(() => buildHeatmapWeeks(activity), [activity]);
  const intensityByDate = useMemo(() => {
    const levels = activityIntensityLevels(activity.items.map(({ totalTokens }) => totalTokens));
    return new Map(activity.items.map((item, index) => [item.date, levels[index]!]));
  }, [activity.items]);

  useEffect(() => {
    const element = scrollContainer.current;
    if (element !== null) element.scrollLeft = element.scrollWidth;
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.overview.activity_title']()}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div ref={scrollContainer} className="overflow-x-auto pb-2">
          <div className="grid w-max gap-1">
            <div className="grid h-5 grid-cols-[repeat(52,--spacing(3))] gap-1 text-xs text-muted-foreground">
              {monthMarkers.map((marker) => (
                <span
                  key={`${marker.index}-${marker.label}`}
                  className="whitespace-nowrap"
                  style={{ gridColumn: marker.index + 1 }}
                >
                  {marker.label}
                </span>
              ))}
            </div>
            <div
              aria-label={m['dashboard.overview.activity_title']()}
              className="grid auto-cols-3 grid-flow-col grid-rows-7 gap-1"
              role="group"
            >
              {weeks.flatMap((week, weekIndex) =>
                week.map((cell, dayIndex) => {
                  if (cell === null) return <div key={`${weekIndex}-${dayIndex}`} className="size-3" />;
                  const level = intensityByDate.get(cell.date) ?? 0;
                  return (
                    <TokenActivityDayCell
                      key={cell.date}
                      cell={cell}
                      intensityClassName={intensityClasses[level]!}
                      level={level}
                    />
                  );
                }),
              )}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{m['dashboard.overview.activity_legend_less']()}</span>
          {intensityClasses.map((className, level) => (
            <span
              key={className}
              aria-label={m['dashboard.overview.activity_level']({ level })}
              className={cn('size-3 rounded-[2px]', className)}
            />
          ))}
          <span>{m['dashboard.overview.activity_legend_more']()}</span>
        </div>
      </CardContent>
    </Card>
  );
};
