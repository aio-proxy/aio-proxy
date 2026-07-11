import { m } from "@aio-proxy/i18n";
import type { UsageOverviewGroupBy, UsageOverviewMetric } from "@aio-proxy/types";
import { useAtomValue, useSetAtom } from "jotai";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usageOverviewFiltersAtom } from "../stores/usage-overview-filters";

const metrics: readonly UsageOverviewMetric[] = ["cost", "tokens", "requests"];
const groupings: readonly UsageOverviewGroupBy[] = ["model", "provider"];

export const UsageTrendTabs: React.FC = () => {
  const filters = useAtomValue(usageOverviewFiltersAtom);
  const setFilters = useSetAtom(usageOverviewFiltersAtom);
  const metricLabels: Record<UsageOverviewMetric, string> = {
    cost: m["dashboard.usage.metric_cost"](),
    tokens: m["dashboard.usage.metric_tokens"](),
    requests: m["dashboard.usage.metric_requests"](),
  };
  const groupingLabels: Record<UsageOverviewGroupBy, string> = {
    model: m["dashboard.usage.group_by_model"](),
    provider: m["dashboard.usage.group_by_provider"](),
  };

  return (
    <div className="flex min-w-0 gap-2 overflow-x-auto pb-1">
      <Tabs
        className="w-max shrink-0"
        value={filters.metric}
        onValueChange={(value) => setFilters((current) => ({ ...current, metric: value as UsageOverviewMetric }))}
      >
        <TabsList aria-label={m["dashboard.usage.metric_label"]()}>
          {metrics.map((metric) => (
            <TabsTrigger key={metric} value={metric}>
              {metricLabels[metric]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Tabs
        className="w-max shrink-0"
        value={filters.groupBy}
        onValueChange={(value) => setFilters((current) => ({ ...current, groupBy: value as UsageOverviewGroupBy }))}
      >
        <TabsList aria-label={m["dashboard.usage.group_by_label"]()}>
          {groupings.map((groupBy) => (
            <TabsTrigger key={groupBy} value={groupBy}>
              {groupingLabels[groupBy]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
};
