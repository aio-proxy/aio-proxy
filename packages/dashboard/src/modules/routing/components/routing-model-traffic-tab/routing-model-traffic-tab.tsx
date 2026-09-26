import { dateFnsLocale, getLocale, m } from '@aio-proxy/i18n';
import type { UsageOverviewRange } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@aio-proxy/ui/components/chart';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { format, parseISO } from 'date-fns';
import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { formatDuration } from '@/lib/format-duration';

import { formatRoutingShare } from '../../lib/routing-summary';
import { routingTrafficBucketsQueryOptions, routingTrafficQueryOptions } from '../../services/routing-traffic-service';

export interface RoutingModelTrafficTabProps {
  readonly modelId: string;
  readonly range: UsageOverviewRange;
}

const providerRate = (numerator: bigint, denominator: bigint): number | null =>
  denominator === 0n ? null : Number(numerator) / Number(denominator);

export const RoutingModelTrafficTab: React.FC<RoutingModelTrafficTabProps> = ({ modelId, range }) => {
  const bucketsQuery = useQuery(routingTrafficBucketsQueryOptions(range, modelId));
  const trafficQuery = useQuery(routingTrafficQueryOptions(range));
  const uiLocale = getLocale();
  const dateLocale = dateFnsLocale(uiLocale);

  const totalsByProvider = useMemo(() => {
    const model = trafficQuery.data?.models.find((entry) => entry.modelId === modelId);
    return new Map(model?.providers.map((row) => [row.providerId, row]) ?? []);
  }, [trafficQuery.data, modelId]);

  if (bucketsQuery.isPending) {
    return <Skeleton className="h-72 w-full" />;
  }

  if (bucketsQuery.isError) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{m['dashboard.routing.load_failed']()}</p>
        <Button type="button" variant="outline" onClick={() => void bucketsQuery.refetch()}>
          {m['dashboard.routing.retry']()}
        </Button>
      </div>
    );
  }

  const bucketsData = bucketsQuery.data;
  if (bucketsData === undefined) {
    return <Skeleton className="h-72 w-full" />;
  }

  if (bucketsData.providerIds.length === 0) {
    return (
      <Empty>
        <p>{m['dashboard.routing.traffic.none']()}</p>
      </Empty>
    );
  }

  const formatBucket = (value: string, tooltip: boolean) => {
    let pattern = tooltip ? 'PP' : 'MMM d';
    if (bucketsData.bucketUnit === 'hour') pattern = 'MMM d, HH:mm xxx';
    return format(parseISO(value), pattern, { locale: dateLocale });
  };

  // Display-only: bucket counts stay well below MAX_SAFE_INTEGER, so Number() is exact for the chart.
  const chartData = bucketsData.buckets.map((bucket) => ({
    bucket: bucket.key,
    ...Object.fromEntries(
      bucketsData.providerIds.map((providerId) => [providerId, Number(bucket.values[providerId] ?? 0n)]),
    ),
  }));

  const chartConfig = Object.fromEntries(
    bucketsData.providerIds.map((providerId, index) => [
      providerId,
      { label: providerId, color: `var(--chart-${(index % 5) + 1})` },
    ]),
  ) satisfies ChartConfig;

  return (
    <div className="space-y-6">
      <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full sm:h-72">
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
              dataKey={providerId}
              fill={`var(--chart-${(index % 5) + 1})`}
              stackId="traffic"
              radius={index === bucketsData.providerIds.length - 1 ? [4, 4, 0, 0] : 0}
            />
          ))}
        </BarChart>
      </ChartContainer>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{m['dashboard.traces.provider']()}</TableHead>
            <TableHead>{m['dashboard.traces.span_metric_attempts']()}</TableHead>
            <TableHead>{m['dashboard.overview.success_rate']()}</TableHead>
            <TableHead>{m['dashboard.overview.p95_latency']()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {bucketsData.providerIds.map((providerId) => {
            const totals = totalsByProvider.get(providerId);
            const successRate = totals === undefined ? null : providerRate(totals.successCount, totals.attemptCount);
            return (
              <TableRow key={providerId}>
                <TableCell className="font-mono text-xs">{providerId}</TableCell>
                <TableCell className="tabular-nums">
                  {totals === undefined ? null : String(totals.attemptCount)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {successRate === null ? null : formatRoutingShare(successRate)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {totals === undefined || totals.p95LatencyMs === null
                    ? null
                    : formatDuration(totals.p95LatencyMs, uiLocale)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <Button render={<Link to="/traces" search={{ requestedModelId: modelId }} />}>
        {m['dashboard.routing.detail.open_in_traces']()}
      </Button>
    </div>
  );
};
