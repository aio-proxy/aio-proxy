# P0 Language Protocol Ports

GitHub: [#205](https://github.com/aio-proxy/aio-proxy/issues/205) (parent [#204](https://github.com/aio-proxy/aio-proxy/issues/204))

Date: 2026-08-25

Status: awaiting review (revised after Sol review, round 5). Compact `model: null` is locked: parse-time protocol-shaped 400, no inference, no A/B choice.

## Goal

Finish the remaining official language-generation ports on the existing `languageModel` pipeline. Clients that speak OpenAI Completions or Responses compact must be able to hit aio-proxy without a new protocol enum. Clients that probe remaining official Responses resource operations must receive a stable protocol-shaped 501 instead of a generic 404.

This issue does not reopen the epic-wide protocol boundary. Images, Embeddings, Audio, Interactions, Realtime, Videos, Midjourney, Files, and Assistants stay out.

## Current state

Live checkout at this design:

| Surface | Today |
| --- | --- |
| `POST /v1/chat/completions` | Registered. `openAICompletionsAdapter` parses a Chat Completions body (`messages`) and egresses `chat.completion`. Protocol enum is `openai-compatible`. |
| `POST /v1/completions` | Missing. Official OpenAI Completions is the legacy prompt API (`prompt` in, `object: "text_completion"` out). Official `prompt` is a string, array of strings, token array, or array of token arrays. Official `n` selects how many completions to return per prompt. |
| `POST /v1/responses` | Registered. `openAIResponsesAdapter` parses create bodies and egresses `response`. Protocol enum is `openai-response`. Create-time `background: true` is dropped with a diagnostic. Model-path create forces `store: false`. |
| `POST /v1/responses/compact` | Missing. Official compact is a stateless endpoint that returns `object: "response.compaction"` including opaque encrypted compaction items. Codex clients call this. |
| `GET /v1/responses/:id` | Explicit 501 via `errors.unsupported('response_retrieval')`. |
| `DELETE /v1/responses/:id` | Unregistered Hono 404. Official Responses delete exists. |
| `GET /v1/responses` | Unregistered Hono 404. This is not an official Responses operation. |

Shared pipeline behavior that this design relies on and must not change:

- Route files stay thin. `handleProtocolRequest` is the only candidate loop.
- Same-protocol raw wins. `rawRequest` returns `new Request(raw, …)`, so the inbound path is preserved and raw transport joins it onto the provider origin.
- `modelJson` / `modelSse` receive only `ModelEgressContext` (`modelId`, optional `onResponseId`). Pipeline does not pass route `TContext` into egress. Surface-specific JSON/SSE therefore cannot be selected from adapter context.
- Cross-protocol uses `modelInvocation`. If that throws an error mapped by `errors.modelUnsupported`, the candidate is 501 and later candidates still get a chance. Mapping the same error through `requestError` would terminate the request before later raw candidates run.

## Decisions

| Decision | Choice |
| --- | --- |
| Protocol enums | Keep `openai-compatible` and `openai-response`. No new enum. |
| Completions adapters | Two `defineProtocolAdapter` instances from shared Completions internals: chat keeps `openAICompletionsAdapter` and its `chat.completion` writers; legacy is `openAILegacyCompletionsAdapter` with fixed `text_completion` writers. Do not extend the pipeline egress seam. |
| Completions ingress | Accept the official Completions wire schema, including every official `prompt` shape and `n`. Ingress must not reject options that a same-protocol raw provider can serve. |
| Completions transform | In `modelInvocation`, 501 any option the `languageModel` path cannot honor without changing output cardinality or dropping requested behavior. Do not join multi-prompts. Do not convert omitted/`null` `prompt` into an empty user message. Do not silently drop `stop`, `echo`, `suffix`, any non-null `logprobs` (including `0`), `best_of`, or `stream_options`. |
| Compact ingress | Dedicated compact parser. Do not reuse the create parser. Official compact `input` may be omitted or `null`; that must parse and raw-forward when `model` is a non-empty string. Official compact `model` is required-but-nullable in generated types only. Parse recognizes `null` first, then requires a non-empty string. `null` / omitted / `""` is a parse-time 400 `invalid_request`. This is aio-proxy’s model-first no-inference policy, matching CLIProxyAPI; it is not an official default or history-inference behavior. |
| Compact transform | Same-protocol raw only. Compact is unary JSON: `wantsStream` is `ctx.operation !== 'compact' && req.stream === true`. Parse 400s `stream: true`. Dedicated compact `rawRequest` uses the preserve/strip/rewrite allowlist below; do not reuse the create rewrite. Cross-protocol is an explicit 501. Do not invent a local summarizer or a fake `compaction` item. Compact may keep one Responses adapter because its 501 happens in `modelInvocation`, which already receives `TContext`, and compact never uses create egress writers. |
| Create-time `store` / `background` | Unchanged. Do not 501 `POST /v1/responses` when those fields are present. |
| Resource 501s | Explicit official resource routes only. Replace the earlier non-official list route with delete. No catch-all `/v1/responses/*`. |
| Pipeline / capabilities | Reuse `languageModel`. No new dispatch seam. |

## Approaches considered

### Completions adapters

1. One adapter plus `context.surface`, with egress branching on that context. Not implementable: `modelJson` / `modelSse` never receive `TContext`. Rejected.
2. Extend `ModelEgressContext` / pipeline so routes can pass a surface into egress. That is a new pipeline seam. Rejected.
3. Two adapter instances that share parse helpers, raw rewrite, errors, and session extraction, each wiring a fixed writer. Chat route keeps the existing instance. Completions route uses the legacy instance. Chosen.

### Completions transform limits

1. Reject token arrays, `n !== 1`, and similar options in ingress. Blocks a legal same-protocol raw provider before candidate selection. Rejected.
2. Accept those options in ingress and drop or join them on the model path. Changes Completions output cardinality and silently loses requested behavior. Rejected.
3. Accept the official wire schema in ingress. `modelInvocation` throws a Completions-specific unsupported error for unfaithful options, mapped through `modelUnsupported` so a later raw candidate can still succeed. Chosen.

### Compact

1. Convert compact to a normal `languageModel` summarization and wrap the text as `response.compaction`. The official output is an encrypted, non-human-readable compaction item that later `/v1/responses` calls must consume as-is. A proxy-invented item would break Codex continuation. Rejected.
2. Same-protocol raw for `openai-response` candidates; `modelInvocation` throws `OpenAIResponsesUnsupportedFeatureError('responses_compact')` so every cross-protocol candidate is 501, while a later same-protocol candidate can still succeed. Chosen.
3. Reuse `parseOpenAIResponses` for compact. Create schema requires `input` and rejects empty arrays, so omitted/`null` compact bodies 400 before candidate selection and block same-protocol raw. Rejected.
4. Dedicated compact ingress (`parseOpenAIResponsesCompact`) that accepts omitted/`null` `input` while leaving the create parser unchanged. Chosen.
5. New protocol enum for compact. Forbidden. Rejected.
6. Reuse create `wantsStream` / create `rawRequest` for compact. Compact is unary JSON and has no official `stream`; create rewrite also strips `background` and clamps `reasoning.effort`. Rejected.

### Resource 501s

1. Hono catch-all under `/v1/responses/*`. Would race `POST /v1/responses/compact` and hide future generation ports. Rejected.
2. 501 `POST /v1/responses` when `store: true` or `background: true`. That changes the current drop/forward policy and is not required to stop generic 404s. Rejected.
3. 501 `GET /v1/responses` as `response_list`. That path is not an official Responses operation. Rejected.
4. Register remaining official resource operations as thin 501 routes, matching retrieve, including `DELETE /v1/responses/:id`. Chosen.

## Completions: `POST /v1/completions`

### Route

Add the path on the existing Completions Hono app next to chat. Each path binds a different adapter instance:

```ts
.post('/v1/chat/completions', (context) =>
  handleProtocolRequest({
    adapter: openAICompletionsAdapter,
    context: {},
    rawRequest: context.req.raw,
    source,
  }),
)
.post('/v1/completions', (context) =>
  handleProtocolRequest({
    adapter: openAILegacyCompletionsAdapter,
    context: {},
    rawRequest: context.req.raw,
    source,
  }),
)
```

Both instances use `EmptyProtocolContext`. Neither instance reads a surface flag.

### Adapter instances

Keep `openAICompletionsAdapter` as the chat instance: current Chat Completions parse, session hints, raw rewrite, model invocation, `writeOpenAICompletionsResponse`, and `writeOpenAICompletionsSSE`.

Add `openAILegacyCompletionsAdapter` from the same Completions internals:

- `protocol: ProviderProtocol.OpenAICompatible`
- official Completions parse
- Completions-shaped session hints when present
- Completions raw rewrite (model only; do not inject `messages` or `reasoning_effort`)
- legacy `modelInvocation` described below
- fixed writers `writeOpenAITextCompletionResponse` / `writeOpenAITextCompletionSSE`

Shared internals live next to the existing Completions modules (parse helpers, raw rewrite, error mapper, session extraction). Do not grow the chat ingress schema into a union of chat and legacy bodies. Do not add a Completions surface field to `ModelEgressContext`.

### Legacy ingress

New ingress, official Completions wire schema. Required field is `model`. Official `prompt` is accepted in every documented shape:

- omitted
- `null`
- `string` (including `""`)
- `string[]`
- token array (`number[]`)
- array of token arrays (`number[][]`)

Official `n` is accepted, including `n > 1`. Official `stop`, `echo`, `suffix`, `logprobs` (including `0`), `best_of`, `stream_options`, and the remaining Completions body fields are accepted and preserved for raw.

Parse 400 only for malformed JSON or schema-invalid values (wrong types, empty `model`). Do not 400 a well-typed official Completions body because the model path cannot honor it. Do not rewrite omitted/`null` `prompt` into `""` at parse time.

### Legacy raw

Same rewrite rules as chat, applied to a Completions body: rewrite `model` when the router resolved a different upstream id; leave the rest of the bytes alone when nothing changed. Omitted and `null` `prompt` stay omitted/`null` on the wire. Do not insert `prompt: ""`. Because `rawRequest` keeps the inbound URL, same-protocol raw lands on upstream `POST /v1/completions`.

If that upstream is chat-only and returns ordinary 4xx (including 404), the pipeline keeps today's raw 4xx rule: no fallback except 422, 429, and 5xx. This design does not special-case Completions 404 into a transform retry. An `openai-compatible` AI SDK / OAuth candidate has no raw capability, so it uses the legacy transform on the first attempt.

### Legacy model path

`modelInvocation` may throw `OpenAICompletionsUnsupportedFeatureError`. `openAICompletionsErrors.modelUnsupported` maps that error to 501 `unsupported_feature` with the feature token. That uses the existing `modelUnsupported` fallback path so a later same-protocol raw candidate can still succeed. Do not map these cases through `requestError`.

Transform is faithful only when the request is a single text prompt and does not ask Completions-only sampling or cardinality behavior:

| Condition | Model-path result |
| --- | --- |
| `prompt` is a single `string` (including `""`) | One user message with that text. |
| `prompt` is omitted or `null` | 501 `prompt_omitted`. Official omitted/`null` starts a new document at `<|endoftext|>`; an empty user message is not equivalent and some target providers reject empty users. Do not normalize omitted/`null` to `""`. |
| `prompt` is `string[]` with length 1 | Same as a single string. This is one prompt, not a join. |
| `prompt` is `string[]` with length != 1 | 501 `prompt_array`. Do not join with newlines. |
| `prompt` is a token array or array of token arrays | 501 `prompt_tokens`. |
| `n == null \|\| n === 1` (including omitted) | One choice. |
| `n` is a number other than `1` | 501 `n`. |
| `stop` present and not `null` | 501 `stop`. |
| `echo === true` | 501 `echo`. |
| `suffix` present and not `null` / `""` | 501 `suffix`. |
| `logprobs` is not `null` and not omitted, including `0` | 501 `logprobs`. Official `logprobs: 0` still requests the sampled-token logprob. The legacy writer always emits `choices[].logprobs: null`, so any non-null request is unfaithful unless a later change implements the matching egress. |
| `best_of == null \|\| best_of === 1` (including omitted) | One candidate. |
| `best_of` is a number other than `1` | 501 `best_of`. |
| `logit_bias` omitted, `null`, or `{}` | No bias. |
| `logit_bias` is a non-empty object | 501 `logit_bias`. |
| `stream_options` present and not `null` | 501 `stream_options`. `include_usage` and `include_obfuscation` change the Completions SSE contract. This issue does not implement those fields on the model path. |

Before the table, normalize official JSON `null` to omitted on the model path only. Raw still preserves `null` bytes.

| Wire field | Model-path normalization |
| --- | --- |
| `n` | `null` means omitted. Faithful when `n == null \|\| n === 1`. 501 only when `n` is a number other than `1`. |
| `best_of` | `null` means omitted. Faithful when `best_of == null \|\| best_of === 1`. 501 only when `best_of` is a number other than `1`. |
| `logit_bias` | `null` means empty. 501 only when the object is present and has at least one key. |
| `stop`, `echo`, `suffix`, `logprobs`, `stream_options` | `null` means omitted. Apply the 501 table only to non-null values. |
| `temperature`, `top_p`, `max_tokens`, `seed`, `presence_penalty`, `frequency_penalty` | Map only non-null values onto `AiSdkCallSettings`. Do not pass `null`. |

`stream` is not an `AiSdkCallSettings` field. Do not put it in `settings`. The legacy adapter sets `wantsStream: (request) => request.stream === true`. `stream: true` uses SSE writers. `stream` omitted, `null`, or `false` uses JSON writers.

Do not forward `user`: `AiSdkCallSettings` has no `user` field. Raw keeps `user`. The model path does not 501 `user`; it is an identity field, not a sampling or SSE-contract field.

Do not invent tools, `response_format`, or reasoning settings.

If several unfaithful options are present, throw on the first in the table order. Map through `openAICompletionsErrors.modelUnsupported`, not the Responses mapper and not `requestError`. Envelope:

```json
{
  "error": {
    "code": "unsupported_feature",
    "message": "OpenAI Completions feature is not supported: prompt_array",
    "type": "invalid_request_error"
  }
}
```

`type` stays the Completions `invalid_request_error` used by other Completions 4xx/501s. Tests assert `code`, the feature token in `message`, and status 501.

### Legacy egress

Official Completions JSON and SSE, not chat. Writers are fixed on `openAILegacyCompletionsAdapter`.

JSON `object: "text_completion"` must include:

- top-level `id` prefixed `cmpl-`
- top-level `object`
- top-level `created` (unix seconds)
- top-level `model` (resolved upstream model id from `ModelEgressContext`)
- `choices[]` with `text`, `index`, `logprobs`, `finish_reason`
- `choices[].logprobs` is `null` when the model stream does not supply logprobs
- optional `usage` when token counts exist

SSE chunks use `object: "text_completion"` and end with `data: [DONE]`. Every chunk, including partial text deltas and the finish chunk, carries the same identity fields: `id`, `object`, `created`, `model`, and `choices[].index`. `choices[].logprobs` is `null` when unavailable. `choices[].finish_reason` is `null` on partial chunks.

A chat adapter instance must not emit `text_completion`. A legacy adapter instance must not emit `chat.completion`.

## Compact: `POST /v1/responses/compact`

### Route

Register on the existing Responses Hono app, as a static path before `:id`:

```ts
.post('/v1/responses/compact', (context) =>
  handleProtocolRequest({
    adapter: openAIResponsesAdapter,
    context: { operation: 'compact' },
    rawRequest: context.req.raw,
    source,
  }),
)
```

`POST /v1/responses` keeps `context: {}` (or `{ operation: 'create' }`). Missing `operation` means create.

### Adapter context

```ts
type OpenAIResponsesContext = {
  readonly operation?: 'create' | 'compact';
};
```

Protocol remains `ProviderProtocol.OpenAIResponse`. Compact does not need a second Responses adapter: the compact 501 is thrown from `modelInvocation`, which already receives `TContext`, and compact never calls `writeOpenAIResponsesResponse` / `writeOpenAIResponsesSSE`.

Compact is unary JSON. Official compact has no `stream` field and returns `object: "response.compaction"` as a single JSON body. Live `openAIResponsesAdapter.wantsStream` is `(request) => request.stream === true`. Extra compact fields survive `.loose()`, so `stream: true` would otherwise be retained and the pipeline would set `streamRequested` / `upstreamStream` true. That must not happen.

```ts
wantsStream: (req, ctx) => ctx.operation !== 'compact' && req.stream === true
```

Create still streams only when `request.stream === true`. Compact never streams.

### Parse

Do not call `parseOpenAIResponses`. Create ingress requires `input` as a non-empty string or a `min(1)` item array that must still contain a semantic item after filtering. Official compact `input` may be omitted or `null`. Reusing create parse would 400 those bodies before candidate selection and block a legal same-protocol raw compact provider.

Add `parseOpenAIResponsesCompact` / `OpenAIResponsesCompactRequest`. Official wire recognition happens first; model and stream guards happen inside the same parse. `openAIResponsesAdapter.parse` dispatches on `context.operation`: create stays on `parseOpenAIResponses`; compact uses the compact parser. Create and compact do not share one Zod object.

Official compact body the parser must recognize:

- `model`: required but nullable (`string | null`). Do not treat JSON `null` as a wrong type.
- `input`: omitted, `null`, a string (including `""`), or an item array. Empty arrays are valid compact wire and must not 400.
- `instructions`, `previous_response_id`, `prompt_cache_key`, `prompt_cache_options`, `prompt_cache_retention`, `service_tier`: optional, each nullable.
- Extra fields survive `.loose()`, same as create.
- Compact parse does not require a semantic item.

After official recognition, parse applies these closed-scope guards. They must run inside `adapter.parse`. `ProtocolAdapter.model` returns `string`. The pipeline calls `adapter.model(request, context)` immediately after a successful parse. A throw there is not mapped by `requestError`; only parse throws are.

| Wire | Parse result |
| --- | --- |
| `stream === true` | 400 `invalid_request`. Official compact has no stream. Silently deleting `true` would return unary JSON to a client that asked for SSE. |
| `model` is `null`, omitted, or `""` | 400 `invalid_request`. Throw `ZodError` or `OpenAIResponsesTransformError('model')`. Do not throw `OpenAIResponsesUnsupportedFeatureError`; that mapper is 501. This is no-inference, not an official default. |
| `stream` omitted, `false`, or `null` | Parse continues. Any remaining `stream` key is stripped in compact raw rewrite. |
| `model` is a non-empty string | Success. `CompactRequest.model` is that string. |

On parse success, `CompactRequest.model` is already narrowed to a non-empty string. `adapter.model` returns `request.model` and must not throw. Compact responses stay unary JSON.

`openAIResponsesErrors.requestError` maps:

- `OpenAIResponsesUnsupportedFeatureError` → 501
- `SyntaxError` / `ZodError` / `InvalidCompressedRequestBodyError` / `OpenAIResponsesTransformError` → 400 `invalid_request`

When `model` is a non-empty string, raw compact must preserve omitted and `null` `input` bytes. Do not insert `input: []` or `input: ""`.

### Compact `model`

Official Compact describes `model` as the “Model ID used to generate the response.” Official curl / JS / Python examples all send a concrete model id. Generated OpenAI SDK types mark `model` required `string | null` but give `null` no semantics. That type is not a routing contract.

CLIProxyAPI Compact reads `body.model` as a string and hands it to ordinary routing. The Codex executor then overwrites `body.model` with the already-selected `req.Model`. Neither path infers provider or model from `null`, omitted `model`, or `previous_response_id`.

aio-proxy matches that no-inference policy. Do not add a previous-response owner route, a default model, or any other non-model route source for Compact.

Parse still recognizes official nullable `model` first (`string | null`); do not treat JSON `null` as a wrong type. After recognition, Compact must already have a non-empty string before parse returns. `null` / omitted / `""` is a protocol-shaped 400 `invalid_request` via `requestError`. This is not an official defined default. It is aio-proxy’s model-first policy, consistent with the CLIProxyAPI reference.

On success, `CompactRequest.model` is a non-empty string. `adapter.model` returns `request.model` and must not throw. A throw from `model()` after parse is not mapped by `requestError`.

### Same-protocol raw

Compact `rawRequest` is a dedicated rewrite. It MUST NOT reuse the create rewrite. Create rewrite strips `background` and clamps `reasoning.effort`; official compact has neither top-level `stream` nor those create-only mutations. Reusing create rewrite, or leaving the reuse as “may”, makes implementations diverge.

| Action | Field |
| --- | --- |
| Preserve | inbound path `/v1/responses/compact` via `new Request(raw, …)`. Do not rewrite onto `/v1/responses`. |
| Rewrite | `model` only when the router resolved a different id. |
| Preserve | omitted / `null` `input`. Do not invent `[]` or `""`. |
| Strip | any remaining `stream` key after parse 400s `stream === true`. `false` / `null` leftovers must not reach upstream. |
| Preserve | unknown extras, including create-only `background` / `reasoning` if a client sends them. |
| Do not apply | create `background` strip. |
| Do not apply | create `reasoning.effort` clamp. |

An `openai-response` raw candidate therefore forwards compact to compact. Success is the upstream unary JSON `object: "response.compaction"` body. `upstreamStream` is `false`.

### Transform-or-501 policy

This is the required defined policy:

| Candidate | Compact behavior |
| --- | --- |
| Same-protocol raw (`openai-response`) | Forward. Success is the upstream `response.compaction` body. |
| Model capability (any protocol, including `openai-response` AI SDK / OAuth) | Do not convert. `modelInvocation` throws `OpenAIResponsesUnsupportedFeatureError('responses_compact', 'POST /v1/responses/compact')`. Pipeline maps that to 501 `unsupported_feature` and may fall through to a later raw candidate. |
| No remaining candidate | Final 501, same envelope as retrieve. |

Never call `writeOpenAIResponsesResponse` / `writeOpenAIResponsesSSE` for compact. Those writers emit `object: "response"`, which is the wrong compact contract.

Do not locally summarize, do not mint `encrypted_content`, and do not pass compact output through a generic chat/completions transform.

Create-time `context_management` / `compact_threshold` on `POST /v1/responses` is not this issue. Leave create as it is.

## Responses resource 501s

Keep retrieve. Add the remaining official resource operations that currently 404. These routes must not enter the generation pipeline.

| Method and path | Feature token | Status |
| --- | --- | --- |
| `GET /v1/responses/:id` | `response_retrieval` | Already 501 |
| `DELETE /v1/responses/:id` | `response_delete` | Add 501 |
| `POST /v1/responses/:id/cancel` | `response_cancel` | Add 501 |
| `GET /v1/responses/:id/input_items` | `response_input_items` | Add 501 |

Do not register `GET /v1/responses`. It is not an official Responses operation; leaving it unregistered is the correct 404.

Implementation shape, same as retrieve:

```ts
() => openAIResponsesAdapter.errors.unsupported('response_delete')
```

Envelope stays:

```json
{
  "error": {
    "code": "unsupported_feature",
    "message": "OpenAI Responses feature is not supported: response_delete",
    "type": "unsupported_feature"
  }
}
```

Register static `/v1/responses/compact` before parameterized `/v1/responses/:id`.

Create-time fields are not resource operations:

- `background: true` on `POST /v1/responses` stays dropped-with-diagnostic.
- `store` on create stays forwarded on raw and forced `false` on the model path.
- `previous_response_id` stays a session hint only. No retrieve/replay/cancel/delete lifecycle.

Do not add invented `/store`, `/background`, or list URLs.

## Testing

### Adapter

- Legacy Completions parse accepts omitted/`null` `prompt`, `string`, `string[]`, token arrays, `n > 1`, `n: null`, `best_of: null`, `logprobs: 0`, and `stream_options`. It does not 400 those official shapes or rewrite omitted/`null` `prompt` to `""`.
- Legacy `rawRequest` rewrites only `model` when needed and forwards official Completions fields including omitted/`null` `prompt`, `prompt` arrays, `n`, `stop`, `echo`, `suffix`, `logprobs` (including `0`), `best_of`, and `stream_options`.
- Legacy `modelInvocation` converts a single string prompt (or a one-element `string[]`) to one user message. `n: null` and `best_of: null` do not 501. Omitted/`null` `prompt` is 501 `prompt_omitted`. Multi-prompt arrays, token prompts, numeric `n !== 1`, `stop`, `echo: true`, `suffix`, any non-null `logprobs` including `0`, numeric `best_of !== 1`, and non-null `stream_options` throw `OpenAICompletionsUnsupportedFeatureError` and map through `modelUnsupported`. Sampling `null`s are omitted from `AiSdkCallSettings`. `wantsStream` is `request.stream === true` only; `stream` is not copied into settings.
- Legacy writers emit `text_completion` with top-level `created` and `model`; `choices[].index`; `choices[].logprobs` (`null` when unavailable). SSE chunks carry the same identity fields on every event.
- Chat instance regression: existing Completions adapter tests still pass and still emit `chat.completion`.
- Compact parse accepts omitted and `null` `input` and does not use the create parser. Create parse still rejects missing/empty `input`. Official nullable `model` is recognized; `model: null` / omitted / `""` is a parse-time 400 `invalid_request` (`status` / `code` / envelope asserted) and does not invoke a provider. Successful compact parse narrows `model` to a non-empty string.
- Compact parse of `stream: true` is 400 `invalid_request` before any provider call and does not enter the streaming path.
- Compact `rawRequest` follows the compact allowlist: preserve omitted/`null` `input` and `/v1/responses/compact`; rewrite `model` only when needed; strip any remaining `stream` key; do not strip `background` or clamp `reasoning.effort`.
- Compact same-protocol raw with omitted `stream` sets `upstreamStream: false` and returns unary JSON `object: "response.compaction"`. `stream: false` / `null` still raw-forwards with `stream` stripped and `upstreamStream: false`.
- Compact `wantsStream` is false whenever `operation === 'compact'`.
- Compact `operation: 'compact'` throws `OpenAIResponsesUnsupportedFeatureError('responses_compact')` from `modelInvocation` and does not build a model ToolSet.
- Create surface is unchanged when `operation` is omitted, including create `wantsStream: request.stream === true`.

### Routes

- `GET /v1/responses/:id` remains 501 `response_retrieval` before any provider call.
- New delete / cancel / input_items routes return 501 with the table above and do not invoke a provider.
- `GET /v1/responses` remains unregistered (generic 404), not `response_list`.
- `POST /v1/responses/compact` does not 404.

### Dispatch matrix

Extend `packages/server/__tests__/cross-protocol-routing.test.ts` without turning compact into a naive extra `inboundCases` row (those rows expect 200 model conversion).

- Add a Completions inbound case: `POST /v1/completions` with `{ model, prompt }` as a single string. Same-protocol `openai-compatible` uses raw only. Cross-protocol uses model only and the JSON body matches `object: "text_completion"` with `created`, `model`, `choices[0].index`, and `choices[0].logprobs: null`.
- Add a Completions unfaithful-option case: inbound `n: 2` (or a multi-prompt array) against a model-only candidate is 501; the same body against a later `openai-compatible` raw candidate still raw-forwards.
- Add compact cases: same-protocol `openai-response` uses raw only and returns 200 unary JSON, including a regression whose body omits `input` or sets `input: null`, with `upstreamStream: false`. Each other provider protocol returns 501 `responses_compact` and must not call model invoke. Compact `stream: true` and `model: null` stay adapter/route 400s, not dispatch-matrix 200 rows.
- Keep the existing four-protocol create matrix.

### Docs

Update the inbound tables in `README.md` and `README.zh-Hans.md`:

| Protocol or purpose | Method and path |
| --- | --- |
| OpenAI Completions | `POST /v1/completions` |
| OpenAI Responses compact | `POST /v1/responses/compact` |

Add one sentence under the table: remaining official Responses resource operations (`GET /v1/responses/:id`, `DELETE /v1/responses/:id`, `POST /v1/responses/:id/cancel`, `GET /v1/responses/:id/input_items`) return a protocol-shaped 501.

Do not document `GET /v1/responses` as a list port. Do not list Images, Embeddings, or other epic children.

## Non-goals

- Implementing Responses `store`, `previous_response_id` replay, `background`, retrieve, delete, or cancel lifecycle.
- `POST /v1/responses/input_tokens` (official count endpoint; not in #205).
- Inventing a Responses list operation at `GET /v1/responses`.
- Chat Completions stored-completion retrieve (`/v1/chat/completions/{id}`).
- Server-side create compaction via `context_management.compact_threshold`.
- New inbound protocols or `imageModel` / `embeddingModel` wiring.
- Extending pipeline `ModelEgressContext` so one Completions adapter can pick chat vs legacy writers.
- Changing raw 4xx fallback rules.
- Reusing create `wantsStream` or create `rawRequest` for compact.
- Inferring Compact provider/model from `model: null`, omitted `model`, or `previous_response_id`.

## Self-review

- No TBD left in this spec. Compact `model: null` is not a user choice.
- Compact `model: null` / omitted / `""` is a parse-time 400. That is no-inference, not an official default.
- Compact does not inherit create `wantsStream`.
- Compact raw rewrite is a MUST allowlist, not “may reuse create rewrite.”

## Done when

- A Completions client can `POST /v1/completions` with an official wire body and receive same-protocol raw Completions, including `prompt` arrays and `n`, when an `openai-compatible` raw candidate exists.
- A single-string Completions request can be served cross-protocol as `text_completion` from `languageModel`, with `created`, `model`, `choices[].index`, and `choices[].logprobs`.
- Unfaithful Completions transform options 501 from `modelInvocation` without blocking a later raw candidate, and without joining multi-prompts, converting omitted/`null` `prompt` into an empty user, or dropping `stop` / `echo` / `suffix` / non-null `logprobs` / `best_of` / `stream_options`.
- A compact client can `POST /v1/responses/compact` with a non-empty `model` against an `openai-response` raw candidate without a new protocol enum, including omitted/`null` `input`. That raw path is unary JSON (`upstreamStream: false`). `stream: true` is 400. `model: null` / omitted / `""` is a parse-time 400 `invalid_request` with no provider call.
- Cross-protocol compact is 501 `responses_compact`, not a converted `response`.
- Retrieve stays 501; delete, cancel, and input_items are 501 instead of 404. `GET /v1/responses` is not treated as a list port.
- Adapter tests, dispatch-matrix coverage, and both README inbound tables match the ports above.
