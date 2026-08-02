# @aio-proxy/core

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
