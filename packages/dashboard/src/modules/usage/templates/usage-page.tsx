import { getLocale, m } from "@aio-proxy/i18n";
import { Activity, CircleDollarSign, Cpu, Database, ReceiptText } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useUsageQuery } from "../hooks/use-usage-query";

const numberFormatter = new Intl.NumberFormat(getLocale());
const costFormatter = new Intl.NumberFormat(getLocale(), {
  currency: "USD",
  maximumFractionDigits: 6,
  style: "currency",
});
const dateFormatter = new Intl.DateTimeFormat(getLocale(), {
  dateStyle: "medium",
  timeStyle: "short",
});
const loadingMetricIds = ["requests", "tokens", "cache", "cost"] as const;

export const UsagePage: React.FC = () => {
  const usage = useUsageQuery();
  const data = usage.data;

  if (usage.isLoading) {
    return (
      <div className="grid gap-3">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {loadingMetricIds.map((id) => (
            <Skeleton key={id} className="h-28 rounded-4xl" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-4xl" />
      </div>
    );
  }

  if (usage.isError) {
    return (
      <Empty className="min-h-80 bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ReceiptText />
          </EmptyMedia>
          <EmptyTitle>{m["dashboard.usage.error_title"]()}</EmptyTitle>
          <EmptyDescription>{m["dashboard.usage.error_description"]()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (data === undefined) {
    return (
      <Empty className="min-h-80 bg-card">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ReceiptText />
          </EmptyMedia>
          <EmptyTitle>{m["dashboard.usage.error_title"]()}</EmptyTitle>
          <EmptyDescription>{m["dashboard.usage.error_description"]()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const summary = data.summary;
  const metrics = [
    {
      icon: ReceiptText,
      label: m["dashboard.usage.metric_requests"](),
      value: numberFormatter.format(summary.requestCount),
      detail: m["dashboard.usage.metric_requests_description"](),
    },
    {
      icon: Cpu,
      label: m["dashboard.usage.metric_tokens"](),
      value: numberFormatter.format(summary.totalTokens),
      detail: m["dashboard.usage.metric_tokens_description"]({
        input: numberFormatter.format(summary.inputTokens),
        output: numberFormatter.format(summary.outputTokens),
      }),
    },
    {
      icon: Database,
      label: m["dashboard.usage.metric_cache"](),
      value: numberFormatter.format(summary.cacheReadTokens + summary.cacheWriteTokens),
      detail: m["dashboard.usage.metric_cache_description"]({
        read: numberFormatter.format(summary.cacheReadTokens),
        write: numberFormatter.format(summary.cacheWriteTokens),
      }),
    },
    {
      icon: CircleDollarSign,
      label: m["dashboard.usage.metric_cost"](),
      value: costFormatter.format(summary.estimatedCostUsd),
      detail: m["dashboard.usage.metric_cost_description"](),
    },
  ] as const;

  return (
    <div className="grid gap-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <Card key={metric.label} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <metric.icon className="size-4 text-primary" />
                {metric.label}
              </CardTitle>
              <CardDescription>{metric.detail}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="font-heading font-semibold text-2xl tabular-nums">{metric.value}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{m["dashboard.usage.recent_title"]()}</CardTitle>
          <CardDescription>{m["dashboard.usage.recent_description"]()}</CardDescription>
        </CardHeader>
        <CardContent>
          {data.rows.length === 0 ? (
            <Empty className="min-h-72">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Activity />
                </EmptyMedia>
                <EmptyTitle>{m["dashboard.usage.empty_title"]()}</EmptyTitle>
                <EmptyDescription>{m["dashboard.usage.empty_description"]()}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m["dashboard.usage.column_time"]()}</TableHead>
                  <TableHead>{m["dashboard.usage.column_provider"]()}</TableHead>
                  <TableHead>{m["dashboard.usage.column_model"]()}</TableHead>
                  <TableHead className="text-right">{m["dashboard.usage.column_input"]()}</TableHead>
                  <TableHead className="text-right">{m["dashboard.usage.column_output"]()}</TableHead>
                  <TableHead className="text-right">{m["dashboard.usage.column_total"]()}</TableHead>
                  <TableHead className="text-right">{m["dashboard.usage.column_cost"]()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{dateFormatter.format(new Date(row.createdAt))}</TableCell>
                    <TableCell>{row.providerId}</TableCell>
                    <TableCell>{row.modelId}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {numberFormatter.format(row.inputTokens ?? 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {numberFormatter.format(row.outputTokens ?? 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {numberFormatter.format(row.totalTokens ?? 0)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.estimatedCostUsd === undefined
                        ? m["dashboard.usage.cost_unknown"]()
                        : costFormatter.format(row.estimatedCostUsd)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
};
