import { describe, expect, test } from "@rstest/core";
import { createStore } from "jotai";

import { usageQueryOptions } from "../services/usage-service";
import { createUsageValueFormatter } from "../services/usage-value-formatter";
import { usageOverviewFiltersAtom } from "../stores/usage-overview-filters";

describe("usage overview", () => {
  test("keys cache and polling by all selected controls", () => {
    const options = usageQueryOptions({ range: "7d", metric: "tokens", groupBy: "provider" });

    expect(options.queryKey).toEqual(["dashboard", "usage", "7d", "tokens", "provider"]);
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  test("stores all overview filters in one Jotai atom", () => {
    const store = createStore();

    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: "24h", metric: "cost", groupBy: "model" });
    store.set(usageOverviewFiltersAtom, (current) => ({ ...current, metric: "requests", groupBy: "provider" }));
    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: "24h", metric: "requests", groupBy: "provider" });
  });

  test("preserves meaningful USD precision without compacting cost", () => {
    const formatCost = createUsageValueFormatter("cost", "en-US");

    expect(formatCost(0.0049)).toBe("$0.0049");
    expect(formatCost(12_345.67)).toBe("$12,345.67");
  });

  test("formats token and request metrics as compact integers", () => {
    const formatTokens = createUsageValueFormatter("tokens", "en-US");
    const formatRequests = createUsageValueFormatter("requests", "en-US");

    expect(formatTokens(1_200)).toBe("1.2K");
    expect(formatRequests(1_234_567)).toBe("1M");
  });
});
