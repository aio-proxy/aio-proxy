import { getLocale, m } from '@aio-proxy/i18n';
import type { DashboardOverviewRange, UsageOverviewMetric } from '@aio-proxy/types';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@aio-proxy/ui/components/chart';
import { Tabs, TabsList, TabsTrigger } from '@aio-proxy/ui/components/tabs';
import { useId } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { createUsageValueFormatter } from '@/modules/usage/services/usage-value-formatter';

import type { OverviewData } from '../../services/overview-service';

interface ModelUsageTrendProps {
  readonly metric: UsageOverviewMetric;
  readonly range: DashboardOverviewRange;
  readonly trend: OverviewData['modelTrendByMetric'][UsageOverviewMetric];
  readonly onMetricChange: (metric: UsageOverviewMetric) => void;
}

const metrics: readonly UsageOverviewMetric[] = ['requests', 'tokens', 'cost'];
const dimensionKeyPrefix = 'dimension:';

const decodeModelSeriesKey = (key: string) =>
  key.startsWith(dimensionKeyPrefix) ? decodeURIComponent(key.slice(dimensionKeyPrefix.length)) : key;

export const ModelUsageTrend: React.FC<ModelUsageTrendProps> = ({ metric, range, trend, onMetricChange }) => {
  const titleId = useId();
  const locale = getLocale();
  const formatValue = createUsageValueFormatter(metric, locale);
  const formatBucket =
    range === '24h'
      ? new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
      : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' });
  const labels: Record<UsageOverviewMetric, string> = {
    requests: m['dashboard.overview.metric_requests'](),
    tokens: m['dashboard.overview.metric_tokens'](),
    cost: m['dashboard.overview.metric_cost'](),
  };
  const modelSeries = [
    ...trend.series.filter(({ kind }) => kind === 'dimension').slice(0, 4),
    ...trend.series.filter(({ kind }) => kind === 'other').slice(0, 1),
  ];
  const seriesLabel = (series: (typeof modelSeries)[number]) =>
    series.kind === 'other' ? m['dashboard.usage.series_other']() : decodeModelSeriesKey(series.key);
  const seriesColor = (series: (typeof modelSeries)[number], index: number) =>
    series.kind === 'other' ? 'var(--chart-5)' : `var(--chart-${(index % 4) + 1})`;
  const chartConfig = Object.fromEntries(
    modelSeries.map((series, index) => [series.key, { color: seriesColor(series, index), label: seriesLabel(series) }]),
  ) satisfies ChartConfig;
  const chartData = trend.buckets.map((bucket) => ({
    bucket: bucket.key,
    ...Object.fromEntries(
      Object.entries(bucket.values).map(([key, value]) => [
        key,
        metric === 'cost' ? Number(value) / 1_000_000_000 : Number(value),
      ]),
    ),
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle id={titleId} role="heading" aria-level={2}>
          {m['dashboard.overview.trend_title']()}
        </CardTitle>
        <CardAction>
          <Tabs value={metric} onValueChange={(value) => onMetricChange(value as UsageOverviewMetric)}>
            <TabsList variant="line" aria-label={m['dashboard.usage.metric_label']()}>
              {metrics.map((value) => (
                <TabsTrigger key={value} value={value}>
                  {labels[value]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-72 w-full">
          <AreaChart data={chartData} margin={{ left: 8, right: 8 }} aria-labelledby={titleId}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="bucket"
              axisLine={false}
              minTickGap={24}
              tickLine={false}
              tickFormatter={(value) => formatBucket.format(new Date(String(value)))}
            />
            <YAxis axisLine={false} tickLine={false} width={56} tickFormatter={(value) => formatValue(Number(value))} />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => formatBucket.format(new Date(String(value)))}
                  formatter={(value, name) => (
                    <div className="flex w-full items-center justify-between gap-4">
                      <span className="text-muted-foreground">{String(name)}</span>
                      <span className="font-mono font-medium tabular-nums">{formatValue(Number(value))}</span>
                    </div>
                  )}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />
            {modelSeries.map((series, index) => (
              <Area
                key={series.key}
                dataKey={series.key}
                fill={seriesColor(series, index)}
                fillOpacity={0.32}
                name={seriesLabel(series)}
                stackId="models"
                stroke={seriesColor(series, index)}
                type="monotone"
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
};
