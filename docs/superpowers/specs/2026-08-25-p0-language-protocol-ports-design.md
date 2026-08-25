# P0 Language Protocol Ports

GitHub: [#205](https://github.com/aio-proxy/aio-proxy/issues/205) (parent [#204](https://github.com/aio-proxy/aio-proxy/issues/204))

Date: 2026-08-25

Status: awaiting review

## Goal

Finish the remaining official language-generation ports on the existing `languageModel` pipeline. Clients that speak OpenAI Completions or Responses compact must be able to hit aio-proxy without a new protocol enum. Clients that probe remaining Responses resource operations must receive a stable protocol-shaped 501 instead of a generic 404.

This issue does not reopen the epic-wide protocol boundary. Images, Embeddings, Audio, Interactions, Realtime, Videos, Midjourney, Files, and Assistants stay out.

## Current state

Live checkout at this design:

| Surface | Today |
| --- | --- |
| `POST /v1/chat/completions` | Registered. `openAICompletionsAdapter` parses a Chat Completions body (`messages`) and egresses `chat.completion`. Protocol enum is `openai-compatible`. |
| `POST /v1/completions` | Missing. Official OpenAI Completions is the legacy prompt API (`prompt` in, `object: "text_completion"` out). |
| `POST /v1/responses` | Registered. `openAIResponsesAdapter` parses create bodies and egresses `response`. Protocol enum is `openai-response`. Create-time `background: true` is dropped with a diagnostic. Model-path create forces `store: false`. |
| `POST /v1/responses/compact` | Missing. Official compact is a stateless endpoint that returns `object: "response.compaction"` including opaque encrypted compaction items. Codex clients call this. |
| `GET /v1/responses/:id` | Explicit 501 via `errors.unsupported('response_retrieval')`. |
| Other Responses resource paths | Unregistered Hono 404. |

Shared pipeline behavior that this design relies on and must not change:

- Route files stay thin. `handleProtocolRequest` is the only candidate loop.
- Same-protocol raw wins. `rawRequest` returns `new Request(raw, …)`, so the inbound path is preserved and raw transport joins it onto the provider origin.
- Cross-protocol uses `modelInvocation`. If that throws `OpenAIResponsesUnsupportedFeatureError`, `modelUnsupported` maps it to 501 and later candidates still get a chance.

## Decisions

| Decision | Choice |
| --- | --- |
| Protocol enums | Keep `openai-compatible` and `openai-response`. No new enum. |
| Completions path | Implement official legacy Completions (`prompt` → `text_completion`) on the existing Completions adapter, not a `/v1/chat/completions` alias. |
| Compact transform | Same-protocol raw only. Cross-protocol is an explicit 501. Do not invent a local summarizer or a fake `compaction` item. |
| Create-time `store` / `background` | Unchanged. Do not 501 `POST /v1/responses` when those fields are present. |
| Resource 501s | Explicit named routes only. No catch-all `/v1/responses/*`. |
| Pipeline / capabilities | Reuse `languageModel`. No new dispatch seam. |

## Approaches considered

### Completions

1. Register `POST /v1/completions` as a second path that reuses the Chat Completions parse. Smallest change, but official Completions clients send `prompt` and expect `text_completion`. They would get 400. Rejected.
2. Add a new protocol enum for legacy Completions. Forbidden by the issue done-when. Rejected.
3. Keep `openai-compatible`. Extend the existing Completions adapter with a route context surface (`chat` vs `legacy`). Legacy gets its own parse, transform, and egress; chat stays unchanged. Chosen.

### Compact

1. Convert compact to a normal `languageModel` summarization and wrap the text as `response.compaction`. The official output is an encrypted, non-human-readable compaction item that later `/v1/responses` calls must consume as-is. A proxy-invented item would break Codex continuation. Rejected.
2. Same-protocol raw for `openai-response` candidates; `modelInvocation` throws `OpenAIResponsesUnsupportedFeatureError('responses_compact')` so every cross-protocol candidate is 501, while a later same-protocol candidate can still succeed. Chosen.
3. New protocol enum for compact. Forbidden. Rejected.

### Resource 501s

1. Hono catch-all under `/v1/responses/*`. Would race `POST /v1/responses/compact` and hide future generation ports. Rejected.
2. 501 `POST /v1/responses` when `store: true` or `background: true`. That changes the current drop/forward policy and is not required to stop generic 404s. Rejected.
3. Register the remaining official resource operations as thin 501 routes, matching retrieve. Chosen.

## Completions: `POST /v1/completions`

### Route

Add the path on the existing Completions Hono app next to chat:

```ts
.post('/v1/completions', (context) =>
  handleProtocolRequest({
    adapter: openAICompletionsAdapter,
    context: { surface: 'legacy' },
    rawRequest: context.req.raw,
    source,
  }),
)
```

`POST /v1/chat/completions` keeps `context: {}` (or `{ surface: 'chat' }`). Missing `surface` means chat.

### Adapter context

Replace `EmptyProtocolContext` on this adapter with:

```ts
type OpenAICompletionsContext = {
  readonly surface?: 'chat' | 'legacy';
};
```

Protocol remains `ProviderProtocol.OpenAICompatible`. Chat parse, session hints, raw rewrite, model invocation, and `chat.completion` writers stay on the chat surface.

### Legacy request

New ingress, not a widening of `OpenAICompletionsRequestSchema`. Required fields are official Completions fields: `model` and `prompt`.

Accepted `prompt` shapes:

- `string`
- `string[]`, joined with `\n` into one user message on the model path

Rejected at parse with Chat/Completions-shaped 400 `invalid_request`:

- missing `model` or `prompt`
- token-id arrays (`number[]` or `number[][]`)
- `n` present and not `1`

Unknown official fields (`suffix`, `echo`, `logprobs`, `stop`, `best_of`, and any extra keys) stay in the raw JSON. The model path does not reconstruct them.

### Legacy raw

Same rewrite rules as chat, applied to a Completions body: rewrite `model` when the router resolved a different upstream id; leave the rest of the bytes alone when nothing changed. Do not inject `messages` or `reasoning_effort`. Because `rawRequest` keeps the inbound URL, same-protocol raw lands on upstream `POST /v1/completions`.

If that upstream is chat-only and returns ordinary 4xx (including 404), the pipeline keeps today's raw 4xx rule: no fallback except 422, 429, and 5xx. This design does not special-case Completions 404 into a transform retry. An `openai-compatible` AI SDK / OAuth candidate has no raw capability, so it uses the legacy transform on the first attempt.

### Legacy model path

`prompt` becomes `[{ role: 'user', content: promptText }]`. Map `temperature` and `max_tokens` onto existing Completions transform settings. Do not invent tools, `response_format`, or reasoning settings.

Egress is official Completions, not chat:

- JSON `object: "text_completion"`, `id` prefixed `cmpl-`, `choices[0].text`, `choices[0].finish_reason`, optional `usage`
- SSE chunks use `object: "text_completion"` and end with `data: [DONE]`

A chat-surface request must not emit `text_completion`. A legacy-surface request must not emit `chat.completion`.

### Files

Keep chat modules. Add colocated legacy parse/transform/egress rather than growing the chat ingress schema. The adapter file branches on `context.surface` and stays under the handwritten size limit.

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

Protocol remains `ProviderProtocol.OpenAIResponse`.

### Parse

Reuse `parseOpenAIResponses`. Official compact bodies are `model` plus `input` (string or item array), which the create schema already accepts. Extra compact fields survive `.loose()`. Missing `model` or empty input is 400, same as create.

Do not add a second Responses protocol adapter.

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
| `GET /v1/responses` | `response_list` | Add 501 |
| `POST /v1/responses/:id/cancel` | `response_cancel` | Add 501 |
| `GET /v1/responses/:id/input_items` | `response_input_items` | Add 501 |

Implementation shape, same as retrieve:

```ts
() => openAIResponsesAdapter.errors.unsupported('response_list')
```

Envelope stays:

```json
{
  "error": {
    "code": "unsupported_feature",
    "message": "OpenAI Responses feature is not supported: response_list",
    "type": "unsupported_feature"
  }
}
```

Register static `/v1/responses` and `/v1/responses/compact` before parameterized `/v1/responses/:id`.

Create-time fields are not resource operations:

- `background: true` on `POST /v1/responses` stays dropped-with-diagnostic.
- `store` on create stays forwarded on raw and forced `false` on the model path.
- `previous_response_id` stays a session hint only. No retrieve/replay/cancel lifecycle.

Do not add invented `/store` or `/background` URLs.

## Testing

### Adapter

- Legacy Completions parse accepts `prompt` string and `string[]`; rejects token arrays, `n !== 1`, and chat `messages` without `prompt`.
- Legacy `rawRequest` rewrites only `model` when needed and forwards unknown Completions fields.
- Legacy `modelInvocation` is a single user message; `modelJson` / `modelSse` emit `text_completion`, never `chat.completion`.
- Chat surface regression: existing Completions adapter tests still pass with default context.
- Compact `operation: 'compact'` throws `OpenAIResponsesUnsupportedFeatureError('responses_compact')` from `modelInvocation` and does not build a model ToolSet.
- Create surface is unchanged when `operation` is omitted.
- Compact raw rewrite keeps the compact path and still clamps `model` / effort.

### Routes

- `GET /v1/responses/:id` remains 501 `response_retrieval` before any provider call.
- New list / cancel / input_items routes return 501 with the table above and do not invoke a provider.
- `POST /v1/responses/compact` does not 404.

### Dispatch matrix

Extend `packages/server/__tests__/cross-protocol-routing.test.ts` without turning compact into a naive extra `inboundCases` row (those rows expect 200 model conversion).

- Add a Completions inbound case: `POST /v1/completions` with `{ model, prompt }`. Same-protocol `openai-compatible` uses raw only. Cross-protocol uses model only and the JSON body matches `object: "text_completion"` with the model-path text.
- Add compact cases: same-protocol `openai-response` uses raw only and returns 200. Each other provider protocol returns 501 `responses_compact` and must not call model invoke.
- Keep the existing four-protocol create matrix.

### Docs

Update the inbound tables in `README.md` and `README.zh-Hans.md`:

| Protocol or purpose | Method and path |
| --- | --- |
| OpenAI Completions | `POST /v1/completions` |
| OpenAI Responses compact | `POST /v1/responses/compact` |

Add one sentence under the table: remaining Responses resource operations (`GET /v1/responses`, `GET /v1/responses/:id`, `POST /v1/responses/:id/cancel`, `GET /v1/responses/:id/input_items`) return a protocol-shaped 501.

Do not list Images, Embeddings, or other epic children.

## Non-goals

- Implementing Responses `store`, `previous_response_id` replay, `background`, retrieve, or cancel lifecycle.
- `POST /v1/responses/input_tokens` (official count endpoint; not in #205).
- Chat Completions stored-completion retrieve (`/v1/chat/completions/{id}`).
- Server-side create compaction via `context_management.compact_threshold`.
- New inbound protocols or `imageModel` / `embeddingModel` wiring.
- Changing raw 4xx fallback rules.

## Done when

- A Completions client can `POST /v1/completions` with `prompt` and receive either same-protocol raw Completions or a cross-protocol `text_completion` from `languageModel`.
- A compact client can `POST /v1/responses/compact` against an `openai-response` raw candidate without a new protocol enum.
- Cross-protocol compact is 501 `responses_compact`, not a converted `response`.
- Retrieve stays 501; list, cancel, and input_items are 501 instead of 404.
- Adapter tests, dispatch-matrix coverage, and both README inbound tables match the ports above.
