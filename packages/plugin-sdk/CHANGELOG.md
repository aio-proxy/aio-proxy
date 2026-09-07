# @aio-proxy/plugin-sdk

## 0.20.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.20.1
  - @aio-proxy/types@0.20.1

## 0.20.0

### Minor Changes

- [#298](https://github.com/aio-proxy/aio-proxy/pull/298) [`13a6c91`](https://github.com/aio-proxy/aio-proxy/commit/13a6c9153739049dab5443dd3ac7d570f7e80690) Thanks [@baranwang](https://github.com/baranwang)! - Serve the Codex Live / Realtime endpoint family as signaling passthrough. `POST /v1/live`,
  `POST /v1/realtime` and `POST /v1/realtime/calls` forward an SDP offer to the ChatGPT Codex realtime
  upstream and answer with its SDP; `GET /v1/live/:call_id`, `GET /v1/realtime/calls/:call_id` and
  `GET /v1/realtime` relay the sideband WebSocket, with provider selection, per-model overrides and
  failover matching ordinary routing. Plugins can serve realtime through a new optional `realtime`
  runtime capability (`models`, `fetch`, `dial`). WebRTC media stays a direct client-to-upstream
  connection, and endpoints the ChatGPT upstream has no equivalent for answer `501`. An embedder that
  builds its own `Bun.serve` must now pass `@aio-proxy/server`'s exported `websocket` handler.

- [#301](https://github.com/aio-proxy/aio-proxy/pull/301) [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0) Thanks [@baranwang](https://github.com/baranwang)! - Add the OpenAI Audio inbound protocol. `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, and `POST /v1/audio/translations` now route through aio-proxy with the same candidate ordering, failover, and usage recording as every other inbound protocol. Providers whose protocol is `openai-audio` serve these ports by raw passthrough, preserving the client's multipart body and `response_format` — the one exception is a form whose `model` field is not spelled exactly once as plain `model` — a repeat, or the bracketed `model[]` the parser treats as equivalent — which is rebuilt with a single resolved `model` so an upstream parser that keeps the first repeat, or ignores the bracketed name entirely, cannot run a different model than the one aio-proxy selected and billed. Other providers are reached by converting the request into a speech or transcription model call. Conversion is granted per direction from the `ai-sdk` package: `@ai-sdk/openai` and `@ai-sdk/xai` serve both directions, `@ai-sdk/google` speech only, `@ai-sdk/groq` transcription only, and the remaining bundled packages implement neither, so they serve audio through same-protocol raw passthrough alone. An `api` Provider whose endpoint protocol is `openai-response` also gains both directions through the same OpenAI bridge that already backs its language traffic, so it converts instead of answering `501`. Omitted `model` defaults to `tts-1` for speech and `whisper-1` for transcriptions and translations, so a non-catalog Audio Provider must make those ids routable for the default to resolve. `/v1/audio/translations` is raw passthrough only and returns `501 unsupported_feature` on the convert path, because the AI SDK's transcription interface has no translation mode; convert also refuses `stream_format`, `chunking_strategy`, `include`, `stream`, and any `response_format` other than `json`, `text`, or `verbose_json` the same way — raw passthrough still forwards `srt`, `vtt`, and an unrecognized format to upstream, but the convert path cannot render one and says so instead of answering a plain `{ text }` body. `srt` and `vtt` are refused on the convert path specifically because they render from segment timings alone and the AI SDK's `transcribe()` cannot demand a segment-bearing upstream format, so a provider answering its default JSON would come back as an empty subtitle file. `verbose_json` is served when the upstream result actually arrived in the verbose shape — its measured `duration` is the signal, so silent audio that legitimately transcribes to an empty text with no segments still renders as a normal verbose body — and returns the same `501 unsupported_feature` when the transport answered in the plain shape instead, rather than dressing a plain transcript up as a verbose envelope with `segments: []`. On the convert path a transcription's `language`, `prompt`, and `temperature` are forwarded to the upstream provider rather than dropped; `timestamp_granularities` returns `501 unsupported_feature` there unless it asks for `segment` alone together with `response_format=verbose_json`, the only combination this path can actually render — `word` granularity is never renderable because the AI SDK's transcription result carries segment timings only, and any granularity asked for alongside `json` or `text` would be billed upstream and then discarded by a body that carries the transcript text alone. Raw passthrough still forwards every granularity for upstream to answer or reject. On the convert path a speech response whose bytes the AI SDK could not sniff is named by the requested `response_format` rather than by the SDK's `audio/mp3` fallback, so `pcm` answers `audio/pcm` and `aac` answers `audio/aac` instead of advertising headerless bytes as MP3; a format the SDK did recognize still wins, and an unrecognized one still normalizes to `audio/mpeg`. On the convert path an upload whose declared type names a format OpenAI accepts — including aliases such as `audio/x-mp3`, `audio/mpga`, `audio/wave`, and `audio/m4a`, plus `video/mp4` and `video/webm`, the dual-purpose containers — is normalized to the canonical media type and sent as declared instead of being re-sniffed from its bytes; any other type, including a generic `application/octet-stream`, is ignored so the bytes decide, and when even the filename is the only signal left, an `.m4a`, `.mp4`, or `.webm` extension names the container. Without this an m4a upload reaches upstream labelled `audio.wav`, because the AI SDK's sniffer cannot see MP4's `ftyp` box and derives the upload filename from the media type. An `openai-audio` Provider is probed with a capability-agnostic `GET /v1/models`, since a speech-only or transcription-only model rejects the other direction's request — a green probe means the endpoint is reachable and the key was accepted (a `401` is FAIL), not that the configured model supports the direction you will call, and an Audio gateway with no `/v1/models` route probes FAIL even when it works. `RawResolver` input for audio carries `capability` (`'speech'` or `'transcription'`) and the inbound `requestPath`, so a plugin's raw resolver can tell speech from transcription and `/v1/audio/translations` from `/v1/audio/transcriptions`. Multipart field coercion is now shared between the Images and Audio ingress paths, so both read scalar form fields the same way. Audio usage is recorded only when upstream reports it — token counts are never estimated from audio duration.

- [#308](https://github.com/aio-proxy/aio-proxy/pull/308) [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3) Thanks [@baranwang](https://github.com/baranwang)! - Subscription quota bars now mark where an even burn would have left the allowance by now, turning
  red when the window is being spent faster than that and drawing nothing while it tracks even. The
  marker appears wherever the provider reports how long the window lasts, which the bundled OAuth
  plugins now do; plugins can opt in through the new optional `OAuthQuotaItem.windowMinutes`. The
  reading is also spoken by the bar's accessible value text.

### Patch Changes

- Updated dependencies [[`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a), [`84b206c`](https://github.com/aio-proxy/aio-proxy/commit/84b206c1d2f296748d2b86cedf0ef97c2b65d8e2), [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0)]:
  - @aio-proxy/types@0.20.0
  - @aio-proxy/shared@0.20.0

## 0.19.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.19.2
  - @aio-proxy/types@0.19.2

## 0.19.1

### Patch Changes

- [#284](https://github.com/aio-proxy/aio-proxy/pull/284) [`80f8b9d`](https://github.com/aio-proxy/aio-proxy/commit/80f8b9d10eef15214fc3f55342ccf097fc00b6ef) Thanks [@baranwang](https://github.com/baranwang)! - Refresh dependencies across the workspace, including `eventsource-parser` 4 for SSE parsing, `hono` 4.13.7 for the proxy and Dashboard routes, and `jose` 6.2.12 for token handling. Behavior is unchanged.
- Updated dependencies []:
  - @aio-proxy/shared@0.19.1
  - @aio-proxy/types@0.19.1

## 0.19.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.19.0
  - @aio-proxy/types@0.19.0

## 0.18.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.18.1
  - @aio-proxy/types@0.18.1

## 0.18.0

### Patch Changes

- [#274](https://github.com/aio-proxy/aio-proxy/pull/274) [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664) Thanks [@baranwang](https://github.com/baranwang)! - plugin-sdk: document and enforce the OAuth quota reset contract — report `resetCredits` only alongside a `reset` implementation, and treat every `reset` call as a new intentional redemption rather than a retry of the last one. A snapshot from an adapter with no `reset` now has its inventory dropped, so a plugin written against the older read-only contract cannot advertise a redemption it would refuse. Absence and zero are also distinct answers now: `{ availableCount: 0 }` reports an inventory read as empty, while omitting the field reports one that could not be read, and a redemption against the latter fails as retryable instead of telling the user their credit is spent.
- Updated dependencies [[`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3)]:
  - @aio-proxy/types@0.18.0
  - @aio-proxy/shared@0.18.0

## 0.17.0

### Minor Changes

- [#260](https://github.com/aio-proxy/aio-proxy/pull/260) [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f) Thanks [@baranwang](https://github.com/baranwang)! - Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

  OAuth Providers whose plugin supports it gain a "Refresh Credential" entry in the card's ⋯ menu that
  forces an upstream token exchange even when the current credential has not expired, clears a stale
  `CREDENTIAL_REFRESH_FAILED` diagnostic on success, and reloads the Provider list so the account label
  and expiry reflect the new credential. A refresh the plugin reports as permanently failed — a revoked
  refresh token, for example — records the same reauthentication diagnostic the automatic refresh path
  does, so the card tells you to re-login instead of continuing to report the Provider as ready. A
  transient failure leaves the Provider untouched. The entry is hidden — not
  disabled — for plugins without the capability, which Provider summaries now report as
  `canRefreshCredential`. All six bundled OAuth plugins support it.

  `OAuthAdapter` gains an optional `refreshCredential`, exported alongside the new
  `OAuthCredentialRefreshContext` and `OAuthCredentialRefreshResult` types. It is a pure exchange: the
  framework owns the lease, single-flight dedupe, revision compare-and-swap, and persistence, and calls
  the adapter unconditionally rather than only past expiry. Adapter registration previously dropped
  fields outside its closed list, so an adapter declaring `refreshCredential` would have lost it.

### Patch Changes

- Updated dependencies [[`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f), [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16), [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2), [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd)]:
  - @aio-proxy/types@0.17.0
  - @aio-proxy/shared@0.17.0

## 0.16.0

### Patch Changes

- [#252](https://github.com/aio-proxy/aio-proxy/pull/252) [`142cc1b`](https://github.com/aio-proxy/aio-proxy/commit/142cc1b419b0109585a53f020343d0eb72b6673f) Thanks [@wqsworks](https://github.com/wqsworks)! - core: terminate converted OpenAI Responses stream failures with `response.failed` and normalize cumulative OpenAI-compatible tool argument snapshots.
- Updated dependencies []:
  - @aio-proxy/shared@0.16.0
  - @aio-proxy/types@0.16.0

## 0.15.0

### Patch Changes

- Updated dependencies [[`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91)]:
  - @aio-proxy/types@0.15.0
  - @aio-proxy/shared@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/shared@0.14.0
  - @aio-proxy/types@0.14.0

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
