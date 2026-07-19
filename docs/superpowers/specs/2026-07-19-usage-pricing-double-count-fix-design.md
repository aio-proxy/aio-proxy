# Usage Pricing Double-Count Fix Design

## Goal

Stop overestimating `estimatedCostUsd` when cache and reasoning/thoughts are reported as subsets of inclusive totals. Align billable math with Claude Code Hub (CCH) and new-api for **raw passthrough**, and with AI SDK v4 token semantics for the **stream** path. Anthropic **raw** passthrough stays exclusive (no subtract). Never undercharge by subtracting cache tokens that then have no catalog price.

## Problem

Today `calculateEstimatedCost` sums five buckets independently:

```text
input + output + cacheRead + cacheWrite + reasoning
```

That double-counts whenever a parent total already includes a detail bucket.

### Two usage sources, two inclusion models

| Source | How tokens arrive | Inclusion reality (verified on installed AI SDK 4.x) |
| --- | --- | --- |
| **Raw passthrough** | Protocol-native fields via `passthrough-usage.ts` | OpenAI/Gemini: prompt includes cache; Anthropic: input vs cache are exclusive; Gemini raw keeps `candidates` and `thoughts` separate |
| **AI SDK stream** | `finish.totalUsage` via `normalizeAiSdkUsage` | `@ai-sdk/anthropic`: `inputTokens.total = noCache + cacheRead + cacheWrite`; `@ai-sdk/google`: `outputTokens.total = candidates + thoughts`, and reasoning details also expose thoughts |

Using **inbound** `adapter.protocol` as the billing key is wrong for the stream path: cross-protocol routing would bill the same upstream usage differently, Anthropic AI SDK would still double-count cache, and Gemini AI SDK would double-count thoughts if we did `output + reasoning`.

### Missing cache prices (blocker if ignored)

`models.dev` OpenRouter often ships `input` without `cache_read` / `cache_write` (review sample: 160 of 339 priced models lack `cache_read`, including `openai/gpt-5-pro`). Blindly subtracting cache from input then skipping unpriced cache lines would undercharge (e.g. 2006/1920 → only 86 input tokens billed).

CCH and new-api always charge after subtract: CCH invents `input×0.1` / write `×1.25`; new-api uses per-model cache ratios (unknown → ratio `1.0`). aio-proxy does **not** invent catalog rates. Policy below is price-aware subtract.

## Decisions

| Topic | Choice |
| --- | --- |
| Alignment target | CCH/new-api math for raw passthrough inclusion; AI SDK totals for stream; **no** invented cache ratios |
| Normalization key | **Usage source** (+ raw upstream protocol), **not** inbound adapter protocol alone |
| Missing cache unit price | **Only subtract that bucket when its price exists**; else leave those tokens in input |
| Normalization owner | `calculateEstimatedCost` only; `toBillableUsage` stays private |
| Stored usage | Keep upstream / AI SDK **raw** totals as recorded today |
| When to normalize | Inside `calculateEstimatedCost`, immediately before summing |
| Historical rows | Forward-only; no backfill |
| Price source | Unchanged (`models.dev` OpenRouter USD / 1M) |
| Multipliers / CPT / group ratio | Out of scope |

## Billable normalization

### Module layout

```text
packages/core/src/usage-pricing/
  index.ts              # public re-exports
  usage-pricing.ts      # implementation (private toBillableUsage)
  usage-pricing.test.ts
```

```text
packages/server/src/usage-capture/
  index.ts              # public re-exports
  usage-capture.ts      # createUsageCapture + priceUsage wiring
  usage-capture.test.ts # migrate describe("usage capture") from request-recorder.test.ts
```

### API shape

```ts
type UsageAccounting =
  | { readonly source: "passthrough"; readonly protocol: ProviderProtocol }
  | { readonly source: "ai-sdk" };

function calculateEstimatedCost(
  usage: UsagePricingInput,
  price: OpenRouterModelPrice,
  accounting: UsageAccounting,
): UsageCostResult | undefined;
```

`toBillableUsage(usage, price, accounting)` is **private** to the module. Callers (including `priceUsage`) must **not** pre-normalize. Public surface stays `calculateEstimatedCost` + types + catalog helpers.

`calculateEstimatedCost` flow:

1. `billable = toBillableUsage(usage, price, accounting)` (price-aware)
2. Sum only:
   - `inputTokens * price.input`
   - `outputTokens * price.output`
   - `cacheReadTokens * price.cacheRead` (only if that price exists — otherwise those tokens stayed in input)
   - `cacheWriteTokens * price.cacheWrite` (same)
3. **Never** add `reasoningTokens * price.reasoning`. Catalog may still carry `reasoning` unused.

### Price-aware subtract (all inclusive sources)

For each of `cacheRead` / `cacheWrite` independently:

- If the corresponding `price.cacheRead` / `price.cacheWrite` is a finite number → subtract that token count from inclusive input (clamped ≥ 0), and later charge the cache line at that unit price.
- If the unit price is missing → **do not subtract**; those tokens remain in `input` and are charged at `price.input` when present.
- Exclusive Anthropic passthrough never subtracts either way.

This avoids both double-count (when catalog has cache prices) and undercharge (when it does not).

### Rules — `source: "passthrough"`

| `protocol` | Billable input | Billable output | Reasoning |
| --- | --- | --- | --- |
| `OpenAICompatible` / `OpenAIResponse` | price-aware: subtract priced `cacheRead` only | unchanged | **not priced** |
| `Gemini` | price-aware: subtract priced `cacheRead` only | `output + (reasoning ?? 0)` | **not priced** (merged into output; raw extractor keeps them split) |
| `Anthropic` | unchanged | unchanged | none |

`cacheWrite` is rare on OpenAI/Gemini raw extractors; if present, same price-aware rule applies.

### Rules — `source: "ai-sdk"`

Independent of inbound protocol (same upstream ⇒ same cost):

| Field | Billable rule |
| --- | --- |
| input | price-aware: subtract priced `cacheRead` and priced `cacheWrite` from inclusive total |
| output | unchanged (`total` already includes thoughts when present) |
| cacheRead / cacheWrite | charged only when unit price exists (else left in input) |
| reasoning | **not priced** |

Rationale vs installed converters:

- Anthropic AI SDK inflates `inputTokens.total` with cache read **and** write → remove each **only when priced**.
- Google AI SDK already folds thoughts into `outputTokens.total` → do **not** add reasoning again.

### Reference regression (CCH raw OpenAI, catalog has cacheRead)

Raw Chat Completions: `prompt=2006`, `cached=1920`, `completion=300`, with `price.cacheRead` present.

- Billable: `input=86`, `cacheRead=1920`, `output=300`
- Stored: `inputTokens=2006` still

Same tokens with `price.cacheRead` **missing** and `price.input` present:

- Billable: `input=2006`, no cacheRead line → charge full prompt at input price (no invented 0.1×)

## Data flow

```text
passthrough extract / AI SDK finish
        │
        ▼
   UsageRow (raw tokens)  ── persisted as today
        │
        ▼
 priceUsage(usage, catalog, accounting)
        │
        └─ calculateEstimatedCost(usage, price, accounting)
              └─ (private) toBillableUsage(usage, price, accounting)
        │
        ▼
   estimatedCostUsd (+ priceModelId) on the same UsageRow
```

`priceUsage` does **not** call `toBillableUsage` itself.

### Call sites

- **`packages/server/src/usage-capture/`**
  - `passthrough(...)`: `accounting = { source: "passthrough", protocol }`
  - `stream(...)`: `accounting = { source: "ai-sdk" }` — **do not** pass inbound `adapter.protocol` for billing
- **`packages/server/src/passthrough-usage.ts`**: no raw extraction change
- **`attempt.ts`**: no protocol-for-billing plumbing on stream; passthrough already has protocol
- **Dashboard**: unchanged UI; still shows raw tokens + new cost

## Error handling

- Pricing / catalog failures must not fail the client response
- Missing token counts contribute nothing
- Missing **parent** prices (e.g. no `input`) still skip that line; price-aware subtract only consults cache unit prices
- If no priced component applies after normalization, omit `estimatedCostUsd`
- Clamp keeps billable input ≥ 0 when priced cache details exceed the parent total

## Testing

### Layout (repo convention)

1. Move core pricing to `packages/core/src/usage-pricing/` as above; delete `packages/core/_test/usage-pricing.test.ts`.
2. Move server capture to `packages/server/src/usage-capture/`; migrate `describe("usage capture")` out of `packages/server/_test/request-recorder.test.ts` into `usage-capture.test.ts`. Update imports (`../usage-capture` → directory index). Leave unrelated request-recorder cases in place.
3. Ensure package `test:unit` scripts pick up colocated `*.test.ts` (core already uses `bun test`; server likewise — verify no `_test/`-only filter blocks the new paths).

### Unit — `usage-pricing.test.ts`

1. Passthrough OpenAI CCH `2006/1920/300` **with** `cacheRead` price → exclusive cost; reasoning ignored if present
2. Same fixture **without** `cacheRead` price → billable input stays `2006`; cost uses input price only for those tokens (no undercharge)
3. Passthrough Anthropic: input + cacheRead both charged; input **not** reduced even when cacheRead is priced
4. Passthrough Gemini: priced cache subtracted; thoughts merged into billable output; `price.reasoning` unused
5. AI SDK Anthropic-shaped usage: inclusive input with priced cache read+write → both subtracted once; missing write price → write tokens stay in input
6. AI SDK Gemini-shaped usage: `output` already includes thoughts + reasoning detail present → output not increased; reasoning unused
7. `cacheRead (+ cacheWrite) > input` with prices → billable input `0`
8. Replace old “five independent buckets including reasoning” expectation

### Server stream / capture tests (required)

In `packages/server/src/usage-capture/usage-capture.test.ts` (migrated + extended):

1. **Gemini AI SDK fixture:** thoughts in both `outputTokens` and `reasoningTokens` → cost does not double-count thoughts
2. **Anthropic AI SDK fixture:** inclusive input with priced cache read + write → cost subtracts both from input once
3. **Same AI SDK usage, two inbound protocols** must not matter: stream capture uses `source: "ai-sdk"` only → **identical** `estimatedCostUsd`
4. Passthrough OpenAI SSE: stored `inputTokens === 2006` and cost matches exclusive formula when `cacheRead` is priced
5. Passthrough OpenAI with cache tokens but **no** `cacheRead` catalog price → cost does not drop to uncached remainder only

## Non-goals

- Backfilling historical `estimatedCostUsd`
- Inventing CCH `0.1×` / new-api ratio tables when models.dev omits cache prices
- new-api quota units, model/group ratios, or CCH CPT tables
- Context-tier / long-context pricing
- Changing dashboard token-display semantics to exclusive buckets
- Removing catalog `reasoning` price field
- Inferring per-package AI SDK egress type beyond the shared AI SDK totalUsage contract

## References

- CCH: `.reference/claude-code-hub/.../response-handler.ts` (`adjustUsageForProviderType`); cost fallbacks in `cost-calculation.ts` (`cache_read → input×0.1`); `extract-usage-metrics.test.ts` (`2006/1920/300`)
- new-api: `.reference/new-api/service/text_quota.go` (non-Claude subtract cache); `GetCacheRatio` default `1.0` when unknown; Gemini folds thoughts into `CompletionTokens`
- Installed AI SDK: `node_modules/@ai-sdk/anthropic/dist/index.js` (`convertAnthropicUsage`); `node_modules/@ai-sdk/google/dist/index.js` (`convertGoogleUsage`)
- aio-proxy: `packages/core/src/usage-pricing.ts`, `packages/server/src/usage-capture.ts`, `packages/server/src/passthrough-usage.ts`
- Test layout: `AGENTS.md` colocated `_test/` migration rule
- Prior billing design: `docs/superpowers/specs/2026-07-09-model-usage-billing-design.md`
