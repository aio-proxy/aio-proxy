# P2 Embeddings Inbound Protocol

Date: 2026-08-25
Status: awaiting user review
Issue: [#207](https://github.com/aio-proxy/aio-proxy/issues/207) (parent [#204](https://github.com/aio-proxy/aio-proxy/issues/204))

## Goal

An embeddings client can embed through aio-proxy. Gemini native embed actions are not a 404.

Embeddings is not chat. Text goes in; float vectors come out. This spec adds that surface as a standalone inbound protocol family. It reuses the existing pipeline's model-first routing, same-protocol raw, fallback, usage, and protocol-shaped errors. It does not route embeddings through `languageModel` or `ModelInvocation`.

## Current repo state

Live checkout `55ebd88e` (detached HEAD of this worktree):

- Inbound protocols are `openai-response`, `openai-compatible`, `anthropic`, and `gemini`. There is no `/v1/embeddings` route. `POST /v1beta/models/*` only accepts `:generateContent`, `:streamGenerateContent`, and `:countTokens`; `:embedContent` and `:batchEmbedContents` 404.
- `ProtocolAdapter` is language-shaped: `modelInvocation` produces messages/tools, and egress consumes a language `TextStreamPart` stream.
- `handleProtocolRequest` / `attemptCandidates` is the only candidate loop. For each candidate it tries `raw.resolve({ protocol: adapter.protocol })`, then `provider.model.invoke` (language), else unsupported.
- API raw matching is exact `endpointTransports.find(endpoint => endpoint.protocol === protocol)`. A new `ProviderProtocol` value would miss every existing OpenAI-compatible or Gemini API provider.
- `createProviderV4Invoke` always calls `provider.languageModel`. Provider V4 still requires `embeddingModel`, but the pipeline never calls it.
- Plugins that implement `embeddingModel` today: ChatGPT, Kimi, Copilot (via OpenAI / OpenAI-compatible SDK). Antigravity, xAI, and Cursor throw unsupported. Every plugin catalog currently sets `embedding: []`. OAuth materialization exposes only `catalog.language` IDs.
- Usage capture has `passthrough` (HTTP body) and `stream` (language parts). There is no embedding result capture. `UsageRow` already has `inputTokens` / `totalTokens`, which is enough.
- This worktree has no Images / P1 spec. This document does not depend on one.

## Scope

In:

- `POST /v1/embeddings`
- `POST /v1beta/models/{model}:embedContent`
- `POST /v1beta/models/{model}:batchEmbedContents`
- Same-protocol raw, cross-protocol convert via `embeddingModel`, fallback, usage, adapter tests, dispatch-matrix coverage, README inbound table

Out:

- Images, audio, realtime, videos
- Vector stores, file search, batch-job APIs
- Token-count endpoints for embeddings
- Streaming embeddings
- Anthropic embeddings (none exist)
- Filling plugin `catalog.embedding` with vendor model lists
- Capability-aware routing that hides embedding IDs from chat (and the reverse)
- New user-authored `ProviderProtocol` values
- Reopening the language `ProtocolAdapter` / `ModelInvocation` contract

## Approaches

### A. Wire-family protocol IDs + embedding capability (recommended)

Add two new stateless adapters and an embedding convert path. Keep `ProviderProtocol` as the four wire families.

- OpenAI embeddings adapter uses `ProviderProtocol.OpenAICompatible`
- Gemini embeddings adapter uses `ProviderProtocol.Gemini`
- Distinctness is the adapter + route + `capability: 'embedding'`, not a new config enum
- Same-protocol raw keeps working: an `openai-compatible` API provider already has a transport that forwards the rewritten `/v1/embeddings` request; a `gemini` transport forwards `:embedContent` / `:batchEmbedContents`

This matches the live raw key (`adapter.protocol` vs `endpointTransports[].protocol`) without forcing users to declare a second endpoint for the same base URL.

### B. New `ProviderProtocol` values + sibling raw mapping

Add `openai-embeddings` and `gemini-embeddings`. Teach raw resolve to treat them as siblings of `openai-compatible` and `gemini`.

Cleaner inbound identity in traces. It also changes a public config enum, `pluginProtocol`, API endpoint validation, and SDK version prefixes. Authors could then write `protocol: openai-embeddings` on a provider, which is the wrong layer: embeddings is an inbound surface, not a separately configured upstream origin. Rejected for P2.

### C. Stuff embeddings into `ModelInvocation`

Treat input strings as user messages and invent a language stream of vectors. This fights the existing adapter, usage, SSE, and tool contracts. Rejected.

P2 implements A.

## Architecture

```text
OpenAI client                 Gemini client
POST /v1/embeddings           POST /v1beta/models/{model}:embedContent
                              POST /v1beta/models/{model}:batchEmbedContents
        \                         /
         \                       /
          v                     v
   openaiEmbeddingsAdapter   geminiEmbeddingsAdapter
   protocol: openai-compatible   protocol: gemini
   capability: embedding         capability: embedding
                    \           /
                     v         v
              handleProtocolRequest
              (shared candidate loop)
                     |
        +------------+-------------+
        |                          |
        v                          v
 same-family raw              embedding convert
 raw.resolve(protocol)        provider.embedding.embed
 rewritten Request            EmbeddingInvocation
        |                          |
        +------------+-------------+
                     v
           fallback / usage / protocol errors
```

### Units

1. **Embedding adapters** — parse, model id, raw rewrite, embedding invocation, JSON egress, errors. No stream, no tools, no effort clamp, no `previous_response_id`.
2. **Thin routes** — OpenAI embeddings is a new `POST /v1/embeddings` registration. Gemini embed actions are additional explicit suffixes on the existing `/v1beta/models/*` router. Unknown Gemini actions still 404. No catch-all action table.
3. **Shared pipeline** — still the only candidate loop. After parse + model-first resolve, each candidate tries raw, then embedding convert, else unsupported. Language `attemptModelCandidate` is not used.
4. **Embedding transport** — new optional runtime capability. API / AI SDK / OAuth materialization can expose it. It is not `ModelTransport.invoke`.
5. **Language stack** — `defineProtocolAdapter`, `ModelInvocation`, `createProviderV4Invoke`, and chat/completions/responses/messages/generateContent adapters stay as they are.

Images / audio can later add their own `capability` and transport the same way. That is conceptual reuse only. This spec does not edit or require an Images document.

## Protocol identity

`ProtocolAdapter.protocol` remains a `ProviderProtocol` wire family. Embeddings adapters reuse the family of their native HTTP API.

| Inbound surface | Route | Adapter protocol | Raw matches |
| --- | --- | --- | --- |
| OpenAI Embeddings | `POST /v1/embeddings` | `openai-compatible` | API/OAuth raw for `openai-compatible` |
| Gemini embed | `:embedContent` / `:batchEmbedContents` | `gemini` | API/OAuth raw for `gemini` |

Traces therefore record `openai-compatible` or `gemini` plus the request path. That is enough to tell embeddings apart from chat without growing the authored protocol enum.

Same-family means: inbound embeddings adapter protocol equals the candidate's raw protocol. It does **not** mean "any OpenAI-shaped provider." `openai-response` is a different family. Inbound embeddings against an `openai-response`-only provider uses convert, not raw.

OAuth raw resolvers that only accept language paths (ChatGPT Responses, Kimi `/v1/chat/completions` or `/v1/messages`) either decline embeddings or throw on the rewritten path. Both become fallback to `embeddingModel` or the next candidate. Do not special-case those plugins in the pipeline.

## Adapter contract

Do not extend language `ModelInvocation`. Add a parallel factory, `defineEmbeddingProtocolAdapter`, with a smaller surface:

```ts
type EmbeddingProviderOptions = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

type EmbeddingValue = {
  readonly value: string;
  readonly providerOptions?: EmbeddingProviderOptions;
};

type EmbeddingInvocation = {
  readonly values: readonly EmbeddingValue[];
  readonly encodingFormat?: 'float' | 'base64';
};

type EmbeddingResult = {
  readonly embeddings: readonly (readonly number[])[];
  readonly usage?: { readonly tokens?: number };
};

type EmbeddingProtocolAdapter<TRequest, TContext> = {
  readonly capability: 'embedding';
  readonly protocol: ProviderProtocol;
  parse(raw: Request, context: TContext): Promise<TRequest>;
  model(request: TRequest, context: TContext): string;
  rawRequest(raw: Request, request: TRequest, resolvedModel: string, context: TContext): Promise<Request>;
  embeddingInvocation(request: TRequest, context: TContext): EmbeddingInvocation;
  embeddingJson(result: EmbeddingResult, context: { readonly modelId: string }): unknown;
  errors: ProtocolErrorMapper;
};
```

Defaults:

- `wantsStream` is always false. There is no SSE egress.
- `session` is omitted. Empty candidates fall through to a generated session unless the client sent an existing session header. Embeddings do not hash the input text as a transcript key and do not commit response ownership.
- `dimensions()` (alias effort bag) is empty. Embeddings do not clamp reasoning effort.
- `requestDiagnostics` is empty. Convert does not silently drop representable embed settings. `dimensions` / `outputDimensionality`, Gemini `taskType` / `title`, and OpenAI `user` are normalized onto per-value `providerOptions`. `encoding_format` is egress-only and is never sent to the SDK.

Language adapters do not grow a `capability` field in this issue. The pipeline distinguishes embeddings by adapter kind / `capability: 'embedding'`, not by route path string matching inside `attemptCandidates`.

## Wire contracts

### OpenAI `POST /v1/embeddings`

Request (supported):

- `model` (required)
- `input`: string or string[] of text (required). Every string — the lone string and every array member — must have length ≥ 1. An empty array is not allowed. An array may contain at most 2048 strings. This is an item cap, not the `dimensions` field.
- `encoding_format`: `float` (default) or `base64`
- `dimensions`: optional positive integer
- `user`: optional; raw forwards; convert maps it into target `providerOptions`

Rejected at parse (400, OpenAI error shape):

- missing / empty `model`
- missing `input`
- empty string `input` (`""`)
- empty-string array member (`["ok", ""]`)
- empty array `input`
- `input` array longer than 2048
- token-id input (`number[]` or `number[][]`)
- `encoding_format` other than `float` / `base64`

Official create-embeddings contract: `input` cannot be an empty string, and an array is at most 2048 items. Rejecting those at parse keeps `embedMany` from splitting an already-invalid request into multiple upstream calls.

Response:

```json
{
  "object": "list",
  "data": [{ "object": "embedding", "index": 0, "embedding": [0.1, 0.2] }],
  "model": "text-embedding-3-small",
  "usage": { "prompt_tokens": 8, "total_tokens": 8 }
}
```

`data` is ordered by `index` matching input order. Convert egress writes float arrays, then base64-encodes each vector only when the client asked for `encoding_format: "base64"`.

Raw rewrite: replace body `model` with the resolved upstream id; otherwise forward the original body bytes, same as Chat Completions.

### Gemini `:embedContent`

Context from the path: `{ model, action: 'embedContent' }`.

Supported body:

- `content.parts` with text only. Multiple text parts become one value, concatenated in order with no separator. The joined value must be a non-empty string.
- `embedContentConfig` when present: `taskType`, `title`, `outputDimensionality`. `mimeType` is ignored because this inbound surface rejects non-text parts.
- legacy top-level aliases `taskType`, `title`, `outputDimensionality` when the corresponding `embedContentConfig` key is absent. If both are present, the config object wins per key.

Rejected at parse (400, Gemini error shape):

- no text
- joined text is `""`
- non-text parts (inline images, file data, video). Text in, vectors out.
- empty model segment

Response:

```json
{ "embedding": { "values": [0.1, 0.2] } }
```

Raw rewrite: set path to `/v1beta/models/{resolvedModel}:embedContent`. If the body already has `model`, rewrite it to `models/<resolvedModel>`. Forward the original body bytes when the body is unchanged.

### Gemini `:batchEmbedContents`

Context: `{ model, action: 'batchEmbedContents' }`.

Supported body: `requests` array, each item a single-embed request. The URL model is authoritative for routing, matching generateContent. Per-item `model` is ignored for routing and, on convert, not required. Per-item `embedContentConfig` / legacy aliases are normalized independently.

Rejected: empty `requests`, any item that would fail single-embed parse.

Response:

```json
{ "embeddings": [{ "values": [0.1] }, { "values": [0.2] }] }
```

Raw rewrite is not URL-only. Google requires every `EmbedContentRequest.model` to equal the batch path model (`models/{model}`).

- Path: `/v1beta/models/{resolvedModel}:batchEmbedContents`
- Every `requests[i].model`, including omitted entries, is set to `models/<resolvedModel>`
- Alias and provider-qualified routes use the same `resolvedModel` as the path. Leftover client model strings and missing models must not survive

`:embedContent` rewrites the path the same way. If that single body already has `model`, rewrite it to `models/<resolvedModel>`; do not invent a body `model` when the client omitted it.

### Convert mapping

Convert never speaks another vendor HTTP API. It folds the inbound body into `EmbeddingInvocation`, calls `embeddingModel`, and the **inbound** adapter writes its own client envelope.

AI SDK Provider V4 `embed` / `embedMany` accept only `values` plus `providerOptions`. There is no top-level `dimensions` bag on the SDK call. Convert therefore writes settings onto per-value `providerOptions` under the namespaces the target packages read:

| Inbound field | `EmbeddingInvocation` |
| --- | --- |
| OpenAI `input` string | `values: [{ value: input, providerOptions }]` |
| OpenAI `input` string[] | one `EmbeddingValue` per string, same `providerOptions` |
| Gemini single text / joined text parts | `values: [{ value: text, providerOptions }]` |
| Gemini batch | one `EmbeddingValue` per item, in request order, each with that item's normalized options |
| OpenAI `dimensions` / Gemini `outputDimensionality` | `providerOptions.openai.dimensions`, `providerOptions['openai-compatible'].dimensions`, and `providerOptions.google.outputDimensionality` |
| OpenAI `user` | `providerOptions.openai.user` and `providerOptions['openai-compatible'].user` |
| Gemini `taskType` | `providerOptions.google.taskType` |
| Gemini `title` | `providerOptions.google.title` (keep it on the invocation even if the current `@ai-sdk/google` options type omits `title`) |
| OpenAI `encoding_format` | `encodingFormat` (egress only) |

The adapter is target-agnostic: it fills every namespace that can represent a field. `@ai-sdk/openai` / `@ai-sdk/openai-compatible` / `@ai-sdk/google` read their own key and ignore the others. That is how convert avoids a silent drop without adding `embeddingInvocationForTarget`.

Gemini per-item options are normalized before mapping:

1. Start from `embedContentConfig` when present.
2. Fill missing `taskType` / `title` / `outputDimensionality` from the legacy top-level aliases.
3. Ignore `mimeType`. Non-text parts are already 400.

`createProviderV4Embed` must not flatten a heterogeneous batch into one `embedMany` with a single `providerOptions`. AI SDK applies one options object to every value in a call.

- Group `EmbeddingValue`s that share structurally equal normalized `providerOptions` (same keys and values; omit empty namespaces).
- Call `embed` for a one-value group and `embedMany` for a multi-value group.
- Restore the original request order when assembling `EmbeddingResult.embeddings`.
- Sum `usage.tokens` across groups.

Grouping lives inside the embedding transport. `attemptCandidates` still makes one convert attempt per candidate. Do not reopen the candidate loop. Do not 501 a heterogeneous Gemini batch solely because `taskType` differs across items. Silent drop of a differing item's `taskType` / `title` / `outputDimensionality` is forbidden.

Anthropic candidates have no embedding convert. They fail this branch and fallback if another candidate exists.

## Dispatch

Keep `handleProtocolRequest` as the entry. Its options type becomes a discriminated union of the language adapter and the embedding adapter. Only the language branch reads `modelInvocation` / `modelJson` / `modelSse`. `attemptCandidates` stays the only loop.

For an embeddings adapter, each live candidate:

1. **Raw** if `provider.raw.resolve({ protocol: adapter.protocol, modelId })` returns a transport. `rawRequest` has already rewritten the embeddings path and, for `:batchEmbedContents`, every `requests[i].model`. Existing fallback statuses apply (`422`, `429`, `>= 500` when `hasNext`).
2. **Embedding convert** if the candidate exposes `embedding`. Call `embedding.embed(invocation, { modelId, signal, logicalRequest })`. Do not call `provider.model.invoke`.
3. **Unsupported** otherwise (`adapter.errors.unsupported`), then fallback if `hasNext`.

Language requests are unchanged: they never see the embedding branch.

`createProviderV4Invoke` remains language-only. Add `createProviderV4Embed(providerId, provider)` that calls `provider.embeddingModel(modelId)` and AI SDK `embed` / `embedMany`. Pass `values` plus the group's `providerOptions`. Return `embeddings` in the original inbound order and `usage.tokens` as the sum across groups. A thrown "does not support embedding" is a candidate failure, not a materialization failure.

### Runtime shape

`RuntimeProviderInstance` gains an optional embedding capability. Existing `raw` / `model` rules stay. A provider may expose raw, language model, embedding, or any combination.

Materialization:

- **API** — raw stays protocol-exact. Convert uses the existing primary-endpoint package map via `embeddingModel` when that package exposes it: `openai-compatible` → `@ai-sdk/openai-compatible`, `openai-response` → `@ai-sdk/openai`, `gemini` → `@ai-sdk/google`. Anthropic-primary API providers have no embedding convert.
- **AI SDK** — if the loaded package has `embeddingModel`, expose it. Otherwise omit the capability.
- **OAuth** — always attach embedding transport from the Provider V4 object. Unsupported implementations fail at invoke and fallback.

Do not look up raw metadata only in `catalog.language`. If a later catalog actually lists embedding models, metadata lookup must accept those IDs too.

## Routing

Routing stays model-first and ID-based. The same router serves chat and embeddings. A chat model posted to `/v1/embeddings` is a candidate that fails at embed and may fallback. An embedding model posted to chat is unchanged existing behavior.

OAuth currently exposes only `catalog.language`. Union `catalog.language` and `catalog.embedding` into routable IDs so a future non-empty embedding catalog works. P2 does not invent ChatGPT / Kimi / Copilot embedding catalogs. Convert still works when the requested ID is already routable and the plugin's `embeddingModel` accepts it.

No new alias dimension for embeddings.

## Usage

Raw: existing `usageCapture.passthrough` with the adapter's wire-family protocol.

- OpenAI embeddings `usage.prompt_tokens` / `usage.total_tokens` already map through `openai-compatible` extraction. `completion_tokens` is absent.
- Gemini embed `usageMetadata` maps through the existing Gemini extractor when present. Missing usage is allowed.

Convert: do not reuse `usageCapture.stream`. Add a non-stream capture that records `inputTokens` and `totalTokens` from `EmbeddingResult.usage.tokens`. No TTFT. No image/web-search event counts. Pricing uses the existing `input` token price when configured; do not add an embeddings-specific price field.

## Errors

Reuse `ProtocolErrorMapper`. Shapes:

- OpenAI embeddings: `{ error: { message, type, code } }` like other OpenAI adapters
- Gemini embeddings: `{ error: { code, message, status } }` like generateContent

| Case | Status |
| --- | --- |
| Invalid body / unsupported input kind | 400 |
| Unknown model (router miss) | 404 |
| Body too large / bad content-encoding | 413 / 415 (existing helpers) |
| Candidate has no embedding convert and no raw | 501 unsupported, then fallback if `hasNext` |
| Upstream / plugin throw | existing provider mapping, then fallback if eligible |

Embeddings have no `previous_response_id`, so the conflict mapper is unused.

## Tests

Protect user-visible behavior, not factory literals.

Adapter tests (colocated with the new modules):

- OpenAI parse: string, string[], empty-string rejection (scalar `""` and array member), empty-array rejection, 2048 items accepted / 2049 rejected, token-id rejection, `encoding_format`, model rewrite on raw
- Gemini parse: single text, batch, non-text part rejection, empty joined text, `embedContentConfig` plus legacy aliases, path action + model context
- Gemini raw: alias and provider-qualified `:batchEmbedContents` rewrite every `requests[i].model` to `models/<resolvedModel>`, including items that omitted `model` or sent a leftover client model
- Convert: OpenAI `dimensions` and Gemini `taskType` appear on the target `providerOptions` passed to `embed` / `embedMany`; a heterogeneous Gemini batch is grouped, order is restored, and no item's `taskType` / `title` / `outputDimensionality` is dropped
- Egress: index order, float vs base64, Gemini single vs batch envelopes

Dispatch matrix (server, next to `cross-protocol-routing.test.ts`, embeddings-specific so the language matrix stays language-only):

| Inbound | Candidate | Expected |
| --- | --- | --- |
| OpenAI embeddings | API `openai-compatible` raw | raw, not language invoke |
| OpenAI embeddings | API `gemini` raw only | embedding convert, not language invoke |
| OpenAI embeddings | API `openai-response` | convert via `@ai-sdk/openai.embeddingModel`, not raw |
| OpenAI embeddings | API `anthropic` | unsupported + fallback |
| Gemini embed / batch | API `gemini` raw | raw to the matching action path |
| Gemini embed | API `openai-compatible` | convert via `embeddingModel`; client still gets a Gemini envelope |
| Either | OAuth with working `embeddingModel` | convert |
| Either | OAuth that throws unsupported | fallback to next candidate |
| Gemini unknown action | any | 404, unchanged |

Also: usage maps `prompt_tokens` / `usage.tokens` onto the usage row; README table lists the three new rows.

## README

Add rows to both `README.md` and `README.zh-Hans.md` inbound tables:

| Protocol or purpose | Method and path |
| --- | --- |
| OpenAI Embeddings | `POST /v1/embeddings` |
| Gemini Embeddings | `POST /v1beta/models/{model}:embedContent` |
| Gemini Batch Embeddings | `POST /v1beta/models/{model}:batchEmbedContents` |

Do not replace the existing Gemini generateContent rows. Do not add a catch-all Gemini line.

## Implementation boundaries

When this spec is later implemented, expect work in:

- `packages/core/src/protocol/` — embedding adapters, parse, egress, errors
- `packages/server/src/routes/` — OpenAI embeddings route; Gemini suffix recognition
- `packages/server/src/routes/pipeline/` — embedding convert branch and usage
- `packages/server/src/runtime.ts` and materialization — optional embedding transport
- `packages/core/src/provider/provider-v4.ts` — `createProviderV4Embed` only; do not change language invoke
- README inbound tables
- A user-facing changeset on `aio-proxy` plus the internal packages that actually change

Do not grow language adapters, do not add `ProviderProtocol` values, and do not teach the language dispatch matrix that `/v1/embeddings` is Chat Completions.

## Done when

- `POST /v1/embeddings` embeds through a same-family OpenAI-compatible API provider via raw
- The same inbound request converts through a provider that only has `embeddingModel`
- Gemini `:embedContent` and `:batchEmbedContents` are not 404 and follow the same raw / convert / fallback rules
- Failures stay in the inbound protocol shape
- Usage records input token counts when the upstream or SDK reports them
- Language inbound protocols still behave as they do today
