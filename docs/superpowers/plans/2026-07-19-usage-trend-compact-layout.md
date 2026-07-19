# Usage Trend Compact Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the Usage trend card height and combine its metric and grouping controls into one compact responsive toolbar.

**Architecture:** Keep the existing nested Base UI tab roots and Jotai filter state unchanged. Reshape only the `UsageTrendTabs` header composition, using the existing portal to place the grouping tab list beside the metric list, and override the shared chart container's aspect ratio with an explicit responsive height.

**Tech Stack:** React 19, TypeScript, Base UI Tabs, Tailwind CSS 4, Recharts, Jotai, Rsbuild/Bun.

## Global Constraints

- Update only the Usage trend chart and its header controls.
- Preserve metric and grouping state, data requests, chart semantics, localized copy, theme tokens, keyboard behavior, and ARIA labels.
- Do not change the global appearance of unrelated tabs.
- Keep each logical control group intact; wrap only between the metric and grouping groups.
- Use approximately 256px chart height on mobile and 288px from the small breakpoint upward.
- Add no dependencies, user-facing copy, or new React components.

---

### Task 1: Compact Usage Trend Card

**Files:**
- Modify: `packages/dashboard/src/modules/usage/components/usage-trend-tabs.tsx:38-94`
- Modify: `packages/dashboard/src/modules/usage/components/usage-trend-chart.tsx:56-115`
- Test: no unit test; this is a layout-only change whose observable contract is verified in a real browser.

**Interfaces:**
- Consumes: `usageOverviewFiltersAtom`, `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, and the existing `groupingTabsContainer` portal target.
- Produces: unchanged `UsageTrendTabs` props and unchanged `UsageTrendChart` export; no caller migrations.

- [x] **Step 1: Build the combined compact toolbar**

In `usage-trend-tabs.tsx`, preserve the outer metric `Tabs` root and inner grouping `Tabs` root. Replace the two vertically stacked control containers in `CardHeader` with one wrapping toolbar:

```tsx
<CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
  <div className="grid gap-1.5">
    <CardTitle id={titleId}>{title}</CardTitle>
    <CardDescription id={descriptionId}>{description}</CardDescription>
  </div>
  <div className="flex min-w-0 max-w-full flex-wrap items-center gap-1 rounded-xl bg-muted p-0.5 sm:justify-end">
    <div className="min-w-0 max-w-full overflow-x-auto">
      <TabsList
        className="h-7! shrink-0 bg-transparent p-0"
        aria-label={m["dashboard.usage.metric_label"]()}
      >
        {metrics.map((metric) => (
          <TabsTrigger key={metric} value={metric} className="px-2.5 py-0.5">
            {metricLabels[metric]}
          </TabsTrigger>
        ))}
      </TabsList>
    </div>
    <div ref={setGroupingTabsContainer} className="min-w-0 max-w-full overflow-x-auto" />
  </div>
</CardHeader>
```

Update the portaled grouping list to use the same compact, transparent treatment so both groups read as one command strip:

```tsx
<TabsList
  className="h-7! shrink-0 bg-transparent p-0"
  aria-label={m["dashboard.usage.group_by_label"]()}
>
  {groupings.map((groupBy) => (
    <TabsTrigger key={groupBy} value={groupBy} className="px-2.5 py-0.5">
      {groupingLabels[groupBy]}
    </TabsTrigger>
  ))}
</TabsList>
```

Expected: the groups remain separate tab roots and complete wrapping units, but share one muted toolbar surface with a 32px total height when they fit on one row.

- [x] **Step 2: Constrain the chart to responsive fixed heights**

In `usage-trend-chart.tsx`, replace the width-driven minimum-height chart class:

```tsx
<ChartContainer config={chartConfig} className="aspect-auto h-64 w-full sm:h-72">
```

Do not change `AreaChart`, axes, legend, tooltip, series, chart config, or accessibility IDs.

Expected: chart height is 256px below the `sm` breakpoint and 288px at `sm` and above, independent of card width.

- [x] **Step 3: Run static and package verification**

Run from the repository root:

```bash
rtk bun run check
rtk bun run test:unit --filter=@aio-proxy/dashboard
rtk bun run --filter @aio-proxy/dashboard build
```

Expected: all three commands exit with status 0; no TypeScript, Biome, Rstest, or Rsbuild errors.

- [x] **Step 4: Smoke-test the real Usage page in a browser**

Run `rtk bun run dev` from the repository root, open the dashboard URL printed by the development server, navigate to `/dashboard/`, and verify at desktop and mobile-width viewports.

Expected desktop observations:

- The chart plotting region is approximately 288px high.
- Metric and grouping controls appear in one toolbar row at the right of the header.
- Active, hover, and keyboard-focus states remain visible.
- Changing metric and grouping still updates the selected state and chart.

Expected mobile observations:

- The chart plotting region is approximately 256px high.
- The header stacks naturally, and wrapping occurs between complete control groups without horizontal page overflow.
- Axis labels, tooltip, and legend remain readable.

- [x] **Step 5: Commit the implementation**

Stage only the two modified component files and this plan:

```bash
rtk git add packages/dashboard/src/modules/usage/components/usage-trend-tabs.tsx packages/dashboard/src/modules/usage/components/usage-trend-chart.tsx docs/superpowers/plans/2026-07-19-usage-trend-compact-layout.md
rtk git commit -m "style(dashboard): compact usage trend layout"
```
