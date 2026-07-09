# Model Usage Billing Design

## Goal

Add an observational usage ledger for aio-proxy model calls. The ledger records token usage and estimated cost for successful requests that return usage data. It does not enforce budgets, deduct balances, or block traffic.

## Scope

The first version records successful completed requests only when aio-proxy can extract token usage. Failed provider attempts, requests without usage, and responses whose usage cannot be parsed are not written to the ledger.

The cost is an estimate in USD. It is suitable for dashboards and operational visibility, not financial settlement.

Out of scope:

- User accounts, API key attribution, balances, and invoices.
- Budget limits or request rejection based on spend.
- Retention policy, archival, or export.
- Exact billing for price tiers when aio-proxy lacks the information needed to select the tier.

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

For raw API passthrough routes, tee the upstream response body before returning it. The returned branch is sent to the client unchanged. The tracing branch is parsed best-effort for protocol usage shapes:

- OpenAI Chat Completions JSON and SSE usage.
- OpenAI Responses JSON and SSE usage.
- Anthropic Messages JSON and SSE usage.
- Gemini generateContent JSON and SSE usage metadata.

Parsing failures are ignored. A parse failure must not change the client response.

## Storage

Add a SQLite `usage` table through the existing migration system. This is the per-request usage log: each recorded successful request writes one row with both token counts and billing estimate fields.

- `id` text primary key
- `trace_id` text not null
- `provider_id` text not null
- `model_id` text not null
- `price_model_id` text nullable
- `input_tokens` integer nullable
- `output_tokens` integer nullable
- `total_tokens` integer nullable
- `cache_read_tokens` integer nullable
- `cache_write_tokens` integer nullable
- `reasoning_tokens` integer nullable
- `estimated_cost_usd` real nullable
- `created_at` integer timestamp_ms not null

No aggregation tables are created in the first version. Dashboard summaries are computed from recent ledger rows.

## Dashboard

Add `GET /dashboard/api/usage?limit=100`. The response contains:

```ts
{
  summary: {
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    estimatedCostUsd: number;
  };
  rows: UsageLedgerRow[];
}
```

The dashboard gets a Usage page linked from the side menu. The page shows:

- Total estimated cost.
- Total requests with usage.
- Token totals.
- Recent ledger rows grouped by provider and model.

All user-facing copy must come from `packages/i18n/messages/*.json`.

## Error Handling

Accounting must never make a successful provider response fail. Database insert failures, pricing fetch failures, and passthrough parse failures are swallowed after optional internal logging. The client response path remains the source of truth.

## Testing

Add tests for:

- Usage schema roundtrips with cache, reasoning, price model, and cost fields.
- Pricing lookup by full OpenRouter id and by bare id.
- Pricing fetch failure returning usage without cost.
- AI SDK route recording usage after stream completion.
- Raw passthrough JSON and SSE usage recording when usage is present.
- No ledger row for failed provider requests or successful requests without usage.
- Dashboard usage API empty and populated responses.

## Assumptions

- `estimatedCostUsd` is stored as a JavaScript number and SQLite `real`.
- `models.dev` prices are interpreted as USD per 1 million tokens.
- Context tier pricing is not applied unless a later implementation has enough request context to choose the tier deterministically.
- The first version keeps usage rows indefinitely.
