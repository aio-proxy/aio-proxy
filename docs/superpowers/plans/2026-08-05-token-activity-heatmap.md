# Token Activity Heatmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overview yearly request-count heatmap with a rolling 52-week Token usage heatmap (square cells, quantile intensity, TokenTracker-style hover model breakdown).

**Architecture:** Core recomputes `overviewDashboardActivity({ now? })` from `usage_daily` over a Sunday-aligned 52-week window and returns `{ from, to, items }`. Server drops the `year` query. Dashboard renames/rebuilds the heatmap as a custom CSS grid with portaled hover detail; intensity and layout are client-side pure helpers.

**Tech Stack:** Bun SQLite, Hono, Zod, TanStack Query, React, `@aio-proxy/i18n`, existing `formatCompactTokenCount`.

**Spec:** `docs/superpowers/specs/2026-08-05-token-activity-heatmap-design.md`

## Global Constraints

- Response shape is exactly `{ from, to, items: [{ date, totalTokens, models: [{ modelId, totalTokens }] }] }` with integer strings for token counts.
- Window is 52 weeks, Sunday week start, `to` = local today; no year query or year UI.
- Metric is `usage_daily.total_tokens` summed per day / per `model_dimension`.
- No third-party heatmap library; no Daily/Weekly/Cumulative toggle; no TokenTracker 3D / AI blurb.
- User-facing copy via `@aio-proxy/i18n`; `TOKEN` may stay as the untranslated unit literal per dashboard rules.
- Changesets must target product package `aio-proxy` plus touched internal packages at the same bump level.
- Do not stage or commit files outside each task's explicit scope.
- Run focused package tests after each task; finish with `bun run check` (or `bun run preflight` before claiming done).

## File Map

| Path | Responsibility |
| --- | --- |
| `packages/types/src/dashboard/dashboard.ts` | Zod activity response contract |
| `packages/core/src/db/trace-store/overview/activity.ts` | 52-week token aggregation |
| `packages/core/src/db/trace-store/types.ts` | `overviewDashboardActivity` signature |
| `packages/server/src/dashboard-routes/overview/overview.ts` | Drop `year` query validation |
| `packages/dashboard/.../overview-service/` | Decode `items` / `totalTokens` as bigint |
| `packages/dashboard/.../token-activity-heatmap/` | Grid, intensity, hover panel (rename from request-activity) |
| `packages/i18n/messages/*.json` | Token activity copy; remove year controls |
| `.changeset/*.md` | Release note |

---

### Task 1: Shared activity response schema

**Files:**
- Modify: `packages/types/src/dashboard/dashboard.ts`
- Modify: `packages/types/src/dashboard/dashboard.test.ts`

**Interfaces:**
- Produces:

```ts
export const DashboardOverviewActivityResponseSchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  items: z
    .array(
      z.object({
        date: z.iso.date(),
        totalTokens: NonNegativeIntegerStringSchema,
        models: z
          .array(
            z.object({
              modelId: IdSchema,
              totalTokens: NonNegativeIntegerStringSchema,
            }),
          )
          .readonly(),
      }),
    )
    .readonly(),
});
```

- [ ] **Step 1: Write failing schema tests**

Replace `activityInput` fixtures. Assert parse success for `{ from, to, items }` with models, and reject `{ year, days: [{ requestCount }] }`.

- [ ] **Step 2: Verify RED**

Run: `bun run --filter @aio-proxy/types test:unit -- src/dashboard/dashboard.test.ts`

Expected: FAIL on old shape / missing new fields.

- [ ] **Step 3: Update schema**

Replace `DashboardOverviewActivityResponseSchema` with the interface above. Keep exported types derived from the schema.

- [ ] **Step 4: Verify GREEN**

Run the same types test; expect PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/dashboard/dashboard.ts packages/types/src/dashboard/dashboard.test.ts
git commit -m "$(cat <<'EOF'
feat(types): reshape overview activity to token items

EOF
)"
```

---

### Task 2: Core 52-week token activity query

**Files:**
- Modify: `packages/core/src/db/trace-store/overview/activity.ts`
- Modify: `packages/core/src/db/trace-store/types.ts` (`overviewDashboardActivity` signature)
- Modify: `packages/core/src/db/trace-store/trace-store.ts` (pass-through)
- Modify: `packages/core/src/db/trace-store/overview/overview.test.ts`

**Interfaces:**
- Consumes: `DashboardOverviewActivityResponse` from types
- Produces:

```ts
overviewDashboardActivity: (options?: { readonly now?: Date }) => DashboardOverviewActivityResponse
```

- Pure date helpers inside `activity.ts` (or a private sibling if the file would exceed ~240 lines):
  - `localDate(date: Date): string`
  - `addLocalDays(date: Date, days: number): Date`
  - `startOfSundayWeek(date: Date): Date`
  - `activityRange(now: Date): { from: string; to: string }` → `to` = today local; `from` = Sunday of (current week − 51 weeks)

- SQL returns rows `{ date, modelId, totalTokens }` from `usage_daily` where `local_day >= from AND local_day <= to`, then fold into `items` sorted by `date` ascending; each day's `models` sorted by `totalTokens` desc (bigint), omitting zero-token models.

- [ ] **Step 1: Rewrite failing activity tests**

Replace year/leap-year/requestCount cases with:

1. Fixed `now = new Date(2026, 7, 5)` (Wed): `from === '2025-08-10'` (Sunday 51 weeks earlier), `to === '2026-08-05'`, `items.length` equals day count inclusive.
2. Seed two models on one day + one model on another; assert day `totalTokens` sum and `models` order.
3. Missing days are `{ totalTokens: '0', models: [] }`.
4. Prune-retention test still finds retained usage via tokens, not `requestCount`.

- [ ] **Step 2: Verify RED**

Run: `bun run --filter @aio-proxy/core test:unit -- src/db/trace-store/overview/overview.test.ts`

- [ ] **Step 3: Implement `overviewDashboardActivity`**

```ts
export function overviewDashboardActivity(
  db: BunSQLiteDatabase,
  options: { readonly now?: Date } = {},
): DashboardOverviewActivityResponse {
  const now = options.now ?? new Date();
  const { from, to } = activityRange(now);
  // query usage_daily, fold by date, fill every day from..to
  return { from, to, items };
}
```

Update `TraceStore.overviewDashboardActivity` and `createTraceStore` wiring. Do not keep a year overload.

- [ ] **Step 4: Verify GREEN**

Re-run the overview core tests; expect PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/db/trace-store
git commit -m "$(cat <<'EOF'
feat(core): return rolling token activity for overview heatmap

EOF
)"
```

---

### Task 3: Server activity route

**Files:**
- Modify: `packages/server/src/dashboard-routes/overview/overview.ts`
- Modify: `packages/server/src/dashboard-routes/overview/overview.test.ts`

**Interfaces:**
- `GET /overview/activity` takes no query params.
- Handler: `context.json(state.traceStore.overviewDashboardActivity())`.

- [ ] **Step 1: Rewrite failing route tests**

- `GET /overview/activity` → 200, body matches new schema, `items` present, no `year`/`days`.
- `GET /overview/activity?year=2026` → still 200 (ignore unknown query) **or** 400 if validator rejects unknown keys — pick **ignore** (no query schema) for simplicity.
- Delete invalid-year table tests.

- [ ] **Step 2: Verify RED**

Run: `bun run --filter server test:unit -- src/dashboard-routes/overview/overview.test.ts`

- [ ] **Step 3: Remove year validator**

Delete `DashboardOverviewActivityQuerySchema` / `activityValidator`. Wire `.get('/activity', ...)`.

- [ ] **Step 4: Verify GREEN**

Re-run server overview tests.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/dashboard-routes/overview
git commit -m "$(cat <<'EOF'
feat(server): drop year query from overview activity

EOF
)"
```

---

### Task 4: Dashboard service and overview page wiring

**Files:**
- Modify: `packages/dashboard/src/modules/overview/services/overview-service/overview-service.ts`
- Modify: `packages/dashboard/src/modules/overview/hooks/use-overview-query.ts`
- Modify: `packages/dashboard/src/modules/overview/templates/overview-page/overview-page.tsx`
- Modify: `packages/dashboard/src/modules/overview/templates/overview-page/overview-page.test.tsx`

**Interfaces:**
- Remove `OverviewActivityQueryInput`.
- `overviewActivityQueryOptions()` key: `['dashboard', 'overview', 'activity']`.
- `decodeOverviewActivity` maps each item/model `totalTokens` with `BigInt(...)`.
- `useOverviewActivityQuery()` takes no args.
- `OverviewPage` drops `year` / `setYear` / `isActivityPending` year mismatch; always render heatmap when activity data exists (optional `isFetching` skeleton only if desired — prefer keepPreviousData without year flicker).

- [ ] **Step 1: Update failing overview-page tests**

Remove year-button expectations. Assert `useOverviewActivityQuery` called with no year arg. Mock activity as `{ from, to, items: [...] }`.

- [ ] **Step 2: Verify RED**

Run: `bun run --filter @aio-proxy/dashboard test:unit -- src/modules/overview/templates/overview-page/overview-page.test.tsx`

- [ ] **Step 3: Implement service + page wiring**

Update decode/query/hook/page. Keep importing the heatmap under the name Task 5 will export (`TokenActivityHeatmap`); if Task 5 not done yet, temporarily keep old import name and rename in Task 5 — prefer completing Task 5 immediately after and fixing the import there in one pass. **Preferred:** do Steps 1–4 here with a temporary type-compatible stub only if needed; otherwise land Task 4 imports after Task 5 file rename in the same working tree without committing until Task 5 if types break — better: Task 4 keeps rendering `<RequestActivityHeatmap activity={activity.data} />` but stops passing `onYearChange`; Task 5 renames component and props.

Concrete Task 4 page change:

```tsx
const activity = useOverviewActivityQuery();
// ...
<RequestActivityHeatmap activity={activity.data} />
```

- [ ] **Step 4: Verify GREEN**

Re-run overview-page tests (may still pass with old heatmap if props loosened). Fix compile errors from removed `year` fields.

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/modules/overview/services packages/dashboard/src/modules/overview/hooks packages/dashboard/src/modules/overview/templates/overview-page
git commit -m "$(cat <<'EOF'
feat(dashboard): fetch parameterless overview token activity

EOF
)"
```

---

### Task 5: Token activity heatmap UI

**Files:**
- Rename directory: `packages/dashboard/src/modules/overview/components/request-activity-heatmap/` → `token-activity-heatmap/`
- Create: `token-activity-heatmap/token-activity-heatmap.tsx` (card + grid)
- Create: `token-activity-heatmap/activity-intensity.ts` (quantile levels)
- Create: `token-activity-heatmap/activity-intensity.test.ts`
- Create: `token-activity-heatmap/heatmap-layout.ts` (52-week cells + month markers)
- Create: `token-activity-heatmap/heatmap-layout.test.ts`
- Create: `token-activity-heatmap/token-activity-hover.tsx` (portaled detail panel)
- Create: `token-activity-heatmap/token-activity-heatmap.test.tsx`
- Create: `token-activity-heatmap/index.ts`
- Modify: `overview-page.tsx` import to `TokenActivityHeatmap`
- Modify: `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`
- Run: `bun run i18n:compile`

**Interfaces:**
- `TokenActivityHeatmapProps = { activity: OverviewActivityData }`
- `activityIntensityLevels(totals: readonly bigint[]): number[]` → parallel level 0–4 using positive-value quantiles p50/p75/p90 (TokenTracker algorithm).
- `buildHeatmapWeeks(activity): { weeks: (ActivityCell | null)[][]; monthMarkers: { index: number; label: string }[] }` with 52 week columns.
- Cell: `size-3` (12px) square, `rounded-[2px]`, theme `primary` opacity ramp; not `Button`.
- Hover: portal to `document.body`, header date + level badge, compact tokens via `formatCompactTokenCount`, model breakdown with `%` and progress bar; no click selection strip.
- Legend: Less → five swatches → More.
- Scroll container scrolls to end on mount.

**i18n keys (under `dashboard.overview`):**
- Rename/repurpose `activity_title` → Token activity copy in all locales
- Add: `activity_legend_less`, `activity_legend_more`, `activity_level` (`Level {level}`), `activity_model_breakdown`, keep unit as literal `TOKEN` in UI or add `activity_token_unit: "TOKEN"` identical across locales only if needed — prefer literal `TOKEN` in component per AGENTS untranslated-term rule
- Remove unused: `activity_year`, `previous_year`, `next_year`, `activity_day_label`, `activity_count`

- [ ] **Step 1: Write failing intensity + layout unit tests**

Cover: all zeros → all level 0; skewed positives map into 1–4; week count 52; trailing days after `to` are `null` pads; month marker at month boundaries.

- [ ] **Step 2: Verify RED**

Run the new colocated unit tests.

- [ ] **Step 3: Implement helpers + heatmap + hover + i18n**

Delete year controls and old `DataTable`-style button cells. Wire overview page to `TokenActivityHeatmap`.

- [ ] **Step 4: Write / update component tests**

- Renders no year buttons
- Shows legend
- Hovering a non-zero cell reveals model id + compact token text (use `userEvent.hover` / `fireEvent.mouseEnter`)
- Empty models day still shows total without breakdown section

- [ ] **Step 5: Verify GREEN**

```bash
bun run i18n:compile
bun run --filter @aio-proxy/dashboard test:unit -- src/modules/overview/components/token-activity-heatmap src/modules/overview/templates/overview-page/overview-page.test.tsx
```

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/modules/overview packages/i18n
git commit -m "$(cat <<'EOF'
feat(dashboard): render TokenTracker-style token activity heatmap

EOF
)"
```

---

### Task 6: Changeset and verification

**Files:**
- Create: `.changeset/<slug>.md`
- Touch only if prior tasks left compile gaps

- [ ] **Step 1: Add changeset**

```md
---
"aio-proxy": minor
"@aio-proxy/core": minor
"@aio-proxy/types": minor
"@aio-proxy/server": minor
"@aio-proxy/dashboard": minor
"@aio-proxy/i18n": minor
---

Replace overview activity heatmap with a rolling 52-week Token usage view and model breakdown hover details.
```

(Adjust package names to match actual `package.json` names if `@aio-proxy/server` differs — use `server` workspace name as declared.)

- [ ] **Step 2: Run preflight**

```bash
bun run preflight
```

Expected: oxlint + oxfmt check + unit tests pass.

- [ ] **Step 3: Commit changeset**

```bash
git add .changeset
git commit -m "$(cat <<'EOF'
chore: add changeset for token activity heatmap

EOF
)"
```

---

## Spec Coverage Check

| Spec requirement | Task |
| --- | --- |
| Token metric from `usage_daily` | 2 |
| 52-week Sunday window, no year API | 2, 3 |
| `{ from, to, items }` + models | 1, 2 |
| Square cells + legend + scroll | 5 |
| Quantile intensity 0–4 | 5 |
| Rich hover with model breakdown | 5 |
| Remove year UI / page state | 4, 5 |
| i18n Token activity title | 5 |
| No 3D / mode toggles / AI blurb | 5 (omitted) |
| Tests (core/types/dashboard) | 1–5 |
| Product changeset | 6 |
