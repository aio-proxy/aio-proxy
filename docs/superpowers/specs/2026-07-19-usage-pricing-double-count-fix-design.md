# Usage Pricing Double-Count Fix Design

## Goal

Stop overestimating `estimatedCostUsd` when OpenAI / Gemini report cache (and reasoning / thoughts) as **subsets of** inclusive prompt / completion totals. Align billable math with Claude Code Hub (CCH) and new-api. Anthropic paths stay unchanged.

## Problem

Today `calculateEstimatedCost` sums five buckets independently:

```text
input + output + cacheRead + cacheWrite + reasoning
```

That matches Anthropic (mutually exclusive buckets). It double-counts for:

1. **Cache (primary):** OpenAI `prompt_tokens` / Responses `input_tokens` / Gemini `promptTokenCount` **already include** cached tokens. CCH and new-api subtract cache before charging input. aio-proxy charges full input **and** cache again.
2. **Reasoning (secondary):** OpenAI `completion_tokens` usually **includes** `reasoning_tokens`. aio-proxy also multiplies `price.reasoning`. new-api / CCH do not charge a separate reasoning line; Gemini `thoughtsTokenCount` is folded into completion / output once.

## Decisions

| Topic | Choice |
| --- | --- |
| Alignment target | Billable formula of CCH + new-api (not their storage quirks) |
| Stored usage | Keep upstream **raw** token fields |
| When to normalize | Immediately before `calculateEstimatedCost` |
| Historical rows | Forward-only; no backfill |
| Price source | Unchanged (`models.dev` OpenRouter USD / 1M) |
| Multipliers / CPT / group ratio | Out of scope |

## Billable normalization

Add `toBillableUsage(usage, protocol)` in `packages/core/src/usage-pricing.ts`.

| `ProviderProtocol` | Billable input | Billable output | Reasoning |
| --- | --- | --- | --- |
| `OpenAICompatible` | `max(0, input − cacheRead)` | unchanged | **not priced** (subset of completion) |
| `OpenAIResponse` | same | unchanged | **not priced** |
| `Gemini` | same | `output + (reasoning ?? 0)` | **not priced** (merged into output) |
| `Anthropic` | unchanged (already exclusive of cache) | unchanged | none |

`cacheRead` / `cacheWrite` pass through unchanged after input adjustment.

`calculateEstimatedCost` then prices only:

- `inputTokens * price.input`
- `outputTokens * price.output`
- `cacheReadTokens * price.cacheRead`
- `cacheWriteTokens * price.cacheWrite`

It must **not** add `reasoningTokens * price.reasoning`. `OpenRouterModelPrice.reasoning` may remain on the catalog type for forward compatibility but is unused by estimation.

### Reference regression (CCH)

Raw Chat Completions usage:

- `prompt_tokens = 2006`
- `cached_tokens = 1920`
- `completion_tokens = 300`

Billable buckets: `input = 86`, `cacheRead = 1920`, `output = 300`.

Cost:

```text
(86 * input + 1920 * cacheRead + 300 * output) / 1_000_000
```

Stored row still records `inputTokens = 2006`.

## Data flow

```text
passthrough extract / AI SDK finish
        │
        ▼
   UsageRow (raw tokens)  ── persisted as today
        │
        ▼
 priceUsage(usage, catalog, protocol)
        │
        ├─ toBillableUsage(usage, protocol)
        └─ calculateEstimatedCost(billable, price)
        │
        ▼
   estimatedCostUsd + priceModelId on the same UsageRow
```

### Call sites

- **`packages/server/src/usage-capture.ts`**
  - Extend `priceUsage` to take `protocol`.
  - Passthrough already has `protocol`; pass it through.
  - Stream path: extend `StreamUsageOptions` with `protocol`; `attempt.ts` passes `adapter.protocol`.
- **`packages/server/src/passthrough-usage.ts`**
  - No change to raw extraction.
- **Dashboard**
  - No UI change; charts still sum stored tokens and `estimatedCostUsd`.

### Stream / AI SDK note

Inbound `adapter.protocol` is the best available signal at the current call site. Anthropic AI SDK usage is typically already exclusive; subtracting when `cacheRead` is absent is a no-op. If both inclusive totals and cache details are present under an Anthropic-labeled path, clamp keeps input ≥ 0. Refining egress-native semantics is out of scope unless a concrete misbill appears.

## Error handling

Unchanged from the model-usage billing design:

- Pricing / catalog failures must not fail the client response.
- Missing token counts or missing price fields contribute nothing.
- If no priced component applies, omit `estimatedCostUsd`.

## Testing

### Unit — `packages/core/_test/usage-pricing.test.ts`

1. CCH `2006 / 1920 / 300` under OpenAI Compatible → expected cost from exclusive buckets.
2. Anthropic: input + cacheRead both present → input **not** reduced.
3. Gemini: prompt includes cache; thoughts merge into billable output; `price.reasoning` ignored.
4. OpenAI + `reasoningTokens`: cost uses output only (no reasoning line).
5. `cacheRead > input` → billable input `0`.
6. Replace the old “five independent buckets including reasoning” expectation.

### Integration (optional if harness already covers capture)

Passthrough OpenAI SSE with the CCH fixture: persisted `inputTokens === 2006` and `estimatedCostUsd` matches the exclusive formula.

## Non-goals

- Backfilling historical `estimatedCostUsd`
- Adopting new-api quota units, model/group ratios, or CCH CPT tables
- Context-tier / long-context pricing
- Changing dashboard token-display semantics to exclusive buckets
- Renaming or removing catalog `reasoning` price field (unused is enough)

## References

- CCH: `.reference/claude-code-hub/src/app/v1/_lib/proxy/response-handler.ts` (`adjustUsageForProviderType`, Gemini extract + thoughts → output); tests `extract-usage-metrics.test.ts` (`2006/1920/300`)
- new-api: `.reference/new-api/service/text_quota.go` (non-Claude: subtract cache from prompt before base charge); Gemini map folds thoughts into `CompletionTokens`
- Current aio-proxy: `packages/core/src/usage-pricing.ts`, `packages/server/src/usage-capture.ts`, `packages/server/src/passthrough-usage.ts`
- Prior billing design: `docs/superpowers/specs/2026-07-09-model-usage-billing-design.md`
