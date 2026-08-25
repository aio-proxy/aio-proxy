# P1: OpenAI Images Inbound Protocol

Date: 2026-08-25
Status: awaiting user review (Sol review incorporated)
Issue: [#206](https://github.com/aio-proxy/aio-proxy/issues/206)
Parent: [#204](https://github.com/aio-proxy/aio-proxy/issues/204)

## Goal

Add a first-class OpenAI Images inbound protocol so an Images client can generate through aio-proxy on two paths:

1. same-protocol raw passthrough to a provider that actually speaks Images
2. at least one converted path that calls Provider V4 `imageModel` **for a model that is known to support image generation**

The shared pipeline today only invokes `languageModel`. This issue is the first non-language capability and must land the dispatch seam later embeddings/audio issues can reuse, without specifying those protocols here.

## Live baseline (this worktree)

These facts are from `codex/p1-openai-images` at `87719102` (parent `55ebd88e`), not from the older image-endpoint research notes.

- Inbound protocols are only `openai-response`, `openai-compatible`, `anthropic`, and `gemini`.
- Each inbound protocol is one `defineProtocolAdapter`, one thin Hono route, adapter tests, and a row in `packages/server/__tests__/cross-protocol-routing.test.ts`.
- `handleProtocolRequest` / `attemptCandidates` is the only candidate loop. Same-protocol `raw.resolve({ protocol })` wins; otherwise the candidate's language `model.invoke` runs with `ModelInvocation.messages`.
- `ProtocolAdapter` is language-shaped: `modelInvocation` returns messages/settings/tools; `modelJson` / `modelSse` consume `TextStreamPart` streams.
- `createProviderV4Invoke` already requires Provider V4 `imageModel`, but only calls `provider.languageModel(...)`. A present `imageModel` method is not evidence the routed id can generate images (Anthropic V4 still exposes `imageModel` and throws `NoSuchModelError`).
- Plugin catalogs already have `image: readonly ModelDescriptor[]`, but OAuth materialization, dashboard edit-view models, alias narrowing, and `modelMetadataRecord` consume **only** `catalog.language` (`packages/server/src/plugin-runtime/materialize.ts`, `packages/server/src/plugin-runtime/catalog.ts`, `packages/server/src/server-state/oauth-views.ts`). An image-only catalog id is not a router candidate today; Images inbound would 404 before any eligibility filter.
- `UsageRow` already has `imageCount`. Usage capture comments already say image endpoints should pass a larger idle timeout.
- Primary API endpoint raw passthrough joins the provider origin with the inbound request path. Reusing `openai-compatible` as the Images protocol would POST `/v1/images/generations` at every Chat Completions provider.
- `Router` only adds a direct route for `provider.models` and preserved alias targets (`directModelIds`). Omitted `models` plus no `alias`/`metadata` ids means `dall-e-2` is not registered; `router.resolve('dall-e-2')` is 404 before any capability filter. Metadata keys are not routes today.
- Pipeline preflight `hasInvalidOrOversizedContentLength` is hardcoded to `REQUEST_BODY_LIMITS.encoded` (64 MiB) in `packages/server/src/routes/pipeline/request.ts`, before adapter parse. Edits official `< 50_000_000` file limits cannot take effect unless this gate reads adapter/route limits.
- Official edits: at most 16 images plus optional mask; each image/mask is **< 50 MB decimal** (`size >= 50_000_000` is over). Mask must match the edited image's format and pixel size and must have an alpha channel. Official generate `n` is 1–10 except `dall-e-3` (`n=1` only). Official omitted-`model` defaults do not mention JSON `null` or empty string.
- Multipart framing makes encoded bodies larger than decoded file bytes. Provider V4 `generateImage` returns `string | Uint8Array`; there is no standard URL field.
- Generic AI SDK `generateImage({ size })` accepts `{width}x{height}` only. `auto` is not a valid SDK size.
- Official Images: generations omit `model` → `dall-e-2` (unless a GPT-image-only parameter is used); edits omit `model` → `gpt-image-1.5`. Official `image_generation.completed` requires `b64_json`, `background`, `created_at`, `output_format`, `quality`, `size`, `usage`, and is one image per event.
- README inbound tables list only the language ports.

Parent #204's adapter/pipeline invariant is kept: no catch-all `/v1/images*`, no Videos / Midjourney / vendor-only image APIs, and no Files / Assistants product backend. Cross-protocol **image input** to language models stays untouched.

## Approaches considered

### A. New `openai-image` protocol + per-model capability routing (recommended)

Add `ProviderProtocol.OpenAIImage = 'openai-image'`. Keep the adapter factory and thin-route pattern. Route the **union** of per-capability model ids. Filter candidates by the inbound adapter's capability. Convert only when a support predicate says that model can generate images — never because `imageModel` exists.

- Pros: matches #206 / #204; image-only catalog ids become routable; dummy V4 `imageModel` cannot poison eligibility; same-protocol raw stays correct.
- Cons: OAuth materialization, metadata records, and the router input must stop being language-only.

### B. Reuse `openai-compatible` and special-case the path

Rejected: catch-all, wrong raw origin, two wire contracts in one adapter.

### C. Rewrite Images into Responses `image_generation`

Rejected as the convert path: #206 requires `imageModel`, not `languageModel`.

Recommendation: **A**.

## Architecture

### Units

1. **Inbound adapter** (`openai-image`) — parse (including official omitted-model defaults), model id used for routing, route-specific `bodyLimits`, raw rewrite that preserves an omitted `model`, image invocation, non-stream Images egress, OpenAI-shaped errors. No candidate loop.
2. **Thin routes** — `POST /v1/images/generations` first; `POST /v1/images/edits` later in this same issue. Each route passes `{ operation: 'generations' | 'edits' }` as adapter context so limits and parse differ. No `/v1/images/variations` and no `/v1/images*`.
3. **Shared pipeline** — still the only loop. It gains an adapter capability, adapter `bodyLimits` for the Content-Length preflight, a per-model capability set, inbound capability filtering, and an image attempt path. It does not grow provider-kind branching.
4. **Image transport** — runtime capability that calls `imageModel` / `generateImage` only after the support predicate passes. Distinct from language `ModelTransport`.
5. **Support predicates** — decide whether a (provider, model id) pair may serve an inbound capability. Method presence is not a predicate.

### Adapter capability (the non-language seam)

Do not stretch `ModelInvocation.messages` to carry prompts and PNG bytes.

Keep `defineProtocolAdapter` for language adapters (`capability: 'language'`). Add `defineImageProtocolAdapter` for Images (`capability: 'image'`). Language factory default `bodyLimits` is today's `REQUEST_BODY_LIMITS`. The public adapter type is a discriminated union that shares parse / model / dimensions / session / wantsStream / rawRequest / errors / `bodyLimits`:

- language: `modelInvocation`, `modelJson`, `modelSse` (unchanged)
- image: `imageInvocation`, `imageJson`

P1 convert does **not** implement Images SSE, so there is no `imageSse`. Raw streaming is passthrough, not adapter-built SSE.

The pipeline switches on `adapter.capability` and then on that candidate's capability set. Later embeddings/audio specs add another capability the same way.

`TokenCountCapability` stays language-only.

### Runtime provider shape

A provider is valid if it exposes at least one of `raw`, `model`, or `image`.

`materializeRuntimeProvider` must accept image-only providers.

Do **not** reuse `RuntimeProviderBase.capability` (plugin/OAuth capability id) for image-vs-language.

Each runtime provider carries a per-model capability index, built at materialization:

```ts
type InboundCapability = 'language' | 'image';

type ModelCapabilityIndex = Readonly<Record<string, ReadonlySet<InboundCapability>>>;
```

Router model ids for that provider are `Object.keys(index)` — the **union** of every capability bucket. Language inbound no longer owns the only routable ids.

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

Typical OpenAI API provider stays `openai-response` or `openai-compatible` for chat. To raw-proxy Images, add an `openai-image` endpoint **and** a finite model-id set that includes the official omitted-model defaults:

```jsonc
{
  "id": "openai",
  "kind": "api",
  "protocol": "openai-response",
  "baseURL": "https://api.openai.com/v1",
  "models": ["dall-e-2", "gpt-image-1.5"],
  "metadata": {
    "dall-e-2": { "capabilities": { "modalities": { "output": ["image"] } } },
    "gpt-image-1.5": { "capabilities": { "modalities": { "output": ["image"] } } }
  },
  "endpoints": { "baseURL": "https://api.openai.com/v1", "protocol": ["openai-image"] }
}
```

`models` (or preserved alias / metadata keys) make the official defaults **routable**. `metadata.capabilities.modalities.output: ["image"]` makes them **image-capable**. An extra `openai-image` endpoint does not mark every `models[]` id as image — a mixed list such as `["gpt-5", "dall-e-2"]` must not treat `gpt-5` as Images.

An `openai-image` endpoint alone is not enough. `Router` does not register a direct route when `models` is omitted, so omitted-`model` generations (`dall-e-2`) and edits (`gpt-image-1.5`) 404 before the capability filter.

Non-catalog providers (API / AI SDK) must supply a **finite** image-routable id set from at least one of:

1. `models`
2. alias targets with `preserve: true`
3. `metadata` object keys

P1 registers all three as direct routes. There is **no wildcard** and no “every id this origin might serve.” An empty finite set cannot route the official defaults.

Catalog providers keep using `catalog.language ∪ catalog.image` as their finite set.

An image-only API provider may use `openai-image` as its primary protocol. In that case do not synthesize a language `ModelTransport`. It still needs the finite id set above.

`auth` remains Anthropic-only.

### API-bridge exhaustiveness

`bridgeApiProviderToAiSdk` switches on the provider's **primary** protocol and currently `assertNever`s unknown values. Adding `openai-image` must not invent a language package mapping for it.

- Primary `openai-compatible` / `openai-response` / `anthropic` / `gemini`: keep today's language bridge. Image convert is a separate transport, used only when the image support predicate passes.
- Primary `openai-image`: language bridge is absent; only raw and/or image transport exist.

Convert never calls `languageModel`.

## Capability sets and support predicates

This replaces the previous "has `image` transport and is not explicitly non-image" rule.

### Building the index

For each configured or catalogued model id, compute `Set<InboundCapability>` from **membership**, not from V4 method tables.

| Source | Adds |
| --- | --- |
| OAuth / plugin `catalog.language` | `language` |
| OAuth / plugin `catalog.image` | `image` |
| Same id in both buckets | union |
| Config / upstream metadata `capabilities.modalities.output` includes `image` | `image` |
| Config / upstream metadata `capabilities.modalities.output` is present and is text-only | does **not** add `image`; does not remove a catalog.image membership |
| Provider primary protocol is `openai-image` and the id is in the **finite** non-catalog set (`models`, preserved alias targets, or `metadata` keys) | `image` |

`imageModel` / `embeddingModel` / `languageModel` **function existence never adds a capability**. A dummy V4 `imageModel` that throws `NoSuchModelError` is not image support.

OAuth materialization must change with this index:

- `withRoutingConfig(..., catalog.language.map(id))` becomes the union of `catalog.language` and `catalog.image` ids
- `modelMetadataRecord` records **both** buckets; image descriptors may carry `protocol: openai-image` when metadata says so
- Dashboard edit-view / alias narrowing that today use only `catalog.language` must not be the source of truth for Images routing. Images routing reads the capability index. Whether the editor lists image ids is out of scope except as needed so those ids are not stripped before materialization.

### Support predicates

```text
supportsLanguage(provider, modelId) :=
  capabilityIndex[modelId] has 'language'

supportsImage(provider, modelId) :=
  capabilityIndex[modelId] has 'image'

supportsImageRaw(provider, modelId) :=
  supportsImage(provider, modelId)
  AND provider.raw.resolve({ protocol: 'openai-image', modelId }) is defined

supportsImageConvert(provider, modelId) :=
  supportsImage(provider, modelId)
  AND provider.image is defined
```

OAuth image support is **exactly** `modelId ∈ catalog.image` (plus any explicit metadata.image overlay). It is not inferred from `createRuntime().provider.imageModel`.

### Inbound filter (after `router.resolve`, before attempts)

`router.resolve` uses the union id space, so an image-only catalog model is a candidate instead of `RouterModelNotFoundError`.

Then filter the resolved list:

- inbound `capability: 'image'` keeps `supportsImage`
- inbound `capability: 'language'` keeps `supportsLanguage`

This is the reusable non-language seam. Image-only models must not be attempted on Chat Completions / Responses / Messages / Gemini generateContent.

Cooldown, affinity, and response-owner run on the filtered live set, same as today.

If `router.resolve` is empty: existing `404 model_not_found`.

If resolve returns rows but the inbound filter empties them: `501 not_implemented` — "No configured provider can generate images for this model" (Images) or the existing language unsupported dispatch (language). This is a capability miss, not an unknown model.

## Dispatch

Per remaining candidate, in order:

1. If `supportsImageRaw` → raw passthrough.
2. Else if `supportsImageConvert` → image convert (`imageModel` / `generateImage`).
3. Else skip (do not call `provider.model`, do not call a dummy `imageModel`).

Language inbound never enters step 2. Image inbound never enters `attemptModelCandidate`.

Fallback among eligible candidates is unchanged: raw `422` / `429` / `>= 500` and mapped convert exceptions continue; ordinary client `4xx` do not.

## Request contract

### Official omission defaults and compatibility normalization

Parse **before** `adapter.model()` / `router.resolve`.

**Official** (OpenAI Images): only an **omitted** `model` field has a default — generations `dall-e-2`, edits `gpt-image-1.5`. Official docs do not define JSON `null`, `""`, or whitespace-only `model`.

**Compatibility normalization** (aio-proxy, same spirit as CLIProxyAPI blank/null tolerance, not official): JSON/`multipart` `null`, `""`, and whitespace-only `model` are treated as omitted **for routing only**. `adapter.model()` returns the same routing id as an omitted field.

| Client `model` | Official? | Routing id | Raw forward |
| --- | --- | --- | --- |
| field omitted | yes | generations `dall-e-2` / edits `gpt-image-1.5` | keep omitted; do not insert a default |
| JSON `null` / empty form value | compatibility | same as omitted | keep `null` / empty as sent; do not insert a default; do not rewrite to omitted |
| `""` or whitespace-only string | compatibility | same as omitted | keep the client's exact string; do not insert a default |
| non-empty string | yes | that id (then aliases) | rewrite only if routing resolved a different upstream id |

Missing `prompt` is still `400`. Convert always uses the routing id.

If the client sent a real model id and routing resolved a different upstream id, rewrite that field as Chat Completions does today.

### First cut — `POST /v1/images/generations`

JSON only. `prompt` is required. `model` is optional because of the official default above.

| Field | Convert behavior |
| --- | --- |
| `model` | routing key after omission/compatibility normalization; raw preserves omit/`null`/empty |
| `prompt` | `generateImage({ prompt })` |
| `n` | default 1; convert `n` is **1** when the effective base id is `dall-e-3`, otherwise 1..10; invalid `n` is `400` (see below) |
| `size` | `{width}x{height}` → SDK `size`; `auto` or omitted → **omit** SDK `size`; never pass `auto` to generic AI SDK `size` |
| `quality` | `providerOptions` |
| `response_format` | convert `url` → skip/501 (below); `b64_json` / omitted → bytes |
| `output_format` | `providerOptions` |
| `output_compression` | `providerOptions` |
| `background` | `providerOptions` |
| `moderation` | `providerOptions` |
| `style` | `providerOptions` (DALL·E 3) |
| `user` | `providerOptions`; not a session key |
| `stream` | convert `true` → `501` (see Streaming); raw keeps it |
| `partial_images` | raw keeps it; convert unused because convert streaming is 501 |
| unknown fields | raw keeps bytes; convert drops them |

Raw rewrite: if the client body should be forwarded verbatim (model omitted/`null`/empty unchanged, or a non-empty model string unchanged), keep the client's exact JSON bytes; otherwise re-serialize. Strip `content-encoding` / `content-length` on rewrite.

### Later in this issue — `POST /v1/images/edits`

Same adapter, same protocol id, second route. Parse two content types:

- `application/json`: `prompt` + `images[]` (`image_url` or `file_id`) + optional `mask`
- `multipart/form-data`: `prompt` + `image` / `image[]` + optional `mask`

**P1 does not ship an aio-proxy URL prefetch.** Convert therefore:

- accepts **uploaded multipart bytes only**, after the per-file / aggregate policy below
- returns `501 unsupported_feature` (`image_url`) for JSON `image_url` / mask URL
- returns `501 unsupported_feature` (`files`) for `file_id`
- does **not** call AI SDK / `@ai-sdk/openai` URL download helpers

Raw path forwards the original content type, including JSON URLs and `file_id`, for the official upstream to fetch. Multipart raw rewrite may replace a present `model` form field; it must not insert a missing one; it must not JSON-parse the body.

#### Body limits (adapter-specific; pipeline must honor them)

The current preflight is a **language** gate: `hasInvalidOrOversizedContentLength` compares `Content-Length` to `REQUEST_BODY_LIMITS.encoded` (64 MiB) before `adapter.parse`. P1 adds adapter/route body limits and the pipeline preflight **must use those**, not the global constant.

```ts
type RequestBodyLimits = { readonly encoded: number; readonly decoded: number };

// on both language and image adapters; language keeps today's 64 / 128 MiB
readonly bodyLimits: (raw: Request, context: TContext) => RequestBodyLimits;
```

`handleProtocolRequestInContext` and `readRequestBytes` / parse helpers take `adapter.bodyLimits(raw, context)`. Token-count stays on the language limits.

| Route | Encoded preflight | Decoded / file policy |
| --- | --- | --- |
| Generations JSON | 64 MiB (unchanged) | 128 MiB decoded JSON (unchanged) |
| Edits JSON | 64 MiB | 128 MiB decoded JSON. Convert still 501s `image_url` / `file_id`. |
| Edits multipart | official file aggregate + 1 MiB framing (below) | Stream-parse parts. **Do not** set encoded equal to the file aggregate. |

Do **not** call these official-compatible. Official is decimal **< 50 MB** per image/mask (`50_000_000` exclusive). 50 MiB (`52_428_800`) and `16 * 50 MiB + 50 MiB` are larger than official and must not be labeled as matching OpenAI.

Edits multipart **official convert/file policy** (counted while streaming parts):

| Limit | Value | On exceed |
| --- | --- | --- |
| Max images | 16 | `413` |
| Max masks | 1 | `413` |
| Per-file payload | `size >= 50_000_000` is over | `413` |
| Aggregate decoded file payloads | `17 * 49_999_999` = `849_999_983` | `413` |
| Non-file form allowance (prompt, model, fields, boundaries, part headers) | 1 MiB **proxy** framing, not official | `413` |
| Encoded `Content-Length` preflight | `849_999_983 + 1_048_576` = `851_048_559` | `413` |

A request whose files are all `< 50_000_000` and whose encoded size is official-max files plus small framing must not 413 on the 64 MiB language gate.

If a later proxy resource ceiling in MiB is added, it is a **DoS ceiling only** and must sit strictly above these official convert limits, never replace them.

Raw edits may stream-forward when `model` is omitted/unchanged. If a present `model` field must be rewritten, buffer only under the edits encoded preflight.

Whether operators want an additional lower proxy cap is a product choice (see Open questions).

### Explicitly not routed

| Path | Response |
| --- | --- |
| `POST /v1/images/variations` | no adapter; existing 404 |
| any other `/v1/images*` | no adapter; existing 404 |

## Convert mapping

`imageInvocation` is the Images IR. It is not `ModelMessage[]`. Convert refs are bytes only.

```ts
type ImageInvocation = {
  readonly operation: 'generate' | 'edit';
  readonly prompt: string;
  readonly n: number;
  readonly size?: `${number}x${number}`; // omitted when client sent auto / omitted
  readonly responseFormat: 'b64_json';
  readonly images?: readonly ImageBytesRef[];
  readonly mask?: ImageBytesRef;
  readonly providerOptions?: AiSdkProviderOptions;
};

type ImageBytesRef = {
  readonly type: 'bytes';
  readonly mediaType: string; // client header, untrusted
  readonly data: Uint8Array;
  readonly byteLength: number;
  readonly format: 'png' | 'jpeg' | 'webp';
  readonly width: number;
  readonly height: number;
  readonly hasAlpha: boolean;
};
```

Populate `format` / `width` / `height` / `hasAlpha` by **decoding the bytes**, not by trusting `Content-Type` or the filename. `byteLength` is `data.byteLength` and is the official size check input.

There is no `stream` field on the convert IR. `stream: true` is valid parse: `wantsStream` stays true so raw passthrough can stream. A convert candidate with `stream: true` is skipped (not invoked). If no raw image candidate remains, the request is `501 unsupported_feature` (`stream`).

`imageModel` / `generateImage` is the only convert implementation. Do not rebuild Images HTTP by hand, do not emit Responses `image_generation` tool calls, and do not download client URLs. AI SDK `normalizePrompt` only forwards files/mask — it does **not** enforce official mask or `n` rules. aio-proxy must validate those **before** `imageModel` / `generateImage`.

### Convert `n`

After routing, take the effective upstream model id (candidate `modelId`). Provider-qualified inbound ids such as `openai/dall-e-3` use the base id after the first `/` when the prefix is a provider id; `dall-e-3` and `*/dall-e-3` are the same model.

| Effective base id | Allowed convert `n` |
| --- | --- |
| `dall-e-3` | **exactly 1** |
| any other image model | 1..10 |

Omitted `n` is 1. Convert `n` outside that set is `400 invalid_request` for the whole request (not a per-candidate skip). Do not call `generateImage` with `n > 1` on `dall-e-3` — the SDK would split into multiple calls and wrongly succeed.

### Convert mask (edits only)

Official GPT Image mask rules, checked on convert after decoding, before invoke:

- every source image and the mask have `byteLength < 50_000_000` (already 413 if not)
- when a mask is present, **every** source image and the mask share `format` and decoded `width`×`height`
- the mask `hasAlpha === true`

Failure is `400 invalid_request` (`mask`). Undecodable bytes are `400 invalid_request` (`image`). Raw does not decode or enforce this; upstream does.

No mask → do not require images to share size/format with each other.

### `size`

| Client `size` | Raw | Convert SDK `size` |
| --- | --- | --- |
| omitted | keep omit | omit |
| `auto` | keep `auto` | omit |
| `1024x1024` (or any `{w}x{h}`) | keep | pass through |

### `response_format`

Provider V4 / `generateImage` only guarantees `string | Uint8Array` images. The OpenAI image adapter returns `b64_json`. There is no cross-provider URL field and P1 must not guess a URL out of `providerMetadata`.

| Client `response_format` | Raw | Convert |
| --- | --- | --- |
| omitted / `b64_json` | passthrough | encode each image as `data[].b64_json` |
| `url` | passthrough | **skip** this candidate; `501 unsupported_feature` (`response_format=url`) if no raw image candidate remains |

Do not invent a `data:` URL. Do not treat a string image as a URL (it may be base64).

A later URL convert requires an explicit `ImageTransportResult` variant (`{ kind: 'url', url: string } | { kind: 'bytes', data: Uint8Array, mediaType: string }`) produced by a provider-specific transport. That is out of P1.

Raw responses are unmodified.

### Egress envelope (non-stream only)

Convert builds official `ImagesResponse` JSON:

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
- `data[]` has one entry per returned image (`n` may be 1..10)
- `usage`: copy only fields the SDK/provider actually returned; omit the object rather than invent token counts

### Streaming

Official `image_generation.completed` is a **single-image** event and requires `b64_json`, `background`, `created_at`, `output_format`, `quality`, `size`, and `usage`. Provider V4 / `generateImage` only guarantees image bytes. P1 will not invent those required fields or invent an event-per-image order for `n > 1`.

| Path | `stream` | Behavior |
| --- | --- | --- |
| Raw | `true` | passthrough official SSE unchanged |
| Raw | `false` / omitted | passthrough JSON |
| Convert | `true` | skip this candidate; `501 unsupported_feature` (`stream`) only when no raw image candidate remains |
| Convert | `false` / omitted | JSON `ImagesResponse` as above |

No convert `imageSse`. No convert partial frames. No P1 SSE schema tests for synthesized convert events.

Usage capture already documents a longer idle timeout for image endpoints. Images **raw** streams pass an explicit `idleTimeoutMs` of `600_000` (10 minutes). Convert JSON uses the non-stream capture path. Do not change the global language default.

## Errors

New `openAIImagesErrors` using the existing OpenAI envelope (`error: { code, message, type }`). Reuse the OpenAI provider/rate-limit helpers.

| Case | Status | `type` / `code` |
| --- | --- | --- |
| parse / Zod / missing `prompt` | 400 | `invalid_request_error` / `invalid_request` |
| convert `n` invalid for effective model (`dall-e-3` and `n !== 1`, or `n` not in 1..10) | 400 | `invalid_request_error` / `invalid_request` |
| convert mask missing alpha, or format/size mismatch, or undecodable image | 400 | `invalid_request_error` / `invalid_request` |
| unknown routing id (`router.resolve` empty after defaulting) | 404 | `invalid_request_error` / `model_not_found` |
| known id, zero image-capable candidates | 501 | `invalid_request_error` / `not_implemented` |
| convert `stream: true` | 501 | `invalid_request_error` / `unsupported_feature` |
| convert `response_format=url` | 501 | `invalid_request_error` / `unsupported_feature` |
| convert `image_url` / URL mask | 501 | `invalid_request_error` / `unsupported_feature` |
| convert `file_id` | 501 | `invalid_request_error` / `unsupported_feature` |
| body / per-file / aggregate too large | 413 | `invalid_request_error` / `request_too_large` |
| unsupported content-encoding | 415 | `invalid_request_error` / `unsupported_content_encoding` |
| provider/SDK failure | 499/5xx | existing OpenAI provider mapping |
| all candidates cooling | 429 | existing `rateLimited` |

Omitted `model` is **not** a 400.

Raw upstream moderation errors (`image_generation_user_error`, `moderation_blocked`) pass through unchanged. Convert maps them only when the SDK/error object already carries that `code`.

`previousResponseConflict` remains on the mapper type for factory compatibility. Images does not read `previous_response_id`.

## Usage and traces

- Raw: existing `usageCapture.passthrough` with `protocol: openai-image`. Parse Images JSON/`completed` usage when present.
- Convert: do not wrap image bytes in a fake `TextStreamPart` language stream. Add an image capture helper that records `UsageRow` from provider usage plus `imageCount` (number of returned images).
- Traces: inbound protocol is `openai-image`; transport is `raw` or `image`. Never record a language `ai_sdk` invoke for an Images convert. Never record an image convert attempt for `stream: true` or convert `response_format=url` (those candidates are skipped).
- Images is stateless. No `session()` hints. `user` is not a session key.

## Testing

Protect user-visible behavior, not literals.

Adapter (colocated with the new protocol module):

- valid generations parse; missing `prompt` rejects
- omitted `model` → official routing defaults; raw body still omits the field
- JSON `null` / `""` `model` → same routing ids (compatibility); raw still forwards `null` / `""`, not a default string and not rewritten to omitted
- raw rewrite changes only a **present non-empty** `model` string and otherwise preserves bytes
- convert `dall-e-3` and `provider/dall-e-3` with `n=2` → `400`; `n=1` allowed; other models accept 1..10
- convert `size: "auto"` omits SDK `size`; raw keeps `auto`; `{w}x{h}` passes through
- convert `response_format=url` → skip / 501; never emit `data[].url` from convert
- convert `stream: true` → 501; no convert SSE frames
- protocol-shaped errors

Dispatch / capability:

- image-only `catalog.image` id is routable on Images inbound (not 404)
- the same image-only id is filtered out of language inbound
- dummy V4 `imageModel` (throws `NoSuchModelError`) + language-only catalog → skipped, no invoke
- OAuth `catalog.image` membership is sufficient for `supportsImage` when an image transport exists
- same-protocol `openai-image` uses raw; other provider protocols do not raw-receive Images
- the documented example (`models` + image metadata + `openai-image` endpoint) routes omitted-model generations to `dall-e-2` and omitted-model edits to `gpt-image-1.5`; the same provider **without** those finite ids 404s the defaults; a sibling `gpt-5` in `models` is not image-capable unless metadata/catalog says so
- a non-catalog provider with only an `openai-image` endpoint and no finite ids does not wildcard-route
- language inbound cases must not start calling `image`

Pipeline / usage:

- all-filtered eligible set returns 501, not 404
- usage records `imageCount` and any real token fields
- no `/v1/images/variations` adapter

Edits, when implemented in this issue:

- JSON + multipart parse
- convert `file_id` / `image_url` → 501
- convert/file `byteLength >= 50_000_000` → 413; `49_999_999` is accepted
- official aggregate `849_999_983` + 1 MiB framing is accepted by preflight (not the 64 MiB language gate)
- 50 MiB (`52_428_800`) file is 413 on convert, not treated as official-legal
- convert mask: same format/size + alpha passes; missing alpha, dimension mismatch, or format mismatch → 400 before `generateImage`
- omitted/`null`/`""` model tests as above

Do not add convert SSE schema tests in P1.

## Documentation

Add rows to both README inbound tables:

| Protocol or purpose | Method and path |
| --- | --- |
| OpenAI Images generations | `POST /v1/images/generations` |
| OpenAI Images edits (same issue, later) | `POST /v1/images/edits` |

Document that:

- raw Images requires an `openai-image` endpoint (or primary protocol)
- omitted generate `model` routes as `dall-e-2` and omitted edits `model` routes as `gpt-image-1.5`; `null`/empty are compatibility-only and raw-forwarded as sent
- convert does not stream, does not fetch `image_url`, and does not honor `response_format=url`
- non-catalog Images providers need a finite `models` / preserved alias / metadata id set; the example includes `dall-e-2` and `gpt-image-1.5`

## Out of scope

- Videos, Realtime, Midjourney, Kling, vendor-only image HTTP APIs
- `/v1/images/variations` and any Images catch-all
- Files / Assistants / convert `file_id` resolution
- Convert `image_url` fetch, convert `response_format=url`, and any `ImageTransportResult` URL variant
- Synthesizing official Images SSE from `generateImage` bytes
- Rewriting Images into Responses `image_generation`
- Embeddings, audio, or a generic "all non-language" adapter beyond the capability seam
- Dashboard-only UX work, except not stripping image catalog ids before materialization
- Changing language image-input behavior

## Done when

An OpenAI Images client can:

1. generate via raw passthrough to a provider that declares `openai-image` for an **image-capable** model
2. generate via at least one `imageModel` convert path for a model in the image capability set
3. route an image-only `catalog.image` id (no 404) and skip dummy `imageModel` / language-only ids
4. omit `model` on generations and still route as `dall-e-2`, with the raw body left omitted; `null`/empty still route but are forwarded unchanged
5. receive Images-shaped **JSON** on convert, or raw SSE when the client streamed to a raw candidate, plus recorded usage

Edits can ship in a follow-up change on the same protocol; they are not required for the generations first cut to be reviewable or implementable. When they ship, they inherit omitted-model `gpt-image-1.5`, convert URL 501, official `< 50_000_000` file limits, and convert mask/`n` checks.

## Open questions (product only)

1. **Generate omit `model` plus GPT-image-only fields** (`background`, `output_format`, `moderation`, `stream`, …). Official generate says default is `dall-e-2` *unless* a GPT-image-only parameter is used, but does not name the alternate default. This spec follows Sol: convert/routing always use `dall-e-2` when `model` is omitted; raw keeps the omission so official upstream can apply its own clause. Confirm if convert should instead 400 or pick a GPT-image default in that combo.
2. **Edits preflight** uses official `< 50_000_000` file math plus 1 MiB proxy framing (`851_048_559` encoded). Confirm if P1 should also add a lower operator DoS cap.
