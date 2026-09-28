import { dateFnsLocale, getLocale, m } from '@aio-proxy/i18n';
import type { UsageOverviewRange } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@aio-proxy/ui/components/chart';
import { Empty, EmptyHeader, EmptyTitle } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { format, parseISO } from 'date-fns';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { routingTrafficChartRows, routingTrafficSeriesKey } from '../../lib/routing-traffic-chart';
import { routingTrafficBucketsQueryOptions } from '../../services/routing-traffic-service';

export interface RoutingModelTrafficTabProps {
  readonly modelId: string;
  readonly range: UsageOverviewRange;
}

export const RoutingModelTrafficTab: React.FC<RoutingModelTrafficTabProps> = ({ modelId, range }) => {
  // The chart is served traffic only, so the card reads nothing else: failed and cancelled requests are
  // left out of the buckets, and a window where every request failed is one with no traffic to show.
  const bucketsQuery = useQuery(routingTrafficBucketsQueryOptions(range, modelId));
  const uiLocale = getLocale();
  const dateLocale = dateFnsLocale(uiLocale);

  // A failed refetch keeps the last successful payload, so an error on its own must not replace a
  // working chart with an error screen. Only a query holding nothing is unavailable; when the
  // measurements are still there they stay up behind a notice, the same reading the rest of this
  // feature takes of `isError` beside cached data.
  const retryFailed = () => void bucketsQuery.refetch();

  if (bucketsQuery.isPending) {
    return <Skeleton className="h-72 w-full" />;
  }

  if (bucketsQuery.isError && bucketsQuery.data === undefined) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{m['dashboard.routing.traffic.load_failed']()}</p>
        <Button type="button" variant="outline" onClick={retryFailed}>
          {m['dashboard.routing.retry']()}
        </Button>
      </div>
    );
  }

  // Shown over whatever the cached measurement says, the empty state included: a "no traffic" reading
  // is just as stale once the refetch that would confirm it has failed.
  const refreshNotice = bucketsQuery.isError ? (
    <div className="flex flex-wrap items-center gap-3">
      <p role="status" className="text-sm text-muted-foreground">
        {m['dashboard.routing.traffic.refresh_failed']()}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={retryFailed}>
        {m['dashboard.routing.retry']()}
      </Button>
    </div>
  ) : null;

  const bucketsData = bucketsQuery.data;
  if (bucketsData === undefined) {
    return <Skeleton className="h-72 w-full" />;
  }

  if (bucketsData.providerIds.length === 0) {
    return (
      <div className="space-y-6">
        {refreshNotice}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{m['dashboard.routing.traffic.none']()}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const formatBucket = (value: string, tooltip: boolean) => {
    let pattern = tooltip ? 'PP' : 'MMM d';
    if (bucketsData.bucketUnit === 'hour') pattern = 'MMM d, HH:mm xxx';
    return format(parseISO(value), pattern, { locale: dateLocale });
  };

  const chartData = routingTrafficChartRows(bucketsData.providerIds, bucketsData.buckets);

  const chartConfig = Object.fromEntries(
    bucketsData.providerIds.map((providerId, index) => [
      routingTrafficSeriesKey(index),
      { label: providerId, color: `var(--chart-${(index % 5) + 1})` },
    ]),
  ) satisfies ChartConfig;

  return (
    <div className="space-y-6">
      {refreshNotice}
      <ChartContainer
        data-testid="routing-traffic-chart"
        data-series={bucketsData.providerIds.join(',')}
        config={chartConfig}
        className="aspect-auto h-64 w-full sm:h-72"
        aria-label={m['dashboard.routing.traffic.chart_label']()}
      >
        <BarChart data={chartData} margin={{ left: 8, right: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="bucket"
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            tickFormatter={(value) => formatBucket(String(value), false)}
          />
          <YAxis tickLine={false} axisLine={false} width={56} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(value) => formatBucket(String(value), true)}
                formatter={(value, name) => (
                  <div className="flex w-full items-center justify-between gap-4">
                    <span className="text-muted-foreground">{String(name)}</span>
                    <span className="font-mono font-medium tabular-nums">{Number(value)}</span>
                  </div>
                )}
              />
            }
          />
          {bucketsData.providerIds.map((providerId, index) => (
            <Bar
              key={providerId}
              dataKey={routingTrafficSeriesKey(index)}
              name={providerId}
              fill={`var(--chart-${(index % 5) + 1})`}
              stackId="traffic"
              radius={index === bucketsData.providerIds.length - 1 ? [4, 4, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>

      <Button size="sm" variant="outline" render={<Link to="/traces" search={{ requestedModelId: modelId }} />}>
        {m['dashboard.routing.detail.open_in_traces']()}
      </Button>
    </div>
  );
};
