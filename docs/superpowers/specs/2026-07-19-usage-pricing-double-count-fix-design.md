# Usage Pricing Double-Count Fix Design

## Goal

Stop overestimating `estimatedCostUsd` when cache and reasoning/thoughts are reported as subsets of inclusive totals. Align billable math with Claude Code Hub (CCH) and new-api for **raw passthrough** inclusion rules, and with AI SDK v4 token semantics for the **stream** path. Anthropic **raw** passthrough stays exclusive (no cache subtract). Never undercharge by subtracting subset tokens that then have no catalog price; when a dedicated subset price exists, use price-aware substitution instead of double-count or silent discard.

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

Using **inbound** `adapter.protocol` as the billing key is wrong for the stream path: cross-protocol routing would bill the same upstream usage differently, Anthropic AI SDK would still double-count cache, and Gemini AI SDK would double-count thoughts if we naively added reasoning on top of inclusive output.

### Missing subset prices (blocker if ignored)

`models.dev` OpenRouter often ships `input` without `cache_read` / `cache_write` (review sample: 160 of 339 priced models lack `cache_read`, including `openai/gpt-5.5-pro`). Blindly subtracting cache from input then skipping unpriced cache lines would undercharge (e.g. 2006/1920 → only 86 input tokens billed).

Some models also publish a dedicated `reasoning` price (review sample: 16 models). Example: `perplexity/sonar-deep-research` has `output=$8/M`, `reasoning=$3/M`. Leaving all completion tokens on the output line overcharges when a cheaper reasoning rate exists; adding reasoning **on top of** inclusive output double-counts.

CCH / new-api always charge after cache subtract (CCH invents `input×0.1`; new-api unknown cache ratio → `1.0`) and fold thoughts into completion without a separate reasoning line. aio-proxy keeps models.dev absolute prices and does **not** invent missing rates. Policy: **price-aware substitution** for cache and reasoning.

## Decisions

| Topic | Choice |
| --- | --- |
| Alignment target | CCH/new-api **inclusion** for raw passthrough; AI SDK totals for stream; models.dev unit prices with price-aware subset handling |
| Normalization key | **Usage source** (+ raw upstream protocol), **not** inbound adapter protocol alone |
| Missing cache / reasoning unit price | **Only peel that subset when its price exists**; else leave tokens in the parent bucket |
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
2. Sum available lines:
   - `inputTokens * price.input`
   - `outputTokens * price.output`
   - `cacheReadTokens * price.cacheRead` (only present in billable when that price existed)
   - `cacheWriteTokens * price.cacheWrite` (same)
   - `reasoningTokens * price.reasoning` (only present in billable when that price existed)
3. Catalog may still list unused fields; unpriced subsets remain inside parent buckets.

### Price-aware peel (shared helper semantics)

For a parent total `P` and subset count `S` with unit price `U`:

- If `U` is a finite number and `S` is defined → billable parent `max(0, P − S)`, billable subset `S`.
- If `U` is missing → leave `S` inside `P`; omit the subset line.

Apply independently to:

- inclusive **input** vs `cacheRead` / `cacheWrite`
- inclusive **output** vs `reasoning` (when reasoning is a subset of that output total)

Exclusive Anthropic passthrough never peels cache from input.

### Rules — `source: "passthrough"`

| `protocol` | Billable input | Billable output / reasoning |
| --- | --- | --- |
| `OpenAICompatible` / `OpenAIResponse` | peel priced `cacheRead` (and `cacheWrite` if present) from inclusive prompt/input | peel priced `reasoning` from inclusive completion/output; else keep full output |
| `Gemini` | peel priced `cacheRead` from inclusive prompt | Raw extractor keeps `candidates` and `thoughts` split. If `price.reasoning` exists → output = candidates, charge thoughts on reasoning line. If missing → `output = candidates + thoughts`, no reasoning line (CCH/new-api fold). |
| `Anthropic` | unchanged (already exclusive of cache) | unchanged; no reasoning peel |

### Rules — `source: "ai-sdk"`

Independent of inbound protocol (same upstream ⇒ same cost):

| Field | Billable rule |
| --- | --- |
| input | peel priced `cacheRead` and priced `cacheWrite` from inclusive total |
| output / reasoning | peel priced `reasoning` from inclusive output total; if reasoning price missing, leave thoughts/reasoning inside output (Google already folded them into `outputTokens.total`) |
| cacheRead / cacheWrite | charged only when unit price exists (else left in input) |

Rationale vs installed converters:

- Anthropic AI SDK inflates `inputTokens.total` with cache read **and** write → peel each only when priced.
- Google AI SDK already folds thoughts into `outputTokens.total` → never **add** reasoning on top; only **split** when `price.reasoning` exists.

### Reference regressions

**CCH raw OpenAI, `cacheRead` priced:** `prompt=2006`, `cached=1920`, `completion=300`

- Billable: `input=86`, `cacheRead=1920`, `output=300`
- Stored: `inputTokens=2006`

**Same tokens, `cacheRead` missing, `input` priced:**

- Billable: `input=2006` (no cache line)

**Inclusive output with reasoning, `reasoning` priced (e.g. output=$8, reasoning=$3):** `output=1000`, `reasoning=400`

- Billable: `output=600` @ $8, `reasoning=400` @ $3
- If `reasoning` price missing → billable `output=1000` @ $8

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
- Missing **parent** prices still skip that line; peel decisions only consult the subset unit prices
- If no priced component applies after normalization, omit `estimatedCostUsd`
- Clamp keeps peeled parents ≥ 0 when subset counts exceed the parent total

## Testing

### Layout (repo convention)

1. Move core pricing to `packages/core/src/usage-pricing/` as above; delete `packages/core/_test/usage-pricing.test.ts`.
2. Move server capture to `packages/server/src/usage-capture/`; migrate `describe("usage capture")` out of `packages/server/_test/request-recorder.test.ts` into `usage-capture.test.ts`. Update imports to the directory index. Leave unrelated request-recorder cases in place.
3. Ensure package `test:unit` scripts pick up colocated `*.test.ts` (no `_test/`-only filter blocking new paths).

### Unit — `usage-pricing.test.ts`

1. Passthrough OpenAI CCH `2006/1920/300` **with** `cacheRead` price → exclusive cost
2. Same fixture **without** `cacheRead` price → billable input stays `2006`
3. Passthrough Anthropic: input + cacheRead both charged; input **not** reduced when cacheRead is priced
4. Passthrough Gemini: priced cache peeled; thoughts → output when reasoning unpriced; thoughts on reasoning line when priced
5. OpenAI / AI SDK inclusive output + reasoning **with** reasoning price → output reduced, reasoning charged
6. Same **without** reasoning price → full output at output price; no reasoning line
7. AI SDK Anthropic-shaped usage: inclusive input with priced cache read+write → both peeled; missing write price → write tokens stay in input
8. AI SDK Gemini-shaped usage: inclusive output + reasoning detail, reasoning **unpriced** → output unchanged (no double add)
9. Subset counts `>` parent with prices → parent billable `0`
10. Replace old “five independent buckets including reasoning always added” expectation

### Server stream / capture tests (required)

In `packages/server/src/usage-capture/usage-capture.test.ts` (migrated + extended):

1. **Gemini AI SDK fixture:** thoughts in both `outputTokens` and `reasoningTokens`, reasoning **unpriced** → cost does not double-count thoughts
2. **Anthropic AI SDK fixture:** inclusive input with priced cache read + write → cost peels both from input once
3. Passthrough OpenAI SSE: stored `inputTokens === 2006` and cost matches exclusive formula when `cacheRead` is priced
4. Passthrough OpenAI with cache tokens but **no** `cacheRead` catalog price → cost does not drop to uncached remainder only
5. Optional: stream fixture with priced `reasoning` → output/reasoning split appears in `estimatedCostUsd`

Do **not** add a dual-inbound-protocol test at the `usageCapture.stream` seam: that API does not take inbound protocol, so two calls are identical and prove nothing about routing. A pipeline dual-adapter harness is out of scope for this fix; the invariant is enforced by stream always using `source: "ai-sdk"`.

## Non-goals

- Backfilling historical `estimatedCostUsd`
- Inventing CCH `0.1×` / new-api ratio tables when models.dev omits cache prices
- new-api quota units, model/group ratios, or CCH CPT tables
- Context-tier / long-context pricing
- Changing dashboard token-display semantics to exclusive buckets
- Pipeline-level dual-adapter cost equality harness
- Inferring per-package AI SDK egress type beyond the shared AI SDK totalUsage contract

## References

- CCH: `.reference/claude-code-hub/.../response-handler.ts` (`adjustUsageForProviderType`); cost fallbacks in `cost-calculation.ts` (`cache_read → input×0.1`); `extract-usage-metrics.test.ts` (`2006/1920/300`)
- new-api: `.reference/new-api/service/text_quota.go` (non-Claude subtract cache); `GetCacheRatio` default `1.0` when unknown; Gemini folds thoughts into `CompletionTokens`
- Installed AI SDK: `node_modules/@ai-sdk/anthropic/dist/index.js` (`convertAnthropicUsage`); `node_modules/@ai-sdk/google/dist/index.js` (`convertGoogleUsage`)
- aio-proxy: `packages/core/src/usage-pricing.ts`, `packages/server/src/usage-capture.ts`, `packages/server/src/passthrough-usage.ts`
- Test layout: `AGENTS.md` colocated `_test/` migration rule
- Prior billing design: `docs/superpowers/specs/2026-07-09-model-usage-billing-design.md`
