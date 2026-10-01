# Desktop panel content

Date: 2026-10-01
Status: draft. Refines the panel of `2026-09-29-desktop-client-design.md` (rev 4). Where the two disagree, this document wins for the panel, the tray menu and the `desktop-summary` DTO. Everything else in rev 4 stands.
Prototype: the interactive "AIO Proxy Panel" artifact built during the design (sample data only).

## Intent

When the user clicks the menu-bar icon, they want three answers at a glance:

1. **Is the proxy healthy?** Running or not, which version, and is anything failing.
2. **What did I use and spend?** Requests, failures, tokens and cost over a window they pick, compared with the window before it, split by model and by Provider.
3. **How much quota is left?** For the Providers that report quota: what remains, when it resets, and whether the current pace will run out before then.

Service actions (start, stop, restart, reload) are secondary. They move out of the panel into the icon's right-click menu. The panel is a glance surface, not a second Dashboard: anything deeper opens the Dashboard.

## Layout

A fixed 360 × 560 pt panel (rev 4's PopUp, unchanged), in three bands:

| Band | Contents | Scrolls |
| --- | --- | --- |
| Header | Status line, endpoint, one alert line, one notice line, and at most one promoted action button | No |
| Body | Three groups, top to bottom: **Usage**, **Quota**, **Last 12 months** | Vertically, as one list |
| Footer | **Open Dashboard**, the "Updated …" time, and **Update to <version>…** when Sparkle reports a pending update | No |

There are no tabs and no ⋯ menu. Each group has a header that sticks to the top of the body while the group scrolls past, so the reader always knows which group they are in.

The organizing rule is time scope: **only the Usage group follows the time window**, and the window switch sits in the Usage group's own header. Quota is live state with its own reset clocks. The heatmap is always the last 12 months. Neither has a window control near it.

### Header

- **Status line:** a colored dot, plus `Running <version>` / `Stopped` / `Not responding`, from rev 4's status logic.
- **Endpoint line**, in monospace, with the owner: `127.0.0.1:9317 · started by AIO Proxy`, `· managed by the aio-proxy CLI`, or `· stopped by you`.
- **Alert line** (red), shown when `alerts` is non-empty. It shows the first alert, adds `+N more` when there are more, and ends with **Show**.
  - When the alerting Provider is in the Quota group, **Show** scrolls the body to that group.
  - Otherwise **Show** opens the Dashboard's Providers page.
- **Notice line** (muted): the outcome of the last user action, e.g. `Restarted · /health answered` or an action's error. It clears when the panel closes, as rev 4's F4 fix does today.
- **Promoted action button:** only the state-relevant action from rev 4's offer table, and at most one: **Start** when stopped, **Install and start** when a fresh install is offered. Every other action lives in the right-click menu.

### Footer

- The **Open Dashboard** primary button.
- `Updated just now` / `Updated 2 min ago`, from the last successful summary.
- **Update to <version>…** when `update_pending` is set (rev 4 Task 14), placed next to Open Dashboard.

The open-at-login switch leaves the footer and moves to the menu.

## Group 1 · Usage

The group header holds the title **Usage** and a segmented control: `24h | 7d | 30d`.

- Windows match the Dashboard overview (`resolveRange`):
  - `24h` is the rolling 24 hours, bucketed by hour.
  - `7d` and `30d` are today plus the previous 6 or 29 local days, bucketed by day.
- The panel remembers the selected window per viewer (app state, kept across panel closes; it resets to `24h` on app launch).

### Cards (metric picker)

Four cards sit in one row: **Requests**, **Failed**, **Tokens**, **Cost**.

- Each shows the window's value and the change against the previous window of equal length. Percentages are shown for requests, tokens and cost; the absolute difference for failed.
- **Coloring:**
  - Failed and Cost: increases are red (`--chart-error`), decreases teal (`--chart-success`).
  - Requests and Tokens: neutral (`--muted-foreground`). More traffic is neither good nor bad.
- **Pricing coverage:** when `pricingCoverage` is below 1, the Cost card value gets a `≈` prefix, and its tooltip and accessible label say `<n>% of requests priced`. When it is `null`, the card shows `—`.
- **Metric picker:** the cards are toggle buttons (`aria-pressed`), and exactly one is selected (default Requests). The selected metric drives the trend chart and both breakdowns below. This replaces separate metric pills, so the group has a single control row.
- Below the cards, a muted line reads `Compared with the previous <window>`.

### Trend

- Bars, one per bucket, scaled to the bucket maximum of the selected metric.
- A caption names the selected bucket and its value, e.g. `14:00 · 1,284 requests (per hour)`. The default is the latest bucket; clicking a bar selects it.
- The axis is labelled with the first, middle and last bucket labels: hours for `24h`, weekday names for `7d`, `Mon D` dates for `30d`.

### Top models

- The top 5 models by the selected metric, one line each: monospace model id, a share bar (share of the window's total for that metric), and the value.
- When the selected metric's total is 0 (for example Failed with no failures), the list shows `No failures in this window`, or the equivalent for that metric.

### By Provider

- Every Provider with traffic in the window, sorted by the selected metric, using the same line shape as Top models.
- Providers with zero for the metric are listed after the others, with an empty bar.

## Group 2 · Quota

- The group header shows the title **Quota** and a summary: `<n> need attention · <m> Providers report quota`.
- The group lists only Providers whose quota capability exists, meaning `quota.status` is `loading`, `failed` or `ready`. Providers with `none` or `unsupported` are not listed. A failing non-quota Provider still reaches the header alert line through `alerts`.

### Provider block

1. **Title row:** the Provider name (bold), `accountLabel` (muted, truncated), and a chevron. The whole row is a button that opens `/dashboard/providers/<id>/edit`.
2. **Meta row:** `Updated <relative sampledAt>` on the left and `plan` on the right. Either side is omitted when unknown.
3. **One entry per quota window, in plugin order:**
   - **Title line:** `<label> · <n>% left`, with `resets in <duration>` at the right.
   - **Bar:**
     - The fill is the remaining ratio: `--chart-success`, or amber when below 15%.
     - A **pace tick** marks the remaining ratio an even burn would have left now. The tick is teal when the remaining fill reaches past it, and red when it does not.
   - **Projection line:**
     - `<n>% in reserve · lasts until reset` (muted) when the window is on or ahead of pace.
     - `<n>% over pace · runs out in <duration>` (red) when it is behind pace *and* the projected exhaustion comes before the reset.
 4. **Quota state other than `ready`:**
   - `loading`: `Loading quota…` in place of the windows.
   - `failed`, or a Provider diagnostic: the diagnostic summary in red. When the diagnostic suggests a command (`dashboardProviderSuggestedCommand`), it appears below in monospace.
   - `ready` with `refreshFailed`: the windows render from the last sample, and the meta row reads `Last refresh failed · data from <relative sampledAt>`.

### Pace math

All of it is client-side, from fields the DTO already carries:

```
length    = windowMinutes                     (null → no tick, no projection)
left      = resetsAt − now, in minutes        (null → no tick, no projection)
elapsed   = clamp(1 − left / length, 0.01, 1)
expected  = 1 − elapsed                       pace tick position
reserve   = remainingRatio − expected
burn      = (1 − remainingRatio) / (elapsed × length)   per minute
runsOutIn = remainingRatio / burn             (burn = 0 → never)
behind    = reserve < 0 and runsOutIn < left
```

Durations format as `Nd Nh`, `Nh Nm` or `Nm`.

### Sorting and attention

Blocks are sorted by:
1. Quota failed or a diagnostic present.
2. Any window below 15% remaining.
3. Any window `behind`.
4. Everything else, by name.

Only ranks 1 and 2 count toward `need attention`. Being merely over pace sorts a block higher but raises no alarm.

## Group 3 · Last 12 months

- The group header shows the title, plus `<n> active days · <total> tokens` by default, or `<Weekday Mon D> · <tokens> tokens` for the selected day.
- **Grid:** 53 weekly columns × 7 days, Sunday first. Cells are 10 pt with 2 pt gaps and five token levels (`--heat-0..4`, built from the dashboard's teal ramp). Month labels sit above the column where each month starts.
- **Scrolling:** the grid is wider than the panel, so it scrolls horizontally on its own. It opens scrolled to the latest week and keeps its offset across refreshes within a panel session.
- **Interaction:** clicking a day selects it; clicking it again clears the selection. A Less → More legend sits below the grid.
- **Data:** `activity`, unchanged from rev 4.

## Right-click menu

The icon's native menu (muda) carries every action. Items appear only when they apply, using rev 4's ownership and offer rules unchanged:

1. **Open Dashboard**
2. ---
3. **Start**, **Install and start**, **Stop**, **Restart**, **Reload config**: whichever the current offer allows. Each runs the same user action and completion condition as today. The outcome shows in the panel's notice line the next time the panel is open, and in the log.
4. **Open logs**
5. ---
6. **Open at login** (a check item). Present only for a persistent install.
   - In the `RequiresApproval` state it reads **Open at login (needs approval)**, and choosing it opens System Settings › Login Items.
   - Its check state is re-read whenever the login-item status is re-read: app launch, panel open, after a toggle.
7. **Check for Updates…**
8. ---
9. **Quit AIO Proxy**

The menu is rebuilt (`set_menu`) whenever the offer set changes: after each discovery and after each action completes.

## Panel states

| State | Header | Body | Footer |
| --- | --- | --- | --- |
| Running, summary ready | Running, version, endpoint, alerts | The three groups | Open Dashboard, Updated |
| Stopped (desktop-owned, user-stopped) | Stopped + **Start** | "The proxy is not running. It stays stopped until you start it." | Open Dashboard |
| Not responding | Not responding | rev 4 message; the right-click menu offers Restart/Start | Open Dashboard |
| Degraded: missing route, no token, unsupported version | Running, version, endpoint | rev 4 degraded text ("older than the app") | Open Dashboard |
| Auth failed | Running | rev 4 auth-failed text | Open Dashboard |

While a window switch fetch is in flight, the Usage group keeps showing the last response for that window, if one exists, with its header switch already moved. Without a cached response it shows a skeleton row of cards. Quota and the heatmap never blank during a window switch.

## `desktop-summary` changes

The DTO stays `protocolVersion: 1`. It has not shipped in any release, so the shape changes in place, and the golden fixture `packages/types/src/desktop-summary/fixtures/v1.json` is regenerated.

**Request:** `GET /dashboard/api/desktop-summary?range=24h|7d|30d[&refresh=true]`.
- `range` defaults to `24h`. An unknown value gives 400.
- `refresh=true` keeps its rev 4 meaning (refresh quota), and also bypasses the usage memo described under Cost.

**Response:**
- `usage24h` and `trend7d` are replaced by one `usage` object.
- `providers[]` gains `accountLabel`.
- `quota` in the `ready` state gains `plan`.
- Everything else (`server`, `activity`, `providers`, `alerts`) is unchanged.

```ts
type UsageTotals = {
  requests: string;               // decimal integer strings, like the rest of the DTO
  failedRequests: string;
  inputTokens: string;
  outputTokens: string;
  estimatedCostNanoUsd: string;
  pricingCoverage: number | null; // 0..1; null when nothing was priceable
};

type UsageSlice = {               // one row of a breakdown
  requests: string;
  failedRequests: string;
  totalTokens: string;            // input + output, as the Dashboard counts it
  estimatedCostNanoUsd: string;
};

type DesktopSummaryV1 = {
  protocolVersion: 1;
  generatedAt: string;
  server: { version: string; pid: number; ppid: number };
  usage: {
    range: '24h' | '7d' | '30d';
    bucketUnit: 'hour' | 'day';
    rangeStart: string;           // RFC 3339
    rangeEnd: string;
    current: UsageTotals;
    previous: UsageTotals;        // the equal-length window ending at rangeStart
    buckets: Array<{ start: string } & UsageSlice>;
    byModel: Array<{ modelId: string } & UsageSlice>;        // up to 20, by cost then requests
    byProvider: Array<{ providerId: string; name: string } & UsageSlice>;
  };
  activity: Array<{ date: string; totalTokens: string }>;    // unchanged
  providers: Array<{
    id: string;
    name: string;
    enabled: boolean;
    accountLabel: string | null;  // new
    state: 'ok' | 'degraded' | 'unavailable' | 'disabled';
    diagnostic: { code: string; summary: string; suggestedCommand: string | null } | null;
    quota:
      | { status: 'none' | 'unsupported' | 'loading' | 'failed' }
      | { status: 'ready'; sampledAt: string; refreshFailed: boolean;
          plan: string | Record<string, string> | null;      // new; LocalizedText like a window label
          windows: Array<{ id: string; label: string | Record<string, string>; remainingRatio: number | null;
                           resetsAt: string | null; windowMinutes: number | null }> };
  }>;
  alerts: Array<{ providerId: string; kind: 'diagnostic' | 'quota_exhausted'; message: string }>;
};
```

`diagnostic.suggestedCommand` is new too. It carries `dashboardProviderSuggestedCommand(provider)`, so the panel shows the same fix the Dashboard does.

### Sources

The panel reuses the Dashboard overview's data paths, so the panel and the Dashboard agree to the request:

| Field | Source |
| --- | --- |
| `usage.current`, `usage.buckets`, `usage.byModel` | The overview row source for the window: `spanRows` for `24h`, `dailyRows` (`usage_daily`) for `7d`/`30d`, aggregated as `overview.ts` does. Failures follow the overview's rule (error + interrupted). |
| `usage.previous` | The same source for the previous window, resolved as `overview.ts` resolves it today (whole local days for `7d`/`30d`) |
| `usage.byProvider` | Root spans (`parent_span_id is null`) in the window, grouped by `final_provider_id`: the query family behind the Dashboard's Provider health table (`diagnostics.ts`), extended with request, failure and cost sums. For every window, because `usage_daily` has no Provider dimension. Read through `trace_span_root_usage_idx`, a partial covering index on `parent_span_id is null`. |
| `providers[].accountLabel` | `DashboardProviderSummary.accountLabel` |
| `quota.plan` | The quota snapshot's `plan` (`OAuthQuotaSnapshot.plan`, already validated in `core/src/plugins/quota.ts`) |
| `diagnostic.suggestedCommand` | `dashboardProviderSuggestedCommand` |

`byProvider` for `7d`/`30d` reads spans, so it covers only what trace pruning has kept. This is the same limit the Dashboard's Provider health table has today, and it is accepted without a note in the panel.

### Cost and the usage memo

The `24h` path keeps rev 4's measured cost: 31 ms at 36k requests per 24 h. `byProvider` adds one grouped scan over the same spans.

`7d`/`30d` totals, buckets and `byModel` read `usage_daily` and are cheap. `byProvider` for `30d` scans a month of root spans, roughly 30× the 24 h span count. That is not affordable every 15 s, so:

- The server memoizes the whole `usage` block for `7d` and `30d`, per range, for **60 s**. `24h` is not memoized.
- `refresh=true` bypasses and replaces the memo.
- `30d` `byProvider` was measured on the spike's synthetic 1 GB trace DB, after adding a partial covering index on root spans (`trace_span_root_usage_idx`).
  - The measured cost is **265 ms** at 36k requests per day. The accepted budget is **≤ 300 ms**, held at most once a minute and only while some panel shows `30d` (user decision, 2026-10-01).
  - `24h` measures 46 ms.
  - The upgrade path, if the budget is ever missed, is a Provider dimension in the daily rollup (a migration, counting from the upgrade on). That is out of scope here.

## Refresh policy changes

Rev 4's table stands, with these changes:

| Trigger | Response |
| --- | --- |
| Panel opens | Fetch `?range=<remembered window>` |
| Window switch | Fetch the new range at once; this is not subject to the 15 s floor, and it is counted like a manual trigger |
| Every 15 s while open | Fetch the selected range. For `7d`/`30d` the server answers usage from its memo, so the tick mostly refreshes status, quota and alerts |
| Response for a range other than the selected one | Discard. Extends rev 4's tag (session, instance, counter) with the range |

The client keeps the last response per range in the app-level model (rev 4's hybrid lifecycle). Reopening the panel, or switching back to a window, renders that response at once, then fetches.

## Error handling

- **A failed window fetch** (timeout, 5xx) keeps the last response for that range and puts `Couldn't refresh usage · <reason>` in the notice line. A first fetch for a range that fails shows the error in place of the Usage group's content. Quota and the heatmap keep their last data.
- **A malformed `usage` block** (missing field, wrong bucket unit) is a parse failure of the whole summary, as rev 4 treats any v1 parse failure: the "invalid desktop summary" state.
- **`byProvider` empty while `current.requests > 0`** (spans pruned): the By Provider list shows `No per-Provider data for this window`.

## Testing

Each test guards one concrete failure.

- **Server**
  - `range` validation: `7d` and `30d` return `bucketUnit: 'day'` and the matching number of buckets; `24h` returns 24 hourly buckets; an unknown range returns 400.
  - `previous` covers the equal-length window ending at `rangeStart`. A request in the previous window counts there and not in `current`, one minute before `rangeStart` for `24h` (the exact boundary millisecond belongs to both windows, as in the Dashboard overview) and at the local-day boundary for `7d`.
  - `byProvider` groups by final Provider. A request that failed over from A to B counts once, under B. Failures and cost are summed per Provider.
  - `byModel` is capped at 20 and ordered by cost, then requests.
  - **Memo:**
    - A second `30d` request within 60 s does not re-run the span scan (store call counted).
    - `refresh=true` re-runs it.
    - `24h` always runs.
  - `quota.plan` and `accountLabel` pass through. A Provider without them yields `null`, and they do not appear as `undefined` keys.
  - The golden fixture is regenerated and parsed by the Rust tests.
- **Rust**
  - Pace math table:
    - ahead of pace;
    - behind and running out;
    - `windowMinutes` null;
    - `resetsAt` null;
    - `remainingRatio` 0;
    - `remainingRatio` null (no tick, no projection).
  - Quota sorting and the attention count. Over pace alone does not count.
  - The Quota group excludes `none`/`unsupported`.
  - Delta coloring per metric, including a previous value of 0, which shows `new`, not a percentage.
  - Top models and By Provider re-sort when the metric changes. A zero total shows the empty line.
  - A response tagged with another range is discarded. A cached range renders without waiting for a fetch.
  - The menu offer set matches the panel's previous action-row offers for every row of rev 4's offer table. Open at login is absent for a non-persistent install.
- **Manual (added to the Phase 2 checklist)**
  - Sticky group headers while scrolling.
  - Horizontal heatmap scroll that opens at the latest week.
  - A window switch keeps Quota and the heatmap intact.
  - The right-click menu shows only state-relevant actions, and its outcome appears in the notice line.

## Out of scope

- A `90d` window.
- Latency and cache hit rate in the panel. Both stay in the Dashboard.
- A Provider dimension in `usage_daily`. It is the upgrade path only if the `30d` measurement misses its budget.
- Customizing which numbers the panel shows.
- Menu-bar title text next to the icon.

## Follow-ups in other documents

- **rev 4 spec:** the `tray.rs` row's menu contents, the `panel/` row ("stat cards, Provider quota list, 7-day trend, heatmap, action row"), and the `DesktopSummaryV1` block and sources table all point here.
- **`.changeset/desktop-app.md`:** it announces a "7-day trend … with start, stop, restart and reload" in the panel. When this design ships, rewrite it to describe the panel as shipped: usage over 24 h, 7 days or 30 days by model and Provider, quota with pace, a 12-month heatmap, and service actions in the menu.
