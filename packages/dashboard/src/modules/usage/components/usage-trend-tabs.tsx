import { m } from "@aio-proxy/i18n";
import type { UsageOverviewGroupBy, UsageOverviewMetric } from "@aio-proxy/types";
import { useAtomValue, useSetAtom } from "jotai";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usageOverviewFiltersAtom } from "../stores/usage-overview-filters";

const metrics: readonly UsageOverviewMetric[] = ["cost", "tokens", "requests"];
const groupings: readonly UsageOverviewGroupBy[] = ["model", "provider"];

type Props = {
  readonly children: React.ReactNode;
};

export const UsageTrendTabs: React.FC<Props> = ({ children }) => {
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
    <Tabs
      className="min-w-0 gap-2"
      value={filters.metric}
      onValueChange={(value) => setFilters((current) => ({ ...current, metric: value as UsageOverviewMetric }))}
    >
      <div className="min-w-0 overflow-x-auto px-6 pb-1">
        <TabsList className="shrink-0" aria-label={m["dashboard.usage.metric_label"]()}>
          {metrics.map((metric) => (
            <TabsTrigger key={metric} value={metric}>
              {metricLabels[metric]}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {metrics.map((metric) => (
        <TabsContent key={metric} value={metric} keepMounted>
          {filters.metric === metric ? (
            <Tabs
              className="min-w-0 gap-2"
              value={filters.groupBy}
              onValueChange={(value) =>
                setFilters((current) => ({ ...current, groupBy: value as UsageOverviewGroupBy }))
              }
            >
              <div className="min-w-0 overflow-x-auto px-6 pb-1">
                <TabsList className="shrink-0" aria-label={m["dashboard.usage.group_by_label"]()}>
                  {groupings.map((groupBy) => (
                    <TabsTrigger key={groupBy} value={groupBy}>
                      {groupingLabels[groupBy]}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              {groupings.map((groupBy) => (
                <TabsContent key={groupBy} value={groupBy} keepMounted>
                  {filters.groupBy === groupBy ? children : null}
                </TabsContent>
              ))}
            </Tabs>
          ) : null}
        </TabsContent>
      ))}
    </Tabs>
  );
};
