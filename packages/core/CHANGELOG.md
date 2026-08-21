# @aio-proxy/core

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks [@baranwang](https://github.com/baranwang)! - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks [@baranwang](https://github.com/baranwang)! - Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The plugin SDK descriptor contract, brand, and host accepted version are restored to v1; v2 descriptors are rejected. The xAI artifact smoke gate now follows plugin API v1.

### Patch Changes

- [#188](https://github.com/aio-proxy/aio-proxy/pull/188) [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc) Thanks [@baranwang](https://github.com/baranwang)! - core: pin the bundled Bun runtime to 1.4.0 and restore streamed request bodies through HTTP proxies. Bun 1.4.0 ships the `fetch` + `proxy` `ReadableStream` body fix, so `createProxyFetch` no longer buffers the request. Plugin runtime compatibility is now Bun `>=1.4.0`. Compiled macOS binaries are ad-hoc re-signed after `bun build --compile` so they launch on macOS 27. Release runs on macOS so that signature is applied when the CLI is actually published.
- Updated dependencies [[`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309)]:
  - @aio-proxy/plugin-google-antigravity@0.9.0
  - @aio-proxy/types@0.9.0
  - @aio-proxy/i18n@0.9.0
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
