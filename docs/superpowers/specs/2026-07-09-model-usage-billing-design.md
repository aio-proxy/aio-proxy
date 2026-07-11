# Model Usage Billing Design

## Goal

Add an observational usage ledger for aio-proxy model calls. The ledger records token usage and estimated cost for successful requests that return usage data. It does not enforce budgets, deduct balances, or block traffic.

## Scope

- One routed inbound request produces one request-log row, regardless of fallback count.
- Successful final attempts may additionally produce one usage row keyed by request id.
- Failed attempts are retained only in ordered request-log metadata and do not contribute token or cost metrics.
- Dashboard ranges are 24h, 7d, 14d, and 30d; 24h uses hourly buckets and the remaining ranges use server-local calendar-day buckets.
- The Dashboard root shows known estimated cost plus pricing coverage, requests, input+output tokens, Average RPM, Average TPM, success rate, and a metric/grouping-switchable stacked chart.
- The standalone Usage route and recent-request table are removed.

## Dashboard Filter Controls

- One Jotai atom is the source of truth for `{ range, metric, groupBy }`, with defaults `24h`, `cost`, and `model`.
- The range control is a Base UI segmented Tabs group above the overview content because range affects both summary cards and the chart.
- Metric and grouping controls are separate Base UI segmented Tabs groups inside the chart header because they affect only the stacked chart.
- The exact tab values are `24h/7d/14d/30d`, `cost/tokens/requests`, and `model/provider`.
- Changing any tab updates the Jotai atom and therefore the TanStack Query key; no submit action or TanStack Form is involved.
- On narrow screens, each tab list remains one line and can scroll horizontally rather than collapsing into a Select.
- Dashboard time labels are formatted from canonical ISO bucket keys with `date-fns`; hourly labels include a numeric UTC offset so repeated DST wall-clock hours remain distinct.

Metric naming and retry semantics were compared against `docs/research/usage-metrics-comparison.md`.

## Price Source

Prices come from `https://models.dev/api.json`, using the `openrouter.models` entries. Each model entry has an `id` and a `cost` object. aio-proxy treats these prices as USD per 1 million tokens.

The runtime fetches prices lazily on first need and keeps them in memory for 6 hours. After the TTL expires, the next request that needs pricing refreshes the catalog. If the fetch or parse fails, the request still succeeds and usage is recorded without `estimatedCostUsd`.

Model price matching is deterministic:

1. Match the routed upstream `modelId` against the full OpenRouter model id.
2. If that fails, match by unique bare model id after the slash. For example, `gpt-5.5` matches `openai/gpt-5.5`.
3. If no match exists, record usage without cost.

No fuzzy matching, provider guessing, or fallback price is used.

## Usage Data

Extend `UsageRowSchema` so usage can represent every token dimension aio-proxy can observe:

- `providerId`
- `modelId`
- `inputTokens`
- `outputTokens`
- `totalTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `reasoningTokens`
- `priceModelId`
- `estimatedCostUsd`

`inputTokens`, `outputTokens`, and `totalTokens` remain non-negative integers when present. Cache and reasoning fields are optional because not every provider returns them.

Cost calculation uses only known token dimensions:

- `inputTokens * cost.input`
- `outputTokens * cost.output`
- `cacheReadTokens * cost.cache_read`
- `cacheWriteTokens * cost.cache_write`
- `reasoningTokens * cost.reasoning`

Each component is divided by 1,000,000. Missing token counts or missing price fields contribute nothing. If every price component needed for the observed usage is missing, `estimatedCostUsd` is omitted.

## Recording Flow

Add one shared server-side recorder instead of duplicating accounting logic in each route.

For AI SDK and cross-protocol routes, wrap the stream returned by `provider.invoke()`. The wrapper passes every part through unchanged, captures the final usage from the `finish` part, calculates estimated cost, and writes a ledger row after the stream completes.

For raw API passthrough routes, wrap the upstream response body with one pull-driven reader. Forward every chunk and cancellation reason unchanged while accumulating bytes only until normal completion, then parse protocol usage best-effort:

- OpenAI Chat Completions JSON and SSE usage.
- OpenAI Responses JSON and SSE usage.
- Anthropic Messages JSON and SSE usage.
- Gemini generateContent JSON and SSE usage metadata.

Parsing failures are ignored. A parse failure must not change the client response.

## Error Handling

Accounting must never make a successful provider response fail. Database insert failures, pricing fetch failures, and passthrough parse failures are swallowed after optional internal logging. The client response path remains the source of truth.

## Assumptions

- `estimatedCostUsd` is stored as a JavaScript number and SQLite `real`.
- `models.dev` prices are interpreted as USD per 1 million tokens.
- Context tier pricing is not applied unless a later implementation has enough request context to choose the tier deterministically.
- Request-log and usage rows are retained for 45 days. Pruning runs at startup and at most once per 24 hours during later writes.
