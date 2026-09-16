# Quota-window API-equivalent cost

Date: 2026-09-16

Status: Draft for review (not approved for implementation)

Prior art: [aio-proxy/aio-proxy#374](https://github.com/aio-proxy/aio-proxy/pull/374) (`feat(dashboard): show ChatGPT quota estimates in USD`). Still open. Useful UI and window join; drop the ChatGPT-only math.

## Goal

Answer **“is this subscription worth it?”** on the existing OAuth quota dialog.

For each quota window, show the API-price equivalent of requests **this aio-proxy instance recorded for this Provider during that window**. That is **Used $x only**. It is not remaining balance, not an upstream dollar figure, and not an extrapolated allowance.

## Current behavior

- Providers page: quota ring (percent remaining) opens a details dialog. Ring stays percent after this change.
- `OAuthQuotaItem` is `{ id, displayName, remainingRatio?, resetsAt?, windowMinutes? }`. Core `validateOAuthQuotaSnapshot` allowlists only those keys. Plugins do not see the trace store.
- ChatGPT reports percent windows only. Cursor / xAI Grok compute used/limit internally, then throw the amounts away after converting to `remainingRatio`.
- Request cost lives on completed root spans as `trace_span.estimated_cost_nano_usd`.
- Trace retention is **45 days**, hardcoded in `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.ts` (`RETENTION_MS`). Prune deletes root spans with `endedAt < now - 45d`. This is **not** Settings `logging.retentionDays` (default 3). The Traces date picker already uses 45 days.
- `usage_daily` is keyed by local day + model, has no Provider ID, and is not window-aligned. It is not the source.
- `#374` hardcodes `@aio-proxy/plugin-openai-chatgpt`, ChatGPT item IDs, and model regexes, then extrapolates `Est. total = used / consumed%`. Codex review P1: `.all()` of a week of traces, repeated per window, while the page polls every 60s. P2: `gpt-` / `o` prefixes drop models such as `codex-auto-review`.

## Decision

Host-only join. Reuse `#374`’s dialog row and window bounds. Do not special-case a plugin, do not extrapolate, do not change the plugin SDK.

1. On every OAuth quota read, attach host `estimates` to the existing `/providers/:id/quota` JSON. Key by `itemId`. No ChatGPT package check. No model regex. No lane split.
2. For each dialog window that has usable `resetsAt` + `windowMinutes`, query this Provider’s successful priced root traces in `[resetsAt - windowMinutes, sampledAt]` and sum `estimatedCostNanoUsd`.
3. Render one compact **Used $x** row under that window’s progress bar. Hide the row when the window is unusable or there is no priced cost.
4. Copy must say this is aio-proxy-recorded API-price equivalent, not an account balance.

### Why not the plugin layer

The dollars are in host traces. `AccountContext` has credentials / options / fetch, not history. Injecting the trace store into plugins, or putting `amounts` / `usageAttribution` on ChatGPT items so the host can fake a USD balance, does not answer this question. Cursor / Grok official used/limit passthrough is a different product and stays out of this change.

## Non-goals

- Plugin SDK changes (`amounts`, `usageAttribution`, ChatGPT `OAuthQuotaItem` USD).
- Injecting the trace store into plugins.
- `Est. total`, `used / consumed%`, fake ChatGPT dollar balance, dollars on the ring.
- Special-casing `@aio-proxy/plugin-openai-chatgpt` or ChatGPT item IDs / model names.
- Mixing this number with Cursor / Grok upstream credits (no add, subtract, or replace).
- Raising 45-day trace retention.
- Lane split (Spark vs Codex vs image). Overlapping windows may share overlapping dollars.

## Data

### Window bounds

Same rule as `quotaPace` (`packages/dashboard/src/modules/providers/lib/quota-view/quota-view.ts`):

- `start = resetsAt - windowMinutes * 60_000`
- `end = sampledAt` (the quota cache timestamp, not `Date.now()`)
- Hide when `resetsAt` or `windowMinutes` is missing, `windowMinutes <= 0`, `sampledAt >= resetsAt`, or `resetsAt - sampledAt > windowMinutes * 60_000` (reset already past, or further out than one window).

The dialog already drops items with no `remainingRatio` (`applicableQuotaItems`). Do not attach an estimate for those. `remainingRatio` is not an input to the dollar sum.

This is only the bound-validity half of `quotaPace`. Do not hide the row just because the pace marker is on-track.

Stale last-good snapshots still use their stored `sampledAt` and window bounds.

### Trace query

Add `TraceStore.providerWindowCost({ providerId, start, end })`.

SQLite returns **one aggregated row**. Do not `.all()` matching traces into JS (that is `#374`’s P1 and a merge blocker if copied).

Count a span when all of these hold:

- `parent_span_id IS NULL` (root)
- `termination_reason IS NULL` (successful completed request)
- `final_provider_id = providerId`
- `ended_at` in `[start, end]` inclusive
- `estimated_cost_nano_usd IS NOT NULL`

`SUM(estimated_cost_nano_usd)` as text, parsed with the existing `parseSqliteInteger` helper. Return `undefined` when there is no matching priced row (so the UI never prints `$0.00` for unpriced or empty history). Failed / cancelled / interrupted / still-running roots are out. Unpriced successful roots are out of the sum and do not become zero dollars.

Existing `trace_span_root_ended_idx` is enough for v1. Do not add an index unless a measured poll path needs it.

Deduplicate identical `[start, end]` pairs when several items share bounds. Two windows with different starts (5h vs weekly) are two sums. They **share overlapping dollars**; that is accepted. The weekly line is the subscription-value answer.

`# ponytail: 按 Provider+时间窗口汇总，车道拆分要等 usageAttribution`

### HTTP

`QUERY /providers/:id/quota` keeps `snapshot`, `sampledAt`, `stale`, `error`. Add:

```ts
estimates?: readonly {
  itemId: string
  usedNanoUsd: string // integer nano-USD, base-10
  basis: 'local-api-equivalent'
}[]
```

Host-owned. Not part of `OAuthQuotaSnapshot`, not validated by `validateOAuthQuotaSnapshot`. Omit the field, or the item, when there is nothing to show. Compute on the route from the returned cache entry plus `traceStore` so the 60s dashboard poll sees new traces without a new upstream quota read. Quota cache stays an upstream-snapshot cache.

## UI

Home: Providers → card ring → quota dialog. New row sits under the progress bar of each applicable window (`ProviderQuotaItem`), same place `#374` put costs.

- Compact `formatNanoUsd(..., 'compact')`. If the compact amount would round to `$0.00` but the value is `> 0`, show `<$0.01` (`cost_less_than`). Exact amount on hover (`formatNanoUsd` default).
- Visible label: used amount plus a short “API equivalent” marker.
- Note (title / accessible description): aio-proxy recorded this Provider’s requests in this window, priced as API equivalents. Not an account balance. Outside clients, other instances, downtime, and prune undercount. Never claim a full bill.
- Do not ship `cost_total` / Est. total.
- Cursor / Grok get the same local-$ row. Do not place it next to a fake upstream dollar line in this change.

i18n: Paraglide, all five locales (`en`, `ja`, `ko`, `zh-Hans`, `zh-Hant`). Keys: `dashboard.providers.quota.cost_used`, `cost_note`, `cost_less_than`. Run `bun run i18n:compile`.

## Retention

| Window | Coverage |
| --- | --- |
| 5h / 7d | Full, if aio-proxy was recording |
| 30d billing | Full only if this instance recorded the whole cycle inside the 45-day file |
| Longer than 45d | Only leftover history |

Copy must not imply a complete vendor invoice.

## Error cases

| Case | Result |
| --- | --- |
| No `resetsAt` / `windowMinutes`, or window bounds fail the checks above | No row |
| No priced successful roots in range | No row (not `$0.00`) |
| Quota read 404 / 502 | Unchanged; no estimates |
| Stale snapshot with still-valid bounds | Show Used $x for that stored window |
| Overlapping 5h and weekly | Both rows; overlapping dollars |
| Plugin with amounts we do not display yet | Local-$ row only |

## Testing

Behavior-level, colocated:

- `providerWindowCost` returns one aggregate, not N traces; failed / unpriced roots are excluded; empty / unpriced range is `undefined`.
- Route attaches `estimates` for any OAuth quota window with usable bounds; never branches on plugin package name.
- Dialog shows Used $x under a matching window, hides it otherwise, and does not render Est. total.
- Compact `<$0.01` for a positive sub-cent sum.

No tests that restate ChatGPT item IDs or model regexes: those rules are not in this design.

## Files

- `packages/core/src/db/trace-store/` — `providerWindowCost` on `TraceStore`
- `packages/server/src/dashboard-routes/provider-routes/provider-routes.ts` — attach `estimates`
- `packages/dashboard/src/modules/providers/components/provider-quota-ring/provider-quota-item.tsx` — the row
- `packages/i18n/messages/*.json` — three keys, five locales

No edits under `packages/plugin-sdk` or `packages/plugins/*`.

## Changeset

One `minor` note targeting `aio-proxy` plus every internal package touched (`@aio-proxy/core`, `@aio-proxy/server`, `@aio-proxy/dashboard`, `@aio-proxy/i18n`). Same bump. No `@aio-proxy/plugin-sdk` changeset. User-facing: quota details show this instance’s API-equivalent spend for each window; it is not the vendor balance.

## Out of scope later

Plugin `amounts` / `usageAttribution`, Cursor / Grok official used/limit in the dialog, raising 45-day retention, fake totals, ring dollars.
