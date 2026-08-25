# P3: Google Interactions inbound protocol

- Date: 2026-08-25
- Status: ready for review
- Issue: [#208](https://github.com/aio-proxy/aio-proxy/issues/208) (parent [#204](https://github.com/aio-proxy/aio-proxy/issues/204))

## Background

aio-proxy Gemini routes only accept `:generateContent`, `:streamGenerateContent`, and `:countTokens` under `POST /v1beta/models/*`. Any other `/v1beta/models/*` path 404s. There is no `POST /v1beta/interactions` route.

The inbound protocol enum is `openai-response`, `openai-compatible`, `anthropic`, and `gemini`. `gemini` means GenerateContent. The shared pipeline already does:

1. Parse through one `defineProtocolAdapter`.
2. Resolve candidates by the adapter's routing id.
3. Same-protocol raw when `provider.raw.resolve({ protocol: adapter.protocol })` returns a transport.
4. Otherwise convert through `languageModel` and egress in the inbound shape.
5. 501 when there is no raw transport and no model capability, or when conversion throws an unsupported-feature error.

`POST /v1beta/interactions` is not an alias of `:generateContent`. Among `.reference` gateways, only CLIProxyAPI registers this port. It treats Interactions as its own entry protocol (`interactions`), keeps a dedicated `gemini-interactions` executor that POSTs to `{base}/{v1beta}/interactions`, and converts to Claude / Codex / OpenAI / Antigravity / GenerateContent only when the request is model-targeted. Agent requests are forced onto native Interactions execution.

This issue adds Interactions as a fifth inbound protocol on the existing language pipeline. It does not reopen the epic-wide Images / Embeddings / Audio / Realtime capability split.

## Goal

A Gemini Interactions client can call aio-proxy at `POST /v1beta/interactions` without being rewritten as generateContent.

Done means:

- One new inbound protocol adapter, one thin route, adapter tests, dispatch-matrix coverage, and README inbound-table rows (EN + ZH).
- `model` XOR `agent`, optional boolean `stream`.
- Same-protocol raw to an Interactions-capable upstream.
- A closed convert-or-501 policy onto the four existing language protocols.

## Non-goals

- Expanding the generateContent adapter to silently accept Interactions bodies.
- Images, Embeddings, Audio, Realtime, Videos.
- `GET /v1beta/interactions/:id`, cancel, or any other Interactions product backend.
- Token counting for Interactions.
- Teaching Antigravity / other OAuth plugins a native Interactions raw transport. They keep today's GenerateContent raw resolver; Interactions inbound reaches them through convert, or 501s when convert refuses.
- CLIProxyAPI's separate `interactions-api-key` config surface. aio-proxy uses the existing API-provider / OAuth credential model.
- Pretending Interactions `store` / `previous_interaction_id` / background / retrieve are implemented.

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
| Stream | Body field `stream` (boolean). Not a URL suffix. Absent means false. |
| Routing id | `model` after stripping a `models/` prefix, else the `agent` resource name. Model-first router is unchanged. |
| Same-protocol raw | `provider.raw.resolve({ protocol: 'gemini-interactions' })` hits. URL stays `/v1beta/interactions`. |
| Convert capability | Existing `languageModel`. No new pipeline capability. |
| Convert eligibility | Model-targeted language subset only. Agent and non-language / stateful extras 501. |
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
- **Ingress** (`packages/core/src/ingress/gemini-interactions/`): XOR + stream + convert-relevant fields. Unknown wire fields must not be stripped from the raw body.
- **Transform** (`packages/core/src/transform/gemini-interactions/`): language subset <-> `ModelMessage`. Throws typed errors for agent and non-convertible features.
- **Egress** (`packages/core/src/egress/gemini-interactions/`): Interactions JSON and SSE from `languageModel` events.
- **Protocol identity**: add `ProviderProtocol.GeminiInteractions = 'gemini-interactions'` in `@aio-proxy/types`. Add the same literal to plugin-sdk `ProtocolId`. Exhaustive `switch`/`Record<ProviderProtocol, …>` sites (raw SDK prefix, API key header, probe, dashboard `PROTOCOL_LABELS`) must gain a `gemini-interactions` arm so they compile.

The pipeline candidate loop does not change. `handleProtocolRequest` / `attemptCandidates` already implement raw-then-model-then-501.

## Wire contract

Grounded in CLIProxyAPI's Interactions handler and translators (the only `.reference` implementation of this port). Official Google field names that CLIProxyAPI already accepts:

Request (JSON object):

- `model` XOR `agent`: exactly one, non-empty string after trim. Both missing, both present, or empty → 400 `INVALID_ARGUMENT` ("request requires exactly one of model or agent").
- `stream`: optional. Must be a boolean if present. Non-boolean → 400. Default false.
- `input`: optional for parse/raw. String, step object, or array of steps (`user_input`, `model_output`, `thought`, `function_call`, `function_result`, …).
- `system_instruction`: optional text or parts.
- `generation_config`: optional. Snake_case on this wire (`top_p`, `max_output_tokens`, `thinking_level`, `thinking_budget`, `thinking_summaries`, `tool_choice`).
- `tools`: optional function declarations / tool choice.
- Other fields (including `previous_interaction_id`, store, background, audio/video parts): accepted on the raw path; convert 501s them.

Routing id:

- `model: "models/gemini-3.5-flash"` routes as `gemini-3.5-flash`. Raw rewrite of the body `model` happens only when the routing id or a resolved alias actually changes the bytes; otherwise forward the original body verbatim (same rule as GenerateContent).
- `agent: "agents/test-agent"` routes as `agents/test-agent`. Body `agent` is never rewritten. The caller must list that id (or an alias to it) on an Interactions-capable provider. aio-proxy does not copy CLIProxyAPI's hidden `gemini-2.5-flash` auth-selection model.

Convert egress minimum (non-stream):

```json
{
  "id": "<generated or upstream>",
  "object": "interaction",
  "model": "<routed model id>",
  "status": "completed",
  "steps": [
    { "type": "thought", "content": [{ "text": "..." }] },
    { "type": "model_output", "content": [{ "text": "..." }] },
    { "type": "function_call", "name": "...", "arguments": {} }
  ],
  "usage": { "input_tokens": 0, "output_tokens": 0, "total_tokens": 0 }
}
```

Convert stream: SSE `data:` frames. Synthesize Interactions step/delta/completed events from `languageModel` parts. Do not emit GenerateContent candidate chunks.

Raw stream: forward the upstream response. Do not wrap or unwrap SSE. CLIProxyAPI re-wraps bare JSON as `data:`; aio-proxy raw does not, because same-protocol raw is byte-preserving.

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

## Convert-or-501 policy

Apply this at `modelInvocation` / transform time so raw can still forward agent and extra fields.

### Convert (language subset, `model` set, `agent` absent)

Map onto `ModelMessage` + `AiSdkCallSettings` + function `ToolSet`, then let the existing pipeline invoke `languageModel` and egress as Interactions.

| Inbound | Model invocation |
| --- | --- |
| `input` string | one user text message |
| `input` steps `user_input` / `model_output` / `thought` / `function_call` / `function_result` with text or function payloads | user / assistant / tool messages |
| `system_instruction` text | system message |
| function `tools` | function `ToolSet` |
| `generation_config` temperature / top_p / max_output_tokens / seed / stop / thinking_level | matching AI SDK settings / reasoning / dimensions |
| `stream: true` | `wantsStream` true |

Thinking level uses the same canonical effort ladder as GenerateContent (`none` / `minimal` / `low` / `medium` / `high` / `xhigh`). Dimensions: `thinking: false` for off; otherwise `thinking: true` plus canonical effort.

Targets: any candidate with a `languageModel` capability — `openai-response`, `openai-compatible`, `anthropic`, `gemini` (GenerateContent), and AI SDK / OAuth language models. No per-target Interactions translator. The ModelMessage pivot is the conversion, same as the other four inbound protocols.

Empty convertible transcript (`model` set, no `input` / `system_instruction` content) → 400 `INVALID_ARGUMENT`.

### 501 `UNIMPLEMENTED` (convert-ineligible)

| Feature | Reason |
| --- | --- |
| `agent` | Native Interactions only. Same rule as CLIProxyAPI; aio-proxy uses 501 rather than 400 because this is convert-or-501, not a malformed body. |
| Audio / video / non-text media parts | Audio/Images are out of scope. |
| `previous_interaction_id`, store, retrieve, cancel, background | Stateful product backends. Same stance as Responses retrieve. |
| Interactions-only tools that are not function declarations | Cannot represent on `languageModel`. |
| No model capability and no Interactions raw | Existing `errors.unsupported('transform_dispatch')`. |

501 is per candidate when `modelUnsupported` maps the transform error (fallback may still hit a later Interactions-capable raw provider). Agent is convert-ineligible for every model candidate; a later raw `gemini-interactions` candidate can still succeed.

Pipeline mapping that implementers must not invert:

- Convert-ineligible features (agent, audio/video, store / `previous_interaction_id`) throw a typed error that `errors.modelUnsupported` maps to 501. `resolveInvocation` then stores `invocationUnsupported` and `emitReject`s **that candidate**, so a later raw Interactions candidate can still run.
- `errors.requestError` that returns 501 is request-terminal in `resolveInvocation` (no further candidates). Use it only for malformed bodies (XOR, non-boolean `stream`, empty convertible transcript), never for agent.

### 400 `INVALID_ARGUMENT`

- Invalid JSON / schema.
- `model` and `agent` both missing, both present, or blank.
- `stream` present and not a boolean.
- Convert path with a model id but nothing convertible to messages.

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
| `requestError` | 400 `INVALID_ARGUMENT` (Zod / syntax / XOR / stream type) |
| `modelNotFound` | 404 `NOT_FOUND` |
| `previousResponseConflict` | 409 `ABORTED` |
| `tooLarge` | 413 `RESOURCE_EXHAUSTED` |
| `unsupportedContentEncoding` | 415 `INVALID_ARGUMENT` |
| `unsupported` / agent / non-language convert | 501 `UNIMPLEMENTED` |
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
  "models": ["gemini-3.5-flash", "agents/my-agent"]
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
- Probe of a **primary** `gemini-interactions` endpoint: `POST /v1beta/interactions` with `{ model, input: "ping" }` using `providerProbeModel()`. Probe does not send `agent`. If `models[0]` is only an agent resource, probe may FAIL; that is acceptable.

No new CLIProxyAPI-style `interactions-api-key` list.

## Testing

Adapter tests (colocated with the adapter / ingress / transform, not under legacy `_test/`):

- XOR: model, `models/` prefix, agent, missing, both, blank.
- `stream` true / absent / non-boolean.
- `protocol === gemini-interactions`.
- `model()` returns stripped model id or agent resource name.
- `wantsStream` reads the body, not the URL.
- `rawRequest` rewrites pathname to `/v1beta/interactions`, preserves query and original body bytes when the model is unchanged, rewrites `model` when the resolved id differs, never rewrites `agent`.
- Convert maps string `input` + `generation_config` + function tools + thinking_level.
- Convert throws 501-mapped errors for agent, audio/video parts, and `previous_interaction_id`.
- Egress writers are the Interactions JSON/SSE functions, not generateContent writers.

Dispatch matrix (`packages/server/__tests__/cross-protocol-routing.test.ts`):

- Add inbound `{ protocol: gemini-interactions, path: '/v1beta/interactions', body: { model: 'm', input: 'hello' } }`.
- Add `ProviderProtocol.GeminiInteractions` to the provider-protocol list.
- Existing 4×4 cells stay: raw iff inbound protocol equals provider protocol.
- New row/column: Interactions inbound raw only against `gemini-interactions`; convert against `gemini` / `openai-response` / `openai-compatible` / `anthropic`.
- Convert response shape is Interactions (`object: "interaction"`, `steps`), never GenerateContent `candidates`.
- Antigravity fixture still raw-resolves only `gemini`. Interactions inbound against Antigravity is convert (`model`), not raw. Add that case so the plugin does not silently become Interactions-capable.
- Agent inbound against a language-only provider 501s; against a `gemini-interactions` raw provider raws.

README (both `README.md` and `README.zh-Hans.md`):

- Add a row for Gemini Interactions: `POST /v1beta/interactions`.
- Do not list retrieve/cancel. Do not fold it into the GenerateContent row.

## File layout

New handwritten non-test files stay under the 500-line cap and split by responsibility:

```text
packages/core/src/protocol/gemini-interactions/     # adapter
packages/core/src/ingress/gemini-interactions/      # parse / XOR
packages/core/src/transform/gemini-interactions/    # ModelMessage pivot
packages/core/src/egress/gemini-interactions/       # JSON + SSE
packages/server/src/routes/gemini-interactions.ts   # thin POST route
```

`packages/server/src/routes/gemini-generate-content.ts` does not grow Interactions. `packages/core/src/protocol/gemini-generate-content/` does not parse Interactions bodies.

## Changesets

User-facing. Target `aio-proxy` at the same bump as internals (`@aio-proxy/core`, `@aio-proxy/types`, `@aio-proxy/plugin-sdk`, `server`). Never internals-only.

## Out of scope recap

- generateContent silently accepting Interactions.
- Images / Embeddings / Audio / Realtime / Videos.
- Interactions retrieve/cancel/countTokens.
- Making Antigravity natively Interactions-capable.
- Reopening parent #204's capability boundary.
