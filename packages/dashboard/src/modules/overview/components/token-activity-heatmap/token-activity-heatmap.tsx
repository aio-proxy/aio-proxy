import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { useEffect, useMemo, useRef, useState } from 'react';

import { formatCompactTokenCount } from '@/components/token-count';

import type { OverviewActivityData } from '../../services/overview-service';
import { activityIntensityLevels } from './activity-intensity';
import { buildHeatmapWeeks, type ActivityCell } from './heatmap-layout';
import { TokenActivityHover } from './token-activity-hover';

interface TokenActivityHeatmapProps {
  readonly activity: OverviewActivityData;
}

interface HoveredActivity {
  readonly cell: ActivityCell;
  readonly level: number;
  readonly position: { readonly x: number; readonly y: number };
}

const intensityClasses = ['bg-muted/70', 'bg-primary/15', 'bg-primary/35', 'bg-primary/60', 'bg-primary'] as const;

const formatDate = (date: string) =>
  new Intl.DateTimeFormat(getLocale(), { dateStyle: 'long', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00.000Z`),
  );

export const TokenActivityHeatmap: React.FC<TokenActivityHeatmapProps> = ({ activity }) => {
  const scrollContainer = useRef<HTMLDivElement>(null);
  const [hoveredActivity, setHoveredActivity] = useState<HoveredActivity>();
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
            <div
              className="grid h-5 gap-1 text-xs text-muted-foreground"
              style={{ gridTemplateColumns: 'repeat(52, 0.75rem)' }}
            >
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
              className="grid grid-flow-col grid-rows-7 gap-1"
              role="group"
              style={{ gridAutoColumns: '0.75rem' }}
            >
              {weeks.flatMap((week, weekIndex) =>
                week.map((cell, dayIndex) => {
                  if (cell === null) return <div key={`${weekIndex}-${dayIndex}`} className="size-3" />;
                  const level = intensityByDate.get(cell.date) ?? 0;
                  const label = `${formatDate(cell.date)}, ${formatCompactTokenCount(cell.totalTokens)} TOKEN, ${m['dashboard.overview.activity_level']({ level })}`;
                  return (
                    <div
                      key={cell.date}
                      aria-label={label}
                      className={`size-3 rounded-[2px] ${intensityClasses[level]}`}
                      tabIndex={0}
                      onBlur={() => setHoveredActivity(undefined)}
                      onFocus={(event) =>
                        setHoveredActivity({
                          cell,
                          level,
                          position: {
                            x: event.currentTarget.getBoundingClientRect().left,
                            y: event.currentTarget.getBoundingClientRect().bottom,
                          },
                        })
                      }
                      onMouseEnter={(event) =>
                        setHoveredActivity({ cell, level, position: { x: event.clientX, y: event.clientY } })
                      }
                      onMouseLeave={() => setHoveredActivity(undefined)}
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
              className={`size-3 rounded-[2px] ${className}`}
            />
          ))}
          <span>{m['dashboard.overview.activity_legend_more']()}</span>
        </div>
      </CardContent>
      {hoveredActivity === undefined ? null : <TokenActivityHover {...hoveredActivity} />}
    </Card>
  );
};
