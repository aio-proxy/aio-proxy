# Usage Trend Compact Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the reduced chart height, move the model/provider choice into the chart title area, and restore shared default styling for every tab trigger.

**Architecture:** Keep the existing nested Base UI tab roots and Jotai filter state. Portal the inner grouping list into the left side of `CardHeader` as line tabs, keep the outer metric list on the right with its default appearance, and retain a screen-reader-only active `CardTitle` for the chart's existing `aria-labelledby` relationship.

**Tech Stack:** React 19, TypeScript, Base UI Tabs, Tailwind CSS 4, Recharts, Jotai, Paraglide, Rsbuild/Bun.

## Global Constraints

- Update only the usage chart header, its localized grouping-title copy, and the existing responsive chart height.
- Preserve metric and grouping state, data requests, chart semantics, description and metric copy, theme tokens, keyboard behavior, and ARIA labels.
- Do not add local padding, height, background, border-radius, or active-state classes to `TabsTrigger`.
- Do not change the shared tabs component or the global appearance of unrelated tabs.
- Keep the chart at approximately 256px on mobile and 288px from the small breakpoint upward.
- Add no dependencies or new React components.

---

### Task 1: Replace the static chart title copy

**Files:**
- Modify: `packages/i18n/messages/en.json:429`
- Modify: `packages/i18n/messages/zh-Hans.json:429`

**Contract:**
- Replace the unused static `chart_title` message with two grouping-specific messages.
- English: `chart_title_model` = `Model usage`; `chart_title_provider` = `Provider usage`.
- Simplified Chinese: `chart_title_model` = `模型用量`; `chart_title_provider` = `提供商用量`.

- [x] **Step 1: Update both locale sources**

Keep the two locale files structurally identical and remove the obsolete `chart_title` key rather than leaving an unused alias.

- [x] **Step 2: Regenerate and type-check Paraglide output**

Run from the repository root:

```bash
rtk bun run --filter @aio-proxy/i18n build
```

Expected: Paraglide exposes both new message functions and TypeScript exits with status 0.

---

### Task 2: Make grouping tabs the chart title

**Files:**
- Modify: `packages/dashboard/src/modules/usage/components/usage-trend-tabs.tsx:6-96`
- Modify: `packages/dashboard/src/modules/usage/components/usage-trend-chart.tsx:57-62`
- Test: no unit test; this is a presentation and accessibility composition change verified against the rendered page.

**Interfaces:**
- Remove the `title` prop from the private `UsageTrendTabs` call contract.
- Preserve `description`, `titleId`, `descriptionId`, `children`, and the exported component name.
- Preserve the existing metric and grouping tab values and state transitions.

- [x] **Step 1: Confirm the private component's caller set**

Use LSP references on `UsageTrendTabs` before changing its props. Expected: `UsageTrendChart` is the only caller.

- [x] **Step 2: Replace the title and toolbar composition**

In `usage-trend-tabs.tsx`:

- Remove the `title` prop and the static visible `CardTitle`.
- Map `model` and `provider` to the new grouping-title messages.
- Render a screen-reader-only `CardTitle` containing the currently selected grouping title so the chart's existing `aria-labelledby={titleId}` remains accurate.
- Place the `groupingTabsContainer` portal target in the visible title position above the description.
- Render the metric list on the right with only layout classes on its wrapper and `className="shrink-0"` on `TabsList`.
- Remove every local `TabsTrigger` class.

Target header shape:

```tsx
<CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
  <div className="grid min-w-0 gap-1.5">
    <CardTitle id={titleId} className="sr-only">
      {groupingLabels[filters.groupBy]}
    </CardTitle>
    <div ref={setGroupingTabsContainer} className="min-w-0 max-w-full overflow-x-auto pb-1" />
    <CardDescription id={descriptionId}>{description}</CardDescription>
  </div>
  <div className="min-w-0 max-w-full overflow-x-auto pb-1 sm:shrink-0">
    <TabsList className="shrink-0" aria-label={m["dashboard.usage.metric_label"]()}>
      {metrics.map((metric) => (
        <TabsTrigger key={metric} value={metric}>
          {metricLabels[metric]}
        </TabsTrigger>
      ))}
    </TabsList>
  </div>
</CardHeader>
```

Render the portaled grouping list with the shared line variant and no trigger overrides:

```tsx
<TabsList
  variant="line"
  className="shrink-0"
  aria-label={m["dashboard.usage.group_by_label"]()}
>
  {groupings.map((groupBy) => (
    <TabsTrigger key={groupBy} value={groupBy}>
      {groupingLabels[groupBy]}
    </TabsTrigger>
  ))}
</TabsList>
```

Expected: the grouping choice reads as the card title on the left; the metric selector remains a default shared pill on the right; neither list changes shared trigger sizing.

- [x] **Step 3: Remove the obsolete caller prop**

In `usage-trend-chart.tsx`, remove `title={m["dashboard.usage.chart_title"]()}`. Keep `titleId`, `descriptionId`, chart height classes, and all chart internals unchanged.

---

### Task 3: Run static and package verification

- [x] **Step 1: Format and check changed source files**

Run:

```bash
rtk bunx biome check --write packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/dashboard/src/modules/usage/components/usage-trend-tabs.tsx packages/dashboard/src/modules/usage/components/usage-trend-chart.tsx
rtk bunx biome check packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/dashboard/src/modules/usage/components/usage-trend-tabs.tsx packages/dashboard/src/modules/usage/components/usage-trend-chart.tsx
```

Expected: the second command exits with status 0 and applies no changes.

- [x] **Step 2: Run repository and dashboard verification**

Run:

```bash
rtk bun run preflight
rtk bun run --filter @aio-proxy/dashboard build
rtk bun run test:unit --filter=@aio-proxy/dashboard
```

Observed: changed source checks, the i18n build, the dashboard production build, and the 18-file / 113-test dashboard unit suite pass. Full preflight stops at pre-existing Biome errors in untouched core and types files; no unrelated fixes are included.

---

### Task 4: Smoke-test the real Usage page

- [x] **Step 1: Verify desktop rendering and interaction**

Use the existing worktree development server with `/Volumes/ExternalSSD/workspace/aio-proxy/.aio-proxy-dev` as its configuration directory. Open `/dashboard/` at 1440×900.

Expected:

- `Model usage` / `Provider usage` appear as line tabs in the title position.
- `Cost` / `Tokens` / `Requests` appear on the right with the shared default pill appearance.
- The chart plotting region remains approximately 288px high.
- Clicking both grouping tabs and all metric tabs updates selected state and chart content.
- Keyboard focus remains visible; tooltip, legend, and axis labels remain readable.
- The page has no horizontal overflow.

- [x] **Step 2: Verify mobile rendering**

Repeat at 375×812.

Expected:

- The grouping title tabs and description stack above the metric tabs.
- Both lists remain intact and usable without horizontal page overflow.
- The chart plotting region remains approximately 256px high.

---

### Task 5: Commit and update the pull request

- [x] **Step 1: Commit the revised implementation**

Stage only the two locale sources, two modified components, and this plan:

```bash
rtk git add packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json packages/dashboard/src/modules/usage/components/usage-trend-tabs.tsx packages/dashboard/src/modules/usage/components/usage-trend-chart.tsx docs/superpowers/plans/2026-07-19-usage-trend-compact-layout.md
rtk git commit -m "style(dashboard): use grouping tabs as usage title"
```

- [x] **Step 2: Push the branch**

```bash
rtk git push
```

Expected: pull request #42 updates with the revised title interaction and verification evidence.
