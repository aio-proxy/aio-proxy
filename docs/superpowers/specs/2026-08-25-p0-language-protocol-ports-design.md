# P0 Language Protocol Ports

GitHub: [#205](https://github.com/aio-proxy/aio-proxy/issues/205) (parent [#204](https://github.com/aio-proxy/aio-proxy/issues/204))

Date: 2026-08-25

Status: awaiting review (revised after Sol review)

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
| Completions transform | In `modelInvocation`, 501 any option the `languageModel` path cannot honor without changing output cardinality or dropping requested behavior. Do not join multi-prompts. Do not silently drop `stop`, `echo`, `suffix`, `logprobs`, or `best_of`. |
| Compact transform | Same-protocol raw only. Cross-protocol is an explicit 501. Do not invent a local summarizer or a fake `compaction` item. Compact may keep one Responses adapter because its 501 happens in `modelInvocation`, which already receives `TContext`, and compact never uses create egress writers. |
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
3. New protocol enum for compact. Forbidden. Rejected.

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

- omitted (official: generate as if from the start of a new document)
- `string`
- `string[]`
- token array (`number[]`)
- array of token arrays (`number[][]`)

Official `n` is accepted, including `n > 1`. Official `stop`, `echo`, `suffix`, `logprobs`, `best_of`, and the remaining Completions body fields are accepted and preserved for raw.

Parse 400 only for malformed JSON or schema-invalid values (wrong types, empty `model`). Do not 400 a well-typed official Completions body because the model path cannot honor it.

### Legacy raw

Same rewrite rules as chat, applied to a Completions body: rewrite `model` when the router resolved a different upstream id; leave the rest of the bytes alone when nothing changed. Because `rawRequest` keeps the inbound URL, same-protocol raw lands on upstream `POST /v1/completions`.

If that upstream is chat-only and returns ordinary 4xx (including 404), the pipeline keeps today's raw 4xx rule: no fallback except 422, 429, and 5xx. This design does not special-case Completions 404 into a transform retry. An `openai-compatible` AI SDK / OAuth candidate has no raw capability, so it uses the legacy transform on the first attempt.

### Legacy model path

`modelInvocation` may throw `OpenAICompletionsUnsupportedFeatureError`. `openAICompletionsErrors.modelUnsupported` maps that error to 501 `unsupported_feature` with the feature token. That uses the existing `modelUnsupported` fallback path so a later same-protocol raw candidate can still succeed. Do not map these cases through `requestError`.

Transform is faithful only when the request is a single text prompt and does not ask Completions-only sampling or cardinality behavior:

| Condition | Model-path result |
| --- | --- |
| `prompt` omitted or a single `string` | One user message with that text (empty string when omitted). |
| `prompt` is `string[]` with length 1 | Same as a single string. This is one prompt, not a join. |
| `prompt` is `string[]` with length != 1 | 501 `prompt_array`. Do not join with newlines. |
| `prompt` is a token array or array of token arrays | 501 `prompt_tokens`. |
| `n` omitted or `1` | One choice. |
| `n` present and not `1` | 501 `n`. |
| `stop` present and not `null` | 501 `stop`. |
| `echo === true` | 501 `echo`. |
| `suffix` present and not `null` / `""` | 501 `suffix`. |
| `logprobs` present and not `null` / `0` | 501 `logprobs`. |
| `best_of` present and not `1` | 501 `best_of`. |
| `logit_bias` present and not empty | 501 `logit_bias`. |

`temperature`, `top_p`, `max_tokens`, `stream`, `user`, `seed`, `presence_penalty`, and `frequency_penalty` may be forwarded onto existing AI SDK settings when present. Do not invent tools, `response_format`, or reasoning settings.

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

### Parse

Reuse `parseOpenAIResponses`. Official compact bodies are `model` plus `input` (string or item array), which the create schema already accepts. Extra compact fields survive `.loose()`. Missing `model` or empty input is 400, same as create.

### Same-protocol raw

`rawRequest` stays the current create rewrite (`model` / effort clamp; strip create-time `background` if present). The inbound path `/v1/responses/compact` is preserved, so an `openai-response` raw candidate forwards compact to compact.

Do not rewrite compact onto `/v1/responses`.

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

- Legacy Completions parse accepts omitted `prompt`, `string`, `string[]`, token arrays, and `n > 1`. It does not 400 those official shapes.
- Legacy `rawRequest` rewrites only `model` when needed and forwards official Completions fields including `prompt` arrays, `n`, `stop`, `echo`, `suffix`, `logprobs`, and `best_of`.
- Legacy `modelInvocation` converts a single string prompt (or a one-element `string[]`) to one user message. Multi-prompt arrays, token prompts, `n !== 1`, `stop`, `echo: true`, `suffix`, requested `logprobs`, and `best_of !== 1` throw `OpenAICompletionsUnsupportedFeatureError` and map through `modelUnsupported` (fallback-capable 501). They are not joined or dropped.
- Legacy writers emit `text_completion` with top-level `created` and `model`; `choices[].index`; `choices[].logprobs` (`null` when unavailable). SSE chunks carry the same identity fields on every event.
- Chat instance regression: existing Completions adapter tests still pass and still emit `chat.completion`.
- Compact `operation: 'compact'` throws `OpenAIResponsesUnsupportedFeatureError('responses_compact')` from `modelInvocation` and does not build a model ToolSet.
- Create surface is unchanged when `operation` is omitted.
- Compact raw rewrite keeps the compact path and still clamps `model` / effort.

### Routes

- `GET /v1/responses/:id` remains 501 `response_retrieval` before any provider call.
- New delete / cancel / input_items routes return 501 with the table above and do not invoke a provider.
- `GET /v1/responses` remains unregistered (generic 404), not `response_list`.
- `POST /v1/responses/compact` does not 404.

### Dispatch matrix

Extend `packages/server/__tests__/cross-protocol-routing.test.ts` without turning compact into a naive extra `inboundCases` row (those rows expect 200 model conversion).

- Add a Completions inbound case: `POST /v1/completions` with `{ model, prompt }` as a single string. Same-protocol `openai-compatible` uses raw only. Cross-protocol uses model only and the JSON body matches `object: "text_completion"` with `created`, `model`, `choices[0].index`, and `choices[0].logprobs: null`.
- Add a Completions unfaithful-option case: inbound `n: 2` (or a multi-prompt array) against a model-only candidate is 501; the same body against a later `openai-compatible` raw candidate still raw-forwards.
- Add compact cases: same-protocol `openai-response` uses raw only and returns 200. Each other provider protocol returns 501 `responses_compact` and must not call model invoke.
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

## Done when

- A Completions client can `POST /v1/completions` with an official wire body and receive same-protocol raw Completions, including `prompt` arrays and `n`, when an `openai-compatible` raw candidate exists.
- A single-string Completions request can be served cross-protocol as `text_completion` from `languageModel`, with `created`, `model`, `choices[].index`, and `choices[].logprobs`.
- Unfaithful Completions transform options 501 from `modelInvocation` without blocking a later raw candidate, and without joining multi-prompts or dropping `stop` / `echo` / `suffix` / `logprobs` / `best_of`.
- A compact client can `POST /v1/responses/compact` against an `openai-response` raw candidate without a new protocol enum.
- Cross-protocol compact is 501 `responses_compact`, not a converted `response`.
- Retrieve stays 501; delete, cancel, and input_items are 501 instead of 404. `GET /v1/responses` is not treated as a list port.
- Adapter tests, dispatch-matrix coverage, and both README inbound tables match the ports above.
