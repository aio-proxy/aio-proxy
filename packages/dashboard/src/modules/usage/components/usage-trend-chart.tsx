import { getLocale, m } from "@aio-proxy/i18n";
import type { DashboardUsageOverviewResponse, DashboardUsageSeries } from "@aio-proxy/types";
import { format, parseISO } from "date-fns";
import { enUS, zhCN } from "date-fns/locale";
import { useAtomValue } from "jotai";
import { useId } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { usageOverviewFiltersAtom } from "../stores/usage-overview-filters";
import { UsageTrendTabs } from "./usage-trend-tabs";

type Props = {
  readonly data: DashboardUsageOverviewResponse;
};

const seriesColor = (series: DashboardUsageSeries, index: number) => {
  if (series.kind === "failed") return "var(--destructive)";
  if (series.kind === "cancelled") return "var(--muted-foreground)";
  if (series.kind === "other") return "var(--chart-5)";
  return `var(--chart-${(index % 5) + 1})`;
};

export const UsageTrendChart: React.FC<Props> = ({ data }) => {
  const { metric } = useAtomValue(usageOverviewFiltersAtom);
  const chartTitleId = useId();
  const chartDescriptionId = useId();
  const locale = getLocale().startsWith("zh") ? zhCN : enUS;
  const compactNumberFormatter = new Intl.NumberFormat(getLocale(), {
    maximumFractionDigits: 0,
    notation: "compact",
  });
  const costFormatter = new Intl.NumberFormat(getLocale(), {
    currency: "USD",
    maximumFractionDigits: 2,
    notation: "compact",
    style: "currency",
  });
  const seriesLabel = (series: DashboardUsageSeries) => {
    if (series.kind === "dimension") return series.key;
    if (series.kind === "other") return m["dashboard.usage.series_other"]();
    if (series.kind === "failed") return m["dashboard.usage.series_failed"]();
    return m["dashboard.usage.series_cancelled"]();
  };
  const chartConfig = Object.fromEntries(
    data.series.map((series, index) => [series.key, { label: seriesLabel(series), color: seriesColor(series, index) }]),
  ) satisfies ChartConfig;
  const chartData = data.buckets.map((bucket) => ({ bucket: bucket.key, ...bucket.values }));
  const formatBucket = (value: string, tooltip: boolean) =>
    format(parseISO(value), data.bucketUnit === "hour" ? "MMM d, HH:mm xxx" : tooltip ? "PP" : "MMM d", {
      locale,
    });
  const formatValue = (value: number) => {
    if (metric === "cost") return costFormatter.format(value);
    return compactNumberFormatter.format(value);
  };

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1.5">
          <CardTitle id={chartTitleId}>{m["dashboard.usage.chart_title"]()}</CardTitle>
          <CardDescription id={chartDescriptionId}>{m["dashboard.usage.chart_description"]()}</CardDescription>
        </div>
      </CardHeader>
      <UsageTrendTabs>
        <CardContent>
          <ChartContainer config={chartConfig} className="min-h-80 w-full">
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
                        <span className="font-medium font-mono tabular-nums">{formatValue(Number(value))}</span>
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
