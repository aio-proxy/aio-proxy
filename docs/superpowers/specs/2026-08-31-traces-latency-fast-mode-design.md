# Traces Latency Grades and Fast-Mode Marker

## Goal

`/dashboard/traces` latency coloring measures request efficiency the way new-api usage logs do, and the lightning icon marks an inbound fast/priority request rather than a short duration.

## Background

Current `TraceLatencyCell` uses one wall-clock scale for both duration and TTFT:

- `< 1s` → `bg-primary` plus a Zap icon
- `1s .. < 3s` → `bg-muted-foreground`
- `>= 3s` → `bg-destructive`

That scale over-punishes long generations. The Zap icon is also wrong: it currently means "this finished in under a second", not "the client asked for fast/priority".

new-api (`QuantumNous/new-api`, `.reference/new-api/web/src/features/usage-logs/lib/format.ts`) splits the two:

- First-token color is wall-clock in seconds.
- Total-time color is wall-clock only when output is too small to judge throughput; otherwise it is generated tokens per second.

aio-proxy already stores `durationMs`, optional `ttftMs`, `stream`, and `usage.outputTokens` on `DashboardTraceSummary`. It does **not** currently persist the inbound fast/priority signals.

## Color grades (new-api, ported)

Keep the existing three dashboard tokens. Do not add `--success` / `--warning` CSS.

| Grade | Dot class | Meaning |
|---|---|---|
| `success` | `bg-primary` | healthy |
| `warning` | `bg-muted-foreground` | slow |
| `danger` | `bg-destructive` | too slow |

Convert milliseconds to seconds before comparing (`ms / 1000`). Missing `outputTokens` is treated as `0`.

### TTFT (`getFirstResponseTimeColor`)

Only rendered when `stream` is true and `ttftMs` is present.

- `< 5s` → `success`
- `< 10s` → `warning`
- else → `danger`

### Duration (`getResponseTimeColor`)

- If `outputTokens < 100` or `durationSeconds <= 0`, use wall-clock (`getTimeColor`):
  - `< 10s` → `success`
  - `< 30s` → `warning`
  - else → `danger`
- Else use throughput `outputTokens / durationSeconds` (`getThroughputColor`):
  - `>= 30 t/s` → `success`
  - `>= 15 t/s` → `warning`
  - else → `danger`

Do not color the numeric labels. Only the existing latency dots change. Do not add a TPS column.

## Fast-mode lightning

Show `Zap` iff the inbound request asked for fast/priority. Exact signals, OR'd:

1. JSON body `service_tier` string, trimmed and lowercased, equals `priority`
2. JSON body `speed` string, trimmed and lowercased, equals `fast`
3. Request header `anthropic-beta` includes the substring `fast-mode-2026-02-01`

Do **not** use routing `AliasDimensions.speed`. Protocol adapters map `service_tier: "fast"` onto the speed axis; that must **not** light the icon. `service_tier: "flex" | "fast" | "standard"` and `speed: "standard" | "flex"` stay unmarked unless one of the three signals above is present.

Persist a root-span boolean `aio_proxy.request.fast = true` only when the request matched. Omit the attribute otherwise. Project it onto `DashboardTraceSummary.fast` the same way `stream` is projected from `aio_proxy.request.stream`.

The traces table reads `row.original.fast`. Duration must not control the icon.

## Non-goals

- Recreating new-api's full-height timing bar or colored numeric text
- Persisting raw `service_tier` / `speed` / beta header strings
- Changing provider routing, alias matching, or billed cost
- Backfilling historical traces that were stored without `aio_proxy.request.fast`

## Sources

- `.reference/new-api/web/src/features/usage-logs/lib/format.ts` (`getTimeColor`, `getFirstResponseTimeColor`, `getThroughputColor`, `getResponseTimeColor`)
- `.reference/new-api/web/src/features/usage-logs/components/timing-metrics-cell.tsx`
- `packages/dashboard/src/modules/traces/components/trace-latency-cell/trace-latency-cell.tsx`
