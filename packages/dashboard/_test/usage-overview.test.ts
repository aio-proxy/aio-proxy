import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createStore } from "jotai";
import ts from "typescript";
import { usageQueryOptions } from "../src/modules/usage/services/usage-service";
import { createUsageValueFormatter } from "../src/modules/usage/services/usage-value-formatter";
import { usageOverviewFiltersAtom } from "../src/modules/usage/stores/usage-overview-filters";

const dashboardRoot = join(import.meta.dir, "../src");

const parseTsx = (path: string) =>
  ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

const jsxName = (node: ts.JsxElement | ts.JsxSelfClosingElement) =>
  ts.isJsxElement(node) ? node.openingElement.tagName.getText() : node.tagName.getText();

const findJsxElements = (source: ts.SourceFile, name: string) => {
  const matches: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node) => {
    if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && jsxName(node) === name) matches.push(node);
    ts.forEachChild(node, visit);
  };

  visit(source);
  return matches;
};

const descendantJsxElements = (root: ts.Node, name: string) => {
  const matches: Array<ts.JsxElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node) => {
    if (node !== root && (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && jsxName(node) === name) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };

  visit(root);
  return matches;
};

const findCallExpressions = (source: ts.SourceFile, name: string) => {
  const matches: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === name) matches.push(node);
    ts.forEachChild(node, visit);
  };

  visit(source);
  return matches;
};

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
    expect(chart).toContain("<UsageTrendTabs");
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
    expect(chart).toContain("<UsageTrendTabs");
  });

  test("composes both trend tab controls inside the chart header before every panel and the single chart", () => {
    const trendTabsPath = join(dashboardRoot, "modules/usage/components/usage-trend-tabs.tsx");
    const chartPath = join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx");
    const trendTabs = parseTsx(trendTabsPath);
    const chart = parseTsx(chartPath);
    const [header] = findJsxElements(trendTabs, "CardHeader");
    const [groupingControlsPortal] = findCallExpressions(trendTabs, "createPortal");

    expect(header).toBeDefined();
    if (!header) throw new Error("UsageTrendTabs must render CardHeader");
    expect(descendantJsxElements(header, "TabsList")).toHaveLength(1);
    expect(
      descendantJsxElements(header, "div").some((node) => node.getText().includes("setGroupingTabsContainer")),
    ).toBe(true);
    expect(groupingControlsPortal).toBeDefined();
    if (!groupingControlsPortal) throw new Error("Grouping TabsList must be portaled into CardHeader");
    expect(descendantJsxElements(groupingControlsPortal, "TabsList")).toHaveLength(1);
    expect(groupingControlsPortal.arguments[1]?.getText()).toBe("groupingTabsContainer");

    const panels = findJsxElements(trendTabs, "TabsContent");
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every((panel) => panel.pos > header.end)).toBe(true);
    expect(findJsxElements(chart, "ChartContainer")).toHaveLength(1);
  });

  test("labels and describes the Recharts SVG through the visible chart copy", () => {
    const chart = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx"), "utf8");
    const trendTabs = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-tabs.tsx"), "utf8");

    expect(chart).toContain("const chartTitleId = useId();");
    expect(chart).toContain("const chartDescriptionId = useId();");
    expect(chart).toContain("titleId={chartTitleId}");
    expect(chart).toContain("descriptionId={chartDescriptionId}");
    expect(trendTabs).toContain("<CardTitle id={titleId}>{title}</CardTitle>");
    expect(trendTabs).toContain("<CardDescription id={descriptionId}>{description}</CardDescription>");
    expect(chart).toContain("aria-labelledby={chartTitleId}");
    expect(chart).toContain("aria-describedby={chartDescriptionId}");
    expect(chart).not.toContain('aria-label={m["dashboard.usage.chart_title"]()}');
  });

  test("decodes escaped dimension keys for chart labels", () => {
    const chart = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx"), "utf8");

    expect(chart).toContain('series.key.startsWith("dimension:")');
    expect(chart).toContain('decodeURIComponent(series.key.slice("dimension:".length))');
  });

  test("preserves meaningful USD precision without compacting cost", () => {
    const formatCost = createUsageValueFormatter("cost", "en-US");

    expect(formatCost(0.0049)).toBe("$0.0049");
    expect(formatCost(12_345.67)).toBe("$12,345.67");
  });

  test("formats token and request metrics as compact integers", () => {
    const formatTokens = createUsageValueFormatter("tokens", "en-US");
    const formatRequests = createUsageValueFormatter("requests", "en-US");

    expect(formatTokens(1_200)).toBe("1K");
    expect(formatRequests(1_234_567)).toBe("1M");
  });

  test("derives component response shapes from the typed usage service", () => {
    const service = readFileSync(join(dashboardRoot, "modules/usage/services/usage-service.ts"), "utf8");
    const chart = readFileSync(join(dashboardRoot, "modules/usage/components/usage-trend-chart.tsx"), "utf8");
    const summary = readFileSync(join(dashboardRoot, "modules/usage/components/usage-summary-grid.tsx"), "utf8");

    expect(service).toContain("export type UsageOverviewData = Awaited<ReturnType<typeof getUsage>>;");
    expect(service).toContain('export type UsageOverviewSeries = UsageOverviewData["series"][number];');
    expect(service).toContain('export type UsageOverviewSummary = UsageOverviewData["summary"];');
    expect(chart).not.toContain('from "@aio-proxy/types"');
    expect(summary).not.toContain('from "@aio-proxy/types"');
  });
});
