import type { UsageOverviewGroupBy, UsageOverviewMetric } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";
import { useAtomValue, useSetAtom } from "jotai";
import { useReducer } from "react";
import { createPortal } from "react-dom";

import { CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { usageOverviewFiltersAtom } from "../stores/usage-overview-filters";

const metrics: readonly UsageOverviewMetric[] = ["cost", "tokens", "requests"];
const groupings: readonly UsageOverviewGroupBy[] = ["model", "provider"];

type Props = {
  readonly description: string;
  readonly titleId: string;
  readonly descriptionId: string;
  readonly children: React.ReactNode;
};

export const UsageTrendTabs: React.FC<Props> = ({ description, titleId, descriptionId, children }) => {
  const filters = useAtomValue(usageOverviewFiltersAtom);
  const setFilters = useSetAtom(usageOverviewFiltersAtom);
  const [groupingTabsContainer, setGroupingTabsContainer] = useReducer(
    (_current: HTMLDivElement | null, next: HTMLDivElement | null) => next,
    null,
  );
  const metricLabels: Record<UsageOverviewMetric, string> = {
    cost: m["dashboard.usage.metric_cost"](),
    tokens: m["dashboard.usage.metric_tokens"](),
    requests: m["dashboard.usage.metric_requests"](),
  };
  const groupingLabels: Record<UsageOverviewGroupBy, string> = {
    model: m["dashboard.usage.chart_title_model"](),
    provider: m["dashboard.usage.chart_title_provider"](),
  };

  return (
    <Tabs
      className="min-w-0 gap-2"
      value={filters.metric}
      onValueChange={(value) => setFilters((current) => ({ ...current, metric: value as UsageOverviewMetric }))}
    >
      <CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
        <div className="grid min-w-0 gap-1.5">
          <CardTitle id={titleId} className="sr-only">
            {groupingLabels[filters.groupBy]}
          </CardTitle>
          <div ref={setGroupingTabsContainer} className="max-w-full min-w-0 overflow-x-auto pb-1" />
          <CardDescription id={descriptionId}>{description}</CardDescription>
        </div>
        <div className="max-w-full min-w-0 overflow-x-auto pb-1 sm:shrink-0">
          <TabsList className="shrink-0" aria-label={m["dashboard.usage.metric_label"]()}>
            {metrics.map((metric) => (
              <TabsTrigger key={metric} value={metric}>
                {metricLabels[metric]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </CardHeader>
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
              {groupingTabsContainer
                ? createPortal(
                    <TabsList variant="line" className="shrink-0" aria-label={m["dashboard.usage.group_by_label"]()}>
                      {groupings.map((groupBy) => (
                        <TabsTrigger key={groupBy} value={groupBy}>
                          {groupingLabels[groupBy]}
                        </TabsTrigger>
                      ))}
                    </TabsList>,
                    groupingTabsContainer,
                  )
                : null}
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
