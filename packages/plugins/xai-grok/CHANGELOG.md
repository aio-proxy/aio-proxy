# @aio-proxy/plugin-xai-grok

## 0.10.0

### Minor Changes

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks [@baranwang](https://github.com/baranwang)! - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

### Patch Changes

- Updated dependencies [[`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402)]:
  - @aio-proxy/plugin-sdk@0.10.0

## 0.9.1

### Patch Changes

- [#197](https://github.com/aio-proxy/aio-proxy/pull/197) [`c9fe40d`](https://github.com/aio-proxy/aio-proxy/commit/c9fe40dfb7b1ad7fbadb94f4c9ce64ced43dc294) Thanks [@baranwang](https://github.com/baranwang)! - Compile OpenAI Responses custom tools to Grok-compatible function tools for xAI OAuth providers while preserving custom tool responses for clients.
- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.9.1

## 0.9.0

### Minor Changes

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks [@baranwang](https://github.com/baranwang)! - Add managed OpenCode, Pi, and oh-my-pi Agent integrations. Configure them with `aio-proxy agent configure` (floors: OpenCode 1.17.10, Pi 0.84.2, oh-my-pi 17.3.7; login with `opencode auth login --provider aio-proxy` or `/login aio-proxy`). `aio-proxy upgrade` refreshes managed adapters; reload or restart the Agent after configure or upgrade. Exact string KPI values no longer lose visible precision. The plugin SDK descriptor contract, brand, and host accepted version are restored to v1; v2 descriptors are rejected. The xAI artifact smoke gate now follows plugin API v1.

### Patch Changes

- [#192](https://github.com/aio-proxy/aio-proxy/pull/192) [`29a90c2`](https://github.com/aio-proxy/aio-proxy/commit/29a90c24c45d4e00ada1960ca4cfd492344f6535) Thanks [@baranwang](https://github.com/baranwang)! - Grok OAuth now sends current Grok CLI identity headers and strips Codex Desktop Responses fields that `cli-chat-proxy.grok.com` rejects or hangs on.
- Updated dependencies [[`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309)]:
  - @aio-proxy/plugin-sdk@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks [@baranwang](https://github.com/baranwang)! - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

### Patch Changes

- Updated dependencies [[`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5)]:
  - @aio-proxy/plugin-sdk@0.7.0

## 0.6.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.2

## 0.6.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/plugin-sdk@0.2.0
