# P3: Google Interactions inbound protocol

- Date: 2026-08-25
- Status: revised after review
- Issue: [#208](https://github.com/aio-proxy/aio-proxy/issues/208) (parent [#204](https://github.com/aio-proxy/aio-proxy/issues/204))
- Official wire: [Interactions API reference](https://ai.google.dev/api/interactions-api), [Interactions overview](https://ai.google.dev/gemini-api/docs/interactions)

## Background

aio-proxy Gemini routes only accept `:generateContent`, `:streamGenerateContent`, and `:countTokens` under `POST /v1beta/models/*`. Any other `/v1beta/models/*` path 404s. There is no `POST /v1beta/interactions` route.

The inbound protocol enum is `openai-response`, `openai-compatible`, `anthropic`, and `gemini`. `gemini` means GenerateContent. The shared pipeline already does:

1. Parse through one `defineProtocolAdapter`.
2. Resolve candidates by the adapter's routing id.
3. Same-protocol raw when `provider.raw.resolve({ protocol: adapter.protocol })` returns a transport.
4. Otherwise convert through `languageModel` and egress in the inbound shape.
5. 501 when there is no raw transport and no model capability, or when conversion throws an unsupported-feature error.

`POST /v1beta/interactions` is not an alias of `:generateContent`. Google documents it as a distinct create surface: `model` XOR `agent`, required `input`, optional `stream`. Among `.reference` gateways, only CLIProxyAPI registers this port. CLIProxyAPI is evidence of gateway behavior, not the wire contract; field names, types, and SSE events in this spec follow the official Interactions API.

This issue adds Interactions as a fifth inbound protocol on the existing language pipeline. It does not reopen the epic-wide Images / Embeddings / Audio / Realtime capability split.

## Goal

A Gemini Interactions client can call aio-proxy at `POST /v1beta/interactions` without being rewritten as generateContent.

Done means:

- One new inbound protocol adapter, one thin route, adapter tests, dispatch-matrix coverage, and README inbound-table rows (EN + ZH).
- `model` XOR `agent`, required `input`, optional boolean `stream`.
- Same-protocol raw to an Interactions-capable upstream, including alias rewrite of the authored `model` or `agent` field.
- A closed convert-or-501 policy onto the four existing language protocols. Every official request field is either mapped or per-candidate 501. No silent drop.

## Non-goals

- Expanding the generateContent adapter to silently accept Interactions bodies.
- Images, Embeddings, Audio, Realtime, Videos.
- `GET /v1beta/interactions/:id`, cancel, delete, `last_event_id` resume, or any other Interactions product backend.
- Token counting for Interactions.
- Teaching Antigravity / other OAuth plugins a native Interactions raw transport. They keep today's GenerateContent raw resolver; Interactions inbound reaches them through convert, or 501s when convert refuses.
- CLIProxyAPI's separate `interactions-api-key` config surface. aio-proxy uses the existing API-provider / OAuth credential model.
- Pretending Interactions storage (`store` omitted/`true`) / `previous_interaction_id` / `background=true` / retrieve are implemented.

## Approaches considered

1. **New inbound protocol `gemini-interactions` (chosen).** One `defineProtocolAdapter`, one thin route, a new `ProviderProtocol` value. GenerateContent stays `gemini`. Raw matches only providers that expose `gemini-interactions`. Everything else is convert or 501. Matches AGENTS.md, issue #208, and parent #204.

2. **Bolt onto the generateContent adapter.** One protocol, two bodies. Same-protocol raw would rewrite Interactions onto `:generateContent` (today's `rawRequest` always does that). Explicitly out of scope.

3. **Raw-only, 501 every convert.** Smaller, but the issue requires a defined convert-or-501 policy onto existing language protocols. A language subset must convert; the rest 501.

## Core decisions

| Decision | Choice |
| --- | --- |
| Inbound protocol id | `gemini-interactions` (new `ProviderProtocol` + matching `ProtocolId`) |
| GenerateContent protocol | Unchanged `gemini`. The two are not aliases. |
| Route | New thin Hono route `POST /v1beta/interactions`. Do not extend `createGeminiGenerateContentRoutes`. |
| `input` | Required on parse for every request (raw and convert). Missing/null → 400. |
| `system_instruction` | Official wire type is `string`. Non-string → 400. Parts are not a raw-wire extension. |
| Stream | Body field `stream` (boolean). Not a URL suffix. Absent means false. |
| Routing id | Authored `model` or `agent` string after trim. Strip a `models/` prefix from `model` only. Agent ids are bare (`deep-research-preview-04-2026`), never `agents/...`. |
| Raw rewrite | Write `resolvedModel` (`candidate.modelId`) back into the **same XOR field the client sent**. Agent is not exempt from alias rewrite. |
| Same-protocol raw | `provider.raw.resolve({ protocol: 'gemini-interactions' })` hits. URL stays `/v1beta/interactions`. |
| Convert capability | Existing `languageModel`. This issue does not extend `streamAiSdkText` with AI SDK `output`. |
| Convert eligibility | Closed field table below. Mapped or per-candidate 501. No silent drop. |
| Convert `store` | Only explicit `store: false` converts. Omitted and `store: true` are per-candidate 501 (`modelUnsupported`). |
| Convert JSON usage | Official `Usage`: `total_input_tokens`, `total_output_tokens`, `total_tokens`, plus optional `total_thought_tokens` / `total_cached_tokens` / `total_tool_use_tokens`. Never `input_tokens` / `output_tokens`. |
| Convert SSE | Named `event: <event_type>` frames, one `status_update:in_progress` after created, `interaction.completed` then `event: done` / `[DONE]`. |
| Error envelope | Gemini-style `{ error: { code, message, status } }`. |
| Auth for API raw | Same as `gemini`: `x-goog-api-key`. SDK path prefix `/v1beta`. |
| Plugins | No plugin is Interactions-capable until its raw resolver accepts `gemini-interactions`. Antigravity today only raw-resolves `gemini`. |

## Architecture

Keep the existing layering. Interactions is another inbound protocol, not a GenerateContent branch and not a new generation capability.

```text
POST /v1beta/interactions
  -> geminiInteractionsAdapter.parse
  -> router.resolve(model | agent)
  -> candidate loop (unchanged)
       raw.resolve(gemini-interactions)?  raw passthrough
       else provider.model?               languageModel convert + Interactions egress
       else                               501
```

Units:

- **Route** (`packages/server/src/routes/gemini-interactions.ts`): `POST /v1beta/interactions` only. Mount next to the GenerateContent routes in `createRoutes`. No `:generateContent` path sharing.
- **Adapter** (`packages/core/src/protocol/gemini-interactions/`): `defineProtocolAdapter`. Protocol `gemini-interactions`. Owns parse, routing id, stream flag, raw rewrite, model invocation, Interactions JSON/SSE egress, and Gemini-shaped errors.
- **Ingress** (`packages/core/src/ingress/gemini-interactions/`): XOR + required `input` + `system_instruction` string + stream. Unknown official fields are retained so convert can 501 them; they are not stripped from the raw body.
- **Transform** (`packages/core/src/transform/gemini-interactions/`): language subset <-> `ModelMessage`. Throws typed errors for agent and non-convertible features.
- **Egress** (`packages/core/src/egress/gemini-interactions/`): Interactions JSON and the SSE event contract below from `languageModel` events.
- **Protocol identity**: add `ProviderProtocol.GeminiInteractions = 'gemini-interactions'` in `@aio-proxy/types`. Add the same literal to plugin-sdk `ProtocolId`. Exhaustive `switch`/`Record<ProviderProtocol, …>` sites (raw SDK prefix, API key header, probe, dashboard `PROTOCOL_LABELS`) must gain a `gemini-interactions` arm so they compile.

The pipeline candidate loop does not change. `handleProtocolRequest` / `attemptCandidates` already implement raw-then-model-then-501. `rawRequest` already receives `resolvedModel = candidate.modelId` after alias / provider-qualified routing.

## Wire contract

Official `interactions.create` request body ([reference](https://ai.google.dev/api/interactions-api)):

| Field | Official type | Parse |
| --- | --- | --- |
| `model` | string, XOR `agent` | Required if `agent` absent. Trim. Strip a leading `models/` for the **routing id only**. |
| `agent` | string, XOR `model` | Required if `model` absent. Trim. Routing id is the bare id. Do not require, add, or strip an `agents/` prefix. Official examples: `deep-research-preview-04-2026`, `antigravity-preview-05-2026`. |
| `input` | `Content` \| `Content[]` \| `Step[]` \| `string` | **Required.** Missing, `null`, or non-allowed type → 400 `INVALID_ARGUMENT`. Empty string and empty array are present and parse. |
| `system_instruction` | `string` | Optional. If present, must be a string. Object/array/parts → 400. Convert maps the string to a system `ModelMessage`; that is not a wire extension. |
| `stream` | boolean | Optional. Non-boolean → 400. Absent → false. |
| `tools` | `Tool[]` | Optional. Convert table below. |
| `response_format` | `ResponseFormat` or array | Optional. Convert table below. |
| `generation_config` | object, model-only | Optional. Convert table below. |
| `agent_config` | object, agent-only | Optional. Convert 501. |
| `store` | boolean | Optional. Official omitted ≡ `true` ([data storage](https://ai.google.dev/gemini-api/docs/interactions#data-storage-retention)). Convert table below. |
| `background` | boolean | Optional. Convert 501 when `true`. |
| `previous_interaction_id` | string | Optional. Convert 501 when present. |
| `environment` | object or string | Optional. Convert 501 when present. |
| `labels` | object | Optional. Convert 501 when present. |
| `safety_settings` | array | Optional. Convert 501 when present. |
| `service_tier` | enum | Optional. Convert 501 when present. |
| `webhook_config` | object | Optional. Convert 501 when present. |

XOR: both missing, both present, or blank after trim → 400 `INVALID_ARGUMENT` ("request requires exactly one of model or agent").

Any **other** top-level request field → convert 501 (unknown, do not strip on raw). Raw forwards the original bytes unless the XOR id field is rewritten.

`generation_config` official members: `max_output_tokens`, `seed`, `stop_sequences`, `thinking_level` (`minimal` \| `low` \| `medium` \| `high`), `thinking_summaries` (`auto` \| `none`), `tool_choice`, `speech_config`, `transcription_config`, `video_config`. Any other member (including CLIProxyAPI `top_p` / `temperature`) is unknown → convert 501.

### Missing `input`

Parse rejects before routing, raw, or convert:

| Body | Result | Test |
| --- | --- | --- |
| no `input` key | 400 `INVALID_ARGUMENT` | adapter parse test |
| `"input": null` | 400 | adapter parse test |
| `"input"` wrong type (number/boolean) | 400 | adapter parse test |
| `"input": ""` | parse succeeds (required field present) | adapter parse test |
| `"input": []` | parse succeeds | adapter parse test |
| convert of `[]` / `""` with no `system_instruction` | 400 at convert (`requestError`, request-terminal) | transform test |

Raw never sees a missing-`input` request.

## Routing id and raw rewrite

Pipeline fact: `attemptRawCandidate` calls `adapter.rawRequest(..., resolvedModel, ...)` where `resolvedModel` is `candidate.modelId` after alias and provider-qualified routing. GenerateContent already rewrites the resolved id into the upstream URL. Interactions carries the id in the body, in whichever XOR field the client sent.

Rules:

1. `adapter.model()` returns the routing key:
   - `model` present: trim, then strip one leading `models/` prefix if the remainder is non-empty. Example: `models/gemini-3.5-flash` → `gemini-3.5-flash`.
   - `agent` present: trim only. Example: `deep-research-preview-04-2026`. A client that sends `agents/foo` routes as `agents/foo`; aio-proxy does not canonicalize that to a Google agent id.
2. Router resolves that key against provider `models` / `alias` exactly as today. Agent ids are ordinary model catalog entries on an Interactions-capable provider.
3. `rawRequest` inspects which XOR field was authored:
   - Authored `model` → set body `model` to `resolvedModel` when it differs from the current `model` string.
   - Authored `agent` → set body `agent` to `resolvedModel` when it differs from the current `agent` string.
   - Never copy `model` onto `agent` or the reverse.
4. If neither XOR field needs rewriting (resolved id equals the current field value) **and** no other JSON rewrite applied, forward the **decoded body text** from `readRequestText` (same as GenerateContent). That helper decompresses `content-encoding` then decodes UTF-8. Compressed wire bytes are **not** preserved. Always drop `content-encoding` and `content-length` on the rewritten `Request` (the forwarded body is uncompressed text).
5. Pathname is always `/v1beta/interactions`. Query and inbound abort signal are preserved.

Raw tests that must exist:

- Model unchanged → decoded body **text** preserved, including `models/` spelling if it already matched `resolvedModel`. Do not assert equality of inbound compressed bytes.
- Gzip/br/zstd inbound → forwarded body is the decoded JSON text; outbound headers have no `content-encoding` / `content-length`.
- Model alias / provider-qualified id → rewrite `model` only (re-serialized JSON of the decoded object).
- `models/gemini-3.5-flash` routing id is `gemini-3.5-flash`; if `resolvedModel` is `gemini-3.5-flash` and the decoded body still has the prefix, rewrite `model` to the resolved bare id (official ModelOption has no `models/` prefix).
- Agent unchanged → decoded body text preserved.
- Agent alias → rewrite `agent` to `candidate.modelId`. This is the test that forbids “agent never rewrite”.
- Agent request never writes a `model` field.

aio-proxy does not copy CLIProxyAPI's hidden `gemini-2.5-flash` auth-selection model.

## Convert JSON egress

Non-stream convert returns an official-shaped `Interaction` resource. Minimum:

```json
{
  "id": "<generated>",
  "object": "interaction",
  "model": "<routed model id>",
  "status": "completed",
  "created": "<ISO-8601>",
  "updated": "<ISO-8601>",
  "steps": [
    {
      "type": "thought",
      "summary": [{ "type": "text", "text": "..." }]
    },
    {
      "type": "model_output",
      "content": [{ "type": "text", "text": "..." }]
    },
    {
      "type": "function_call",
      "name": "get_weather",
      "arguments": { "location": "Boston, MA" },
      "id": "<toolCallId>"
    }
  ],
  "usage": {
    "total_input_tokens": 7,
    "total_output_tokens": 20,
    "total_thought_tokens": 22,
    "total_cached_tokens": 0,
    "total_tool_use_tokens": 0,
    "total_tokens": 49
  }
}
```

Usage mapping from `languageModel` finish usage:

| Interactions | Source |
| --- | --- |
| `total_input_tokens` | input tokens |
| `total_output_tokens` | output tokens excluding thought tokens when those are separate; otherwise output tokens |
| `total_thought_tokens` | reasoning / thought tokens when present, else `0` |
| `total_cached_tokens` | cache-read tokens when present, else `0` |
| `total_tool_use_tokens` | `0` unless a concrete language-model usage field exists |
| `total_tokens` | `total_input_tokens + total_output_tokens + total_thought_tokens` when the SDK total is absent; otherwise SDK total |

Do **not** emit `usage.input_tokens` or `usage.output_tokens`. Modality breakdown arrays are omitted unless the SDK supplies them.

JSON and convert SSE use the same Interaction `status` mapping. The Interactions egress sees normalized `TextStreamPart` values and reads `part.finishReason` as a **string** (`stop` / `length` / `content-filter` / `tool-calls` / `error` / `other`, plus defensive `unknown`). V2/V4 finish-reason shapes are normalized in the AI SDK bridge, not here. Do not read `finishReason.unified`.

Apply this order (do not reorder):

| Priority | Condition | `status` / stream outcome |
| --- | --- | --- |
| 1 | Convert egress failure, or finish reason `error` | No Interaction JSON. SSE: `event: error`, then `event: done` / `[DONE]`. Never emit `interaction.completed`. |
| 2 | Unmatched `function_call` (no `function_result.call_id`) **or** finish reason `tool-calls` | `requires_action`. Text/`thought` steps do not suppress this. `other` / `unknown` must **not** override this. |
| 3 | Finish reason `length` or `content-filter` | `incomplete` (official: completed with incomplete results, e.g. max_tokens / safety stop). Do **not** label `completed`. |
| 3 | Finish reason `stop` | `completed`. |
| 4 | Finish reason `other` or `unknown`, and no unmatched `function_call` | Same error path as priority 1. Never label `completed`. |

Do not require “function calls are the only terminal output.” Thought + text + tool calls is still `requires_action`. Regression: finish `other` plus an unmatched `function_call` is `requires_action`, not the error path.

Agent convert never reaches egress (501 first). When `model` was authored, echo it on the resource; do not invent an `agent` field.

## Convert SSE contract

Convert `modelSse` writes **named** SSE events, matching CLIProxyAPI `SSEEventData` and the `@google/genai` `[DONE]` parser:

```text
event: <event_type>
data: <json-or-sentinel>

```

Each JSON payload still includes `event_type` (except the `done` sentinel, whose data is the literal `[DONE]`). Raw forwards upstream bytes unchanged.

`event_id` is an opaque resume token. Convert assigns `evt_1`, `evt_2`, … in emission order. `GET …?last_event_id=` resume remains out of scope; the field is still present so a client can ignore it.

`index` is a 0-based step index. It appears only on `step.start` / `step.delta` / `step.stop`. Start, every delta, and stop of one step share the same index. The next step increments by 1. No gaps.

### Event types convert emits

| `event_type` | Required fields | When |
| --- | --- | --- |
| `interaction.created` | `event_id`, `event_type`, `interaction` (`id`, `object: "interaction"`, `model`, `status: "in_progress"`) | First event. |
| `interaction.status_update` | `event_id`, `event_type`, `interaction_id`, `status` | Once, immediately after created, `status: "in_progress"` only. No terminal `status_update`. |
| `step.start` | `event_id`, `event_type`, `index`, `step` (see FunctionCallStep below) | Before deltas of that step. |
| `step.delta` | `event_id`, `event_type`, `index`, `delta` | Zero or more per step. Official `metadata` (including `total_usage`) is omitted on convert. |
| `step.stop` | `event_id`, `event_type`, `index` | After that step's deltas. Official optional `step_usage` is omitted on convert. |
| `interaction.completed` | `event_id`, `event_type`, `interaction` (full resource: `id`, `object`, `model`, `status`, `steps`, `usage`, `created`, `updated`) | Last **JSON** event on success. `status` uses the same mapping as non-stream JSON. |
| `done` | SSE `event: done` and `data: [DONE]` (not JSON) | After `interaction.completed` on success, and after `error` when the stream already opened. |
| `error` | `event_type` (`"error"`), `error` (`code`, `message`), `event_id` if one was already allocated | Instead of `interaction.completed` when convert egress fails, finish reason is `error`, or finish reason is `other` / `unknown` with no unmatched `function_call`. |

Convert does not emit audio / image / video / document / google_search / mcp deltas. Those request features 501 before invoke.

### `function_call` `step.start`

Official `FunctionCallStep` requires `type`, `id`, `name`, and `arguments` ([InteractionSseEvent](https://ai.google.dev/api/interactions-api)). Convert must not emit a start whose `step` omits any of them.

On AI SDK `tool-input-start` (id + `toolName` present):

```json
{"event_id":"evt_N","event_type":"step.start","index":1,"step":{"type":"function_call","id":"<toolCallId>","name":"<toolName>","arguments":{}}}
```

`arguments` at start is `{}`. Later `step.delta` `arguments_delta` fragments fill the object. The JSON / `interaction.completed` `function_call` step must still include the required keys; merged `arguments` may be `{}` if no deltas arrived.

If `id` or `name` is missing, **do not emit** that `step.start` (and no deltas/stop for it). Convert egress fails: non-stream returns a protocol error instead of an Interaction; stream already opened emits `error` and must not emit `interaction.completed`. Do not invent ids. A schema-level test must reject a `function_call` start missing `id`, `name`, or `arguments`.

### `delta` shapes convert may emit

| `delta.type` | Fields | From |
| --- | --- | --- |
| `text` | `text` | assistant text / model_output |
| `thought_summary` | `content` (text Content) | reasoning text on a `thought` step. Accumulate into the final step `summary`; never copy `content` onto the finished ThoughtStep. |
| `arguments_delta` | `arguments` (string fragment) | function-call argument streaming |

### Order (success)

```text
event: interaction.created
event: interaction.status_update   status=in_progress   (exactly once)
[ for each output step i = 0..n-1 ]
    event: step.start              index=i
    event: step.delta*             index=i
    event: step.stop               index=i
event: interaction.completed       status=completed | requires_action | incomplete
event: done
data: [DONE]
```

Skip a step type that the model did not produce. Do not emit empty `model_output` steps.

Step `type` values convert produces: `thought`, `model_output`, `function_call`.

Examples (convert frames, including `event:` lines):

```text
event: interaction.created
data: {"event_id":"evt_1","event_type":"interaction.created","interaction":{"id":"…","model":"gemini-3.5-flash","object":"interaction","status":"in_progress"}}

event: interaction.status_update
data: {"event_id":"evt_2","event_type":"interaction.status_update","interaction_id":"…","status":"in_progress"}

event: step.start
data: {"event_id":"evt_3","event_type":"step.start","index":0,"step":{"type":"model_output"}}

event: step.delta
data: {"event_id":"evt_4","event_type":"step.delta","index":0,"delta":{"type":"text","text":"Hello"}}

event: step.stop
data: {"event_id":"evt_5","event_type":"step.stop","index":0}

event: interaction.completed
data: {"event_id":"evt_6","event_type":"interaction.completed","interaction":{"id":"…","object":"interaction","model":"gemini-3.5-flash","status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"Hello"}]}],"usage":{"total_input_tokens":1,"total_output_tokens":1,"total_thought_tokens":0,"total_cached_tokens":0,"total_tool_use_tokens":0,"total_tokens":2}}}

event: done
data: [DONE]
```

SSE tests must assert named `event:` lines, this sequence, **no second** `status_update`, `done` / `[DONE]` after `interaction.completed`, monotonic `event_id` on JSON events, shared `index`, and `usage` field names on `interaction.completed`. They must fail if egress emits data-only frames, a terminal `status_update`, GenerateContent candidates, or `input_tokens`.

## Same-protocol raw

An upstream is Interactions-capable when its runtime raw resolver returns a transport for `gemini-interactions`.

API providers:

- Primary `protocol: "gemini-interactions"` with `baseURL` in AI SDK Google style (`https://generativelanguage.googleapis.com/v1beta`), or
- `endpoints` including `{ protocol: "gemini-interactions", baseURL: "..." }` beside a GenerateContent `gemini` endpoint.

Raw URL rewrite:

- Pathname is `/v1beta/interactions` (never `:generateContent` / `:streamGenerateContent`).
- Query string is preserved.
- Inbound abort signal is preserved.
- `content-encoding` / `content-length` dropped as in other adapters.
- SDK-mode join uses prefix `/v1beta` (same as `gemini`).
- API key header is `x-goog-api-key` (same as `gemini`).

`protocol: "gemini"` is **not** Interactions-capable. A Google GenerateContent provider is a convert candidate, not a raw Interactions candidate.

OAuth / plugin providers are Interactions-capable only if they opt into `gemini-interactions` on `RawResolver`. Today's Antigravity runtime raw-resolves `gemini` only, so Interactions inbound will not take its raw path.

Raw stream: forward the upstream response. Do not wrap or unwrap SSE.

## Convert-or-501 policy

Apply this at `modelInvocation` / transform time so raw can still forward agent and extra fields. **Closed:** every official create field is listed. Mapped or 501. Unknown field → 501. No silent drop.

### Convert (language subset, `model` set, `agent` absent)

Map onto `ModelMessage` + `AiSdkCallSettings` + function `ToolSet`, then invoke `languageModel` and egress as Interactions. Do not put structured output on `AiSdkCallSettings`.

| Inbound | Mapping |
| --- | --- |
| `input` string | one user text message |
| `input` `Content` / `Content[]` with `type: "text"` parts | user text |
| `input` steps `user_input` / `model_output` / `function_call` / `function_result` with text or function payloads | user / assistant / tool messages |
| `input` step `thought` | read `summary` (text Content → reasoning/text). `content` on a thought step is not official → 501 |
| `system_instruction` string | system message |
| `tools` entries that are function declarations | function `ToolSet` |
| `generation_config.max_output_tokens` | `maxOutputTokens` |
| `generation_config.seed` | `seed` |
| `generation_config.stop_sequences` | `stopSequences` |
| `generation_config.thinking_level` `minimal`\|`low`\|`medium`\|`high` | `reasoning` + dimensions `{ thinking: true, effort }` |
| `generation_config.thinking_summaries: "none"` | no extra setting |
| `generation_config.tool_choice` `"auto"` / `"none"` | matching tool choice when the SDK has it |
| `generation_config.tool_choice` `{ "allowed_tools": { "mode": "auto" } }` or `{ "allowed_tools": { "mode": "none" } }` with `tools` absent or `[]` | same as the matching string enum |
| `response_format` `{ "type": "text" }` with `mime_type` omitted or `"text/plain"` and no `schema` | no structured-output setting |
| `response_format` array of length 1 whose only member is that text/plain object | same as that object |
| `stream: true` | `wantsStream` true |
| `stream` absent / false | non-stream |
| `store: false` | convert (stateless language call) |
| `background` absent or `false` | convert |

`thinking_level` uses Google's Interactions enum only (`minimal` / `low` / `medium` / `high`). There is no Interactions `none` / `xhigh` / `off` on this wire. Dimensions: `{ thinking: true, effort }` from that enum.

Official `TextResponseFormat` extra keys besides `type` / `mime_type` / `schema` → 501. `schema` on `text/plain` → 501.

**JSON `response_format` (no bridge expansion):** `AiSdkCallSettings` is `LanguageModelCallOptions` plus request controls. It has no `responseFormat`. `streamAiSdkText` spreads settings into `streamText` and does not pass AI SDK `output` (`Output.object({ schema })` / `Output.json()`). This issue does not extend that typed-output path. Therefore `mime_type: "application/json"` (with or without `schema`) is convert-ineligible: per-candidate 501. Do not map it onto a non-existent settings field and do not drop it.

**`store` (official default):** omitted `store` ≡ `store: true` (server-side retention, `previous_interaction_id`, background). Convert cannot implement that backend and must not return a non-retrievable fake Interaction id. Only explicit `store: false` converts. Omitted and `true` throw the unsupported-feature error (`modelUnsupported` 501) so a later native Interactions raw candidate can still run.

The Interactions overview mentions `generation_config.temperature`. The official `GenerationConfig` object does **not** include `temperature` or `top_p`. Those keys are extra members → 501.

Targets: any candidate with a `languageModel` capability — `openai-response`, `openai-compatible`, `anthropic`, `gemini` (GenerateContent), and AI SDK / OAuth language models. No per-target Interactions translator. The ModelMessage pivot is the conversion, same as the other four inbound protocols.

### 501 `UNIMPLEMENTED` (convert-ineligible, per candidate)

| Feature | Reason |
| --- | --- |
| `agent` | Native Interactions only. 501, not 400. |
| `agent_config` | Agent-only. |
| `store` omitted or `store: true` | Official omitted ≡ stored Interaction. Convert cannot store or mint a retrievable id. |
| `background: true` | Background execution is a product backend. |
| `previous_interaction_id` | Stateful retrieve. |
| `environment`, `labels`, `safety_settings`, `service_tier`, `webhook_config` | No `languageModel` mapping. |
| `generation_config.speech_config` / `transcription_config` / `video_config` | Audio / video out of scope. |
| `generation_config.thinking_summaries: "auto"` | Cannot guarantee thought summaries on every language protocol. |
| `generation_config.tool_choice` `"any"` / `"validated"` | No faithful mapping. |
| `generation_config.tool_choice` object with `tools` names, extra keys, or mode other than `auto`/`none` | No faithful mapping. |
| Any other `generation_config` member (`temperature`, `top_p`, …) | Not on the official Interactions `GenerationConfig`; do not silently ignore. Empty `generation_config: {}` converts. |
| `response_format` `type` `image` / `audio` / `video` | Images / Audio / Videos out of scope. |
| `response_format` `type: "text"` with `mime_type: "application/json"` (schema or not) | No `streamAiSdkText` `output` in this issue. |
| `response_format` missing `type`, or `type: "text"` with unknown keys / `schema` on `text/plain` | Closed policy. |
| `response_format` array of length 0, length > 1, or containing any ineligible member | Whole field 501. Do not take the first eligible member and drop the rest. |
| `tools` that are not function declarations (`google_search`, `google_maps`, MCP, code execution, file search, url_context, retrieval, …) | Not function `ToolSet`. |
| Audio / video / image / document `Content` parts in `input` | Images / Audio out of scope. |
| `thought` step carrying `content` instead of / in addition to `summary` | Official ThoughtStep is `summary`, not `content`. |
| Step types other than `user_input` / `model_output` / `thought` / `function_call` / `function_result` | No ModelMessage mapping. |
| Unknown top-level field | Closed policy. |
| No model capability and no Interactions raw | Existing `errors.unsupported('transform_dispatch')`. |

Pipeline mapping that implementers must not invert (`resolveInvocation` in `packages/server/src/routes/pipeline/attempt/model-prepare.ts`):

- Convert-ineligible features throw a dedicated unsupported-feature error. `errors.modelUnsupported` maps it to 501. The pipeline stores `invocationUnsupported` and `emitReject`s **that candidate**, so a later Interactions-raw candidate can still run.
- This adapter's `errors.requestError` is **400 only** (Zod / syntax / XOR / missing `input` / stream type / `system_instruction` type / empty convertible transcript). Empty transcript is request-terminal because no candidate can invent messages.
- Never put `agent`, JSON/`image` `response_format`, omitted/`true` `store`, tools, or other convert-ineligible features on `requestError`. OpenAI Responses currently dual-maps some unsupported features onto `requestError` (501, request-terminal) **and** `modelUnsupported`; Interactions must not copy that. `modelUnsupported` is checked first; relying on `requestError` for 501 would still terminate the whole request if `modelUnsupported` missed the class.
- `errors.unsupported('transform_dispatch')` stays the no-capability 501, also per-candidate.

### 400 `INVALID_ARGUMENT`

- Invalid JSON / schema.
- `model` and `agent` both missing, both present, or blank.
- Missing or `null` `input`.
- `stream` present and not a boolean.
- `system_instruction` present and not a string.
- Convert path with a model id but nothing convertible to messages (`input` `""` / `[]` and no `system_instruction`).

### Explicitly not convert-or-501

- GenerateContent inbound (`:generateContent`) does not grow Interactions parsing.
- Other `/v1beta/models/*` verbs stay 404.
- No Interactions countTokens.

## Errors

Reuse the Gemini JSON error envelope already used by generateContent:

```json
{ "error": { "code": 501, "message": "...", "status": "UNIMPLEMENTED" } }
```

| Mapper | Status / status string |
| --- | --- |
| `requestError` | 400 `INVALID_ARGUMENT` (Zod / syntax / XOR / missing `input` / stream type / `system_instruction` type / empty convertible transcript) |
| `modelNotFound` | 404 `NOT_FOUND` |
| `previousResponseConflict` | 409 `ABORTED` |
| `tooLarge` | 413 `RESOURCE_EXHAUSTED` |
| `unsupportedContentEncoding` | 415 `INVALID_ARGUMENT` |
| `modelUnsupported` | 501 `UNIMPLEMENTED` (agent / omitted or `true` `store` / JSON or image `response_format` / non-function tools / unknown fields) |
| `unsupported` | 501 `UNIMPLEMENTED` (no model capability: `transform_dispatch`) |
| `rateLimited` | 429 `RESOURCE_EXHAUSTED` + `Retry-After` |
| provider abort | 499 `CANCELLED` |

Agent convert 501 message: `agent is only supported for native Interactions execution`.

## Config, dashboard, probe

Adding the enum value is user-visible because API providers declare `protocol` / `endpoints[].protocol` from `ProviderProtocol`.

Example Interactions-capable API provider:

```jsonc
{
  "kind": "api",
  "protocol": "gemini-interactions",
  "baseURL": "https://generativelanguage.googleapis.com/v1beta",
  "apiKey": "{{env.GEMINI_API_KEY}}",
  "models": ["gemini-3.5-flash", "deep-research-preview-04-2026"]
}
```

A dual-endpoint Google provider is legal and is the intended way to serve both surfaces without confusing them:

```jsonc
{
  "kind": "api",
  "protocol": "gemini",
  "baseURL": "https://generativelanguage.googleapis.com/v1beta",
  "apiKey": "{{env.GEMINI_API_KEY}}",
  "models": ["gemini-3.5-flash"],
  "endpoints": [
    { "protocol": "gemini-interactions", "baseURL": "https://generativelanguage.googleapis.com/v1beta" }
  ]
}
```

Follow-through required for a compiling tree, not a dashboard redesign:

- `PROTOCOL_LABELS` / `PROTOCOL_ORDER`: label `Gemini Interactions`, same Gemini icon.
- `SDK_VERSION_PREFIXES['gemini-interactions'] = '/v1beta'`.
- API raw auth: `x-goog-api-key`.
- Probe of a **primary** `gemini-interactions` endpoint: `POST /v1beta/interactions` with `{ model, input: "ping", store: false }` using `providerProbeModel()`. `store: false` is required so a successful probe does not persist an Interaction on Google. Probe does not send `agent`. If `models[0]` is only an agent id, probe may FAIL; that is acceptable.

No new CLIProxyAPI-style `interactions-api-key` list.

## Testing

Adapter / ingress tests (colocated, not under legacy `_test/`):

- XOR: model, `models/` prefix, bare agent (`deep-research-preview-04-2026`), missing, both, blank.
- Required `input`: omit, `null`, wrong type → 400; `""` and `[]` parse.
- `system_instruction` string accepted; parts/object → 400.
- `stream` true / absent / non-boolean.
- `protocol === gemini-interactions`.
- `model()` returns stripped model id or bare agent id.
- `wantsStream` reads the body, not the URL.

`rawRequest` tests:

- Pathname `/v1beta/interactions`, query preserved.
- Model id unchanged → decoded body text preserved (not inbound compressed bytes).
- Compressed inbound → decode, then forward uncompressed text; drop `content-encoding` / `content-length`.
- `models/` prefix rewritten to resolved bare model id.
- Model alias / provider-qualified `resolvedModel` rewrites `model` only.
- Agent id unchanged → decoded body text preserved.
- Agent alias rewrites `agent` to `candidate.modelId` and does not add `model`.

Convert / egress tests:

- Maps string `input` + string `system_instruction` + function tools + `thinking_level` + `store: false` + text/plain `response_format`, including a one-element eligible text/plain array and `tool_choice` object `{ "allowed_tools": { "mode": "auto" } }`.
- Throws 501-mapped (`modelUnsupported`, not `requestError`) errors for agent, omitted `store`, `store: true`, JSON `response_format` (schema or object mode), `response_format` image/audio/video, empty or multi-element `response_format` arrays, `google_search` tools, audio/video input parts, `previous_interaction_id`, unknown `generation_config` members (`temperature`), `thinking_summaries: "auto"`, and `tool_choice` object with `tools`.
- JSON usage uses `total_input_tokens` / `total_output_tokens` / `total_tokens`, never `input_tokens` / `output_tokens`.
- `status` mapping uses string `part.finishReason` (JSON and `interaction.completed`): `error` (or true egress failure) → protocol/SSE error; unmatched `function_call` / `tool-calls` → `requires_action` (regression: `other` + unmatched `function_call` is `requires_action`, not error); `length` **and** `content-filter` → `incomplete`; `stop` → `completed`; `other` / `unknown` with no unmatched call → error path. Tests use string finish reasons, not `{ unified }`.
- SSE uses named `event:` lines, one `status_update` (`in_progress`) after created, no terminal `status_update`, and `event: done` / `[DONE]` after `interaction.completed`.
- Schema-level: a `function_call` `step.start` missing `id`, `name`, or `arguments` fails. Happy path start is `{ type: "function_call", id, name, arguments: {} }`. Missing id/name fails egress instead of emitting the step.
- Schema-level: a final `thought` step with `content` fails; it must be `{ type: "thought", summary: [{ type: "text", text }] }`. Streaming `thought_summary` deltas still use `delta.content`.

Dispatch matrix (`packages/server/__tests__/cross-protocol-routing.test.ts`):

- Add inbound `{ protocol: gemini-interactions, path: '/v1beta/interactions', body: { model: 'm', input: 'hello', store: false } }` so convert cells are eligible.
- Add `ProviderProtocol.GeminiInteractions` to the provider-protocol list.
- Existing 4×4 cells stay: raw iff inbound protocol equals provider protocol.
- New row/column: Interactions inbound raw only against `gemini-interactions`; convert against `gemini` / `openai-response` / `openai-compatible` / `anthropic`.
- Convert response shape is Interactions (`object: "interaction"`, `steps`, `usage.total_input_tokens`), never GenerateContent `candidates`.
- Antigravity fixture still raw-resolves only `gemini`. Interactions inbound against Antigravity is convert (`model` + `store: false`), not raw.
- Omitted or `store: true` inbound 501s on language-only / Antigravity convert; a later `gemini-interactions` raw candidate still raws.
- Agent inbound against a language-only provider 501s; against a `gemini-interactions` raw provider raws, including after an agent alias rewrite.

README (both `README.md` and `README.zh-Hans.md`):

- Add a row for Gemini Interactions: `POST /v1beta/interactions`.
- Do not list retrieve/cancel. Do not fold it into the GenerateContent row.

## File layout

New handwritten non-test files stay under the 500-line cap and split by responsibility:

```text
packages/core/src/protocol/gemini-interactions/     # adapter
packages/core/src/ingress/gemini-interactions/      # parse / XOR / required input
packages/core/src/transform/gemini-interactions/    # ModelMessage pivot
packages/core/src/egress/gemini-interactions/       # JSON + SSE event contract
packages/server/src/routes/gemini-interactions.ts   # thin POST route
```

`packages/server/src/routes/gemini-generate-content.ts` does not grow Interactions. `packages/core/src/protocol/gemini-generate-content/` does not parse Interactions bodies.

## Changesets

User-facing. Target `aio-proxy` at the same bump as internals (`@aio-proxy/core`, `@aio-proxy/types`, `@aio-proxy/plugin-sdk`, `server`). Never internals-only.

## Out of scope recap

- generateContent silently accepting Interactions.
- Images / Embeddings / Audio / Realtime / Videos.
- Interactions retrieve/cancel/countTokens / `last_event_id` resume.
- Making Antigravity natively Interactions-capable.
- Reopening parent #204's capability boundary.
