import { m } from "@aio-proxy/i18n";
import type { UsageOverviewGroupBy, UsageOverviewMetric, UsageOverviewRange } from "@aio-proxy/types";
import { ReceiptText } from "lucide-react";
import { useState } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { UsageOverviewControls } from "../components/usage-overview-controls";
import { UsageSummaryGrid } from "../components/usage-summary-grid";
import { UsageTrendChart } from "../components/usage-trend-chart";
import { useUsageQuery } from "../hooks/use-usage-query";

const loadingMetricIds = ["cost", "requests", "tokens", "rpm", "tpm", "success-rate"] as const;

export const UsageOverview: React.FC = () => {
  const [range, setRange] = useState<UsageOverviewRange>("24h");
  const [metric, setMetric] = useState<UsageOverviewMetric>("cost");
  const [groupBy, setGroupBy] = useState<UsageOverviewGroupBy>("model");
  const usage = useUsageQuery({ range, metric, groupBy });
  const controls = (
    <UsageOverviewControls
      range={range}
      metric={metric}
      groupBy={groupBy}
      onRangeChange={setRange}
      onMetricChange={setMetric}
      onGroupByChange={setGroupBy}
    />
  );

  if (usage.isLoading) {
    return (
      <div className="grid gap-3">
        <span className="sr-only" role="status">
          {m["dashboard.usage.loading"]()}
        </span>
        {controls}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {loadingMetricIds.map((id) => (
            <Skeleton key={id} className="h-28 rounded-4xl" />
          ))}
        </div>
        <Skeleton className="h-96 rounded-4xl" />
      </div>
    );
  }

  if (usage.isError || usage.data === undefined) {
    return (
      <div className="grid gap-3">
        {controls}
        <Empty className="min-h-80 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ReceiptText />
            </EmptyMedia>
            <EmptyTitle>{m["dashboard.usage.error_title"]()}</EmptyTitle>
            <EmptyDescription>{m["dashboard.usage.error_description"]()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  if (usage.data.summary.requestCount === 0) {
    return (
      <div className="grid gap-3">
        {controls}
        <Empty className="min-h-80 bg-card">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ReceiptText />
            </EmptyMedia>
            <EmptyTitle>{m["dashboard.usage.empty_title"]()}</EmptyTitle>
            <EmptyDescription>{m["dashboard.usage.empty_description"]()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className="grid gap-3">
      {controls}
      <UsageSummaryGrid summary={usage.data.summary} />
      <UsageTrendChart data={usage.data} metric={metric} />
    </div>
  );
};
