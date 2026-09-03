# @aio-proxy/plugin-sdk

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

### Patch Changes

- [#238](https://github.com/aio-proxy/aio-proxy/pull/238) [`99755b5`](https://github.com/aio-proxy/aio-proxy/commit/99755b58b7492f9da4161ac429325dd319ba48f8) Thanks [@baranwang](https://github.com/baranwang)! - core: preserve stable session affinity across supported language protocols and native Gemini Interactions continuations.
- Updated dependencies [[`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d)]:
  - @aio-proxy/types@0.13.0
  - @aio-proxy/shared@0.13.0

## 0.12.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.12.3
  - @aio-proxy/types@0.12.3

## 0.12.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.12.2
  - @aio-proxy/types@0.12.2

## 0.12.1

### Patch Changes

- Updated dependencies [[`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6)]:
  - @aio-proxy/types@0.12.1
  - @aio-proxy/shared@0.12.1

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks [@baranwang](https://github.com/baranwang)! - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`. The removed `providers.<id>.metadata` field is silently ignored, and metadata keys no longer create routes; expose models through `providers.<id>.models` or `alias`. Metadata editing now lives in the Dashboard routing drawer instead of the Provider editor.

  Rename the plugin SDK's free-form `ModelDescriptor.metadata`, `ModelCatalog.metadata`, and raw-resolver `metadata` input to `extra`, and add typed `ModelDescriptor.modelMetadata` for host-consumed model metadata. Publish `@aio-proxy/types` as the SDK metadata type source.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks [@baranwang](https://github.com/baranwang)! - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
- Updated dependencies [[`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2), [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca)]:
  - @aio-proxy/types@0.12.0
  - @aio-proxy/shared@0.12.0

## 0.11.2

## 0.11.1

## 0.11.0

### Minor Changes

- [#215](https://github.com/aio-proxy/aio-proxy/pull/215) [`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13) Thanks [@baranwang](https://github.com/baranwang)! - Add Gemini Interactions as an inbound protocol at `POST /v1beta/interactions`.

- [#212](https://github.com/aio-proxy/aio-proxy/pull/212) [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b) Thanks [@baranwang](https://github.com/baranwang)! - openai: add Completions and Responses compact ports

  `POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline. Remaining official Responses resource operations return a protocol-shaped 501 instead of a generic 404. ChatGPT OAuth providers forward compact to the Codex compaction endpoint. GitHub Copilot and Kimi Code providers decline endpoints they do not serve so the same candidate can convert through its language model, or a later provider can take the request. Legacy Completions streams omit usage unless the client can opt in.

- [#213](https://github.com/aio-proxy/aio-proxy/pull/213) [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608) Thanks [@baranwang](https://github.com/baranwang)! - Add OpenAI Images inbound (`POST /v1/images/generations` and `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert. Blank JSON `model` and multipart missing/empty/whitespace `model` look up `gpt-image-2` (CPA-compatible); multipart literal `null` is the explicit id `"null"`. Raw/convert use the resolved candidate id. Alias-only API providers seed every alias target so language/image inbound can route. Image-capable API and ai-sdk providers attach convert (`provider.image`) when a V4 `imageModel` can be built; primary `openai-image` stays raw+image with no language transport. Edits accept official-max JSON (`357_564_416`) and multipart (`851_048_559`) envelopes — `Bun.serve` `maxRequestBodySize` matches the multipart encoded limit so those bodies reach the adapter. Convert egress `usage` is official Images snake_case (`input_tokens`, `output_tokens`, `total_tokens`, `input_tokens_details`). Convert copies present image options onto both `openai` and `openaiCompatible` providerOptions so `@ai-sdk/openai-compatible` transports receive `quality`, `output_format`, and `output_compression`. Multipart edits parse is abort-aware and idle-bounded per body read so stalled or compressed uploads cannot pin the process-wide parse slots. Same-id JSON returns a byte-preserving clone. Explicit unchanged multipart raw replays from a size-capped disk spool (`0600`) so parse does not tee an official-max body in memory; compressed edits decode as a bounded stream (decoder output is drained with a 64 KiB pending cap so a highly compressible chunk cannot stall a parse slot or materialize the full expansion before the parser reads); the pipeline unlinks the spool after fallback attempts finish. Fallback candidates still see the original body, boundary, and integrity headers. Defaulted or aliased multipart still rebuilds FormData. Image-primary providers with a language extra endpoint keep finite ids chat-capable and materialize `provider.model` from that endpoint so inbound Responses/chat convert instead of 501. Catalog embedding-only ids stay out of language dispatch. Image raw resolve passes the inbound path so generation-versus-edit resolvers see `/v1/images/generations` or `/v1/images/edits`. Multipart body search only ends a part when `\r\n--<boundary>` is followed by `--` or CRLF, so in-file boundary text is not a delimiter. The initial boundary scan skips preamble text that contains `--<boundary>` without a line start and `--`/CRLF suffix, and keeps enough prefix bytes across chunk splits — including partial-boundary overlap — to validate that line position. Multipart parse counts through EOF so a MIME epilogue cannot bypass the official-max encoded limit or the 1 MiB non-file budget. Rewritten Images raw (defaulted/aliased JSON or any multipart rebuild) drops `Content-MD5`, `Digest`, and `Content-Digest` so upstreams do not verify the client's original body. Convert returns `501 unsupported_feature` for `image_url` or `file_id`, and enforces official mask size/format/alpha on uploaded bytes.

- [#214](https://github.com/aio-proxy/aio-proxy/pull/214) [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612) Thanks [@baranwang](https://github.com/baranwang)! - Add inbound OpenAI Embeddings and Gemini embed/batch embed through same-protocol raw, embedding convert, and fallback.

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks [@baranwang](https://github.com/baranwang)! - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

## 0.9.1

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks [@baranwang](https://github.com/baranwang)! - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

  Skip same-wire aliases that only restate one model at every effort. When a family also has a colliding `-tiered` wire, default the alias there and send `xhigh` to it instead of hiding that id. Merge leftover `-thinking` siblings onto `when.thinking` even if the picker omitted them.

  Accept object-form `alias.variants` on read, then store only `{ when, model, preserve }` rows. Unpreserved variant targets stay hidden from the client model list.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks [@baranwang](https://github.com/baranwang)! - Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The plugin SDK descriptor contract, brand, and host accepted version are restored to v1; v2 descriptors are rejected. The xAI artifact smoke gate now follows plugin API v1.

### Patch Changes

- [#188](https://github.com/aio-proxy/aio-proxy/pull/188) [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc) Thanks [@baranwang](https://github.com/baranwang)! - core: pin the bundled Bun runtime to 1.4.0 and restore streamed request bodies through HTTP proxies. Bun 1.4.0 ships the `fetch` + `proxy` `ReadableStream` body fix, so `createProxyFetch` no longer buffers the request. Plugin runtime compatibility is now Bun `>=1.4.0`. Compiled macOS binaries are ad-hoc re-signed after `bun build --compile` so they launch on macOS 27. Release runs on macOS so that signature is applied when the CLI is actually published.

- [#184](https://github.com/aio-proxy/aio-proxy/pull/184) [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309) Thanks [@baranwang](https://github.com/baranwang)! - Cursor first-login now writes family aliases from AvailableModels, so clients can request names like `claude-sonnet-4-6` / `grok-4.6` and match thinking, effort, and speed onto the live wire slug.

## 0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

## 0.6.4

## 0.6.3

## 0.6.2

## 0.6.1

## 0.6.0

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.1

## 0.2.0
