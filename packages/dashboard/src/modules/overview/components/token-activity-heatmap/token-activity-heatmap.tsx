import { m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { ScrollArea, ScrollBar } from '@aio-proxy/ui/components/scroll-area';
import { useEffect, useMemo, useRef } from 'react';

import type { OverviewActivityData } from '../../services/overview-service';
import { activityIntensityLevels } from './activity-intensity';
import { HeatmapItem, heatmapIntensities } from './heatmap-item';
import { buildHeatmapWeeks } from './heatmap-layout';
import { TokenActivityDayCell } from './token-activity-day-cell';

interface TokenActivityHeatmapProps {
  readonly activity: OverviewActivityData;
}

export const TokenActivityHeatmap: React.FC<TokenActivityHeatmapProps> = ({ activity }) => {
  const scrollRoot = useRef<HTMLDivElement>(null);
  const { weeks, monthMarkers } = useMemo(() => buildHeatmapWeeks(activity), [activity]);
  const intensityByDate = useMemo(() => {
    const levels = activityIntensityLevels(activity.items.map(({ totalTokens }) => totalTokens));
    return new Map(activity.items.map((item, index) => [item.date, levels[index]!]));
  }, [activity.items]);

  // ScrollArea puts the ref on its root; the scrollable node is the viewport slot.
  useEffect(() => {
    const viewport = scrollRoot.current?.querySelector('[data-slot="scroll-area-viewport"]') ?? null;
    if (viewport !== null) viewport.scrollLeft = viewport.scrollWidth;
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.overview.activity_title']()}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <ScrollArea ref={scrollRoot} className="min-w-0">
          <div className="mx-auto grid w-max gap-1 pb-2">
            <div className="grid h-5 grid-cols-[repeat(52,--spacing(4))] gap-1 text-xs text-muted-foreground">
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
              className="grid auto-cols-4 grid-flow-col grid-rows-7 gap-1"
              role="group"
            >
              {weeks.flatMap((week, weekIndex) =>
                week.map((cell, dayIndex) => {
                  if (cell === null) return <div key={`${weekIndex}-${dayIndex}`} className="size-4" />;
                  return (
                    <TokenActivityDayCell key={cell.date} cell={cell} intensity={intensityByDate.get(cell.date) ?? 0} />
                  );
                }),
              )}
            </div>
          </div>
          <ScrollBar
            className="opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100"
            orientation="horizontal"
          />
        </ScrollArea>
        <div className="flex items-center justify-center gap-1 text-xs text-muted-foreground">
          <span>{m['dashboard.overview.activity_legend_less']()}</span>
          {heatmapIntensities.map((intensity) => (
            <HeatmapItem key={intensity} aria-hidden="true" intensity={intensity} />
          ))}
          <span>{m['dashboard.overview.activity_legend_more']()}</span>
        </div>
      </CardContent>
    </Card>
  );
};
