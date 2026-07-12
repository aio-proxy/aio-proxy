import type { UsageOverviewGroupBy, UsageOverviewMetric, UsageOverviewRange } from "@aio-proxy/types";
import { atom } from "jotai";

export type UsageOverviewFilters = {
  readonly range: UsageOverviewRange;
  readonly metric: UsageOverviewMetric;
  readonly groupBy: UsageOverviewGroupBy;
};

export const usageOverviewFiltersAtom = atom<UsageOverviewFilters>({
  range: "24h",
  metric: "cost",
  groupBy: "model",
});
