# Token Activity Heatmap Design

## Goal

Replace the overview request-count calendar-year heatmap with a GitHub/TokenTracker-style **Token usage** heatmap: a rolling **52-week** daily grid of square cells, with no year switching and no daily/weekly/cumulative modes.

Reference behavior comes from `.reference/TokenTracker` (`ActivityHeatmap` + `buildActivityHeatmap`): custom CSS grid, fixed-size square cells, token-based intensity. No third-party heatmap library.

## Decisions

| Topic | Choice |
| --- | --- |
| Metric | Daily `totalTokens` from `usage_daily` (sum across model dimensions) |
| Window | Rolling 52 weeks ending at the week that contains today |
| Week start | Sunday (TokenTracker / GitHub default) |
| Aggregation modes | Daily only |
| Year UI | Removed |
| Cell shape | Equal width/height squares (~12px) with small radius (~2px) |
| Intensity | Quantile bands 0–4 over positive daily token values (p50 / p75 / p90), matching TokenTracker |
| Interaction | Rich hover detail like TokenTracker; no click-selected detail bar |
| API approach | Break/replace the existing private activity contract (no parallel legacy endpoint) |

## API Contract

`GET /dashboard/api/overview/activity` no longer accepts `year`.

```ts
interface DashboardOverviewActivityResponse {
  from: string; // yyyy-MM-dd, inclusive, Sunday week start
  to: string; // yyyy-MM-dd, inclusive, local today
  items: readonly {
    date: string; // yyyy-MM-dd
    totalTokens: string;
    models: readonly { modelId: string; totalTokens: string }[];
  }[];
}
```

`from` is the Sunday that starts the oldest of the 52 weeks. `to` is today's local date. `items` covers every calendar day from `from` through `to` inclusive (missing usage rows are `totalTokens: "0"` and `models: []`). Days after `to` in the current week are not in the API response; the UI renders those trailing week slots as empty pads so the grid stays 7×52, matching TokenTracker.

Backend (`overviewDashboardActivity`) queries `usage_daily` for `[from, to]`, groups by `local_day` + `model_dimension`, and for each item:

- sums `total_tokens` across models into `totalTokens`
- returns per-model rows as `models`, sorted by `totalTokens` descending
- omits zero-token model rows; zero-activity days keep `models: []`

Date math uses the same local-day calendar as `usage_daily.local_day` (not UTC day keys).

## Dashboard UI

Rename the card to Token activity (i18n). Remove year chevrons/`CardAction` year state from `OverviewPage`.

Render a 7-row × 52-column CSS grid:

- Fixed square cells (`width` = `height`), not `Button icon-xs`
- Month labels above week columns (first week where the month changes)
- Optional Less → More legend
- Horizontal scroll with initial scroll to the latest (rightmost) weeks when needed

Keep the existing overview Card chrome and theme colors (`primary` intensity ramp or an equivalent muted → primary scale). Do not port TokenTracker's 3D view, AI filler copy, or Codex's Daily/Weekly/Cumulative toggle.

### Hover detail (TokenTracker-aligned)

Hovering a cell shows a rich floating panel (portaled / not clipped by card overflow), not a one-line shadcn tooltip:

1. Header: date + level badge (`0`–`4`)
2. Large compact token total + `TOKEN` unit
3. When `models.length > 0`: "Model breakdown" list — model id, compact tokens, percent of day total, thin progress bar; sorted by tokens desc; scroll if long
4. When `models` is empty: only date / level / total (no fake AI blurb)

Reuse existing dashboard token formatting if present; otherwise compact number formatting (e.g. `879.1M`). Percent = `round(modelTokens / dayTotal * 100)` with day total `0` treated as no breakdown rows.

## Frontend Data Flow

`overviewActivityQueryOptions` becomes parameterless (or keyed only by a stable activity key). Decode item and model `totalTokens` as `bigint`. Drop `year` query state and pending-year skeleton branching that compared `activity.data.year`. Intensity levels are computed client-side from the item totals (quantile bands); the tooltip badge uses that same level.

## Error And Empty States

Keep overview-page query error / loading treatment. An all-zero window still renders the full grid at level 0; hover still shows date, level 0, and `0` tokens with no model list. No special empty card solely for zero token activity.

## Testing

- Core: activity query returns 52-week-aligned `from`/`to`/`items`, sums tokens across models, includes per-day model breakdown ordered by tokens, fills missing days with `"0"` / `[]`, ignores `year`
- Types: schema accepts `from`/`to`/`items` with `totalTokens`/`models`, rejects the old `year`/`days`/`requestCount` shape
- Dashboard: renders square cells and Less→More legend; hover shows total + model breakdown; does not expose year controls; covers a non-zero day intensity path

## Out Of Scope

- Daily / weekly / cumulative toggles
- Billable-vs-total token split (schema has only `total_tokens`)
- Monday week-start preference
- Third-party heatmap dependencies
- Changing other overview cards (KPI, trend, provider health, top model costs)
