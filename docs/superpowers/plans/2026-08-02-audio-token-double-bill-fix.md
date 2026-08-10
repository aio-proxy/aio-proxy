# Fix: audio tokens double-billed in usage pricing

## Problem (CONFIRMED, money-affecting)

`calculateEstimatedCost` in `packages/core/src/usage-pricing/usage-pricing.ts` bills audio
tokens **on top of** the full input/output token cost, instead of peeling them out of the
parent totals the way `cacheRead`/`cacheWrite`/`reasoning` subsets are peeled.

In real OpenAI-compatible Chat Completions usage, `prompt_tokens_details.audio_tokens` is a
**subset** of `prompt_tokens` (and `completion_tokens_details.audio_tokens` ⊆
`completion_tokens`) — the same relationship as `cached_tokens`/`reasoning_tokens`. Our capture
layer (`packages/server/src/passthrough-usage/usage.ts`) reads audio only from the
OpenAI-compatible path, which is exactly the path that routes through `inclusiveBillableUsage`.

### Current (buggy) flow
- `inclusiveBillableUsage` peels cache/reasoning from `inputTokens`/`outputTokens` → `billable.*`.
- Lines 133-137 bill the peeled `billable.*` at text/cache/reasoning rates.
- Lines 138-139 bill **raw** `usage.inputAudioTokens`/`usage.outputAudioTokens` at the audio rate.
- The audio tokens are still counted inside `billable.inputTokens`/`billable.outputTokens`, so
  they get billed at BOTH the text rate and the audio rate.

### Failure scenario
`prompt_tokens: 1000`, `prompt_tokens_details.audio_tokens: 800`, `input: 2`, `inputAudio: 40`
(USD/1M). Correct = `200*2 + 800*40 = 32,400` micros. Current = `1000*2 + 800*40 = 34,000` micros.
Over-bills by `audioTokens * inputRate` on every audio request.

## Chosen fix (user: 剥离后计费 / peel-then-bill)

Mirror the existing cache/reasoning peeling exactly:

1. **`inclusiveBillableUsage`** — add `inputAudioTokens`/`outputAudioTokens` as subsets peeled
   from their parents:
   - peel `inputAudioTokens` (priced by `price.inputAudio`) from `inputTokens`, alongside the
     existing cacheRead/cacheWrite peels.
   - peel `outputAudioTokens` (priced by `price.outputAudio`) from `outputTokens`, alongside the
     existing reasoning peel.
   - carry the audio counts onto the returned billable object, gated by `pricedSubset` (only when
     the audio rate is finite) — same conditional-spread pattern as cacheRead/reasoning. This
     yields the existing "no audio rate → audio tokens stay in the parent at text rate" behavior
     for free (equivalent to the recommended option; no separate audio fee when unpriced).

2. **`calculateEstimatedCost`** — bill `billable.inputAudioTokens`/`billable.outputAudioTokens`
   instead of raw `usage.inputAudioTokens`/`usage.outputAudioTokens` (lines 138-139).

3. **Anthropic / Gemini paths** — audio is never captured on those protocols, so
   `usage.*AudioTokens` is always `undefined` there; billing `billable.*Audio` (undefined) is a
   no-op. To keep `calculateEstimatedCost` uniform, the Anthropic `return usage` and the Gemini
   branch pass audio through untouched (undefined in practice). No behavior change for them.

## Files

- `packages/core/src/usage-pricing/usage-pricing.ts` — peel audio in `inclusiveBillableUsage`;
  bill `billable.*Audio` in `calculateEstimatedCost`. Small, localized.

## Tests

- `packages/core/src/usage-pricing/usage-pricing.test.ts` (or the ai-sdk sibling) — add:
  - **subset peel**: `inputTokens: 1000, inputAudioTokens: 800`, `input: 2, inputAudio: 40` →
    `200*2 + 800*40 = 32,400` micros (proves audio peeled from parent, billed once).
  - **output audio peel** symmetric case.
  - **unpriced audio stays in parent**: audio tokens present, no `inputAudio` rate → billed at
    text rate only, no separate audio line (mirrors the cacheRead-missing test).
  - **clamp at zero**: `inputAudioTokens > inputTokens` → parent clamps to 0 (reuses `peelSubsets`
    `Math.max(0, …)`), audio billed on the real count.
- `packages/server/src/usage-capture/usage-capture.pricing.fees.test.ts` — FIX the masking test:
  the current `inputTokens: 100, inputAudioTokens: 1000` is physically impossible (audio > total).
  Rewrite with a realistic subset (`inputTokens: 1000, inputAudioTokens: 800`, etc.) and correct
  the expected total to the peeled figure. Keep the image/webSearch fee assertions (those are
  per-event, not token subsets — unaffected).

## Out of scope / confirmed clean by review

- Feature B (`metadata.extend`) inheritance wiring — clean; inherited cost carries audio/fee rates
  correctly through `configModelPrice`. Once this fix lands, inherited audio pricing is also
  correct (same code path).
- `mergeWith` aliasing, event-counts guards, snapshot wiring — all reviewed clean.
- Array-replace customizer aliases the user's array into merged metadata, but the original config
  is discarded post-`buildSnapshot` and consumers only read — benign, no fix.

## Verification

- `bunx turbo run build --filter=@aio-proxy/types --filter=@aio-proxy/core`
- `cd packages/core && bun test src/usage-pricing/`
- `cd packages/server && bun test src/usage-capture/`
- `bun run lint:types` (only known monaco/dashboard noise), `bun run format:check`.

## Changeset

Amend / add: the fee/audio changeset (`.changeset/usage-fee-inputs-wiring.md`) already targets the
fee wiring. Add a `fix:` line (or a new changeset) targeting `aio-proxy` + `@aio-proxy/core`
noting audio tokens are now peeled from the parent totals (no double-bill). Since the fee wiring
shipped in this same branch and was never released, folding the fix into the existing changeset is
cleanest — the net user-visible behavior is "audio billed correctly", one note.
