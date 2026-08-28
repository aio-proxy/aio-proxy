# @aio-proxy/server

## 0.11.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/core@0.11.1
  - @aio-proxy/i18n@0.11.1
  - @aio-proxy/logger@0.11.1
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
  - @aio-proxy/core@0.11.0
  - @aio-proxy/types@0.11.0
  - @aio-proxy/plugin-sdk@0.11.0
  - @aio-proxy/logger@0.11.0
  - @aio-proxy/i18n@0.11.0

## 0.10.0

### Patch Changes

- [#202](https://github.com/aio-proxy/aio-proxy/pull/202) [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1) Thanks [@baranwang](https://github.com/baranwang)! - dashboard: show OAuth account labels on model routing Providers
- Updated dependencies [[`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402), [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1)]:
  - @aio-proxy/plugin-sdk@0.10.0
  - @aio-proxy/core@0.10.0
  - @aio-proxy/i18n@0.10.0
  - @aio-proxy/logger@0.10.0
  - @aio-proxy/types@0.10.0

## 0.9.1

### Patch Changes

- [#199](https://github.com/aio-proxy/aio-proxy/pull/199) [`2e19250`](https://github.com/aio-proxy/aio-proxy/commit/2e192507075833219fff1bec8379f4144b383c84) Thanks [@baranwang](https://github.com/baranwang)! - Return upstream model errors before committing a streaming response when AI SDK startup emits a start event first.

- [#198](https://github.com/aio-proxy/aio-proxy/pull/198) [`af389a5`](https://github.com/aio-proxy/aio-proxy/commit/af389a50b57f123c71965cd337185cb8185629e1) Thanks [@baranwang](https://github.com/baranwang)! - Serve dashboard public files such as `/dashboard/favicon.svg` from the built assets instead of the SPA fallback.
- Updated dependencies [[`fcef8e5`](https://github.com/aio-proxy/aio-proxy/commit/fcef8e5af578aee26df0db1b2ebb30bd6e50d3a0), [`1a1c519`](https://github.com/aio-proxy/aio-proxy/commit/1a1c519422c9be44a770646539803c929b5b9e43)]:
  - @aio-proxy/core@0.9.1
  - @aio-proxy/types@0.9.1
  - @aio-proxy/logger@0.9.1
  - @aio-proxy/i18n@0.9.1
  - @aio-proxy/plugin-sdk@0.9.1

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

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ed5f7b7`](https://github.com/aio-proxy/aio-proxy/commit/ed5f7b78654738c9ca75178e2a060d3be628782b) Thanks [@baranwang](https://github.com/baranwang)! - Reject dashboard and admin requests carrying a foreign `Host` header while no dashboard password is
  set. A malicious page could previously rebind its own hostname to `127.0.0.1` and read every
  unauthenticated dashboard endpoint — including the provider editor's real API keys, headers and proxy
  credentials — because the loopback check trusts the browser's connection and the CSRF check ran only
  on writes.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks [@baranwang](https://github.com/baranwang)! - The provider editor now loads an unsaved model catalog with HTTP QUERY, and leftover kind-switch fields no longer block that request.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f25104e`](https://github.com/aio-proxy/aio-proxy/commit/f25104ea345daeb6f4ec07f5db8fe505e6ca5da6) Thanks [@baranwang](https://github.com/baranwang)! - Serve the provider editor its per-model `metadata.extend` unresolved. The edit view read the
  runtime config, where `extend` has already been merged into a flat copy of the model's models.dev
  entry, so opening a provider and saving it froze that copy into the config file and cut the model
  loose from the catalog it was tracking.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00) Thanks [@baranwang](https://github.com/baranwang)! - Give Dashboard OAuth loopback a styled completion page with a close button, and lock the plugin account form as soon as authorization starts.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1) Thanks [@baranwang](https://github.com/baranwang)! - Keep per-model metadata edits when saving an OAuth provider also re-authorizes it. The editor saves
  credentials and model metadata in one action; if the credential half required re-authorization, the
  login path rebuilt the provider entry from a patch that had no metadata field, so the metadata half
  of the save was silently discarded.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1bcb8d`](https://github.com/aio-proxy/aio-proxy/commit/b1bcb8dc140edff15f9534a8058dd038a2ee5717) Thanks [@baranwang](https://github.com/baranwang)! - Stop the Dashboard provider editor from deleting a hand-written `endpoints` list. Saving a provider from the editor used to drop its multi-protocol `endpoints` — the mutation body schema strips the field, so every save read as "the author deleted it" — and still answer 200. The list is now retained across a save, like `headers`, `metadata`, `proxy`, and `transforms` already were.

  Also in the editor: provider sections render as cards, and the identity section says up front that the ID is fixed once saved.

- [#191](https://github.com/aio-proxy/aio-proxy/pull/191) [`5be2d7c`](https://github.com/aio-proxy/aio-proxy/commit/5be2d7c0c1f2e9d844b33ce17b3fcefc78afd62e) Thanks [@baranwang](https://github.com/baranwang)! - Raw provider `422` responses now fall through to the next live candidate. Other `4xx` statuses still return immediately.

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
- Updated dependencies [[`f8947e7`](https://github.com/aio-proxy/aio-proxy/commit/f8947e78bc3ec3c7ccfa04e6c82606d7fa7989d9), [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8), [`6560946`](https://github.com/aio-proxy/aio-proxy/commit/65609463e6ede5798787c54614d716f2120e8148), [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`b71e13c`](https://github.com/aio-proxy/aio-proxy/commit/b71e13c8c991d3482a5446fdbd980ffc37a73ae1), [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5), [`21883d3`](https://github.com/aio-proxy/aio-proxy/commit/21883d33ab3ceb0081e123aaa985f42b4622f33d), [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00), [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e), [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1), [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e), [`cd6c5a3`](https://github.com/aio-proxy/aio-proxy/commit/cd6c5a3dd352ea22198d99345a6da3272510caca), [`798e1e2`](https://github.com/aio-proxy/aio-proxy/commit/798e1e2c230dd925f6a2df1741b52ee75c955852), [`cff1a38`](https://github.com/aio-proxy/aio-proxy/commit/cff1a38dda0e9c6e3c0be008580f8144f62ea725), [`35dacf3`](https://github.com/aio-proxy/aio-proxy/commit/35dacf3cfbd006598e0f1f7a4082f1f2399971c6), [`3cb3b81`](https://github.com/aio-proxy/aio-proxy/commit/3cb3b8135f109c0eb6ee9fab138e83ee32136ae0), [`165d4c1`](https://github.com/aio-proxy/aio-proxy/commit/165d4c1ef27a9519ff6a76387c1740643c038db1), [`e3ff7aa`](https://github.com/aio-proxy/aio-proxy/commit/e3ff7aa430a1a0d4429aa93e34f7e77836063c83), [`c73de2d`](https://github.com/aio-proxy/aio-proxy/commit/c73de2d1bd7c849a239d8e6a3fe139f7b6be4da6), [`a3cf9b5`](https://github.com/aio-proxy/aio-proxy/commit/a3cf9b55e0377cd8df102acf3fd9463ff5899207), [`6fb3a79`](https://github.com/aio-proxy/aio-proxy/commit/6fb3a799f2abd3ee6f4fd11b01a7040be226257f), [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca), [`ef90e90`](https://github.com/aio-proxy/aio-proxy/commit/ef90e90173a91816649d5c76053caf776b30e5dc), [`ecb6e0c`](https://github.com/aio-proxy/aio-proxy/commit/ecb6e0c74220388cc4dd51445e994b0cef0865a5), [`b1bcb8d`](https://github.com/aio-proxy/aio-proxy/commit/b1bcb8dc140edff15f9534a8058dd038a2ee5717), [`4c33182`](https://github.com/aio-proxy/aio-proxy/commit/4c33182e52533af7b613df3e67c82a3cba09cdb0), [`ea6b1c9`](https://github.com/aio-proxy/aio-proxy/commit/ea6b1c98ca4c9a9ba35b39de91df4b1b25165135), [`0a93cfd`](https://github.com/aio-proxy/aio-proxy/commit/0a93cfd509c919280fcfea53528e1a706edd36d5), [`e86cff1`](https://github.com/aio-proxy/aio-proxy/commit/e86cff1401ae66805faee73f5fa990a5249d52fb), [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b), [`c22a6ec`](https://github.com/aio-proxy/aio-proxy/commit/c22a6ec1e96f9b6e1b014f8601609565bef6ca23), [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250), [`f75367e`](https://github.com/aio-proxy/aio-proxy/commit/f75367ebf14dfd6a47c86c19f0851f27065c6876), [`476b0a8`](https://github.com/aio-proxy/aio-proxy/commit/476b0a8133f3c2a46e710e682006bf8074170bb5), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309)]:
  - @aio-proxy/i18n@0.9.0
  - @aio-proxy/types@0.9.0
  - @aio-proxy/plugin-sdk@0.9.0
  - @aio-proxy/core@0.9.0
  - @aio-proxy/logger@0.9.0

## 0.8.0

### Minor Changes

- [#179](https://github.com/aio-proxy/aio-proxy/pull/179) [`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203) Thanks [@baranwang](https://github.com/baranwang)! - core: select alias targets from effort, thinking, and speed dimensions. A Gemini 1D variant key `off`/`OFF` no longer matches `thinkingLevel: "OFF"`; replace it with `{ "when": { "thinking": false }, "model": "…" }` (or drop the row and use the alias `model`) — shipped Antigravity defaults are unaffected.

- [#177](https://github.com/aio-proxy/aio-proxy/pull/177) [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705) Thanks [@baranwang](https://github.com/baranwang)! - API providers can declare multi-protocol `endpoints` (per-protocol or shared AI SDK-style base URLs). Raw passthrough now matches any natively supported protocol, Anthropic endpoints accept `auth: "bearer"`, and cross-protocol conversion keeps targeting the primary endpoint.

- [#176](https://github.com/aio-proxy/aio-proxy/pull/176) [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9) Thanks [@baranwang](https://github.com/baranwang)! - Allow authenticated remote model API access with labeled caller API keys.

### Patch Changes

- Updated dependencies [[`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203), [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705), [`4f73aa6`](https://github.com/aio-proxy/aio-proxy/commit/4f73aa69236d458a8ad8c811287fad03d674ad43), [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9)]:
  - @aio-proxy/core@0.8.0
  - @aio-proxy/types@0.8.0
  - @aio-proxy/i18n@0.8.0
  - @aio-proxy/logger@0.8.0
  - @aio-proxy/plugin-sdk@0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Accept Anthropic requests that combine disabled thinking with `output_config.effort`. Keep slow models.dev refreshes off the startup path. Resolve model metadata per source (config overrides catalogs). Fix overview day ranges to read `usage_daily` instead of pruned spans.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

### Patch Changes

- Updated dependencies [[`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5)]:
  - @aio-proxy/core@0.7.0
  - @aio-proxy/types@0.7.0
  - @aio-proxy/i18n@0.7.0
  - @aio-proxy/plugin-sdk@0.7.0
  - @aio-proxy/logger@0.7.0

## 0.6.4

### Patch Changes

- Updated dependencies [[`08a579c`](https://github.com/aio-proxy/aio-proxy/commit/08a579cad9b5192820cd42f2cbb6ba18e0bc9e18)]:
  - @aio-proxy/core@0.6.4
  - @aio-proxy/i18n@0.6.4
  - @aio-proxy/logger@0.6.4
  - @aio-proxy/plugin-sdk@0.6.4
  - @aio-proxy/types@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies [[`ba2aeae`](https://github.com/aio-proxy/aio-proxy/commit/ba2aeae4dfae3d932e2a22ac97d816b74d32a5ca)]:
  - @aio-proxy/core@0.6.3
  - @aio-proxy/i18n@0.6.3
  - @aio-proxy/logger@0.6.3
  - @aio-proxy/plugin-sdk@0.6.3
  - @aio-proxy/types@0.6.3

## 0.6.2

### Patch Changes

- [#155](https://github.com/aio-proxy/aio-proxy/pull/155) [`04ed2df`](https://github.com/aio-proxy/aio-proxy/commit/04ed2dff458272169af2bf04c36cfc09372f6557) Thanks [@baranwang](https://github.com/baranwang)! - Fix empty Codex model picker for gpt-5.6 aliases. The `/v1/models` Case A passthrough now guarantees the Codex client reads a non-empty prompt: it resolves one non-empty instruction text (existing `model_messages.instructions_template`, else `base_instructions`, else the bundled template) and writes it back to `base_instructions`, also replacing a present-but-empty `instructions_template` (which the client prefers verbatim). Codex client 0.146.0 treats `base_instructions` as required and prefers `instructions_template` whenever present, so upstream rows that omit `base_instructions` (gpt-5.6-sol/terra/luna) previously failed catalog deserialization and emptied the picker.
- Updated dependencies [[`52cb5ce`](https://github.com/aio-proxy/aio-proxy/commit/52cb5cef04cd1532dac2a773ee61b4fefd72d54d)]:
  - @aio-proxy/core@0.6.2
  - @aio-proxy/i18n@0.6.2
  - @aio-proxy/logger@0.6.2
  - @aio-proxy/plugin-sdk@0.6.2
  - @aio-proxy/types@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies [[`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7), [`5ab65bf`](https://github.com/aio-proxy/aio-proxy/commit/5ab65bf7ef8dd5b74e2589df30b6da7342436cb6)]:
  - @aio-proxy/i18n@0.6.1
  - @aio-proxy/core@0.6.1
  - @aio-proxy/logger@0.6.1
  - @aio-proxy/plugin-sdk@0.6.1
  - @aio-proxy/types@0.6.1

## 0.6.0

### Minor Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`963e395`](https://github.com/aio-proxy/aio-proxy/commit/963e3951a64644441a36b0ae4c9b93d644444d18) Thanks [@baranwang](https://github.com/baranwang)! - extend: resolve per-model `metadata.extend` into effective merged metadata — inherit a models.dev catalog entry as a base layer, deep-merged under your explicit fields, so cost accounting and model resolution both see the inherited values.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085) Thanks [@baranwang](https://github.com/baranwang)! - feat: per-provider model metadata & cost overrides

  Providers can now declare a `metadata` map keyed by upstream model id to override client-facing model metadata (name, description, token limits, capabilities) and cost accounting. User config wins over models.dev auto-discovery. Billing uses the actual hit channel's configured `cost`, and each usage row records its `priceSource` (`config`/`models-dev`/`default`). A new `router.modelContextAggregation` (`min` default / `max`) reconciles the context window when multiple providers expose the same public model.

- [#136](https://github.com/aio-proxy/aio-proxy/pull/136) [`465fa49`](https://github.com/aio-proxy/aio-proxy/commit/465fa494bc0446e11b68b0922b29ba2c15880c37) Thanks [@baranwang](https://github.com/baranwang)! - Make `count_tokens` traces distinguish upstream counts from the local estimate

  Previously a `count_tokens` request answered by the local estimator was only
  signalled by an `x-aio-proxy-token-count-estimated: true` response header, and
  candidates that were passed over before their count capability ran (no token
  count capability, unsupported image input, or a missing provider tool) left no
  span at all. A trace answered without any upstream count was therefore
  indistinguishable from an upstream success.

  The response header is removed. The local-estimate fallback now records an
  `aio_proxy.token_count` span tagged `aio_proxy.token_count.source=local_estimate`,
  and each passed-over candidate records an `aio_proxy.token_count.candidate_skipped`
  span carrying the provider id and a skip reason (`no_capability`,
  `image_unsupported`, or `missing_tool`). The observability signal moves from the
  client response into the trace, where the whole candidate loop is now visible.

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

- Updated dependencies [[`963e395`](https://github.com/aio-proxy/aio-proxy/commit/963e3951a64644441a36b0ae4c9b93d644444d18), [`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee), [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085), [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd)]:
  - @aio-proxy/core@0.6.0
  - @aio-proxy/types@0.6.0
  - @aio-proxy/i18n@0.6.0
  - @aio-proxy/logger@0.6.0
  - @aio-proxy/plugin-sdk@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95)]:
  - @aio-proxy/i18n@0.5.2
  - @aio-proxy/core@0.5.2
  - @aio-proxy/logger@0.5.2
  - @aio-proxy/plugin-sdk@0.5.2
  - @aio-proxy/types@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [[`1a525e8`](https://github.com/aio-proxy/aio-proxy/commit/1a525e861a0ef77668c3321f75171bb9e2880e9f)]:
  - @aio-proxy/core@0.5.1
  - @aio-proxy/i18n@0.5.1
  - @aio-proxy/logger@0.5.1
  - @aio-proxy/plugin-sdk@0.5.1
  - @aio-proxy/types@0.5.1

## 0.5.0

### Minor Changes

- [#125](https://github.com/aio-proxy/aio-proxy/pull/125) [`7856451`](https://github.com/aio-proxy/aio-proxy/commit/7856451f2434912a619e1c72aca44a1ccd1aaf43) Thanks [@baranwang](https://github.com/baranwang)! - server: return real upstream token counts for `/v1/messages/count_tokens` when a same-protocol raw provider is configured, and replace the `bytes/64` fallback with a character-class-weighted estimator

### Patch Changes

- Updated dependencies [[`c6ecfc0`](https://github.com/aio-proxy/aio-proxy/commit/c6ecfc0dc81e6cb0f0c5cd7b27b79f32cfb0955c), [`d95834a`](https://github.com/aio-proxy/aio-proxy/commit/d95834ad85ea0352f5c389497ea008c687a80d64)]:
  - @aio-proxy/core@0.5.0
  - @aio-proxy/i18n@0.5.0
  - @aio-proxy/logger@0.5.0
  - @aio-proxy/plugin-sdk@0.5.0
  - @aio-proxy/types@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282)]:
  - @aio-proxy/i18n@0.4.0
  - @aio-proxy/core@0.4.0
  - @aio-proxy/logger@0.4.0
  - @aio-proxy/plugin-sdk@0.4.0
  - @aio-proxy/types@0.4.0

## 0.3.0

### Patch Changes

- [#116](https://github.com/aio-proxy/aio-proxy/pull/116) [`5a6deb7`](https://github.com/aio-proxy/aio-proxy/commit/5a6deb759ed7c748369db2dee814d2686dcd2e8d) Thanks [@baranwang](https://github.com/baranwang)! - server: end streamed request traces at the upstream terminal frame instead of socket EOF, so traces no longer stay "running" after the model finished. Raw passthrough resolves completion at the terminal frame across all four protocols and the AI SDK path at the finish part, without ending the client stream. Adds a configurable upstream idle timeout (300s default) that cancels a stalled upstream and errors the client stream rather than closing it cleanly. OpenAI-compatible passthrough treats [DONE] (not finish_reason) as terminal so trailing include_usage accounting is still captured; session commit stays gated on true stream EOF.
- Updated dependencies [[`38960fd`](https://github.com/aio-proxy/aio-proxy/commit/38960fd9fca94d3e38cb5277a5eb928a3962d96a)]:
  - @aio-proxy/core@0.3.0
  - @aio-proxy/i18n@0.3.0
  - @aio-proxy/logger@0.3.0
  - @aio-proxy/plugin-sdk@0.3.0
  - @aio-proxy/types@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/core@0.2.1
  - @aio-proxy/i18n@0.2.1
  - @aio-proxy/logger@0.2.1
  - @aio-proxy/plugin-sdk@0.2.1
  - @aio-proxy/types@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/core@0.2.0
  - @aio-proxy/i18n@0.2.0
  - @aio-proxy/logger@0.2.0
  - @aio-proxy/plugin-sdk@0.2.0
  - @aio-proxy/types@0.2.0
