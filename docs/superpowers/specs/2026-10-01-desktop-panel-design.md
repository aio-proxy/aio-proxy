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

- **Surface:** frosted glass. The window is transparent, with the system `popover` NSVisualEffectView (behind-window blending, always active) inserted under GPUI's content view; GPUI's own `Blurred` background strips that view's layers for a colorless blur, which leaves no blur on macOS 27. The panel paints no fill of its own; the material shows around three opaque group cards (`--popover`, large radius, one 8 pt gutter between cards and to the panel edges, and 12 pt padding on every side inside a card, no border: `--border` is lighter than the glass and reads as a pale halo), which hold all the body's content. The sticky group header is the top of a card: opaque `--popover` with rounded top corners and a bottom `--border` rule, shown once the top card's header has scrolled past the edge. The header and footer sit on the glass without divider lines, inset 20 pt (gutter plus card padding) so their text lines up with the cards' content; the footer's end buttons sit their own padding further out, so the Open Dashboard label and the ⋯ glyph are what line up. No translucent fill sits under other content: GPUI blends alpha additively, so anti-aliased edges over a translucent fill come out dark-rimmed. GPUI Component's root plugin fills the window with the theme background, so the panel window clears its Root's background. Cards are `--muted`. The window switch and the trend's split are GPUI Kit `TabBar::segmented()` (extra small), its track mapped to `--muted`, its thumb to `--popover`, and its labels to `--muted-foreground` / `--foreground`. The selected card follows shadcn's checked radio card: `color-mix(in oklab, --primary 5%, --popover)` with a `--primary` 30% border. Colors come from the Dashboard's Tailwind and shadcn tokens (`packages/ui/src/styles.css`), mirrored as constants in `desktop/src/theme/`, light or dark with the system.


| Band | Contents | Scrolls |
| --- | --- | --- |
| Header | Status line with the refresh button, endpoint, one alert line, one notice line, and at most one promoted action button | No |
| Body | Three groups, top to bottom: **Usage**, **Quota**, **Last 12 months** | Vertically, as one list |
| Footer | **Open Dashboard**, **Update to <version>…** when Sparkle reports a pending update, and the **⋯** menu | No |

There are no tabs. Each group has a header that sticks to the top of the body while the group scrolls past, so the reader always knows which group they are in.

The organizing rule is time scope: **only the Usage group follows the time window**, and the window switch sits in the Usage group's own header. Quota is live state with its own reset clocks. The heatmap is always the last 12 months. Neither has a window control near it.

### Header

- **Status line:** a colored dot, plus `Running <version>` / `Stopped` / `Not responding`, from rev 4's status logic.
- **Refresh button** (ghost, refresh icon), at the end of the status line while a summary is shown: a click fetches now (`manual_refresh`), and it spins while any summary fetch is out, automatic or manual. Its tooltip is `Updated just now` / `Updated 2 min ago`, from the last successful summary.
- **Endpoint line**, in monospace, with the owner: `127.0.0.1:9317 · started by AIO Proxy`, `· managed by the aio-proxy CLI`, or `· stopped by you`.
- **Alert line** (red), shown when `alerts` is non-empty. It shows the first alert, adds `+N more` when there are more, and ends with **Show**.
  - When the alerting Provider is in the Quota group, **Show** scrolls the body to that group.
  - Otherwise **Show** opens the Dashboard's Providers page.
- **Notice line** (muted): the outcome of the last user action, e.g. `Restarted · /health answered` or an action's error. It clears when the panel closes, as rev 4's F4 fix does today.

### Footer

- The **Open Dashboard** primary button, while the proxy is up. A stopped or unresponsive proxy serves no Dashboard, so the button is gone, and the menus' Open Dashboard is disabled by the same down state (live health, not only the last discovery).
- **Update to <version>…** when `update_pending` is set (rev 4 Task 14), placed next to Open Dashboard.
- A **⋯** button at the right opens a GPUI Kit dropdown menu, upward, with exactly the right-click menu's entries (`tray::entries`) and the same commands (`tray::run`), so the menu is reachable without leaving the panel. The open-at-login check appears there as in the right-click menu.

## Group 1 · Usage

The group header holds the title **Usage** and a segmented control: `24h | 7d | 30d`.

- Windows match the Dashboard overview (`resolveRange`):
  - `24h` is the rolling 24 hours, bucketed by hour.
  - `7d` and `30d` are today plus the previous 6 or 29 local days, bucketed by day.
- The panel remembers the selected window per viewer (app state, kept across panel closes; it resets to `24h` on app launch).

### Cards (metric picker)

Four cards sit in one row: **Requests**, **Failed**, **Tokens**, **Cost**.

- Each shows the window's value and the change against the previous window of equal length. Percentages are shown for requests, tokens and cost; the absolute difference for failed. When the previous window has no requests at all, the cards show no change line (every one would read `new`).
- **Cost value:** three significant digits so the `≈` and the amount fit the card: `$7.46`, `$74.6`, `$746`, `$1.2K`. The tooltip carries the exact amount.
- **Coloring:**
  - Failed and Cost: increases are red (`--chart-error`), decreases teal (`--chart-success`).
  - Requests and Tokens: neutral (`--muted-foreground`). More traffic is neither good nor bad.
- **Pricing coverage:** when `pricingCoverage` is below 1, the Cost card value gets a `≈` prefix, and its tooltip and accessible label add `· <n>% of requests priced` to the exact amount. When it is `null`, the card shows `—`.
- **Metric picker:** the cards are toggle buttons (`aria-pressed`), and exactly one is selected (default Requests). The selected metric drives the trend chart and the breakdown below. This replaces separate metric pills, so the group has a single control row.
- Below the cards, a muted line reads `Compared with the previous <window>`, or `No usage in the previous <window>` when it is empty.

### Trend

- Bars, one per bucket, scaled to the largest bucket of the selected metric, and **stacked** by model or by Provider. A `Model | Provider` switch (default Model) sits above the bars at the right; it is panel-local, like the metric.
- **Series:** the top 4 keys by the selected metric over the window, then **Other**, each bucket's remainder, as the Dashboard's model trend stacks. Colors run from `--chart-5` (the darkest) for the largest series at the bottom to `--chart-2`, and Other is `--chart-1`, the lightest. A key with nothing for the metric is not drawn; Other is omitted when nothing is left. A Provider series is labelled with its name.
- **No legend:** the hover tooltip names each series with its color.
- **Hover:** a band marks the bucket and a tooltip lists `<bucket label> · per hour|day`, one row per series with a value in that bucket (top first), and `Total`. There is no click selection.
- The axis is labelled with the first, middle and last bucket labels: hours for `24h`, weekday names for `7d`, `Mon D` dates for `30d`.
- Drawn as a GPUI Kit `Plot` (stacked `Bar` shapes, `Tooltip`, `CrossLine`), as the kit's stacked bar chart story is; the kit's `BarChart` has a single series.

### Breakdown

- One list under the trend, following its `Model | Provider` switch: a row per trend series (the top 4, then Other), largest first. It is the trend's legend and replaces separate Top models and By Provider lists.
- **Row:** the series' color swatch, its name, its value over the window, and its share of the window's total for the metric (`<1%` for a nonzero share under 1%).
- **Names:** the series label, as the tooltip names it: model ids in monospace; a Provider by its title, with ` · <subtitle>` only when another Provider shares the title, and its id once gone from config; Other as plain text. No plugin marks: the swatch is the row's only lead.
- When the selected metric's total is 0 (for example Failed with no failures), the trend and the breakdown give way to one GPUI Kit `Empty` state: an inbox icon and `No failures in this window`, or the equivalent for that metric.

## Group 2 · Quota

- The group header shows the title **Quota** and a summary: `<n> need attention · <m> Providers report quota`.
- The group lists only Providers whose quota capability exists, meaning `quota.status` is `loading`, `failed` or `ready`. Providers with `none` or `unsupported` are not listed. A failing non-quota Provider still reaches the header alert line through `alerts`.

### Provider block

Each block is a GPUI Kit `Accordion` item (several may be open at once, no border, flush with the panel's padding). Blocks needing attention (sorting ranks 1 and 2: failed, a diagnostic, or a window below 15%) start open; the rest start collapsed. A block the user opens or closes keeps that state until the panel closes.

1. **Title row (the accordion trigger):** for an OAuth Provider, the plugin mark; then the title (bold), the subtitle (muted, truncated), the headline, and the accordion's chevron.
   - **Headline:** the tightest window, the one with the lowest remaining ratio: a 32 pt bar (amber below 15%, else `--chart-success`) and `<n>%`, red when that window is behind pace. `Loading…` while loading, `Failed` (red) when failed or diagnosed; nothing when no window reports a ratio. An open block hides the headline, and the subtitle takes its width.
   - **Title:** `service` for an OAuth Provider, otherwise the Provider name. An OAuth Provider's name defaults to its account email, so two plugins logged in with one email would otherwise read alike.
   - **Subtitle:** `accountLabel`, else the Provider name when the title is the service. It is omitted when it repeats the title.
   - Several accounts of one plugin each get their own block, side by side through the ordering below.
   - **Plugin mark:** a 16 pt `--muted` square holding the plugin `icon` at 12 pt, resolved as the Dashboard's `PluginIcon` does: an http(s) URL as is, a Lobe Icons slug from `@lobehub/icons-static-png` for the current appearance. No icon, a `data:` icon, or a failed load shows the title's first letter. The app loads it through NSURLSession, which GPUI lacks natively.
2. **Meta row (first in the open block):** `Updated <relative sampledAt>` on the left, `plan`, and a `›` (tooltip `Open in Dashboard`) that opens `/dashboard/providers/<id>/edit`. Updated and plan are omitted when unknown.
3. **One entry per quota window, in plugin order:**
   - **Title line:** `<label> · <n>% left`, with `resets in <duration>` at the right.
   - **Bar:**
     - The fill is the remaining ratio: `--chart-success`, or amber when below 15%.
     - A **pace tick** marks the remaining ratio an even burn would have left now. The tick is teal when the remaining fill reaches past it, and red when it does not. It is as tall as the bar, 2 pt wide, with a 1 pt background-colored gap either side, so it reads on the fill without sticking out of the bar.
   - **Projection line:**
     - `<n>% in reserve · lasts until reset` (muted) when the window is on or ahead of pace.
     - `<n>% over pace · runs out in <duration>` (red) when it is behind pace *and* the projected exhaustion comes before the reset.
 4. **Quota state other than `ready`:**
   - `loading`: the headline reads `Loading…`; the open block has no windows yet.
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
4. Everything else.

Within a rank, blocks sort by title, then subtitle, ignoring case, so one plugin's accounts sit together.

Only ranks 1 and 2 count toward `need attention`. Being merely over pace sorts a block higher but raises no alarm.

## Group 3 · Last 12 months

- The group header shows the title, plus `<n> active days · <total> tokens`.
- **Grid:** 52 weekly columns × 7 days (the source starts 51 weeks before this week, as the Dashboard heatmap does), Sunday first. Cells are 10 pt with 2 pt gaps and five token levels (`--heat-0..4`, built from the dashboard's teal ramp). Month labels sit above the column where each month starts; one starting in the last two columns is right-aligned to the grid's end instead, so it is not clipped.
- **Scrolling:** the grid is wider than the panel, so it scrolls horizontally on its own. It opens scrolled to the latest week and keeps its offset across refreshes within a panel session.
- **Interaction:** hovering a day opens a GPUI Kit `HoverCard` at once, above the cell with left edges aligned, matching the Dashboard's day hover: the date (`October 1st, 2026`), `<compact tokens> Token`, and under a `Model breakdown` rule, one row per model (id, its tokens, its share of the day) with a `--primary` share bar. There is no click selection. A Less → More legend sits below the grid.
- **Data:** `activity`, unchanged from rev 4.

## Right-click menu

The menu-bar icon is the AIO mark from `packages/brand` as a template image (glyphs 10 pt tall in a 58 × 36 px canvas, 18 pt high, `desktop/assets/tray-mark.png`), sized with the system's own status items: full strength when running, at 40% when down, with a dot at its top right when running with something needing attention.

The icon's native menu (muda) carries every action. Items appear only when they apply, using rev 4's ownership and offer rules unchanged:

1. **Open Dashboard**
2. ---
3. **Start**, **Install and start**, **Take over and start**, **Stop**, **Restart**, **Reload config**: whichever the current offer allows. Each runs the same user action and completion condition as today. The outcome shows in the panel's notice line the next time the panel is open, and in the log.
4. **Open logs**
   - **Install aiop command**, only when the user's login shell (`$SHELL -l -i -c 'command -v aiop'`, probed at launch and after an install) has no `aiop`. It links `/usr/local/bin/aiop` to the stable symlink behind the system's admin prompt, and `/usr/local/bin/aio-proxy` too when nothing is there yet (an npm or Homebrew copy is left alone). A non-persistent copy shows it disabled as **Install aiop command (move to Applications first)**.
5. ---
6. **Open at login** (a check item). Always listed, so the switch can be found. A non-persistent copy shows it disabled and unchecked as **Open at login (move to Applications first)**: registering would point the login item at wherever that bundle happens to be.
   - In the `RequiresApproval` state it reads **Open at login (needs approval)**, and choosing it opens System Settings › Login Items.
   - Its check state is re-read whenever the login-item status is re-read: app launch, panel open, after a toggle.
7. **Check for Updates…**
8. ---
9. **Quit AIO Proxy**

The menu is rebuilt (`set_menu`) whenever the offer set changes: after each discovery and after each action completes.

## Panel states

| State | Header | Body | Footer |
| --- | --- | --- | --- |
| Running, summary ready | Running, version, refresh, endpoint, alerts | The three groups | Open Dashboard, ⋯ |
| Stopped | Stopped | GPUI Kit `Empty`: power-off icon, `The proxy is not running`, `It stays stopped until you start it.`, and the one action that starts it: **Start**, or **Install and start** when a fresh install is offered | ⋯ |
| Stopped, CLI uninstalled (orphaned plist) | Stopped | `Empty`: unplug icon, `Its CLI was uninstalled`, and **Take over and start** | ⋯ |
| Not responding | Not responding | `Empty`: server-off icon and a pointer to Restart in the ⋯ and right-click menus | ⋯ |
| Degraded: missing route, no token, unsupported version | Running, version, endpoint | rev 4 degraded text ("older than the app") | Open Dashboard, ⋯ |
| Auth failed | Running | rev 4 auth-failed text | Open Dashboard, ⋯ |

While a window switch fetch is in flight, the Usage group keeps showing the last response for that window, if one exists, with its header switch already moved. Without a cached response it shows a skeleton row of cards. Quota and the heatmap never blank during a window switch.

## `desktop-summary` changes

The DTO stays `protocolVersion: 1`. It has not shipped in any release, so the shape changes in place, and the golden fixture `packages/types/src/desktop-summary/fixtures/v1.json` is regenerated.

**Request:** `GET /dashboard/api/desktop-summary?range=24h|7d|30d[&refresh=true]`.
- `range` defaults to `24h`. An unknown value gives 400.
- `refresh=true` keeps its rev 4 meaning (refresh quota), and also bypasses the usage memo described under Cost.

**Response:**
- `usage24h` and `trend7d` are replaced by one `usage` object.
- `providers[]` gains `accountLabel`, `service` and `icon`.
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
    // Sparse per-bucket splits for the stacked trend; `bucket` indexes `buckets`. Models are those in
    // `byModel`, so a bucket's model cells may sum below the bucket: the client draws the rest as Other.
    trendByModel: Array<{ bucket: number; modelId: string } & UsageSlice>;
    trendByProvider: Array<{ bucket: number; providerId: string } & UsageSlice>;
  };
  activity: Array<{ date: string; totalTokens: string; models: Array<{ modelId: string; totalTokens: string }> }>; // models new: the day's top 5 by tokens
  providers: Array<{
    id: string;
    name: string;
    service: string | Record<string, string> | null;  // new; LocalizedText, null for non-OAuth
    icon: string | null;          // new; the plugin's declared icon, null for non-OAuth
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
| `usage.trendByModel` | The same rows as `byModel`, kept per bucket |
| `usage.trendByProvider` | The `byProvider` scan, run once per bucket: a range scan between bucket starts (local midnights for day buckets), grouped by Provider. `byProvider` is its sum. |
| `providers[].accountLabel` | `DashboardProviderSummary.accountLabel` |
| `providers[].icon` | The OAuth plugin's `DashboardPluginSummary.icon` |
| `providers[].service` | The Dashboard's `providerOAuthService`, unresolved: the plugin's `displayName` (else the package name after its last `/`), plus ` / <capability>` for a non-default capability |
| `quota.plan` | The quota snapshot's `plan` (`OAuthQuotaSnapshot.plan`, already validated in `core/src/plugins/quota.ts`) |
| `diagnostic.suggestedCommand` | `dashboardProviderSuggestedCommand` |

`byProvider` for `7d`/`30d` reads spans, so it covers only what trace pruning has kept. This is the same limit the Dashboard's Provider health table has today, and it is accepted without a note in the panel.

### Cost and the usage memo

The `24h` path keeps rev 4's measured cost: 31 ms at 36k requests per 24 h. `byProvider` adds one grouped scan over the same spans.

`7d`/`30d` totals, buckets and `byModel` read `usage_daily` and are cheap. `byProvider` for `30d` scans a month of root spans, roughly 30× the 24 h span count. That is not affordable every 15 s, so:

- The server memoizes the whole `usage` block for `7d` and `30d`, per range, for **60 s**. `24h` is not memoized.
- `refresh=true` bypasses and replaces the memo.
- `30d` `byProvider` was measured on the spike's synthetic 1 GB trace DB, after adding a partial covering index on root spans (`trace_span_root_usage_idx`).
  - The accepted budget is **≤ 300 ms**, held at most once a minute and only while some panel shows `30d` (user decision, 2026-10-01).
  - With the per-bucket Provider split, the whole `30d` usage block measures **196 ms** at 36k requests per day (1.08M root spans), down from 252 ms for the single grouped scan: one range scan per day sorts 30 small groups instead of a month at once. Grouping the month by a computed bucket instead measured 356 ms.
  - `24h` measures 53 ms and `7d` 42 ms.
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
- **`trendByProvider` empty while `current.requests > 0`** (spans pruned): with the Provider split, the trend shows no Provider series and the breakdown shows `No per-Provider data for this window`.

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
  - The trend's series and the breakdown re-rank when the metric changes. A zero total shows the empty state.
  - A response tagged with another range is discarded. A cached range renders without waiting for a fetch.
  - The menu offer set matches the panel's previous action-row offers for every row of rev 4's offer table. Open at login is listed but disabled for a non-persistent install.
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
