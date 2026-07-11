import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createStore } from "jotai";
import { usageQueryOptions } from "../src/modules/usage/services/usage-service";
import { usageOverviewFiltersAtom } from "../src/modules/usage/stores/usage-overview-filters";

const dashboardRoot = join(import.meta.dir, "../src");

describe("usage overview query", () => {
  test("keys cache and polling by all selected controls", () => {
    const options = usageQueryOptions({ range: "7d", metric: "tokens", groupBy: "provider" });

    expect(options.queryKey).toEqual(["dashboard", "usage", "7d", "tokens", "provider"]);
    expect(options.refetchInterval).toBe(60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  test("renders usage on the root route without a standalone usage navigation item", () => {
    const indexRoute = readFileSync(join(dashboardRoot, "routes/index.tsx"), "utf8");
    const sideMenu = readFileSync(join(dashboardRoot, "components/side-menu/side-menu.tsx"), "utf8");

    expect(indexRoute).toContain("<UsageOverview />");
    expect(existsSync(join(dashboardRoot, "routes/usage.tsx"))).toBe(false);
    expect(sideMenu).not.toContain('to: "/usage"');
  });

  test("stores all overview filters in one Jotai atom", () => {
    const store = createStore();

    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: "24h", metric: "cost", groupBy: "model" });
    store.set(usageOverviewFiltersAtom, (current) => ({ ...current, metric: "requests", groupBy: "provider" }));
    expect(store.get(usageOverviewFiltersAtom)).toEqual({ range: "24h", metric: "requests", groupBy: "provider" });
  });

  test("uses range tabs globally and metric/grouping tabs inside the chart", () => {
    const overview = readFileSync(join(dashboardRoot, "modules/usage/templates/usage-overview.tsx"), "utf8");
    const chart = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx"), "utf8");

    expect(overview).toContain("<UsageRangeTabs>");
    expect(chart).toContain("<UsageTrendTabs>");
    expect(overview).not.toContain("<Select");
  });

  test("renders exact accessible localized tab values without Select or useState fallbacks", () => {
    const rangeTabs = readFileSync(join(dashboardRoot, "modules/usage/components/usage-range-tabs.tsx"), "utf8");
    const trendTabs = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-tabs.tsx"), "utf8");
    const overview = readFileSync(join(dashboardRoot, "modules/usage/templates/usage-overview.tsx"), "utf8");
    const usageComponents = `${rangeTabs}\n${trendTabs}\n${overview}`;

    expect(rangeTabs).toContain('["24h", "7d", "14d", "30d"]');
    expect(trendTabs).toContain('["cost", "tokens", "requests"]');
    expect(trendTabs).toContain('["model", "provider"]');
    expect(rangeTabs).toContain('aria-label={m["dashboard.usage.range_label"]()}');
    expect(trendTabs).toContain('aria-label={m["dashboard.usage.metric_label"]()}');
    expect(trendTabs).toContain('aria-label={m["dashboard.usage.group_by_label"]()}');
    expect(usageComponents).not.toContain("<Select");
    expect(usageComponents).not.toContain("useState");
    expect(existsSync(join(dashboardRoot, "modules/usage/components/usage-overview-controls.tsx"))).toBe(false);
  });

  test("associates every range tab with a panel that owns the overview state", () => {
    const rangeTabs = readFileSync(join(dashboardRoot, "modules/usage/components/usage-range-tabs.tsx"), "utf8");
    const overview = readFileSync(join(dashboardRoot, "modules/usage/templates/usage-overview.tsx"), "utf8");

    expect(rangeTabs).toContain("TabsContent");
    expect(rangeTabs).toContain("ranges.map((range) => (");
    expect(rangeTabs).toContain('<TabsContent key={range} value={range} keepMounted className="grid gap-3">');
    expect(rangeTabs).toContain("{filters.range === range ? children : null}");
    expect(overview).toContain("<UsageRangeTabs>{content}</UsageRangeTabs>");
  });

  test("associates every metric and grouping tab with a panel without duplicating the chart", () => {
    const trendTabs = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-tabs.tsx"), "utf8");
    const chart = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx"), "utf8");

    expect(trendTabs).toContain("TabsContent");
    expect(trendTabs).toContain("metrics.map((metric) => (");
    expect(trendTabs).toContain("<TabsContent key={metric} value={metric} keepMounted>");
    expect(trendTabs).toContain("groupings.map((groupBy) => (");
    expect(trendTabs).toContain("<TabsContent key={groupBy} value={groupBy} keepMounted>");
    expect(trendTabs).toContain("{filters.groupBy === groupBy ? children : null}");
    expect(chart).toContain("<UsageTrendTabs>");
  });

  test("labels and describes the Recharts SVG through the visible chart copy", () => {
    const chart = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx"), "utf8");

    expect(chart).toContain("const chartTitleId = useId();");
    expect(chart).toContain("const chartDescriptionId = useId();");
    expect(chart).toContain("<CardTitle id={chartTitleId}>");
    expect(chart).toContain("<CardDescription id={chartDescriptionId}>");
    expect(chart).toContain("aria-labelledby={chartTitleId}");
    expect(chart).toContain("aria-describedby={chartDescriptionId}");
    expect(chart).not.toContain('aria-label={m["dashboard.usage.chart_title"]()}');
  });

  test("uses the same compact formatter for token/request axes and tooltips", () => {
    const chart = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx"), "utf8");

    expect(chart).toContain('notation: "compact"');
    expect(chart).toContain("tickFormatter={(value) => formatValue(Number(value))}");
    expect(chart).toContain("{formatValue(Number(value))}");
    expect(chart).not.toContain("tooltipNumberFormatter");
    expect(chart).not.toContain("formatValue(Number(value), true)");
  });
});
