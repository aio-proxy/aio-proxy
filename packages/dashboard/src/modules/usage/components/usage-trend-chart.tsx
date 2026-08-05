import { dateFnsLocale, getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '@aio-proxy/ui/components/chart';
import { format, parseISO } from 'date-fns';
import { useAtomValue } from 'jotai';
import { useId } from 'react';
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { formatExactTokenCount } from '@/components/token-count';

import type { UsageOverviewData, UsageOverviewSeries } from '../services/usage-service';
import { createUsageValueFormatter } from '../services/usage-value-formatter';
import { usageOverviewFiltersAtom } from '../stores/usage-overview-filters';
import { UsageTrendTabs } from './usage-trend-tabs';

interface UsageTrendChartProps {
  readonly data: UsageOverviewData;
}

export const toUsageChartData = (data: UsageOverviewData) =>
  data.buckets.map((bucket) => ({
    bucket: bucket.key,
    ...Object.fromEntries(
      Object.entries(bucket.values).map(([key, value]) => [
        key,
        data.metric === 'cost' ? Number(value) / 1_000_000_000 : Number(value),
      ]),
    ),
  }));

const seriesColor = (series: UsageOverviewSeries, index: number) => {
  if (series.kind === 'failed') return 'var(--destructive)';
  if (series.kind === 'cancelled') return 'var(--muted-foreground)';
  if (series.kind === 'other') return 'var(--chart-5)';
  return `var(--chart-${(index % 5) + 1})`;
};

export const UsageTrendChart: React.FC<UsageTrendChartProps> = ({ data }) => {
  const { metric } = useAtomValue(usageOverviewFiltersAtom);
  const chartTitleId = useId();
  const chartDescriptionId = useId();
  const uiLocale = getLocale();
  const dateLocale = dateFnsLocale(uiLocale);
  const formatValue = createUsageValueFormatter(metric, uiLocale);
  const formatTooltipValue =
    metric === 'tokens' ? (value: number) => formatExactTokenCount(value, uiLocale) : formatValue;
  const seriesLabel = (series: UsageOverviewSeries) => {
    if (series.kind === 'dimension')
      return series.key.startsWith('dimension:')
        ? decodeURIComponent(series.key.slice('dimension:'.length))
        : series.key;
    if (series.kind === 'other') return m['dashboard.usage.series_other']();
    if (series.kind === 'failed') return m['dashboard.usage.series_failed']();
    return m['dashboard.usage.series_cancelled']();
  };
  const chartConfig = Object.fromEntries(
    data.series.map((series, index) => [series.key, { label: seriesLabel(series), color: seriesColor(series, index) }]),
  ) satisfies ChartConfig;
  const chartData = toUsageChartData(data);
  const formatBucket = (value: string, tooltip: boolean) =>
    format(parseISO(value), data.bucketUnit === 'hour' ? 'MMM d, HH:mm xxx' : tooltip ? 'PP' : 'MMM d', {
      locale: dateLocale,
    });
  return (
    <Card>
      <UsageTrendTabs
        description={m['dashboard.usage.chart_description']()}
        titleId={chartTitleId}
        descriptionId={chartDescriptionId}
      >
        <CardContent>
          <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full sm:h-72">
            <AreaChart
              data={chartData}
              margin={{ left: 8, right: 8 }}
              aria-labelledby={chartTitleId}
              aria-describedby={chartDescriptionId}
            >
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="bucket"
                tickLine={false}
                axisLine={false}
                minTickGap={24}
                tickFormatter={(value) => formatBucket(String(value), false)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(value) => formatValue(Number(value))}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatBucket(String(value), true)}
                    formatter={(value, name) => (
                      <div className="flex w-full items-center justify-between gap-4">
                        <span className="text-muted-foreground">{String(name)}</span>
                        <span className="font-mono font-medium tabular-nums">{formatTooltipValue(Number(value))}</span>
                      </div>
                    )}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent className="flex-wrap" />} />
              {data.series.map((series, index) => (
                <Area
                  key={series.key}
                  dataKey={series.key}
                  name={seriesLabel(series)}
                  stackId="usage"
                  type="monotone"
                  stroke={seriesColor(series, index)}
                  fill={seriesColor(series, index)}
                  fillOpacity={0.35}
                />
              ))}
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </UsageTrendTabs>
    </Card>
  );
};
