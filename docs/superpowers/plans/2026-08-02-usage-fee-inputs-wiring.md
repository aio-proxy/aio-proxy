# Plan: Wire per-event & audio usage inputs into billing capture

Date: 2026-08-02
Follow-up to: `2026-08-02-provider-model-metadata.md` (same branch `claude/epic-kapitsa-8ee712`)
Issue context: closes the "half-wired fee machinery" gap surfaced by the final whole-branch review.

## Problem

T3 of the provider-model-metadata feature extended `calculateEstimatedCost`
(`packages/core/src/usage-pricing/usage-pricing.ts`) to price:

- split audio tokens — `usage.inputAudioTokens` / `usage.outputAudioTokens` via `tokenPrice.inputAudio` / `outputAudio` (lines 138-139),
- per-event fees — `usage.imageCount` × `price.image`, `usage.webSearchCount` × `price.webSearch` (lines 141-142),
- request fee — once (line 143).

But nothing on the capture side ever produces those inputs:

- `UsageRow` (`packages/types/src/usage.ts`) has no `inputAudioTokens` / `outputAudioTokens` / `imageCount` / `webSearchCount` fields.
- `pricingInput()` (`packages/server/src/usage-capture/pricing.ts:64`) forwards only the five token fields.
- The passthrough usage extractor (`packages/server/src/passthrough-usage/usage.ts`) reads only token fields from the upstream `usage` object.
- The stream capture (`packages/server/src/usage-capture/stream-capture.ts`) consumes only the AI SDK `finish` part (`totalUsage` — token-only).

So `cost.image` / `cost.webSearch` / audio-rate config keys currently bill $0 with no warning. Only token and `request` costs are reachable. **Request fee is already wired** (T3 line 143) and stays as-is.

## Research grounding (how upstreams actually expose these — cited)

- **Audio tokens.** Present ONLY in OpenAI **Chat Completions** usage: `usage.prompt_tokens_details.audio_tokens` and `usage.completion_tokens_details.audio_tokens` (OpenAI `CompletionUsage` type). The **Responses** API `ResponseUsage` has NO audio field (only `cached_tokens` / `cache_write_tokens` / `reasoning_tokens`). Anthropic / Gemini usage have no audio breakdown. → audio extraction is meaningful only for the `OpenAICompatible` passthrough protocol.
- **Image count.** NOT in any provider's `usage` object. new-api derives it by parsing response `Output[]` items (`image_generation_call`) or the request `N` (`relay/image_handler.go` line 122). For our chat/responses billing path, the AI SDK surfaces generated images as `type: 'file'` stream parts (`TextStreamFilePart` / `GeneratedFile`); the raw passthrough body exposes them as `output[]` items of type `image_generation_call` (Responses) — neither is in `usage`.
- **Web search count.** NOT in any provider's `usage` object. new-api counts `web_search_call` entries in the response `Output[]` (non-stream) or subscribes to `response.output_item.done` events (stream) — comment: "Count actual tool invocations from Output (not tool declarations)." (`relay/channel/openai/relay_responses.go` lines 51-59, 122-154). AI SDK surfaces these as `type: 'tool-call'` stream parts.

**Conclusion:** audio is a clean field-extraction on the passthrough path; image/webSearch require counting response content items (passthrough) and stream parts (AI SDK) — a small counting subsystem on BOTH capture paths.

## Scope decision (confirmed with user)

Full wiring: audio + image + webSearch, on both capture paths, tagged so config pricing bills them. Request fee already works.

## Global constraints (apply to every task)

- ALL subagents dispatched with NO explicit model param (inherit session model).
- `exactOptionalPropertyTypes: true` → conditional-spread every optional property.
- Handwritten non-test impl files stay < 300 lines; split by responsibility into `foo/{index.ts,foo.ts,bar.ts}` when needed.
- Colocated tests next to source (`foo/foo.test.ts`); do not add to legacy `_test/`.
- Prefer `es-toolkit` narrow imports for generic utilities; keep trivial native JS.
- Counts are integers ≥ 0 (reuse `TokenCountSchema` bound: `.finite().int().min(0)`).
- Units: audio tokens priced per-1M like other tokens (already handled by `addTokens`); image/webSearch are per-EVENT fees (already ×1e6 in `addFee`). No new scaling anywhere — the counts flow in raw.
- Keep the branch typecheck-green between tasks (`bun run lint:types`, monaco noise excepted).
- Do NOT alter the request-fee wiring, the `priceSource` provenance logic, or the daily-aggregation path.
- Counting must never throw into the stream: any parse/observe error is swallowed (mirror existing `safely()` in passthrough-usage and the try/catch in stream-capture).
- Cancelled/failed attempts must not bill partial event counts differently from how token usage is already gated (counts ride the same `UsageRow`, dropped when the trace is not a success).

## Tasks (TDD; each = fresh implementer → task review → fix loop → ledger line)

### Task 1 — UsageRow schema: add fee/audio count fields
`packages/types/src/usage.ts`
- Add optional fields to `UsageRowSchema`, all reusing the existing `TokenCountSchema` (finite int ≥ 0):
  `inputAudioTokens`, `outputAudioTokens`, `imageCount`, `webSearchCount`.
- Keep them optional; conditional presence throughout.
- Test (colocated `usage.test.ts` if one exists, else add): schema accepts the new fields, rejects negatives/non-integers, and round-trips `z.output`. Behaviour-level: assert a row with `imageCount: 2` parses and a row with `imageCount: -1` fails. Do NOT restate the schema literally.
- Rebuild `@aio-proxy/types`.

### Task 2 — pricingInput forwards the new fields
`packages/server/src/usage-capture/pricing.ts`
- Extend `pricingInput()` to conditionally forward `inputAudioTokens` / `outputAudioTokens` / `imageCount` / `webSearchCount` from the `UsageRow` into the `UsagePricingInput` (same conditional-spread style as the existing five).
- No change to `priceUsage` provenance logic.
- Test: with a `configPrice` carrying `image`/`webSearch`/audio rates and a `UsageRow` carrying the counts, `priceUsage` returns an `estimatedCostUsd` that includes the fee/audio contribution AND `priceSource: 'config'`. This is the end-to-end money assertion the review asked for — trace a concrete number (e.g. `imageCount:2, image:0.01` ⇒ +0.02 USD). Reuse `usage-capture.pricing*.test.ts` patterns.

### Task 3 — Passthrough audio-token extraction (OpenAICompatible)
`packages/server/src/passthrough-usage/usage.ts` (+ `shared.ts` `UsageField` if the field list is enumerated there)
- In `openAICompatibleUsage`, extract:
  `inputAudioTokens` = `nestedNumberField(usage, 'prompt_tokens_details', 'audio_tokens', 'inputAudioTokens')`,
  `outputAudioTokens` = `nestedNumberField(usage, 'completion_tokens_details', 'audio_tokens', 'outputAudioTokens')`.
- Do NOT add audio to Responses/Anthropic/Gemini extractors (upstreams don't expose it there). Add a one-line comment on each citing that.
- If `UsageField` / `tokenUsage` enumerate allowed fields, extend the allow-list so validation passes them through.
- Test: an OpenAI-compatible `usage` JSON with `prompt_tokens_details.audio_tokens`/`completion_tokens_details.audio_tokens` yields those on the extracted usage; a Responses usage with an audio-looking field does NOT (guard against accidental leakage). Behaviour-level.

### Task 4 — Passthrough image/webSearch item counting
New collaborator under `packages/server/src/passthrough-usage/` (e.g. `event-counts/{index.ts,event-counts.ts,event-counts.test.ts}`) to keep `usage.ts`/`passthrough-usage.ts` under 300 lines.
- Count, from the parsed response, per the newapi model:
  - **Responses (non-stream JSON):** `output[]` entries with `type === 'image_generation_call'` → imageCount; `type === 'web_search_call'` → webSearchCount.
  - **Responses (SSE):** count `response.output_item.done` events whose item `type` is `image_generation_call` / `web_search_call`. Wire into `createPassthroughSseUsageObserver`'s `onEvent` accumulation (alongside `mergeObservedUsage`), then fold the totals into the final `observation()` usage.
  - **OpenAICompatible / Anthropic / Gemini:** no built-in image/web_search item shape → contribute 0 (document why; do not fabricate).
- Fold counts into `PassthroughObservation.usage` (they live on `ExtractedUsage = Omit<UsageRow,'providerId'|'modelId'>`, so adding them to `UsageRow` in Task 1 makes them valid here automatically).
- Counting is idempotent per item and dedup-safe against a JSON body also being scanned as SSE (the extractor picks ONE path — `parseJson` first, else SSE — so no double count).
- Errors swallowed; never throw into the observer.
- Tests: Responses JSON with 2 `image_generation_call` + 1 `web_search_call` → counts {image:2, web:1}; SSE stream of matching `output_item.done` events → same; non-Responses protocols → undefined/0; malformed items ignored.

### Task 5 — Stream capture: count file & tool-call parts
`packages/server/src/usage-capture/stream-capture.ts` (extract a small counter helper if it pushes the file over 240 lines)
- In the `pull` loop, before/at enqueue, accumulate:
  - `next.value.type === 'file'` → imageCount++ (generated image file; guard on the part actually representing an image — check the `GeneratedFile` mediaType/`file` shape, count image/* only; document the guard).
  - `next.value.type === 'tool-call'` where the tool is the built-in web search → webSearchCount++. Identify the built-in web-search tool name/provider-defined shape; if the AI SDK marks built-in tools distinctly, gate on that. If web-search tool identity is not reliably distinguishable on the AI SDK path, count NOTHING and document the limitation (do not overcount arbitrary function tool-calls).
- At `finish`, merge the accumulated counts into `finishUsage` (via `normalizeAiSdkUsage` output or a post-merge) before `finalizeUsage`.
- Counts only apply to a `success` trace (same gate as token usage; abort/cancel/idle discard them by not settling success).
- Tests: a stream with N `file` image parts + a web_search tool-call, ending in `finish`, yields a `UsageRow` with the counts; a cancelled stream does not bill counts; non-image file parts don't inflate imageCount.

### Task 6 — Docs + changeset update
- `npm/aio-proxy/README.md`: update the metadata/pricing section so `cost.image` / `cost.webSearch` / audio rates are documented as **wired** (state exactly which paths/protocols supply each: audio ← OpenAI-compatible passthrough usage; image/webSearch ← response items on passthrough + file/tool-call parts on AI SDK stream). Remove any "future/not-yet" caveat this feature makes obsolete; keep an honest note for protocols that cannot supply a given count.
- Update the existing `.changeset/provider-model-metadata.md` body (or add a new changeset) to mention per-event & audio cost inputs are now captured and billed. Keep it targeting `aio-proxy` + the internal packages at `minor` (repo changeset rule).

## Verification (final gate, after all tasks)
- `bunx turbo run build --filter=@aio-proxy/types --filter=@aio-proxy/core`
- `bun run lint:types` (monaco cascade excepted), `bun run format:check`
- Package tests: `@aio-proxy/types`, `@aio-proxy/core` usage-pricing, `@aio-proxy/server` usage-capture + passthrough-usage.
- Whole-branch review over the full feature diff, then `bun run preflight`.
- `finishing-a-development-branch`.

## Risks / non-goals
- **AI SDK web-search identity.** If built-in web-search tool-calls are not reliably distinguishable from ordinary function tool-calls on the AI SDK path, Task 5 counts webSearch = 0 there (passthrough Responses still counts it). Documented, not guessed.
- **Image-generation models via the dedicated image endpoint** (request `N`): out of scope — this wires the chat/responses billing path only. The image endpoint already passes a larger idle timeout; a request-`N` image charge is a separate follow-up if wanted.
- No change to request-fee wiring, provenance tags, or daily aggregation.
