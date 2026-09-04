# @aio-proxy/types

## 0.16.0

## 0.15.0

### Minor Changes

- [#243](https://github.com/aio-proxy/aio-proxy/pull/243) [`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91) Thanks [@baranwang](https://github.com/baranwang)! - OAuth providers now hide models with `excludedModels` instead of a `models` whitelist. Leftover `models` keys are ignored and no longer restrict exposure — newly discovered catalog ids stay visible unless hidden. Plugin default aliases inherit at runtime and are no longer written into the config file.

## 0.14.0

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks [@baranwang](https://github.com/baranwang)! - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

  Each Provider — including each OAuth account — is now one card showing its name, kind, protocols,
  plan, routing priority and weight, 24-hour success rate and p95 latency, model count, and request
  count, with search and availability/enablement/kind filters replacing the old table's pagination and
  grouping. OAuth Providers whose plugin exposes a quota capability show a remaining-quota ring that
  opens a detail dialog with one bar per quota window that reports a remaining amount.

  The quota read is cached in memory behind a per-provider five-minute cooldown, refreshed
  asynchronously once a Provider has finished answering a model request, and exposed at
  `QUERY /dashboard/api/providers/:id/quota`; the dialog's refresh button bypasses the cooldown, and the
  Providers page polls the reading the way it already polls health. `OAuthQuotaSnapshot` gains an
  optional `plan`, which `kimi-code` and `xai-grok` now populate, and `xai-grok` also reports per-product
  usage. Dashboard Provider summaries gain `protocols` and `hasQuota` in place of the single `protocol`
  field.

## 0.12.3

## 0.12.2

## 0.12.1

### Patch Changes

- [#231](https://github.com/aio-proxy/aio-proxy/pull/231) [`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6) Thanks [@baranwang](https://github.com/baranwang)! - dashboard: grade traces latency like new-api and show the lightning icon for fast/priority requests

  Chat Completions `service_tier` now maps onto the speed routing axis (`priority`/`fast` → fast, `flex` → flex), matching Responses.

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks [@baranwang](https://github.com/baranwang)! - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`. The removed `providers.<id>.metadata` field is silently ignored, and metadata keys no longer create routes; expose models through `providers.<id>.models` or `alias`. Metadata editing now lives in the Dashboard routing drawer instead of the Provider editor.

  Rename the plugin SDK's free-form `ModelDescriptor.metadata`, `ModelCatalog.metadata`, and raw-resolver `metadata` input to `extra`, and add typed `ModelDescriptor.modelMetadata` for host-consumed model metadata. Publish `@aio-proxy/types` as the SDK metadata type source.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks [@baranwang](https://github.com/baranwang)! - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.

## 0.11.2

## 0.11.1

## 0.11.0

### Minor Changes

- [#215](https://github.com/aio-proxy/aio-proxy/pull/215) [`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13) Thanks [@baranwang](https://github.com/baranwang)! - Add Gemini Interactions as an inbound protocol at `POST /v1beta/interactions`.

- [#213](https://github.com/aio-proxy/aio-proxy/pull/213) [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608) Thanks [@baranwang](https://github.com/baranwang)! - Add OpenAI Images inbound (`POST /v1/images/generations` and `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert. Blank JSON `model` and multipart missing/empty/whitespace `model` look up `gpt-image-2` (CPA-compatible); multipart literal `null` is the explicit id `"null"`. Raw/convert use the resolved candidate id. Alias-only API providers seed every alias target so language/image inbound can route. Image-capable API and ai-sdk providers attach convert (`provider.image`) when a V4 `imageModel` can be built; primary `openai-image` stays raw+image with no language transport. Edits accept official-max JSON (`357_564_416`) and multipart (`851_048_559`) envelopes — `Bun.serve` `maxRequestBodySize` matches the multipart encoded limit so those bodies reach the adapter. Convert egress `usage` is official Images snake_case (`input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details`). Convert copies present image options onto both `openai` and `openaiCompatible` providerOptions so `@ai-sdk/openai-compatible` transports receive `quality`, `output_format`, and `output_compression`. Multipart edits parse is abort-aware and idle-bounded per body read so stalled or compressed uploads cannot pin the process-wide parse slots. Same-id JSON returns a byte-preserving clone. Explicit unchanged multipart raw replays from a size-capped disk spool (`0600`) so parse does not tee an official-max body in memory; compressed edits decode as a bounded stream (decoder output is drained with a 64 KiB pending cap so a highly compressible chunk cannot stall a parse slot or materialize the full expansion before the parser reads); the pipeline unlinks the spool after fallback attempts finish. Fallback candidates still see the original body, boundary, and integrity headers. Defaulted or aliased multipart still rebuilds FormData. Image-primary providers with a language extra endpoint keep finite ids chat-capable and materialize `provider.model` from that endpoint so inbound Responses/chat convert instead of 501. Catalog embedding-only ids stay out of language dispatch. Image raw resolve passes the inbound path so generation-versus-edit resolvers see `/v1/images/generations` or `/v1/images/edits`. Multipart body search only ends a part when `\r\n--<boundary>` is followed by `--` or CRLF, so in-file boundary text is not a delimiter. The initial boundary scan skips preamble text that contains `--<boundary>` without a line start and `--`/CRLF suffix, and keeps enough prefix bytes across chunk splits — including partial-boundary overlap — to validate that line position. Multipart parse counts through EOF so a MIME epilogue cannot bypass the official-max encoded limit or the 1 MiB non-file budget. Rewritten Images raw (defaulted/aliased JSON or any multipart rebuild) drops `Content-MD5`, `Digest`, and `Content-Digest` so upstreams do not verify the client's original body. Convert returns `501 unsupported_feature` for `image_url` or `file_id`, and enforces official mask size/format/alpha on uploaded bytes.

## 0.10.0

## 0.9.1

### Patch Changes

- [#195](https://github.com/aio-proxy/aio-proxy/pull/195) [`1a1c519`](https://github.com/aio-proxy/aio-proxy/commit/1a1c519422c9be44a770646539803c929b5b9e43) Thanks [@baranwang](https://github.com/baranwang)! - Change the default local log retention from 14 days to 3 days.

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks [@baranwang](https://github.com/baranwang)! - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

  Skip same-wire aliases that only restate one model at every effort. When a family also has a colliding `-tiered` wire, default the alias there and send `xhigh` to it instead of hiding that id. Merge leftover `-thinking` siblings onto `when.thinking` even if the picker omitted them.

  Accept object-form `alias.variants` on read, then store only `{ when, model, preserve }` rows. Unpreserved variant targets stay hidden from the client model list.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks [@baranwang](https://github.com/baranwang)! - The dashboard API connection editor can now select multiple protocols and give each one its own address. Saving writes the existing `endpoints` config instead of dropping it.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks [@baranwang](https://github.com/baranwang)! - Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The plugin SDK descriptor contract, brand, and host accepted version are restored to v1; v2 descriptors are rejected. The xAI artifact smoke gate now follows plugin API v1.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks [@baranwang](https://github.com/baranwang)! - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab. OAuth providers gain a `models` whitelist that filters the discovered catalog (empty or absent exposes everything); ai-sdk providers with an OpenAI-shaped `options.baseURL` can list their catalog; oauth providers can run draft model tests; `models: []` no longer invalidates alias-only providers. The provider edit endpoint now returns the stored credentials so the editor can prefill them, replacing the previous redaction sentinels; `GET /dashboard/api/config` and `aio-proxy config` still mask secrets.

- [#190](https://github.com/aio-proxy/aio-proxy/pull/190) [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b) Thanks [@baranwang](https://github.com/baranwang)! - Add model-level Provider priority and weighted routing, stable-session candidate ordering, routing-v2 diagnostics, and a Dashboard Routing workspace. Provider weight now controls same-priority traffic instead of fixed global order; existing configurations should follow the documented migration table.

### Patch Changes

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8) Thanks [@baranwang](https://github.com/baranwang)! - Fix the provider editor silently corrupting alias variants that match on thinking or speed, and let the
  Dashboard author those conditions instead of only effort names. Config supports two variant shapes — the
  compact `{ low: { model } }` record and the `[{ when: { thinking: true }, model }]` row list — but the
  editor read and wrote both through `Object.entries`, which turns a row list into `{ "0": row }`. Saving
  an unrelated field on such an alias rewrote `when: { thinking: true }` into `when: { effort: "0" }`, a
  condition no request can ever match, so the variant stopped routing with no error shown. Variants are now
  edited as condition rows: each row picks any combination of `effort` (presets plus free text), `thinking`
  and `speed`, and rows are listed in the order they are stored, so a row never moves while its own condition
  is being edited. Saves now persist variants as `{ when, model, preserve }` rows. Compact record input is still accepted on read and rewritten to rows. The editor also reports the conditions the server would refuse or
  could never match — a row with no condition at all, a blank effort, and two rows matching the same
  condition — before the save instead of after it.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks [@baranwang](https://github.com/baranwang)! - The provider editor now loads an unsaved model catalog with HTTP QUERY, and leftover kind-switch fields no longer block that request.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5) Thanks [@baranwang](https://github.com/baranwang)! - types: list a provider's own model ids before its aliases. The derived route list that feeds `/v1/models`,
  each provider's `clientModels`, and the provider editor's exposure preview put alias names first, so a
  provider that renames one model pushed that alias above the models the user actually typed into the
  whitelist. Direct ids now come first and aliases follow, in configuration order. Which models a provider
  exposes is unchanged — only the order of the listing.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250) Thanks [@baranwang](https://github.com/baranwang)! - The provider editor's Model aliases block now offers a Sync plugin aliases button for OAuth providers
  whose plugin ships default aliases. Clicking it merges the plugin's suggestions into the alias list you
  are editing: a suggestion overwrites the alias that already carries its name, every other alias you wrote
  is kept, and names the draft does not have yet are appended. Nothing is written until you save, so the
  merge can be reviewed and undone like any other edit in the form.

  Only suggestions this provider can actually route are offered: a suggestion pointing at a model outside
  the provider's enabled models is dropped, together with any of its variants, because an alias aimed at a
  model the provider does not expose is what blocks Save. The button is absent when the provider's plugin
  has no suggestions or none survive that filter, and disabled while no upstream model is enabled. A plugin
  that returns a malformed suggestion, or throws while producing them, now costs only the suggestions — the
  editor page still opens.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7) Thanks [@baranwang](https://github.com/baranwang)! - Plugin default aliases now respect a provider's `models` whitelist, so a background catalog refresh can no longer insert an alias target outside it and drop the whole provider out of routing.

- [#184](https://github.com/aio-proxy/aio-proxy/pull/184) [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309) Thanks [@baranwang](https://github.com/baranwang)! - Cursor first-login now writes family aliases from AvailableModels, so clients can request names like `claude-sonnet-4-6` / `grok-4.6` and match thinking, effort, and speed onto the live wire slug.

## 0.8.0

### Minor Changes

- [#179](https://github.com/aio-proxy/aio-proxy/pull/179) [`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203) Thanks [@baranwang](https://github.com/baranwang)! - core: select alias targets from effort, thinking, and speed dimensions. A Gemini 1D variant key `off`/`OFF` no longer matches `thinkingLevel: "OFF"`; replace it with `{ "when": { "thinking": false }, "model": "…" }` (or drop the row and use the alias `model`) — shipped Antigravity defaults are unaffected.

- [#177](https://github.com/aio-proxy/aio-proxy/pull/177) [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705) Thanks [@baranwang](https://github.com/baranwang)! - API providers can declare multi-protocol `endpoints` (per-protocol or shared AI SDK-style base URLs). Raw passthrough now matches any natively supported protocol, Anthropic endpoints accept `auth: "bearer"`, and cross-protocol conversion keeps targeting the primary endpoint.

- [#176](https://github.com/aio-proxy/aio-proxy/pull/176) [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9) Thanks [@baranwang](https://github.com/baranwang)! - Allow authenticated remote model API access with labeled caller API keys.

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Accept Anthropic requests that combine disabled thinking with `output_config.effort`. Keep slow models.dev refreshes off the startup path. Resolve model metadata per source (config overrides catalogs). Fix overview day ranges to read `usage_daily` instead of pruned spans.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

## 0.6.4

## 0.6.3

## 0.6.2

## 0.6.1

## 0.6.0

### Minor Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085) Thanks [@baranwang](https://github.com/baranwang)! - feat: per-provider model metadata & cost overrides

  Providers can now declare a `metadata` map keyed by upstream model id to override client-facing model metadata (name, description, token limits, capabilities) and cost accounting. User config wins over models.dev auto-discovery. Billing uses the actual hit channel's configured `cost`, and each usage row records its `priceSource` (`config`/`models-dev`/`default`). A new `router.modelContextAggregation` (`min` default / `max`) reconciles the context window when multiple providers expose the same public model.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd) Thanks [@baranwang](https://github.com/baranwang)! - feat: meter image, web-search, and audio usage for per-event and audio fees

  The proxy now counts generated images and web-search invocations from served
  responses (OpenAI Responses output items and streamed AI SDK file/tool-call
  parts) and reads audio token counts from OpenAI-compatible usage. These flow
  into the configured `cost` fields (`image`, `webSearch`, `inputAudio`,
  `outputAudio`), which previously had no effect because nothing produced the
  counts. Audio tokens are treated as a subset of their input/output totals (as
  the upstream reports them) and peeled out before the text rate applies, so each
  audio token is billed once at the audio rate rather than at both rates.
  Requests without such events are unaffected.

### Patch Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee) Thanks [@baranwang](https://github.com/baranwang)! - Fix model-metadata projection and billing gaps:

  - `/v1/models` now reflects per-provider config metadata overrides — capabilities,
    `limit.output` (max tokens), and modalities — not just the display name and
    context window. Metadata inherited via `extend` surfaces the same way.
  - `max_input_tokens` now reports the model's maximum input tokens
    (`limit.input`) rather than the total context window, so a model whose context
    window exceeds its input limit no longer over-advertises its input capacity.
  - A flat per-request fee (`cost.request`) is now billed on a successful response
    that carries no token usage, instead of being silently dropped.
  - The generated config JSON Schema references the models.dev model-id enum for
    `metadata.extend`, so editors can autocomplete and validate the slug.

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.1

## 0.2.0
