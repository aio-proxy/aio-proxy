# P1: OpenAI Images Inbound Protocol

Date: 2026-08-25
Status: awaiting user review
Issue: [#206](https://github.com/aio-proxy/aio-proxy/issues/206)
Parent: [#204](https://github.com/aio-proxy/aio-proxy/issues/204)

## Goal

Add a first-class OpenAI Images inbound protocol so an Images client can generate through aio-proxy on two paths:

1. same-protocol raw passthrough to a provider that actually speaks Images
2. at least one converted path that calls Provider V4 `imageModel`

The shared pipeline today only invokes `languageModel`. This issue is the first non-language capability and must land the dispatch seam later embeddings/audio issues can reuse, without specifying those protocols here.

## Live baseline (this worktree)

These facts are from detached HEAD `55ebd88e`, not from the older image-endpoint research notes.

- Inbound protocols are only `openai-response`, `openai-compatible`, `anthropic`, and `gemini` (`ProviderProtocol` in `packages/types/src/provider-endpoints/provider-endpoints.ts`).
- Each inbound protocol is one `defineProtocolAdapter`, one thin Hono route, adapter tests, and a row in `packages/server/__tests__/cross-protocol-routing.test.ts`.
- `handleProtocolRequest` / `attemptCandidates` is the only candidate loop. Same-protocol `raw.resolve({ protocol })` wins; otherwise the candidate's language `model.invoke` runs with `ModelInvocation.messages`.
- `ProtocolAdapter` is language-shaped: `modelInvocation` returns messages/settings/tools; `modelJson` / `modelSse` consume `TextStreamPart` streams.
- `createProviderV4Invoke` already requires Provider V4 `imageModel`, but only calls `provider.languageModel(...)`.
- Plugin catalogs already have an unused `image: readonly ModelDescriptor[]` bucket. `UsageRow` already has `imageCount` for per-image fees. Usage capture comments already say image endpoints should pass a larger idle timeout.
- Primary API endpoint raw passthrough joins the provider origin with the **inbound request path**. Reusing `openai-compatible` as the Images protocol would therefore POST `/v1/images/generations` at every Chat Completions provider. That is why Images cannot share the chat protocol id.
- Body limits are already 64 MiB encoded / 128 MiB decoded, which covers official Images payloads (< 50 MB).
- README inbound tables (`README.md`, `README.zh-Hans.md`) list only the language ports.

Parent #204's adapter/pipeline invariant is kept: no catch-all `/v1/images*`, no Videos / Midjourney / vendor-only image APIs, and no Files / Assistants product backend. Cross-protocol **image input** to language models (`packages/core/src/image-input`) is a different feature and stays untouched.

## Approaches considered

### A. New `openai-image` protocol + image transport (recommended)

Add `ProviderProtocol.OpenAIImage = 'openai-image'`. Keep the existing adapter factory and thin-route pattern. Extend the shared loop so an adapter can declare capability `image` and dispatch to `imageModel` instead of `languageModel`. Skip candidates that have neither an `openai-image` raw resolver nor an image transport.

- Pros: matches #206 and the #204 architecture constraint; same-protocol raw is correct; first non-language seam is explicit; chat providers are not accidentally raw-proxied.
- Cons: `ProviderProtocol`, plugin-sdk `ProtocolId`, `api-bridge` exhaustiveness, runtime provider union, and the dispatch matrix all grow by one protocol.

### B. Reuse `openai-compatible` and special-case the path

Keep four protocol ids. Detect `/v1/images/generations` inside the chat adapter or a catch-all route.

- Pros: smaller enum blast radius.
- Cons: violates "a path that only matches a catch-all is not done"; same-protocol raw would hit chat origins with an Images path; mixes two wire contracts in one adapter. Rejected.

### C. Rewrite Images into Responses `image_generation`

Follow CLIProxyAPI's default convert path: turn Images requests into a language Responses tool call.

- Pros: reuses the current language pipeline unchanged.
- Cons: #206 requires convert via `imageModel`, not `languageModel`; it couples Images to Responses store/tool semantics; it is the wrong seam for embeddings/audio. Reference behavior only, not a copy target. Rejected as the convert path.

Recommendation: **A**.

## Architecture

### Units

1. **Inbound adapter** (`openai-image`) — parse, model id, raw rewrite, image invocation, Images-shaped egress, OpenAI-shaped errors. No candidate loop.
2. **Thin routes** — `POST /v1/images/generations` first; `POST /v1/images/edits` later in this same issue. Mount beside the existing language routes in `createRoutes`. No `/v1/images/variations` and no `/v1/images*`.
3. **Shared pipeline** — still the only loop. It gains an adapter capability and an image attempt path. It does not grow provider-kind branching.
4. **Image transport** — runtime capability that calls `provider.imageModel(modelId)` / `generateImage`. Distinct from language `ModelTransport`.
5. **Eligibility filter** — drop candidates that cannot generate images before the attempt, then fall back among the rest.

### Adapter capability (the non-language seam)

Do not stretch `ModelInvocation.messages` to carry prompts and PNG bytes.

Keep `defineProtocolAdapter` for language adapters (`capability: 'language'`). Add `defineImageProtocolAdapter` for Images. Do not overload the language factory with unused image fields. The public adapter type is a discriminated union that shares parse / model / dimensions / session / wantsStream / rawRequest / errors, and splits invocation plus egress:

- language: `modelInvocation`, `modelJson`, `modelSse` (unchanged)
- image: `imageInvocation`, `imageJson`, `imageSse`

The pipeline switches on `adapter.capability` only. Later embeddings/audio specs add another capability the same way; this spec does not define their invocation types.

`TokenCountCapability` stays language-only. Images has no count-tokens port.

### Runtime provider shape

`RuntimeProviderInstance` today requires `raw` and/or language `model`. After this change a provider is valid if it exposes at least one of `raw`, `model`, or `image`.

`materializeRuntimeProvider` must stop throwing when only an image transport exists. Language materialization stays as it is.

Do **not** reuse `RuntimeProviderBase.capability` (plugin/OAuth capability id) for image-vs-language.

## Protocol and authoring

### Protocol id

```ts
enum ProviderProtocol {
  OpenAIResponse = 'openai-response',
  OpenAICompatible = 'openai-compatible',
  Anthropic = 'anthropic',
  Gemini = 'gemini',
  OpenAIImage = 'openai-image',
}
```

Update plugin-sdk `ProtocolId` in lockstep so an OAuth `raw` resolver can later advertise Images. P1 does not require any plugin to implement that resolver.

### How a provider becomes Images-raw

Same rule as today's extra endpoints: inbound protocol must match a declared endpoint.

Typical OpenAI API provider stays `openai-response` or `openai-compatible` for chat. To raw-proxy Images, add an `openai-image` endpoint:

```jsonc
{
  "id": "openai",
  "kind": "api",
  "protocol": "openai-response",
  "baseURL": "https://api.openai.com/v1",
  "endpoints": { "baseURL": "https://api.openai.com/v1", "protocol": ["openai-image"] }
}
```

An image-only API provider may use `openai-image` as its primary protocol. In that case do not synthesize a language `ModelTransport`.

`auth` remains Anthropic-only. Images endpoints do not grow a new auth mode.

### API-bridge exhaustiveness

`bridgeApiProviderToAiSdk` switches on the provider's **primary** protocol and currently `assertNever`s unknown values. Adding `openai-image` must not invent a language package mapping for it.

- Primary `openai-compatible` / `openai-response` / `anthropic` / `gemini`: keep today's language bridge. Image convert, if any, comes from the loaded Provider V4 `imageModel`, not from a second language invoke.
- Primary `openai-image`: language bridge is absent; only raw and/or image transport exist.

Cross-protocol conversion of Images still targets the primary provider package's `imageModel` when that method can serve the routed model. It never calls `languageModel`.

## Dispatch

Per candidate, in order:

1. If `provider.raw?.resolve({ protocol: 'openai-image', modelId })` is defined → raw passthrough (same as language).
2. Else if `provider.image` is defined → image convert (`imageModel` / `generateImage`).
3. Else skip this candidate (do not call `provider.model`).

Language inbound requests never enter step 2. Image inbound requests never enter `attemptModelCandidate`.

### Skipping candidates that cannot generate images

Filter **before** the attempt loop, preserving router order, affinity, response-owner, and cooldown behavior on the remaining live set.

A candidate is image-eligible when any of these is true:

- it has an `openai-image` raw resolver
- it has an image transport **and** the model is not explicitly non-image

A model is explicitly non-image when any of these is true:

- merged metadata `capabilities.modalities.output` exists and does not include `image`
- a plugin catalog lists the model in a non-image bucket and not in `catalog.image`

Unknown metadata plus an image transport: eligible. Try, then fall back on failure.

Language-only transport and no `openai-image` raw resolver: not eligible, even if Provider V4 has a dummy `imageModel` function.

If `router.resolve` returns no candidates: existing `404 model_not_found`.

If `router.resolve` returns candidates but the image filter empties the list: `501` protocol-shaped `not_implemented` — "No configured provider can generate images for this model". This is a capability miss, not an unknown model.

Fallback among eligible candidates is unchanged: raw `422` / `429` / `>= 500` and mapped convert exceptions continue; ordinary client `4xx` do not.

## Request contract

### First cut — `POST /v1/images/generations`

JSON only. `model` and `prompt` are required. Missing `model` is `400`; the router is model-first and there is no implicit `dall-e-2`.

Parse and retain, at least:

| Field | Convert behavior |
| --- | --- |
| `model` | route key; rewritten onto raw bodies when the resolved id differs |
| `prompt` | `generateImage({ prompt })` |
| `n` | passed through; default 1 |
| `size` | passed as SDK `size` (`{width}x{height}` or `auto`) |
| `quality` | `providerOptions` for the target package |
| `response_format` | `url` vs `b64_json` mapping below |
| `output_format` | `providerOptions` (`png` / `jpeg` / `webp`) |
| `output_compression` | `providerOptions` |
| `background` | `providerOptions` |
| `moderation` | `providerOptions` |
| `style` | `providerOptions` (DALL·E 3) |
| `user` | `providerOptions`; not a session key |
| `stream` | see streaming |
| `partial_images` | raw keeps it; convert drops it (diagnostic `dropped`) |
| unknown fields | raw keeps bytes; convert drops them |

Raw rewrite follows Chat Completions: if `model` (and only `model`) is unchanged, forward the client's exact JSON bytes; otherwise re-serialize. Strip `content-encoding` / `content-length` on rewrite.

### Later in this issue — `POST /v1/images/edits`

Same adapter, same protocol id, second route. Parse two content types:

- `application/json`: `prompt` + `images[]` (`image_url` or `file_id`) + optional `mask`
- `multipart/form-data`: `prompt` + `image` / `image[]` + optional `mask`

Convert path:

- URL and uploaded bytes are in scope
- `file_id` is `501 unsupported_feature` (`files`) because Files is out of epic scope
- mask bytes/URL are passed as SDK `prompt.mask` when present

Raw path forwards the original content type. Multipart raw rewrite may replace the `model` form field; it must not JSON-parse the body.

Edits are not a new GitHub issue and not a new inbound protocol. They are not in the generations first cut.

### Explicitly not routed

| Path | Response |
| --- | --- |
| `POST /v1/images/variations` | no adapter; existing 404 |
| any other `/v1/images*` | no adapter; existing 404 |

## Convert mapping

`imageInvocation` is the Images IR. It is not `ModelMessage[]`.

```ts
type ImageInvocation = {
  readonly operation: 'generate' | 'edit';
  readonly prompt: string;
  readonly n: number;
  readonly size?: string;
  readonly responseFormat: 'url' | 'b64_json';
  readonly stream: boolean;
  readonly images?: readonly ImageRef[];
  readonly mask?: ImageRef;
  readonly providerOptions?: AiSdkProviderOptions;
};

type ImageRef =
  | { readonly type: 'url'; readonly url: string }
  | { readonly type: 'bytes'; readonly mediaType: string; readonly data: Uint8Array };
```

`imageModel` / `generateImage` is the only convert implementation. Do not rebuild Images HTTP by hand and do not emit Responses `image_generation` tool calls.

### URL vs `b64_json`

Official GPT Image examples default to `b64_json`. DALL·E historically also returned `url`.

- Omitted `response_format` on convert: `b64_json`
- `b64_json`: encode each SDK image as `data[].b64_json`
- `url`: use a provider/SDK URL when one exists; if the convert result is only bytes, `501 unsupported_feature` (`response_format=url`). Do not invent a `data:` URL and put it in `url`.

Raw responses are unmodified.

### Egress envelope (non-stream)

Convert builds official `ImagesResponse`:

```json
{
  "created": 1713833628,
  "data": [{ "b64_json": "..." }],
  "usage": {
    "total_tokens": 100,
    "input_tokens": 50,
    "output_tokens": 50,
    "input_tokens_details": { "text_tokens": 10, "image_tokens": 40 }
  }
}
```

- `created`: provider metadata timestamp if present, otherwise `Math.floor(Date.now() / 1000)`
- `data[].revised_prompt` / size / quality: copy from provider metadata when present
- `usage`: copy only fields the SDK/provider actually returned; omit the object rather than invent token counts

### Streaming

Official Images can return `text/event-stream` (`image_generation.partial_image` / `image_generation.completed`, and edit equivalents).

- Raw + `stream: true`: passthrough, including partial frames
- Convert + `stream: false`: JSON `ImagesResponse`
- Convert + `stream: true`: run the full generate, then emit a single `image_generation.completed` (or `image_edit.completed`) event. No partial frames on convert.
- Convert ignores `partial_images`

Usage capture already documents a longer idle timeout for image endpoints. Images attempts must pass an explicit `idleTimeoutMs` of `600_000` (10 minutes). Official GPT Image calls can take up to ~2 minutes and emit no language deltas; do not inherit a future lower language default. Do not change the global language default in this issue.

## Errors

New `openAIImagesErrors` using the existing OpenAI envelope (`error: { code, message, type }`). Reuse the OpenAI provider/rate-limit helpers.

| Case | Status | `type` / `code` |
| --- | --- | --- |
| parse / Zod / missing `model` or `prompt` | 400 | `invalid_request_error` / `invalid_request` |
| unknown model (`router.resolve` empty) | 404 | `invalid_request_error` / `model_not_found` |
| known model, zero image-eligible candidates | 501 | `invalid_request_error` / `not_implemented` |
| `response_format=url` with bytes-only convert | 501 | `invalid_request_error` / `unsupported_feature` |
| convert `file_id` | 501 | `invalid_request_error` / `unsupported_feature` |
| body too large | 413 | `invalid_request_error` / `request_too_large` |
| unsupported content-encoding | 415 | `invalid_request_error` / `unsupported_content_encoding` |
| provider/SDK failure | 499/5xx | existing OpenAI provider mapping |
| all candidates cooling | 429 | existing `rateLimited` |

Raw upstream moderation errors (`image_generation_user_error`, `moderation_blocked`) pass through unchanged. Convert maps them only when the SDK/error object already carries that `code`; it does not invent moderation details.

`previousResponseConflict` remains on the mapper type for factory compatibility. Images does not read `previous_response_id`.

## Usage and traces

- Raw: existing `usageCapture.passthrough` with `protocol: openai-image`. Parse Images JSON/`completed` usage when present.
- Convert: do not wrap image bytes in a fake `TextStreamPart` language stream. Add an image capture helper that records `UsageRow` from provider usage plus `imageCount` (number of returned images) so per-image `cost.image` pricing already on `UsageRow` works.
- Traces: inbound protocol is `openai-image`; transport is `raw` or `image`. Never record a language `ai_sdk` invoke for an Images convert.
- Images is stateless. No `session()` hints unless a later change finds a real Images session field. `user` is not one.

## Testing

Protect user-visible behavior, not literals.

Adapter (colocated with the new protocol module):

- valid generations parse; missing `model` / `prompt` reject
- raw rewrite changes only `model` and otherwise preserves bytes
- `b64_json` vs `url` mapping, including bytes-only `url` → 501
- protocol-shaped errors

Dispatch matrix (`cross-protocol-routing.test.ts`):

- add Images inbound (`POST /v1/images/generations`) to the protocol list
- same-protocol `openai-image` uses raw
- other provider protocols do not raw-receive Images
- language-only candidate is skipped
- image transport convert succeeds
- eligible fallback still runs
- language inbound cases must not start calling `image`

Pipeline / usage:

- all-filtered eligible set returns 501, not 404
- usage records `imageCount` and any real token fields
- no `/v1/images/variations` adapter

Edits, when implemented in this issue, add JSON + multipart parse tests and a convert `file_id` → 501 test. They do not add a fifth inbound protocol.

## Documentation

Add rows to both README inbound tables:

| Protocol or purpose | Method and path |
| --- | --- |
| OpenAI Images generations | `POST /v1/images/generations` |
| OpenAI Images edits (same issue, later) | `POST /v1/images/edits` |

Document that raw Images requires an `openai-image` endpoint (or an `openai-image` primary protocol). Chat `openai-compatible` / `openai-response` alone is not same-protocol Images.

## Out of scope

- Videos, Realtime, Midjourney, Kling, vendor-only image HTTP APIs
- `/v1/images/variations` and any Images catch-all
- Files, Assistants, `file_id` resolution on the convert path
- Rewriting Images into Responses `image_generation`
- Embeddings, audio, or a generic "all non-language" adapter beyond the capability seam above
- Dashboard-only UX work, except what falls out of adding one `ProviderProtocol` value
- Changing language image-input behavior
- Implicit default model when `model` is omitted

## Done when

An OpenAI Images client can:

1. generate via raw passthrough to a provider that declares `openai-image`
2. generate via at least one `imageModel` convert path
3. skip language-only candidates and fall back among image-eligible ones
4. receive Images-shaped JSON (and raw SSE when requested) plus recorded usage

Edits can ship in a follow-up change on the same protocol; they are not required for the generations first cut to be reviewable or implementable.
