# @aio-proxy/server

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
