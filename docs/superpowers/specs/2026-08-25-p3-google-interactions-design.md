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
- Pretending Interactions `store=true` / `previous_interaction_id` / `background=true` / retrieve are implemented.

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
| Convert capability | Existing `languageModel`. No new pipeline capability. |
| Convert eligibility | Closed field table below. Mapped or per-candidate 501. No silent drop. |
| Convert `store` omitted | Convert (stateless). Official default is `store=true`; this is an explicit proxy divergence, not a silent drop of a request field. |
| Convert JSON usage | Official `Usage`: `total_input_tokens`, `total_output_tokens`, `total_tokens`, plus optional `total_thought_tokens` / `total_cached_tokens` / `total_tool_use_tokens`. Never `input_tokens` / `output_tokens`. |
| Convert SSE | Full `event_type` contract and order in the SSE section. Not a generic delta/completed stream. |
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
| `store` | boolean | Optional. Official default is `true`. Convert table below. |
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
4. If neither XOR field needs rewriting (resolved id equals the current field value) **and** no other raw rewrite applied, forward the original body bytes verbatim (same as GenerateContent).
5. Pathname is always `/v1beta/interactions`. Query, abort signal, and `content-encoding` / `content-length` handling match GenerateContent.

Raw tests that must exist:

- Model unchanged → original body bytes preserved, including `models/` spelling if it already matched `resolvedModel`.
- Model alias / provider-qualified id → rewrite `model` only.
- `models/gemini-3.5-flash` routing id is `gemini-3.5-flash`; if `resolvedModel` is `gemini-3.5-flash` and the body still has the prefix, rewrite `model` to the resolved bare id (official ModelOption has no `models/` prefix).
- Agent unchanged → original body bytes preserved.
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
      "content": [{ "type": "text", "text": "..." }]
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

`status` is `requires_action` when the only terminal model output is function calls; otherwise `completed`.

Agent convert never reaches egress (501 first). When `model` was authored, echo it on the resource; do not invent an `agent` field.

## Convert SSE contract

Convert `modelSse` writes SSE **data frames** (`data: <json>\n\n`). The JSON always has `event_type`. Convert does not use SSE `event:` lines. Raw forwards upstream bytes unchanged.

`event_id` is an opaque resume token. Convert assigns `evt_1`, `evt_2`, … in emission order. `GET …?last_event_id=` resume remains out of scope; the field is still present so a client can ignore it.

`index` is a 0-based step index. It appears only on `step.start` / `step.delta` / `step.stop`. Start, every delta, and stop of one step share the same index. The next step increments by 1. No gaps.

### Event types convert emits

| `event_type` | Required fields | When |
| --- | --- | --- |
| `interaction.created` | `event_id`, `event_type`, `interaction` (`id`, `object: "interaction"`, `model`, `status: "in_progress"`) | First event. |
| `interaction.status_update` | `event_id`, `event_type`, `interaction_id`, `status` | Immediately after created (`in_progress`); again after the last `step.stop` with `completed` or `requires_action`. |
| `step.start` | `event_id`, `event_type`, `index`, `step` (`type`; for `function_call` also `name` and `id` when known) | Before deltas of that step. |
| `step.delta` | `event_id`, `event_type`, `index`, `delta` | Zero or more per step. Official `metadata` (including `total_usage`) is omitted on convert. |
| `step.stop` | `event_id`, `event_type`, `index` | After that step's deltas. Official optional `step_usage` is omitted on convert. |
| `interaction.completed` | `event_id`, `event_type`, `interaction` (full resource: `id`, `object`, `model`, `status`, `steps`, `usage`, `created`, `updated`) | Last event on success. |
| `error` | `event_type` (`"error"`), `error` (`code`, `message`), `event_id` if one was already allocated | Instead of `interaction.completed` when convert egress fails after the stream opened. |

Convert does not emit audio / image / video / document / google_search / mcp deltas. Those request features 501 before invoke.

### `delta` shapes convert may emit

| `delta.type` | Fields | From |
| --- | --- | --- |
| `text` | `text` | assistant text / model_output |
| `thought_summary` | `content` (text Content) | reasoning text on a `thought` step |
| `arguments_delta` | `arguments` (string fragment) | function-call argument streaming |

### Order (success)

```text
interaction.created
interaction.status_update   status=in_progress
[ for each output step i = 0..n-1 ]
    step.start              index=i
    step.delta*             index=i
    step.stop               index=i
interaction.status_update   status=completed | requires_action
interaction.completed
```

Skip a step type that the model did not produce. Do not emit empty `model_output` steps.

Step `type` values convert produces: `thought`, `model_output`, `function_call`.

Examples (convert):

```json
{"event_id":"evt_1","event_type":"interaction.created","interaction":{"id":"…","model":"gemini-3.5-flash","object":"interaction","status":"in_progress"}}
{"event_id":"evt_2","event_type":"interaction.status_update","interaction_id":"…","status":"in_progress"}
{"event_id":"evt_3","event_type":"step.start","index":0,"step":{"type":"model_output"}}
{"event_id":"evt_4","event_type":"step.delta","index":0,"delta":{"type":"text","text":"Hello"}}
{"event_id":"evt_5","event_type":"step.stop","index":0}
{"event_id":"evt_6","event_type":"interaction.status_update","interaction_id":"…","status":"completed"}
{"event_id":"evt_7","event_type":"interaction.completed","interaction":{"id":"…","object":"interaction","model":"gemini-3.5-flash","status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"Hello"}]}],"usage":{"total_input_tokens":1,"total_output_tokens":1,"total_thought_tokens":0,"total_cached_tokens":0,"total_tool_use_tokens":0,"total_tokens":2}}}
```

SSE tests must assert this `event_type` sequence, monotonic `event_id`, shared `index` across start/delta/stop, and `usage` field names on `interaction.completed`. They must fail if egress emits GenerateContent candidates or `input_tokens`.

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

Map onto `ModelMessage` + `AiSdkCallSettings` + function `ToolSet` (+ optional `responseFormat`), then invoke `languageModel` and egress as Interactions.

| Inbound | Mapping |
| --- | --- |
| `input` string | one user text message |
| `input` `Content` / `Content[]` with `type: "text"` parts | user text |
| `input` steps `user_input` / `model_output` / `thought` / `function_call` / `function_result` with text or function payloads | user / assistant / tool messages |
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
| `response_format` `{ "type": "text", "mime_type": "application/json", "schema" }` | AI SDK JSON `responseFormat` / schema |
| `response_format` `{ "type": "text", "mime_type": "application/json" }` without schema | JSON object mode |
| `response_format` array of length 1 whose only member is eligible | same as that object |
| `stream: true` | `wantsStream` true |
| `stream` absent / false | non-stream |
| `store: false` | convert; convert is always stateless |
| `store` omitted | convert; convert is always stateless (see divergence note) |
| `background` absent or `false` | convert |

`thinking_level` uses Google's Interactions enum only (`minimal` / `low` / `medium` / `high`). There is no Interactions `none` / `xhigh` / `off` on this wire. Dimensions: `{ thinking: true, effort }` from that enum.

Official `TextResponseFormat` extra keys besides `type` / `mime_type` / `schema` → 501. `schema` on `text/plain` → 501.

**`store` omitted (explicit divergence):** Google's Interactions overview defaults omitted `store` to `store=true` (server-side retention, `previous_interaction_id`, background). Convert cannot implement that product backend. aio-proxy still converts an omitted `store` as a **stateless** language call, same as `store: false`. This is not a silent field drop: the key is absent. It is a default-semantics divergence. `store: true` remains per-candidate 501. If product later wants Google-default fidelity, change omitted `store` to 501; do not start storing.

The Interactions overview mentions `generation_config.temperature`. The official `GenerationConfig` object does **not** include `temperature` or `top_p`. Those keys are extra members → 501.

Targets: any candidate with a `languageModel` capability — `openai-response`, `openai-compatible`, `anthropic`, `gemini` (GenerateContent), and AI SDK / OAuth language models. No per-target Interactions translator. The ModelMessage pivot is the conversion, same as the other four inbound protocols.

### 501 `UNIMPLEMENTED` (convert-ineligible, per candidate)

| Feature | Reason |
| --- | --- |
| `agent` | Native Interactions only. 501, not 400. |
| `agent_config` | Agent-only. |
| `store: true` | Convert cannot implement official storage / `previous_interaction_id` continuation. |
| `background: true` | Background execution is a product backend. |
| `previous_interaction_id` | Stateful retrieve. |
| `environment`, `labels`, `safety_settings`, `service_tier`, `webhook_config` | No `languageModel` mapping. |
| `generation_config.speech_config` / `transcription_config` / `video_config` | Audio / video out of scope. |
| `generation_config.thinking_summaries: "auto"` | Cannot guarantee thought summaries on every language protocol. |
| `generation_config.tool_choice` `"any"` / `"validated"` | No faithful mapping. |
| `generation_config.tool_choice` object with `tools` names, extra keys, or mode other than `auto`/`none` | No faithful mapping. |
| Any other `generation_config` member (`temperature`, `top_p`, …) | Not on the official Interactions `GenerationConfig`; do not silently ignore. Empty `generation_config: {}` converts. |
| `response_format` `type` `image` / `audio` / `video` | Images / Audio / Videos out of scope. |
| `response_format` missing `type`, or `type: "text"` with unknown keys / `schema` on `text/plain` | Closed policy. |
| `response_format` array of length 0, length > 1, or containing any ineligible member | Whole field 501. Do not take the first eligible member and drop the rest. |
| `tools` that are not function declarations (`google_search`, `google_maps`, MCP, code execution, file search, url_context, retrieval, …) | Not function `ToolSet`. |
| Audio / video / image / document `Content` parts in `input` | Images / Audio out of scope. |
| Step types other than `user_input` / `model_output` / `thought` / `function_call` / `function_result` | No ModelMessage mapping. |
| Unknown top-level field | Closed policy. |
| No model capability and no Interactions raw | Existing `errors.unsupported('transform_dispatch')`. |

Pipeline mapping that implementers must not invert (`resolveInvocation` in `packages/server/src/routes/pipeline/attempt/model-prepare.ts`):

- Convert-ineligible features throw a dedicated unsupported-feature error. `errors.modelUnsupported` maps it to 501. The pipeline stores `invocationUnsupported` and `emitReject`s **that candidate**, so a later Interactions-raw candidate can still run.
- This adapter's `errors.requestError` is **400 only** (Zod / syntax / XOR / missing `input` / stream type / `system_instruction` type / empty convertible transcript). Empty transcript is request-terminal because no candidate can invent messages.
- Never put `agent`, `response_format`, `store: true`, tools, or other convert-ineligible features on `requestError`. OpenAI Responses currently dual-maps some unsupported features onto `requestError` (501, request-terminal) **and** `modelUnsupported`; Interactions must not copy that. `modelUnsupported` is checked first; relying on `requestError` for 501 would still terminate the whole request if `modelUnsupported` missed the class.
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
| `modelUnsupported` | 501 `UNIMPLEMENTED` (agent / `store: true` / ineligible `response_format` / non-function tools / unknown fields) |
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
- Probe of a **primary** `gemini-interactions` endpoint: `POST /v1beta/interactions` with `{ model, input: "ping" }` using `providerProbeModel()`. Probe does not send `agent`. If `models[0]` is only an agent id, probe may FAIL; that is acceptable.

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
- Model id unchanged → original body bytes.
- `models/` prefix rewritten to resolved bare model id.
- Model alias / provider-qualified `resolvedModel` rewrites `model` only.
- Agent id unchanged → original body bytes.
- Agent alias rewrites `agent` to `candidate.modelId` and does not add `model`.

Convert / egress tests:

- Maps string `input` + string `system_instruction` + function tools + `thinking_level` + JSON `response_format`, including a one-element eligible `response_format` array and `tool_choice` object `{ "allowed_tools": { "mode": "auto" } }`.
- Throws 501-mapped (`modelUnsupported`, not `requestError`) errors for agent, `store: true`, `response_format` image/audio/video, empty or multi-element `response_format` arrays, `google_search` tools, audio/video input parts, `previous_interaction_id`, unknown `generation_config` members (`temperature`), `thinking_summaries: "auto"`, and `tool_choice` object with `tools`.
- JSON usage uses `total_input_tokens` / `total_output_tokens` / `total_tokens`, never `input_tokens` / `output_tokens`.
- SSE sequence, `event_id`, `index`, and `delta` shapes match the SSE contract. Writers are Interactions, not generateContent.

Dispatch matrix (`packages/server/__tests__/cross-protocol-routing.test.ts`):

- Add inbound `{ protocol: gemini-interactions, path: '/v1beta/interactions', body: { model: 'm', input: 'hello' } }`.
- Add `ProviderProtocol.GeminiInteractions` to the provider-protocol list.
- Existing 4×4 cells stay: raw iff inbound protocol equals provider protocol.
- New row/column: Interactions inbound raw only against `gemini-interactions`; convert against `gemini` / `openai-response` / `openai-compatible` / `anthropic`.
- Convert response shape is Interactions (`object: "interaction"`, `steps`, `usage.total_input_tokens`), never GenerateContent `candidates`.
- Antigravity fixture still raw-resolves only `gemini`. Interactions inbound against Antigravity is convert (`model`), not raw.
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
