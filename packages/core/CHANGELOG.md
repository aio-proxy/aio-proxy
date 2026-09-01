# @aio-proxy/core

## 0.12.2

### Patch Changes

- [#233](https://github.com/aio-proxy/aio-proxy/pull/233) [`ccf42a4`](https://github.com/aio-proxy/aio-proxy/commit/ccf42a4555539dd311a0cc36eefd41e75afdd9ac) Thanks [@baranwang](https://github.com/baranwang)! - Emit completed output-item events for streamed OpenAI Responses reasoning and assistant messages so clients can finalize cross-protocol responses.
- Updated dependencies []:
  - @aio-proxy/i18n@0.12.2
  - @aio-proxy/logger@0.12.2
  - @aio-proxy/plugin-cursor@0.12.2
  - @aio-proxy/plugin-github-copilot@0.12.2
  - @aio-proxy/plugin-google-antigravity@0.12.2
  - @aio-proxy/plugin-kimi-code@0.12.2
  - @aio-proxy/plugin-openai-chatgpt@0.12.2
  - @aio-proxy/plugin-sdk@0.12.2
  - @aio-proxy/plugin-xai-grok@0.12.2
  - @aio-proxy/shared@0.12.2
  - @aio-proxy/types@0.12.2

## 0.12.1

### Patch Changes

- [#231](https://github.com/aio-proxy/aio-proxy/pull/231) [`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6) Thanks [@baranwang](https://github.com/baranwang)! - dashboard: grade traces latency like new-api and show the lightning icon for fast/priority requests

  Chat Completions `service_tier` now maps onto the speed routing axis (`priority`/`fast` → fast, `flex` → flex), matching Responses.

- Updated dependencies [[`e674d9a`](https://github.com/aio-proxy/aio-proxy/commit/e674d9a225d36d03fb388c223a6559beff6adb4d), [`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6)]:
  - @aio-proxy/plugin-openai-chatgpt@0.12.1
  - @aio-proxy/plugin-cursor@0.12.1
  - @aio-proxy/plugin-kimi-code@0.12.1
  - @aio-proxy/plugin-github-copilot@0.12.1
  - @aio-proxy/plugin-google-antigravity@0.12.1
  - @aio-proxy/plugin-xai-grok@0.12.1
  - @aio-proxy/types@0.12.1
  - @aio-proxy/i18n@0.12.1
  - @aio-proxy/plugin-sdk@0.12.1
  - @aio-proxy/logger@0.12.1
  - @aio-proxy/shared@0.12.1

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks [@baranwang](https://github.com/baranwang)! - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`. The removed `providers.<id>.metadata` field is silently ignored, and metadata keys no longer create routes; expose models through `providers.<id>.models` or `alias`. Metadata editing now lives in the Dashboard routing drawer instead of the Provider editor.

  Rename the plugin SDK's free-form `ModelDescriptor.metadata`, `ModelCatalog.metadata`, and raw-resolver `metadata` input to `extra`, and add typed `ModelDescriptor.modelMetadata` for host-consumed model metadata. Publish `@aio-proxy/types` as the SDK metadata type source.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks [@baranwang](https://github.com/baranwang)! - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
- Updated dependencies [[`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2), [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca)]:
  - @aio-proxy/plugin-sdk@0.12.0
  - @aio-proxy/types@0.12.0
  - @aio-proxy/i18n@0.12.0
  - @aio-proxy/plugin-cursor@0.12.0
  - @aio-proxy/plugin-github-copilot@0.12.0
  - @aio-proxy/plugin-google-antigravity@0.12.0
  - @aio-proxy/plugin-kimi-code@0.12.0
  - @aio-proxy/plugin-openai-chatgpt@0.12.0
  - @aio-proxy/plugin-xai-grok@0.12.0
  - @aio-proxy/logger@0.12.0
  - @aio-proxy/shared@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.11.2
  - @aio-proxy/logger@0.11.2
  - @aio-proxy/plugin-cursor@0.11.2
  - @aio-proxy/plugin-github-copilot@0.11.2
  - @aio-proxy/plugin-google-antigravity@0.11.2
  - @aio-proxy/plugin-kimi-code@0.11.2
  - @aio-proxy/plugin-openai-chatgpt@0.11.2
  - @aio-proxy/plugin-sdk@0.11.2
  - @aio-proxy/plugin-xai-grok@0.11.2
  - @aio-proxy/types@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [[`0635583`](https://github.com/aio-proxy/aio-proxy/commit/0635583d2067b41c1a27170d4330c6d7a3e53773)]:
  - @aio-proxy/plugin-xai-grok@0.11.1
  - @aio-proxy/i18n@0.11.1
  - @aio-proxy/logger@0.11.1
  - @aio-proxy/plugin-cursor@0.11.1
  - @aio-proxy/plugin-github-copilot@0.11.1
  - @aio-proxy/plugin-google-antigravity@0.11.1
  - @aio-proxy/plugin-kimi-code@0.11.1
  - @aio-proxy/plugin-openai-chatgpt@0.11.1
  - @aio-proxy/plugin-sdk@0.11.1
  - @aio-proxy/types@0.11.1

## 0.11.0

### Minor Changes

- [#215](https://github.com/aio-proxy/aio-proxy/pull/215) [`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13) Thanks [@baranwang](https://github.com/baranwang)! - Add Gemini Interactions as an inbound protocol at `POST /v1beta/interactions`.

- [#212](https://github.com/aio-proxy/aio-proxy/pull/212) [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b) Thanks [@baranwang](https://github.com/baranwang)! - openai: add Completions and Responses compact ports

  `POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline. Remaining official Responses resource operations return a protocol-shaped 501 instead of a generic 404. ChatGPT OAuth providers forward compact to the Codex compaction endpoint. GitHub Copilot and Kimi Code providers decline endpoints they do not serve so the same candidate can convert through its language model, or a later provider can take the request. Legacy Completions streams omit usage unless the client can opt in.

- [#213](https://github.com/aio-proxy/aio-proxy/pull/213) [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608) Thanks [@baranwang](https://github.com/baranwang)! - Add OpenAI Images inbound (`POST /v1/images/generations` and `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert. Blank JSON `model` and multipart missing/empty/whitespace `model` look up `gpt-image-2` (CPA-compatible); multipart literal `null` is the explicit id `"null"`. Raw/convert use the resolved candidate id. Alias-only API providers seed every alias target so language/image inbound can route. Image-capable API and ai-sdk providers attach convert (`provider.image`) when a V4 `imageModel` can be built; primary `openai-image` stays raw+image with no language transport. Edits accept official-max JSON (`357_564_416`) and multipart (`851_048_559`) envelopes — `Bun.serve` `maxRequestBodySize` matches the multipart encoded limit so those bodies reach the adapter. Convert egress `usage` is official Images snake_case (`input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details`). Convert copies present image options onto both `openai` and `openaiCompatible` providerOptions so `@ai-sdk/openai-compatible` transports receive `quality`, `output_format`, and `output_compression`. Multipart edits parse is abort-aware and idle-bounded per body read so stalled or compressed uploads cannot pin the process-wide parse slots. Same-id JSON returns a byte-preserving clone. Explicit unchanged multipart raw replays from a size-capped disk spool (`0600`) so parse does not tee an official-max body in memory; compressed edits decode as a bounded stream (decoder output is drained with a 64 KiB pending cap so a highly compressible chunk cannot stall a parse slot or materialize the full expansion before the parser reads); the pipeline unlinks the spool after fallback attempts finish. Fallback candidates still see the original body, boundary, and integrity headers. Defaulted or aliased multipart still rebuilds FormData. Image-primary providers with a language extra endpoint keep finite ids chat-capable and materialize `provider.model` from that endpoint so inbound Responses/chat convert instead of 501. Catalog embedding-only ids stay out of language dispatch. Image raw resolve passes the inbound path so generation-versus-edit resolvers see `/v1/images/generations` or `/v1/images/edits`. Multipart body search only ends a part when `\r\n--<boundary>` is followed by `--` or CRLF, so in-file boundary text is not a delimiter. The initial boundary scan skips preamble text that contains `--<boundary>` without a line start and `--`/CRLF suffix, and keeps enough prefix bytes across chunk splits — including partial-boundary overlap — to validate that line position. Multipart parse counts through EOF so a MIME epilogue cannot bypass the official-max encoded limit or the 1 MiB non-file budget. Rewritten Images raw (defaulted/aliased JSON or any multipart rebuild) drops `Content-MD5`, `Digest`, and `Content-Digest` so upstreams do not verify the client's original body. Convert returns `501 unsupported_feature` for `image_url` or `file_id`, and enforces official mask size/format/alpha on uploaded bytes.

- [#214](https://github.com/aio-proxy/aio-proxy/pull/214) [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612) Thanks [@baranwang](https://github.com/baranwang)! - Add inbound OpenAI Embeddings and Gemini embed/batch embed through same-protocol raw, embedding convert, and fallback.

### Patch Changes

- [#217](https://github.com/aio-proxy/aio-proxy/pull/217) [`e0c9ea0`](https://github.com/aio-proxy/aio-proxy/commit/e0c9ea0b6c8cea6329cf2eeefc2dc4ee2675d44c) Thanks [@baranwang](https://github.com/baranwang)! - Continue OpenAI Responses model fallback across completed hosted-search history and fall back xAI Grok OAuth custom grammar declarations to ordinary function tools with reversible client wire restoration.
- Updated dependencies [[`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13), [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b), [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608), [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612), [`e0c9ea0`](https://github.com/aio-proxy/aio-proxy/commit/e0c9ea0b6c8cea6329cf2eeefc2dc4ee2675d44c)]:
  - @aio-proxy/types@0.11.0
  - @aio-proxy/plugin-sdk@0.11.0
  - @aio-proxy/plugin-github-copilot@0.11.0
  - @aio-proxy/plugin-kimi-code@0.11.0
  - @aio-proxy/plugin-openai-chatgpt@0.11.0
  - @aio-proxy/plugin-google-antigravity@0.11.0
  - @aio-proxy/plugin-xai-grok@0.11.0
  - @aio-proxy/plugin-cursor@0.11.0
  - @aio-proxy/logger@0.11.0
  - @aio-proxy/i18n@0.11.0

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks [@baranwang](https://github.com/baranwang)! - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

### Patch Changes

- Updated dependencies [[`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402), [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1)]:
  - @aio-proxy/plugin-sdk@0.10.0
  - @aio-proxy/i18n@0.10.0
  - @aio-proxy/plugin-openai-chatgpt@0.10.0
  - @aio-proxy/plugin-google-antigravity@0.10.0
  - @aio-proxy/plugin-kimi-code@0.10.0
  - @aio-proxy/plugin-xai-grok@0.10.0
  - @aio-proxy/logger@0.10.0
  - @aio-proxy/plugin-cursor@0.10.0
  - @aio-proxy/plugin-github-copilot@0.10.0
  - @aio-proxy/types@0.10.0

## 0.9.1

### Patch Changes

- [#199](https://github.com/aio-proxy/aio-proxy/pull/199) [`fcef8e5`](https://github.com/aio-proxy/aio-proxy/commit/fcef8e5af578aee26df0db1b2ebb30bd6e50d3a0) Thanks [@baranwang](https://github.com/baranwang)! - Keep OpenAI Responses reasoning summaries with preceding tool calls so cross-protocol tool results remain adjacent.
- Updated dependencies [[`1a1c519`](https://github.com/aio-proxy/aio-proxy/commit/1a1c519422c9be44a770646539803c929b5b9e43), [`c9fe40d`](https://github.com/aio-proxy/aio-proxy/commit/c9fe40dfb7b1ad7fbadb94f4c9ce64ced43dc294)]:
  - @aio-proxy/types@0.9.1
  - @aio-proxy/logger@0.9.1
  - @aio-proxy/plugin-xai-grok@0.9.1
  - @aio-proxy/plugin-cursor@0.9.1
  - @aio-proxy/plugin-openai-chatgpt@0.9.1
  - @aio-proxy/i18n@0.9.1
  - @aio-proxy/plugin-github-copilot@0.9.1
  - @aio-proxy/plugin-google-antigravity@0.9.1
  - @aio-proxy/plugin-kimi-code@0.9.1
  - @aio-proxy/plugin-sdk@0.9.1

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks [@baranwang](https://github.com/baranwang)! - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

  Skip same-wire aliases that only restate one model at every effort. When a family also has a colliding `-tiered` wire, default the alias there and send `xhigh` to it instead of hiding that id. Merge leftover `-thinking` siblings onto `when.thinking` even if the picker omitted them.

  Accept object-form `alias.variants` on read, then store only `{ when, model, preserve }` rows. Unpreserved variant targets stay hidden from the client model list.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks [@baranwang](https://github.com/baranwang)! - Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The plugin SDK descriptor contract, brand, and host accepted version are restored to v1; v2 descriptors are rejected. The xAI artifact smoke gate now follows plugin API v1.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks [@baranwang](https://github.com/baranwang)! - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab. OAuth providers gain a `models` whitelist that filters the discovered catalog (empty or absent exposes everything); ai-sdk providers with an OpenAI-shaped `options.baseURL` can list their catalog; oauth providers can run draft model tests; `models: []` no longer invalidates alias-only providers. The provider edit endpoint now returns the stored credentials so the editor can prefill them, replacing the previous redaction sentinels; `GET /dashboard/api/config` and `aio-proxy config` still mask secrets.

- [#190](https://github.com/aio-proxy/aio-proxy/pull/190) [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b) Thanks [@baranwang](https://github.com/baranwang)! - Add model-level Provider priority and weighted routing, stable-session candidate ordering, routing-v2 diagnostics, and a Dashboard Routing workspace. Provider weight now controls same-priority traffic instead of fixed global order; existing configurations should follow the documented migration table.

### Patch Changes

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e) Thanks [@baranwang](https://github.com/baranwang)! - An OAuth provider's `models` whitelist is now read and validated from the config file, where it was
  previously ignored. If you had hand-written a `models` key on an OAuth provider it now takes effect and
  restricts which models that provider exposes. A malformed value — an empty model id, or a bare string
  instead of a list — is reported instead of being silently dropped: that one provider is marked invalid
  and unavailable in the Dashboard while the proxy and every other provider start normally. A re-login is
  now validated the same way before its config is written: a staged `models` whitelist that is malformed is
  rejected rather than persisted, so a re-login can no longer leave a working provider with a whitelist the
  next start refuses to read.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1) Thanks [@baranwang](https://github.com/baranwang)! - Keep per-model metadata edits when saving an OAuth provider also re-authorizes it. The editor saves
  credentials and model metadata in one action; if the credential half required re-authorization, the
  login path rebuilt the provider entry from a patch that had no metadata field, so the metadata half
  of the save was silently discarded.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e) Thanks [@baranwang](https://github.com/baranwang)! - Harden the OAuth provider update contract so a partial patch cannot delete a provider's display name,
  aliases, or model whitelist. Every field of a provider patch is optional on the wire, but rebuilding the
  entry treated an omitted field as "clear it", so a caller that sent only the fields it owned dropped
  config the user had authored elsewhere. The surfaces that ship today do send those fields — and a CLI
  re-login sends no patch at all, so these three fields were already safe there — so this fixes the contract
  rather than a flow you can hit. The rule it now follows is the one already fixed for per-model metadata: a
  field a save does not mention keeps its stored value. `weight` is the deliberate exception, because an
  omitted key is the only way to say "no weight", and clearing the display name now removes it instead of
  storing an empty name.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`cd6c5a3`](https://github.com/aio-proxy/aio-proxy/commit/cd6c5a3dd352ea22198d99345a6da3272510caca) Thanks [@baranwang](https://github.com/baranwang)! - Keep per-model metadata when an OAuth provider is re-authorized. Every re-login rebuilt the provider
  entry from a fixed field list that omitted `metadata`, so re-authorizing from the Dashboard or running
  `provider login` again deleted all per-model overrides — including `extend`, which is how a model
  tracks its models.dev source.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`a3cf9b5`](https://github.com/aio-proxy/aio-proxy/commit/a3cf9b55e0377cd8df102acf3fd9463ff5899207) Thanks [@baranwang](https://github.com/baranwang)! - A display name that is only whitespace now clears the key on an OAuth provider instead of being written
  into the config file. The empty string was already dropped, but `"   "` survived on both the ordinary
  save path and reauthorization; the editor already treats a blank-after-trim name as absent, so the
  config kept a `name` nothing would ever render. Rejecting a staged OAuth write now throws a real
  `Error`, so the structured logs that record an error's name during config recovery and session-store
  writes report `ZodError` rather than `Error` or `object`; the rejection message and its
  `providers.<id>.<field>` issue paths are unchanged.

- [#188](https://github.com/aio-proxy/aio-proxy/pull/188) [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc) Thanks [@baranwang](https://github.com/baranwang)! - core: pin the bundled Bun runtime to 1.4.0 and restore streamed request bodies through HTTP proxies. Bun 1.4.0 ships the `fetch` + `proxy` `ReadableStream` body fix, so `createProxyFetch` no longer buffers the request. Plugin runtime compatibility is now Bun `>=1.4.0`. Compiled macOS binaries are ad-hoc re-signed after `bun build --compile` so they launch on macOS 27. Release runs on macOS so that signature is applied when the CLI is actually published.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7) Thanks [@baranwang](https://github.com/baranwang)! - Plugin default aliases now respect a provider's `models` whitelist, so a background catalog refresh can no longer insert an alias target outside it and drop the whole provider out of routing.
- Updated dependencies [[`f8947e7`](https://github.com/aio-proxy/aio-proxy/commit/f8947e78bc3ec3c7ccfa04e6c82606d7fa7989d9), [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8), [`6560946`](https://github.com/aio-proxy/aio-proxy/commit/65609463e6ede5798787c54614d716f2120e8148), [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`b71e13c`](https://github.com/aio-proxy/aio-proxy/commit/b71e13c8c991d3482a5446fdbd980ffc37a73ae1), [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5), [`21883d3`](https://github.com/aio-proxy/aio-proxy/commit/21883d33ab3ceb0081e123aaa985f42b4622f33d), [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00), [`798e1e2`](https://github.com/aio-proxy/aio-proxy/commit/798e1e2c230dd925f6a2df1741b52ee75c955852), [`cff1a38`](https://github.com/aio-proxy/aio-proxy/commit/cff1a38dda0e9c6e3c0be008580f8144f62ea725), [`35dacf3`](https://github.com/aio-proxy/aio-proxy/commit/35dacf3cfbd006598e0f1f7a4082f1f2399971c6), [`3cb3b81`](https://github.com/aio-proxy/aio-proxy/commit/3cb3b8135f109c0eb6ee9fab138e83ee32136ae0), [`165d4c1`](https://github.com/aio-proxy/aio-proxy/commit/165d4c1ef27a9519ff6a76387c1740643c038db1), [`e3ff7aa`](https://github.com/aio-proxy/aio-proxy/commit/e3ff7aa430a1a0d4429aa93e34f7e77836063c83), [`c73de2d`](https://github.com/aio-proxy/aio-proxy/commit/c73de2d1bd7c849a239d8e6a3fe139f7b6be4da6), [`6fb3a79`](https://github.com/aio-proxy/aio-proxy/commit/6fb3a799f2abd3ee6f4fd11b01a7040be226257f), [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca), [`ef90e90`](https://github.com/aio-proxy/aio-proxy/commit/ef90e90173a91816649d5c76053caf776b30e5dc), [`ecb6e0c`](https://github.com/aio-proxy/aio-proxy/commit/ecb6e0c74220388cc4dd51445e994b0cef0865a5), [`b1bcb8d`](https://github.com/aio-proxy/aio-proxy/commit/b1bcb8dc140edff15f9534a8058dd038a2ee5717), [`4c33182`](https://github.com/aio-proxy/aio-proxy/commit/4c33182e52533af7b613df3e67c82a3cba09cdb0), [`ea6b1c9`](https://github.com/aio-proxy/aio-proxy/commit/ea6b1c98ca4c9a9ba35b39de91df4b1b25165135), [`0a93cfd`](https://github.com/aio-proxy/aio-proxy/commit/0a93cfd509c919280fcfea53528e1a706edd36d5), [`e86cff1`](https://github.com/aio-proxy/aio-proxy/commit/e86cff1401ae66805faee73f5fa990a5249d52fb), [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b), [`c22a6ec`](https://github.com/aio-proxy/aio-proxy/commit/c22a6ec1e96f9b6e1b014f8601609565bef6ca23), [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250), [`f75367e`](https://github.com/aio-proxy/aio-proxy/commit/f75367ebf14dfd6a47c86c19f0851f27065c6876), [`476b0a8`](https://github.com/aio-proxy/aio-proxy/commit/476b0a8133f3c2a46e710e682006bf8074170bb5), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309), [`29a90c2`](https://github.com/aio-proxy/aio-proxy/commit/29a90c24c45d4e00ada1960ca4cfd492344f6535)]:
  - @aio-proxy/i18n@0.9.0
  - @aio-proxy/types@0.9.0
  - @aio-proxy/plugin-google-antigravity@0.9.0
  - @aio-proxy/plugin-sdk@0.9.0
  - @aio-proxy/plugin-xai-grok@0.9.0
  - @aio-proxy/plugin-cursor@0.9.0
  - @aio-proxy/plugin-openai-chatgpt@0.9.0
  - @aio-proxy/logger@0.9.0
  - @aio-proxy/plugin-github-copilot@0.9.0
  - @aio-proxy/plugin-kimi-code@0.9.0

## 0.8.0

### Minor Changes

- [#179](https://github.com/aio-proxy/aio-proxy/pull/179) [`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203) Thanks [@baranwang](https://github.com/baranwang)! - core: select alias targets from effort, thinking, and speed dimensions. A Gemini 1D variant key `off`/`OFF` no longer matches `thinkingLevel: "OFF"`; replace it with `{ "when": { "thinking": false }, "model": "…" }` (or drop the row and use the alias `model`) — shipped Antigravity defaults are unaffected.

- [#177](https://github.com/aio-proxy/aio-proxy/pull/177) [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705) Thanks [@baranwang](https://github.com/baranwang)! - API providers can declare multi-protocol `endpoints` (per-protocol or shared AI SDK-style base URLs). Raw passthrough now matches any natively supported protocol, Anthropic endpoints accept `auth: "bearer"`, and cross-protocol conversion keeps targeting the primary endpoint.

### Patch Changes

- [#180](https://github.com/aio-proxy/aio-proxy/pull/180) [`4f73aa6`](https://github.com/aio-proxy/aio-proxy/commit/4f73aa69236d458a8ad8c811287fad03d674ad43) Thanks [@baranwang](https://github.com/baranwang)! - core: accept namespaced custom tools and align replayed Codex custom/function call history to the unique flattened tool name
- Updated dependencies [[`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203), [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705), [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9)]:
  - @aio-proxy/types@0.8.0
  - @aio-proxy/plugin-openai-chatgpt@0.8.0
  - @aio-proxy/i18n@0.8.0
  - @aio-proxy/logger@0.8.0
  - @aio-proxy/plugin-cursor@0.8.0
  - @aio-proxy/plugin-github-copilot@0.8.0
  - @aio-proxy/plugin-google-antigravity@0.8.0
  - @aio-proxy/plugin-kimi-code@0.8.0
  - @aio-proxy/plugin-sdk@0.8.0
  - @aio-proxy/plugin-xai-grok@0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Accept Anthropic requests that combine disabled thinking with `output_config.effort`. Keep slow models.dev refreshes off the startup path. Resolve model metadata per source (config overrides catalogs). Fix overview day ranges to read `usage_daily` instead of pruned spans.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

### Patch Changes

- Updated dependencies [[`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5)]:
  - @aio-proxy/types@0.7.0
  - @aio-proxy/i18n@0.7.0
  - @aio-proxy/plugin-sdk@0.7.0
  - @aio-proxy/plugin-cursor@0.7.0
  - @aio-proxy/plugin-github-copilot@0.7.0
  - @aio-proxy/plugin-google-antigravity@0.7.0
  - @aio-proxy/plugin-kimi-code@0.7.0
  - @aio-proxy/plugin-openai-chatgpt@0.7.0
  - @aio-proxy/plugin-xai-grok@0.7.0
  - @aio-proxy/logger@0.7.0

## 0.6.4

### Patch Changes

- [#160](https://github.com/aio-proxy/aio-proxy/pull/160) [`08a579c`](https://github.com/aio-proxy/aio-proxy/commit/08a579cad9b5192820cd42f2cbb6ba18e0bc9e18) Thanks [@baranwang](https://github.com/baranwang)! - Accept empty OpenAI Responses function-call arguments when converting requests across protocols.
- Updated dependencies []:
  - @aio-proxy/i18n@0.6.4
  - @aio-proxy/logger@0.6.4
  - @aio-proxy/plugin-github-copilot@0.6.4
  - @aio-proxy/plugin-google-antigravity@0.6.4
  - @aio-proxy/plugin-kimi-code@0.6.4
  - @aio-proxy/plugin-openai-chatgpt@0.6.4
  - @aio-proxy/plugin-sdk@0.6.4
  - @aio-proxy/plugin-xai-grok@0.6.4
  - @aio-proxy/types@0.6.4

## 0.6.3

### Patch Changes

- [#157](https://github.com/aio-proxy/aio-proxy/pull/157) [`ba2aeae`](https://github.com/aio-proxy/aio-proxy/commit/ba2aeae4dfae3d932e2a22ac97d816b74d32a5ca) Thanks [@baranwang](https://github.com/baranwang)! - core: stop rejecting OpenAI Responses `custom_tool_call` history that has no matching custom tool declaration. Codex compaction turns replay prior custom tool calls (e.g. `apply_patch`) while sending `tools: []`, which previously produced a 501 "OpenAI Responses feature is not supported: custom_tool_call". The transform now converts that history like any other tool call.
- Updated dependencies []:
  - @aio-proxy/i18n@0.6.3
  - @aio-proxy/logger@0.6.3
  - @aio-proxy/plugin-github-copilot@0.6.3
  - @aio-proxy/plugin-google-antigravity@0.6.3
  - @aio-proxy/plugin-kimi-code@0.6.3
  - @aio-proxy/plugin-openai-chatgpt@0.6.3
  - @aio-proxy/plugin-sdk@0.6.3
  - @aio-proxy/plugin-xai-grok@0.6.3
  - @aio-proxy/types@0.6.3

## 0.6.2

### Patch Changes

- [#150](https://github.com/aio-proxy/aio-proxy/pull/150) [`52cb5ce`](https://github.com/aio-proxy/aio-proxy/commit/52cb5cef04cd1532dac2a773ee61b4fefd72d54d) Thanks [@baranwang](https://github.com/baranwang)! - Allow OpenAI Responses requests with image detail hints to fall back across provider protocols.
- Updated dependencies []:
  - @aio-proxy/i18n@0.6.2
  - @aio-proxy/logger@0.6.2
  - @aio-proxy/plugin-github-copilot@0.6.2
  - @aio-proxy/plugin-google-antigravity@0.6.2
  - @aio-proxy/plugin-kimi-code@0.6.2
  - @aio-proxy/plugin-openai-chatgpt@0.6.2
  - @aio-proxy/plugin-sdk@0.6.2
  - @aio-proxy/plugin-xai-grok@0.6.2
  - @aio-proxy/types@0.6.2

## 0.6.1

### Patch Changes

- [#143](https://github.com/aio-proxy/aio-proxy/pull/143) [`5ab65bf`](https://github.com/aio-proxy/aio-proxy/commit/5ab65bf7ef8dd5b74e2589df30b6da7342436cb6) Thanks [@baranwang](https://github.com/baranwang)! - Support OpenAI Responses instructions and hosted web search on cross-protocol model routes.
- Updated dependencies [[`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7)]:
  - @aio-proxy/i18n@0.6.1
  - @aio-proxy/logger@0.6.1
  - @aio-proxy/plugin-github-copilot@0.6.1
  - @aio-proxy/plugin-google-antigravity@0.6.1
  - @aio-proxy/plugin-kimi-code@0.6.1
  - @aio-proxy/plugin-openai-chatgpt@0.6.1
  - @aio-proxy/plugin-sdk@0.6.1
  - @aio-proxy/plugin-xai-grok@0.6.1
  - @aio-proxy/types@0.6.1

## 0.6.0

### Minor Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`963e395`](https://github.com/aio-proxy/aio-proxy/commit/963e3951a64644441a36b0ae4c9b93d644444d18) Thanks [@baranwang](https://github.com/baranwang)! - extend: resolve per-model `metadata.extend` into effective merged metadata — inherit a models.dev catalog entry as a base layer, deep-merged under your explicit fields, so cost accounting and model resolution both see the inherited values.

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

- Updated dependencies [[`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee), [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085), [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd)]:
  - @aio-proxy/types@0.6.0
  - @aio-proxy/plugin-openai-chatgpt@0.6.0
  - @aio-proxy/i18n@0.6.0
  - @aio-proxy/logger@0.6.0
  - @aio-proxy/plugin-github-copilot@0.6.0
  - @aio-proxy/plugin-google-antigravity@0.6.0
  - @aio-proxy/plugin-kimi-code@0.6.0
  - @aio-proxy/plugin-sdk@0.6.0
  - @aio-proxy/plugin-xai-grok@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95)]:
  - @aio-proxy/i18n@0.5.2
  - @aio-proxy/logger@0.5.2
  - @aio-proxy/plugin-github-copilot@0.5.2
  - @aio-proxy/plugin-google-antigravity@0.5.2
  - @aio-proxy/plugin-kimi-code@0.5.2
  - @aio-proxy/plugin-openai-chatgpt@0.5.2
  - @aio-proxy/plugin-sdk@0.5.2
  - @aio-proxy/plugin-xai-grok@0.5.2
  - @aio-proxy/types@0.5.2

## 0.5.1

### Patch Changes

- [#131](https://github.com/aio-proxy/aio-proxy/pull/131) [`1a525e8`](https://github.com/aio-proxy/aio-proxy/commit/1a525e861a0ef77668c3321f75171bb9e2880e9f) Thanks [@baranwang](https://github.com/baranwang)! - core: fix proxied streaming passthrough dropping the request body. Bun 1.3.x
  silently discards a `ReadableStream` request body when `fetch` uses a proxy, so
  `api` providers with a `proxy` configured hung until timeout on streaming
  requests (e.g. `openai-response` passthrough). `createProxyFetch` now buffers a
  streamed request body to bytes before sending it through the proxy, so the body
  survives without changing the streaming response. This lets the build toolchain
  stay on the reproducible Bun 1.3.14 release.
- Updated dependencies []:
  - @aio-proxy/i18n@0.5.1
  - @aio-proxy/logger@0.5.1
  - @aio-proxy/plugin-github-copilot@0.5.1
  - @aio-proxy/plugin-google-antigravity@0.5.1
  - @aio-proxy/plugin-kimi-code@0.5.1
  - @aio-proxy/plugin-openai-chatgpt@0.5.1
  - @aio-proxy/plugin-sdk@0.5.1
  - @aio-proxy/plugin-xai-grok@0.5.1
  - @aio-proxy/types@0.5.1

## 0.5.0

### Minor Changes

- [#129](https://github.com/aio-proxy/aio-proxy/pull/129) [`c6ecfc0`](https://github.com/aio-proxy/aio-proxy/commit/c6ecfc0dc81e6cb0f0c5cd7b27b79f32cfb0955c) Thanks [@baranwang](https://github.com/baranwang)! - normalize and downgrade reasoning effort per upstream model capability

  Inbound reasoning-effort values are now accepted leniently and clamped to what
  each candidate upstream model actually advertises, on both the raw-passthrough
  and AI SDK model-invocation paths. This fixes a `400 ... at output_config.effort`
  error when Claude Code's ultracode mode sent effort `xhigh` to an upstream that
  only supports `low`/`medium`/`high` — the request now downgrades to the highest
  supported level instead of being rejected. Capability resolution is cache-only,
  so a cold or slow models.dev never blocks the request (it falls back to
  forwarding the client's value unchanged).

### Patch Changes

- [#127](https://github.com/aio-proxy/aio-proxy/pull/127) [`d95834a`](https://github.com/aio-proxy/aio-proxy/commit/d95834ad85ea0352f5c389497ea008c687a80d64) Thanks [@baranwang](https://github.com/baranwang)! - core: upgrade the bundled Bun runtime to the 1.4 line so proxied streaming passthrough no longer drops the request body. Bun 1.3.x silently discarded a `ReadableStream` request body when `fetch` used a proxy, so `api` providers with a `proxy` configured hung until timeout on streaming requests (e.g. `openai-response` passthrough). The compiled binary embeds the build-time Bun runtime, so this is delivered by pinning the build toolchain to Bun 1.4.
- Updated dependencies []:
  - @aio-proxy/i18n@0.5.0
  - @aio-proxy/logger@0.5.0
  - @aio-proxy/plugin-github-copilot@0.5.0
  - @aio-proxy/plugin-google-antigravity@0.5.0
  - @aio-proxy/plugin-kimi-code@0.5.0
  - @aio-proxy/plugin-openai-chatgpt@0.5.0
  - @aio-proxy/plugin-sdk@0.5.0
  - @aio-proxy/plugin-xai-grok@0.5.0
  - @aio-proxy/types@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282)]:
  - @aio-proxy/i18n@0.4.0
  - @aio-proxy/logger@0.4.0
  - @aio-proxy/plugin-github-copilot@0.4.0
  - @aio-proxy/plugin-google-antigravity@0.4.0
  - @aio-proxy/plugin-kimi-code@0.4.0
  - @aio-proxy/plugin-openai-chatgpt@0.4.0
  - @aio-proxy/plugin-sdk@0.4.0
  - @aio-proxy/plugin-xai-grok@0.4.0
  - @aio-proxy/types@0.4.0

## 0.3.0

### Patch Changes

- [#120](https://github.com/aio-proxy/aio-proxy/pull/120) [`38960fd`](https://github.com/aio-proxy/aio-proxy/commit/38960fd9fca94d3e38cb5277a5eb928a3962d96a) Thanks [@baranwang](https://github.com/baranwang)! - core: accept `role: "system"` messages on the Anthropic Messages endpoint (matching the official SDK's `MessageParam` union) and surface Zod validation path detail in 400 responses without leaking request values
- Updated dependencies []:
  - @aio-proxy/i18n@0.3.0
  - @aio-proxy/logger@0.3.0
  - @aio-proxy/plugin-github-copilot@0.3.0
  - @aio-proxy/plugin-google-antigravity@0.3.0
  - @aio-proxy/plugin-kimi-code@0.3.0
  - @aio-proxy/plugin-openai-chatgpt@0.3.0
  - @aio-proxy/plugin-sdk@0.3.0
  - @aio-proxy/plugin-xai-grok@0.3.0
  - @aio-proxy/types@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.2.1
  - @aio-proxy/logger@0.2.1
  - @aio-proxy/plugin-github-copilot@0.2.1
  - @aio-proxy/plugin-google-antigravity@0.2.1
  - @aio-proxy/plugin-kimi-code@0.2.1
  - @aio-proxy/plugin-openai-chatgpt@0.2.1
  - @aio-proxy/plugin-sdk@0.2.1
  - @aio-proxy/plugin-xai-grok@0.2.1
  - @aio-proxy/types@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.2.0
  - @aio-proxy/logger@0.2.0
  - @aio-proxy/plugin-github-copilot@0.2.0
  - @aio-proxy/plugin-google-antigravity@0.2.0
  - @aio-proxy/plugin-kimi-code@0.2.0
  - @aio-proxy/plugin-openai-chatgpt@0.2.0
  - @aio-proxy/plugin-sdk@0.2.0
  - @aio-proxy/plugin-xai-grok@0.2.0
  - @aio-proxy/types@0.2.0
