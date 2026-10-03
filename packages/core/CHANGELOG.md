# @aio-proxy/core

## 0.39.0

### Minor Changes

- [#486](https://github.com/aio-proxy/aio-proxy/pull/486) [`a59559d`](https://github.com/aio-proxy/aio-proxy/commit/a59559db8ba07d62f1f2b8dab50a77b5fba272b8) Thanks @baranwang - ChatGPT and GitHub Copilot Providers can use the sign-in Codex or Copilot already keeps on this machine instead of a browser login; aio-proxy keeps Codex signed in when it refreshes, and removing the Provider never signs the tool out.

- [#483](https://github.com/aio-proxy/aio-proxy/pull/483) [`4a26f10`](https://github.com/aio-proxy/aio-proxy/commit/4a26f10bde2ee22dccd0312c484327bc92bf1578) Thanks @baranwang - A Kimi Code, Muse Code, ChatGPT, or Cursor subscription whose quota window is known to be exhausted is now skipped for the models that window covers until it resets, instead of being attempted and failing on every request. Quota that is unknown or older than 10 minutes never skips a Provider. When every candidate is exhausted or cooling down, the client gets a 429 with `Retry-After` set to the earliest reset, and the request trace lists the skipped Providers and why.

- [#483](https://github.com/aio-proxy/aio-proxy/pull/483) [`13ff41d`](https://github.com/aio-proxy/aio-proxy/commit/13ff41dba0d21ef4ec79589e0598d1973fb72f64) Thanks @baranwang - New opt-in `router.selection: quota-reset` (also a switch on the Dashboard Routing page): within each Provider priority tier, the subscription whose quota allowance expires soonest is tried first instead of the weighted draw, so allowance is not left to lapse on one subscription while another is drained. Session affinity still takes precedence, Providers without quota data follow in their weighted order, and the routing list and model details show measured traffic shares without deviation warnings. Nothing changes while the setting stays `weighted`.

- [#484](https://github.com/aio-proxy/aio-proxy/pull/484) [`b2e7941`](https://github.com/aio-proxy/aio-proxy/commit/b2e7941313846cea0c6e179f64c73cc137565e13) Thanks @baranwang - API and discoverable AI SDK Providers can set `syncModels: true` to follow upstream model lists without editing the config: models refresh every hour or on demand in the Dashboard, upstream outages and empty responses keep the last good list, and `excludedModels` hides exact model IDs while aliases can still target them. The Dashboard supports switching between manual and synced models, hiding models, and viewing the last refreshed time; hand-written `models` lists work as before.

### Patch Changes

- Updated dependencies [[`94024af`](https://github.com/aio-proxy/aio-proxy/commit/94024af667f4b691cef234a3f305d6561c5a9192), [`a4d8780`](https://github.com/aio-proxy/aio-proxy/commit/a4d8780eeb767e00a56c151f657f888021ab69f5), [`a59559d`](https://github.com/aio-proxy/aio-proxy/commit/a59559db8ba07d62f1f2b8dab50a77b5fba272b8), [`2763925`](https://github.com/aio-proxy/aio-proxy/commit/27639251609ad47a3d5265815c2a27bd7bc0abb9), [`dd47aa2`](https://github.com/aio-proxy/aio-proxy/commit/dd47aa2333b53934df5b65deec9d72894c629bfa), [`4a26f10`](https://github.com/aio-proxy/aio-proxy/commit/4a26f10bde2ee22dccd0312c484327bc92bf1578), [`946073c`](https://github.com/aio-proxy/aio-proxy/commit/946073caf8219dd6309498aba893b77993193ef1), [`13ff41d`](https://github.com/aio-proxy/aio-proxy/commit/13ff41dba0d21ef4ec79589e0598d1973fb72f64), [`b2e7941`](https://github.com/aio-proxy/aio-proxy/commit/b2e7941313846cea0c6e179f64c73cc137565e13)]:
  - @aio-proxy/types@0.39.0
  - @aio-proxy/i18n@0.39.0
  - @aio-proxy/plugin-openai-chatgpt@0.39.0
  - @aio-proxy/plugin-github-copilot@0.39.0
  - @aio-proxy/plugin-sdk@0.39.0
  - @aio-proxy/plugin-kimi-code@0.39.0
  - @aio-proxy/plugin-muse-code@0.39.0
  - @aio-proxy/plugin-cursor@0.39.0
  - @aio-proxy/logger@0.39.0
  - @aio-proxy/plugin-claude-code@0.39.0
  - @aio-proxy/plugin-google-antigravity@0.39.0
  - @aio-proxy/plugin-opencode-go@0.39.0
  - @aio-proxy/plugin-openrouter@0.39.0
  - @aio-proxy/plugin-xai-grok@0.39.0
  - @aio-proxy/shared@0.39.0

## 0.38.0

### Patch Changes

- [#468](https://github.com/aio-proxy/aio-proxy/pull/468) [`24d77d0`](https://github.com/aio-proxy/aio-proxy/commit/24d77d05fd4e27bfa918a568d904e71ce3593f3b) Thanks @baranwang - Preserve transport timings, retry failure reasons, and response attribution for each upstream HTTP send. Trace details now show send counts and indices, so retries with multiple responses no longer appear to be missing timing data.
- Updated dependencies [[`24d77d0`](https://github.com/aio-proxy/aio-proxy/commit/24d77d05fd4e27bfa918a568d904e71ce3593f3b)]:
  - @aio-proxy/plugin-sdk@0.38.0
  - @aio-proxy/shared@0.38.0
  - @aio-proxy/i18n@0.38.0
  - @aio-proxy/logger@0.38.0
  - @aio-proxy/plugin-claude-code@0.38.0
  - @aio-proxy/plugin-cursor@0.38.0
  - @aio-proxy/plugin-github-copilot@0.38.0
  - @aio-proxy/plugin-google-antigravity@0.38.0
  - @aio-proxy/plugin-kimi-code@0.38.0
  - @aio-proxy/plugin-muse-code@0.38.0
  - @aio-proxy/plugin-openai-chatgpt@0.38.0
  - @aio-proxy/plugin-opencode-go@0.38.0
  - @aio-proxy/plugin-openrouter@0.38.0
  - @aio-proxy/plugin-xai-grok@0.38.0
  - @aio-proxy/types@0.38.0

## 0.37.0

### Patch Changes

- Updated dependencies [[`7f408f2`](https://github.com/aio-proxy/aio-proxy/commit/7f408f2fa1c54d644c5bfe11a649c89567e502b9)]:
  - @aio-proxy/i18n@0.37.0
  - @aio-proxy/logger@0.37.0
  - @aio-proxy/plugin-sdk@0.37.0
  - @aio-proxy/plugin-claude-code@0.37.0
  - @aio-proxy/plugin-cursor@0.37.0
  - @aio-proxy/plugin-github-copilot@0.37.0
  - @aio-proxy/plugin-google-antigravity@0.37.0
  - @aio-proxy/plugin-kimi-code@0.37.0
  - @aio-proxy/plugin-muse-code@0.37.0
  - @aio-proxy/plugin-openai-chatgpt@0.37.0
  - @aio-proxy/plugin-opencode-go@0.37.0
  - @aio-proxy/plugin-openrouter@0.37.0
  - @aio-proxy/plugin-xai-grok@0.37.0
  - @aio-proxy/shared@0.37.0
  - @aio-proxy/types@0.37.0

## 0.36.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.36.1
  - @aio-proxy/logger@0.36.1
  - @aio-proxy/plugin-sdk@0.36.1
  - @aio-proxy/plugin-claude-code@0.36.1
  - @aio-proxy/plugin-cursor@0.36.1
  - @aio-proxy/plugin-github-copilot@0.36.1
  - @aio-proxy/plugin-google-antigravity@0.36.1
  - @aio-proxy/plugin-kimi-code@0.36.1
  - @aio-proxy/plugin-muse-code@0.36.1
  - @aio-proxy/plugin-openai-chatgpt@0.36.1
  - @aio-proxy/plugin-opencode-go@0.36.1
  - @aio-proxy/plugin-openrouter@0.36.1
  - @aio-proxy/plugin-xai-grok@0.36.1
  - @aio-proxy/shared@0.36.1
  - @aio-proxy/types@0.36.1

## 0.36.0

### Minor Changes

- [#456](https://github.com/aio-proxy/aio-proxy/pull/456) [`dcb1ebd`](https://github.com/aio-proxy/aio-proxy/commit/dcb1ebd82b6fddd964c3083c83ff3c2d57c275be) Thanks @baranwang - `aio-proxy service start` now starts a loaded-but-stopped launchd service, `service restart` waits for the old job to unload, and a service whose binary was removed no longer respawns in a loop. A stopping proxy exits within 3 seconds. Groundwork for the macOS desktop app: a private `desktop-token` file in the proxy home, a local summary endpoint and a discovery command. An app-managed install never self-upgrades (the Dashboard hides "Update now" there), and `aio-proxy upgrade` never restarts an app-owned service.

### Patch Changes

- Updated dependencies [[`dcb1ebd`](https://github.com/aio-proxy/aio-proxy/commit/dcb1ebd82b6fddd964c3083c83ff3c2d57c275be)]:
  - @aio-proxy/types@0.36.0
  - @aio-proxy/i18n@0.36.0
  - @aio-proxy/plugin-sdk@0.36.0
  - @aio-proxy/plugin-cursor@0.36.0
  - @aio-proxy/plugin-openai-chatgpt@0.36.0
  - @aio-proxy/logger@0.36.0
  - @aio-proxy/plugin-claude-code@0.36.0
  - @aio-proxy/plugin-github-copilot@0.36.0
  - @aio-proxy/plugin-google-antigravity@0.36.0
  - @aio-proxy/plugin-kimi-code@0.36.0
  - @aio-proxy/plugin-muse-code@0.36.0
  - @aio-proxy/plugin-opencode-go@0.36.0
  - @aio-proxy/plugin-openrouter@0.36.0
  - @aio-proxy/plugin-xai-grok@0.36.0
  - @aio-proxy/shared@0.36.0

## 0.35.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.35.1
  - @aio-proxy/logger@0.35.1
  - @aio-proxy/plugin-sdk@0.35.1
  - @aio-proxy/plugin-claude-code@0.35.1
  - @aio-proxy/plugin-cursor@0.35.1
  - @aio-proxy/plugin-github-copilot@0.35.1
  - @aio-proxy/plugin-google-antigravity@0.35.1
  - @aio-proxy/plugin-kimi-code@0.35.1
  - @aio-proxy/plugin-muse-code@0.35.1
  - @aio-proxy/plugin-openai-chatgpt@0.35.1
  - @aio-proxy/plugin-opencode-go@0.35.1
  - @aio-proxy/plugin-openrouter@0.35.1
  - @aio-proxy/plugin-xai-grok@0.35.1
  - @aio-proxy/shared@0.35.1
  - @aio-proxy/types@0.35.1

## 0.35.0

### Minor Changes

- [#440](https://github.com/aio-proxy/aio-proxy/pull/440) [`76e2bc6`](https://github.com/aio-proxy/aio-proxy/commit/76e2bc6a2405ab48dca41ffcfbcc22189602d349) Thanks @baranwang - Routing groups models by vendor and shows each model's failover tiers (T1, T2, …) with every Provider's share, drift, and why one is left out. A model's page shows its route, traffic, and model info and pricing, which follow an automatically matched reference model unless overridden. Providers' default routing uses the same tiers with typed weights: 0 parks a Provider, and moving it between tiers keeps its weight, bringing a parked one back at 1.

### Patch Changes

- Updated dependencies [[`76e2bc6`](https://github.com/aio-proxy/aio-proxy/commit/76e2bc6a2405ab48dca41ffcfbcc22189602d349)]:
  - @aio-proxy/types@0.35.0
  - @aio-proxy/plugin-sdk@0.35.0
  - @aio-proxy/plugin-cursor@0.35.0
  - @aio-proxy/plugin-openai-chatgpt@0.35.0
  - @aio-proxy/logger@0.35.0
  - @aio-proxy/plugin-claude-code@0.35.0
  - @aio-proxy/plugin-github-copilot@0.35.0
  - @aio-proxy/plugin-google-antigravity@0.35.0
  - @aio-proxy/plugin-kimi-code@0.35.0
  - @aio-proxy/plugin-muse-code@0.35.0
  - @aio-proxy/plugin-opencode-go@0.35.0
  - @aio-proxy/plugin-openrouter@0.35.0
  - @aio-proxy/plugin-xai-grok@0.35.0
  - @aio-proxy/i18n@0.35.0
  - @aio-proxy/shared@0.35.0

## 0.34.0

### Patch Changes

- [#443](https://github.com/aio-proxy/aio-proxy/pull/443) [`b2fb4a4`](https://github.com/aio-proxy/aio-proxy/commit/b2fb4a4c6fb246ee56502063ed410be19aad4f44) Thanks @baranwang - Optional Guardian System One strategies now work for eligible approval requests even when codex-auto-review is not independently configured as a route, while ordinary requests and the default strategy remain unchanged.
- Updated dependencies [[`5dea413`](https://github.com/aio-proxy/aio-proxy/commit/5dea4139c4567284858ae04c8636dd961e47af72), [`6dbb50d`](https://github.com/aio-proxy/aio-proxy/commit/6dbb50deb8a3f7540802e67484056c5bfcfecd54), [`b2fb4a4`](https://github.com/aio-proxy/aio-proxy/commit/b2fb4a4c6fb246ee56502063ed410be19aad4f44)]:
  - @aio-proxy/i18n@0.34.0
  - @aio-proxy/types@0.34.0
  - @aio-proxy/plugin-openai-chatgpt@0.34.0
  - @aio-proxy/plugin-sdk@0.34.0
  - @aio-proxy/plugin-cursor@0.34.0
  - @aio-proxy/logger@0.34.0
  - @aio-proxy/plugin-claude-code@0.34.0
  - @aio-proxy/plugin-github-copilot@0.34.0
  - @aio-proxy/plugin-google-antigravity@0.34.0
  - @aio-proxy/plugin-kimi-code@0.34.0
  - @aio-proxy/plugin-muse-code@0.34.0
  - @aio-proxy/plugin-opencode-go@0.34.0
  - @aio-proxy/plugin-openrouter@0.34.0
  - @aio-proxy/plugin-xai-grok@0.34.0
  - @aio-proxy/shared@0.34.0

## 0.33.4

### Patch Changes

- [#430](https://github.com/aio-proxy/aio-proxy/pull/430) [`3279743`](https://github.com/aio-proxy/aio-proxy/commit/3279743ec7c8447decba5df6c8836405071261e1) Thanks @baranwang - Guardian evaluation now runs on the OpenAI Responses provider selected for that request, not only on a ChatGPT transport. A direct allow or deny does not charge the selected provider; evaluation cost stays on the configured evaluation provider.
- Updated dependencies [[`a223275`](https://github.com/aio-proxy/aio-proxy/commit/a22327585b8574fa08f7b40cc154a982a4999909), [`aab9a9a`](https://github.com/aio-proxy/aio-proxy/commit/aab9a9aabf02664dc973e1afdb1c9daab911be65), [`3279743`](https://github.com/aio-proxy/aio-proxy/commit/3279743ec7c8447decba5df6c8836405071261e1)]:
  - @aio-proxy/plugin-google-antigravity@0.33.4
  - @aio-proxy/i18n@0.33.4
  - @aio-proxy/plugin-openai-chatgpt@0.33.4
  - @aio-proxy/logger@0.33.4
  - @aio-proxy/plugin-sdk@0.33.4
  - @aio-proxy/plugin-claude-code@0.33.4
  - @aio-proxy/plugin-cursor@0.33.4
  - @aio-proxy/plugin-github-copilot@0.33.4
  - @aio-proxy/plugin-kimi-code@0.33.4
  - @aio-proxy/plugin-muse-code@0.33.4
  - @aio-proxy/plugin-opencode-go@0.33.4
  - @aio-proxy/plugin-openrouter@0.33.4
  - @aio-proxy/plugin-xai-grok@0.33.4
  - @aio-proxy/shared@0.33.4
  - @aio-proxy/types@0.33.4

## 0.33.3

### Patch Changes

- Updated dependencies [[`cd5971b`](https://github.com/aio-proxy/aio-proxy/commit/cd5971b2ab87856457a9291a245d74d0e5049739)]:
  - @aio-proxy/plugin-openai-chatgpt@0.33.3
  - @aio-proxy/i18n@0.33.3
  - @aio-proxy/logger@0.33.3
  - @aio-proxy/plugin-sdk@0.33.3
  - @aio-proxy/plugin-claude-code@0.33.3
  - @aio-proxy/plugin-cursor@0.33.3
  - @aio-proxy/plugin-github-copilot@0.33.3
  - @aio-proxy/plugin-google-antigravity@0.33.3
  - @aio-proxy/plugin-kimi-code@0.33.3
  - @aio-proxy/plugin-muse-code@0.33.3
  - @aio-proxy/plugin-opencode-go@0.33.3
  - @aio-proxy/plugin-openrouter@0.33.3
  - @aio-proxy/plugin-xai-grok@0.33.3
  - @aio-proxy/shared@0.33.3
  - @aio-proxy/types@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies [[`7a104ac`](https://github.com/aio-proxy/aio-proxy/commit/7a104ac9de628d0d39fb830a710c8ad8366ac93a)]:
  - @aio-proxy/plugin-openai-chatgpt@0.33.2
  - @aio-proxy/i18n@0.33.2
  - @aio-proxy/logger@0.33.2
  - @aio-proxy/plugin-sdk@0.33.2
  - @aio-proxy/plugin-claude-code@0.33.2
  - @aio-proxy/plugin-cursor@0.33.2
  - @aio-proxy/plugin-github-copilot@0.33.2
  - @aio-proxy/plugin-google-antigravity@0.33.2
  - @aio-proxy/plugin-kimi-code@0.33.2
  - @aio-proxy/plugin-muse-code@0.33.2
  - @aio-proxy/plugin-opencode-go@0.33.2
  - @aio-proxy/plugin-openrouter@0.33.2
  - @aio-proxy/plugin-xai-grok@0.33.2
  - @aio-proxy/shared@0.33.2
  - @aio-proxy/types@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [[`20b7733`](https://github.com/aio-proxy/aio-proxy/commit/20b7733ce0b7a6276e82bbfc582bb25923aac37a)]:
  - @aio-proxy/plugin-openai-chatgpt@0.33.1
  - @aio-proxy/i18n@0.33.1
  - @aio-proxy/logger@0.33.1
  - @aio-proxy/plugin-sdk@0.33.1
  - @aio-proxy/plugin-claude-code@0.33.1
  - @aio-proxy/plugin-cursor@0.33.1
  - @aio-proxy/plugin-github-copilot@0.33.1
  - @aio-proxy/plugin-google-antigravity@0.33.1
  - @aio-proxy/plugin-kimi-code@0.33.1
  - @aio-proxy/plugin-muse-code@0.33.1
  - @aio-proxy/plugin-opencode-go@0.33.1
  - @aio-proxy/plugin-openrouter@0.33.1
  - @aio-proxy/plugin-xai-grok@0.33.1
  - @aio-proxy/shared@0.33.1
  - @aio-proxy/types@0.33.1

## 0.33.0

### Minor Changes

- [#422](https://github.com/aio-proxy/aio-proxy/pull/422) [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568) Thanks @baranwang - ChatGPT OAuth now offers optional Guardian approval strategies that evaluate with a selected System One Provider and model. The default keeps Codex behavior, and supported System One decisions can be final or send denials to the original model for review; unavailable evaluations fall back safely.

### Patch Changes

- Updated dependencies [[`de76673`](https://github.com/aio-proxy/aio-proxy/commit/de76673fe07ae3be9f3d7e3a84d1bd541ca07479), [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568)]:
  - @aio-proxy/plugin-sdk@0.33.0
  - @aio-proxy/types@0.33.0
  - @aio-proxy/plugin-openai-chatgpt@0.33.0
  - @aio-proxy/i18n@0.33.0
  - @aio-proxy/logger@0.33.0
  - @aio-proxy/plugin-claude-code@0.33.0
  - @aio-proxy/plugin-cursor@0.33.0
  - @aio-proxy/plugin-github-copilot@0.33.0
  - @aio-proxy/plugin-google-antigravity@0.33.0
  - @aio-proxy/plugin-kimi-code@0.33.0
  - @aio-proxy/plugin-muse-code@0.33.0
  - @aio-proxy/plugin-opencode-go@0.33.0
  - @aio-proxy/plugin-openrouter@0.33.0
  - @aio-proxy/plugin-xai-grok@0.33.0
  - @aio-proxy/shared@0.33.0

## 0.32.0

### Minor Changes

- [#416](https://github.com/aio-proxy/aio-proxy/pull/416) [`80983cd`](https://github.com/aio-proxy/aio-proxy/commit/80983cdb7dcf9368388c5d9cc9b86ceea3b6322f) Thanks @baranwang - The documentation site publishes stable English and Chinese pages for all supported public API operations, with resource navigation and read-only examples. It covers text, embeddings, media, evaluation, and realtime endpoints, including multipart uploads, binary responses, and WebSocket handshakes, with provider compatibility limits made explicit.

### Patch Changes

- [#413](https://github.com/aio-proxy/aio-proxy/pull/413) [`e77a7ac`](https://github.com/aio-proxy/aio-proxy/commit/e77a7ac7ce18c0b57fd1cf40aa606373213557c5) Thanks @baranwang - Restore Provider success rate, token throughput, and latency statistics for the updated trace format. Restore overview cache hit rate accounting for requests with nested inference spans.
- Updated dependencies []:
  - @aio-proxy/i18n@0.32.0
  - @aio-proxy/logger@0.32.0
  - @aio-proxy/plugin-sdk@0.32.0
  - @aio-proxy/plugin-claude-code@0.32.0
  - @aio-proxy/plugin-cursor@0.32.0
  - @aio-proxy/plugin-github-copilot@0.32.0
  - @aio-proxy/plugin-google-antigravity@0.32.0
  - @aio-proxy/plugin-kimi-code@0.32.0
  - @aio-proxy/plugin-muse-code@0.32.0
  - @aio-proxy/plugin-openai-chatgpt@0.32.0
  - @aio-proxy/plugin-opencode-go@0.32.0
  - @aio-proxy/plugin-openrouter@0.32.0
  - @aio-proxy/plugin-xai-grok@0.32.0
  - @aio-proxy/shared@0.32.0
  - @aio-proxy/types@0.32.0

## 0.31.0

### Minor Changes

- [#410](https://github.com/aio-proxy/aio-proxy/pull/410) [`f0b3105`](https://github.com/aio-proxy/aio-proxy/commit/f0b3105e4dc74a674303c89e1d2eb2e106b7b12b) Thanks @baranwang - Configure ChatGPT's User-Agent once on the Plugins page for all ChatGPT providers, without signing in again. The default follows the latest stable Codex version through cached, proxy-aware npm and GitHub lookups, with a fallback when both fail. Plugin options support simple Handlebars variables such as `{{latest_codex_rs_version}}`, and plugin form fields can declare default values. Previously saved provider-level User-Agent values are ignored.

### Patch Changes

- Updated dependencies [[`f0b3105`](https://github.com/aio-proxy/aio-proxy/commit/f0b3105e4dc74a674303c89e1d2eb2e106b7b12b), [`24209ab`](https://github.com/aio-proxy/aio-proxy/commit/24209ab085ab5155cb37055383b77e5ef11e9c9a), [`38b4c2d`](https://github.com/aio-proxy/aio-proxy/commit/38b4c2d47697aee41c12f5b6ab4fc28cd1d2d8b0)]:
  - @aio-proxy/plugin-openai-chatgpt@0.31.0
  - @aio-proxy/plugin-sdk@0.31.0
  - @aio-proxy/i18n@0.31.0
  - @aio-proxy/logger@0.31.0
  - @aio-proxy/plugin-claude-code@0.31.0
  - @aio-proxy/plugin-cursor@0.31.0
  - @aio-proxy/plugin-github-copilot@0.31.0
  - @aio-proxy/plugin-google-antigravity@0.31.0
  - @aio-proxy/plugin-kimi-code@0.31.0
  - @aio-proxy/plugin-muse-code@0.31.0
  - @aio-proxy/plugin-opencode-go@0.31.0
  - @aio-proxy/plugin-openrouter@0.31.0
  - @aio-proxy/plugin-xai-grok@0.31.0
  - @aio-proxy/shared@0.31.0
  - @aio-proxy/types@0.31.0

## 0.30.0

### Minor Changes

- [#404](https://github.com/aio-proxy/aio-proxy/pull/404) [`69867fc`](https://github.com/aio-proxy/aio-proxy/commit/69867fc1cf275d3f72f4ebea41a0ad8b4f398493) Thanks @baranwang - Settings can send the traces aio-proxy already records to OTLP endpoints. Add a destination URL, choose JSON or protobuf, and set headers. Export stays on when a destination fails, and the local traces page is unchanged.

### Patch Changes

- Updated dependencies [[`fc9ee8c`](https://github.com/aio-proxy/aio-proxy/commit/fc9ee8c2d31bcdc58bc5709b3d0e2a451b2004f2), [`23faacb`](https://github.com/aio-proxy/aio-proxy/commit/23faacb68ea76edfc0f379e602f16023ad749b46), [`69867fc`](https://github.com/aio-proxy/aio-proxy/commit/69867fc1cf275d3f72f4ebea41a0ad8b4f398493)]:
  - @aio-proxy/plugin-openai-chatgpt@0.30.0
  - @aio-proxy/i18n@0.30.0
  - @aio-proxy/types@0.30.0
  - @aio-proxy/plugin-sdk@0.30.0
  - @aio-proxy/plugin-cursor@0.30.0
  - @aio-proxy/logger@0.30.0
  - @aio-proxy/plugin-claude-code@0.30.0
  - @aio-proxy/plugin-github-copilot@0.30.0
  - @aio-proxy/plugin-google-antigravity@0.30.0
  - @aio-proxy/plugin-kimi-code@0.30.0
  - @aio-proxy/plugin-muse-code@0.30.0
  - @aio-proxy/plugin-opencode-go@0.30.0
  - @aio-proxy/plugin-openrouter@0.30.0
  - @aio-proxy/plugin-xai-grok@0.30.0
  - @aio-proxy/shared@0.30.0

## 0.29.0

### Minor Changes

- [#399](https://github.com/aio-proxy/aio-proxy/pull/399) [`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d) Thanks @baranwang - Trace timelines now use stable start ordering, standard HTTP and GenAI semantics, redacted upstream URLs, and accurate provider, failover, TTFT, and usage attribution. OAuth runtimes can explicitly declare their GenAI provider identity; raw transports can declare upstream URL templates, while converted calls omit templates unless authoritative transport metadata is available.

### Patch Changes

- Updated dependencies [[`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d), [`6337347`](https://github.com/aio-proxy/aio-proxy/commit/6337347634da1a8eb0763e14406b050c32e8f5bc)]:
  - @aio-proxy/plugin-sdk@0.29.0
  - @aio-proxy/types@0.29.0
  - @aio-proxy/plugin-openai-chatgpt@0.29.0
  - @aio-proxy/plugin-claude-code@0.29.0
  - @aio-proxy/plugin-google-antigravity@0.29.0
  - @aio-proxy/plugin-xai-grok@0.29.0
  - @aio-proxy/plugin-openrouter@0.29.0
  - @aio-proxy/logger@0.29.0
  - @aio-proxy/plugin-cursor@0.29.0
  - @aio-proxy/plugin-github-copilot@0.29.0
  - @aio-proxy/plugin-kimi-code@0.29.0
  - @aio-proxy/plugin-muse-code@0.29.0
  - @aio-proxy/plugin-opencode-go@0.29.0
  - @aio-proxy/i18n@0.29.0
  - @aio-proxy/shared@0.29.0

## 0.28.0

### Minor Changes

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`c81d4af`](https://github.com/aio-proxy/aio-proxy/commit/c81d4afed84aca4a891180187f5f43b8fcc4e60c) Thanks @baranwang - 调用链详情页现在展示完整的 span 树：解析、会话、路由各成一条；每次请求有一层逻辑操作 span 覆盖路由与全部失败转移，其下每个 provider 尝试各成一条推理 span（厂商、模型、token），再往下是请求准备与每一次上游 HTTP 发送，同一 provider 的退避重试逐次成行。
  瀑布图按父子结构排序，首字时延画成刻度；尝试的首字时延从尝试开始计，失败的尝试也记录，一次尝试观测到多个响应时说明无法归因的原因。
  token 用量与模型不再挂在根 span 上；客户端主动取消不再标成错误。

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`2841175`](https://github.com/aio-proxy/aio-proxy/commit/2841175f2d07089d13beaa629857227cbcd9d0d4) Thanks @baranwang - 调用链详情改为整页三个标签页。「详情」是带时间刻度的瀑布图和选中 span 的状态、耗时、Token 与可筛选属性；同模型同操作的成功样本够了，结束后才给延迟分位。计 token 调用链也能按请求模型筛选。属性加筛选时按这条调用链当天。
  「请求」「响应」按跳列出站和每次上游发送。抓包需 debug 日志，按启动时的配置读（热重载改 level/目录要等重启）；未开启、过期或缺天会说明原因。还在跑时详情会刷新，结束后再抓一次完整日志，跨零点才写完的正文也会扫到。视频请求和响应都不落正文。无正文的 GET/HEAD 记空终态，打开时不再误扫下一天。OAuth 的 `code`、`jwt` / `X-JWT` 会打码；相对 Location（`?token=`、`../jobs`）保持原路径写法。
  失败跳显示失败，清理未读正文不会把成功跳画成取消。客户端取消只留下异常类型时，那一跳仍是取消。取消的调用链不进成功/失败柱和延迟分位。未映射的上游异常也会留下推理层的尝试次数。

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`25f9ec0`](https://github.com/aio-proxy/aio-proxy/commit/25f9ec0be50b28f8f5cc75f20a250e8b0bbc8ed7) Thanks @baranwang - 调用链列表页进入时不再自动轮询，工具栏新增「实时」开关，时间范围选择器从筛选抽屉移到工具栏常驻。表格上方新增按时间分桶的成功/失败堆叠柱状图：图例显示区间总数并直接充当状态筛选，点击柱体把时间范围收窄到该桶，折叠状态记在本地。表格的「状态」列移到 HTTP 之后。

- [#394](https://github.com/aio-proxy/aio-proxy/pull/394) [`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334) Thanks @baranwang - Evaluate with TypeSafe System One. `POST /v1/systemone` routes System One requests like any other model request, with priority and weight failover and System One-shaped errors. Every answered evaluation records usage, so this traffic now bills. The dashboard offers the new `typesafe-systemone` protocol for providers and traces, and reports newer bundled AI SDK provider versions.

### Patch Changes

- Updated dependencies [[`c81d4af`](https://github.com/aio-proxy/aio-proxy/commit/c81d4afed84aca4a891180187f5f43b8fcc4e60c), [`2841175`](https://github.com/aio-proxy/aio-proxy/commit/2841175f2d07089d13beaa629857227cbcd9d0d4), [`25f9ec0`](https://github.com/aio-proxy/aio-proxy/commit/25f9ec0be50b28f8f5cc75f20a250e8b0bbc8ed7), [`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334)]:
  - @aio-proxy/i18n@0.28.0
  - @aio-proxy/types@0.28.0
  - @aio-proxy/logger@0.28.0
  - @aio-proxy/plugin-sdk@0.28.0
  - @aio-proxy/plugin-cursor@0.28.0
  - @aio-proxy/plugin-openai-chatgpt@0.28.0
  - @aio-proxy/plugin-claude-code@0.28.0
  - @aio-proxy/plugin-github-copilot@0.28.0
  - @aio-proxy/plugin-google-antigravity@0.28.0
  - @aio-proxy/plugin-kimi-code@0.28.0
  - @aio-proxy/plugin-muse-code@0.28.0
  - @aio-proxy/plugin-opencode-go@0.28.0
  - @aio-proxy/plugin-openrouter@0.28.0
  - @aio-proxy/plugin-xai-grok@0.28.0
  - @aio-proxy/shared@0.28.0

## 0.27.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.27.1
  - @aio-proxy/logger@0.27.1
  - @aio-proxy/plugin-sdk@0.27.1
  - @aio-proxy/plugin-claude-code@0.27.1
  - @aio-proxy/plugin-cursor@0.27.1
  - @aio-proxy/plugin-github-copilot@0.27.1
  - @aio-proxy/plugin-google-antigravity@0.27.1
  - @aio-proxy/plugin-kimi-code@0.27.1
  - @aio-proxy/plugin-muse-code@0.27.1
  - @aio-proxy/plugin-openai-chatgpt@0.27.1
  - @aio-proxy/plugin-opencode-go@0.27.1
  - @aio-proxy/plugin-openrouter@0.27.1
  - @aio-proxy/plugin-xai-grok@0.27.1
  - @aio-proxy/shared@0.27.1
  - @aio-proxy/types@0.27.1

## 0.27.0

### Patch Changes

- [#386](https://github.com/aio-proxy/aio-proxy/pull/386) [`6273746`](https://github.com/aio-proxy/aio-proxy/commit/62737462d25a35c9d6051a7dd3ad510fb0125cc5) Thanks @foriLLL - Chat Completions streaming now shapes tool-call chunks the way OpenAI does: the first chunk carries the call id and function name, every chunk after it carries only the argument delta. Clients that concatenate the fields they receive no longer end up with duplicated JSON, a repeated call id or tool name, or broken tool calls such as a bash `command` of `{`.
- Updated dependencies [[`bafe0fa`](https://github.com/aio-proxy/aio-proxy/commit/bafe0fa2277d32ff502cf03f0cdb7e96c7970c30)]:
  - @aio-proxy/i18n@0.27.0
  - @aio-proxy/logger@0.27.0
  - @aio-proxy/plugin-sdk@0.27.0
  - @aio-proxy/plugin-claude-code@0.27.0
  - @aio-proxy/plugin-cursor@0.27.0
  - @aio-proxy/plugin-github-copilot@0.27.0
  - @aio-proxy/plugin-google-antigravity@0.27.0
  - @aio-proxy/plugin-kimi-code@0.27.0
  - @aio-proxy/plugin-muse-code@0.27.0
  - @aio-proxy/plugin-openai-chatgpt@0.27.0
  - @aio-proxy/plugin-opencode-go@0.27.0
  - @aio-proxy/plugin-openrouter@0.27.0
  - @aio-proxy/plugin-xai-grok@0.27.0
  - @aio-proxy/shared@0.27.0
  - @aio-proxy/types@0.27.0

## 0.26.0

### Minor Changes

- [#380](https://github.com/aio-proxy/aio-proxy/pull/380) [`3b81cd0`](https://github.com/aio-proxy/aio-proxy/commit/3b81cd0bf7b7746f539652f21efac70ee5e4720e) Thanks @baranwang, @YePiXpert - Quota details show this instance's API-equivalent spend for each OAuth window. It is not the vendor balance.

### Patch Changes

- [#381](https://github.com/aio-proxy/aio-proxy/pull/381) [`a9b3558`](https://github.com/aio-proxy/aio-proxy/commit/a9b355800d01932b1f9e27c63f6f6765bc489125) Thanks @baranwang - Codex Desktop tool results that arrive without a `call_id` are rewritten to a user note on the OpenAI Responses raw path. Outputs that still have a `call_id` are left for stored previous-response state.
- Updated dependencies [[`67e63dd`](https://github.com/aio-proxy/aio-proxy/commit/67e63dde4e3b60b0cae31cbf37f1d70d1aac02e9), [`3b81cd0`](https://github.com/aio-proxy/aio-proxy/commit/3b81cd0bf7b7746f539652f21efac70ee5e4720e)]:
  - @aio-proxy/plugin-cursor@0.26.0
  - @aio-proxy/i18n@0.26.0
  - @aio-proxy/logger@0.26.0
  - @aio-proxy/plugin-sdk@0.26.0
  - @aio-proxy/plugin-claude-code@0.26.0
  - @aio-proxy/plugin-github-copilot@0.26.0
  - @aio-proxy/plugin-google-antigravity@0.26.0
  - @aio-proxy/plugin-kimi-code@0.26.0
  - @aio-proxy/plugin-muse-code@0.26.0
  - @aio-proxy/plugin-openai-chatgpt@0.26.0
  - @aio-proxy/plugin-opencode-go@0.26.0
  - @aio-proxy/plugin-openrouter@0.26.0
  - @aio-proxy/plugin-xai-grok@0.26.0
  - @aio-proxy/shared@0.26.0
  - @aio-proxy/types@0.26.0

## 0.25.0

### Minor Changes

- [#372](https://github.com/aio-proxy/aio-proxy/pull/372) [`c0e2cab`](https://github.com/aio-proxy/aio-proxy/commit/c0e2cab47228253c7d8e5e042bcff9397c369430) Thanks @baranwang - Add a built-in OpenCode Go plugin. Paste an OpenCode API key from opencode.ai/auth to use the Go subscription catalog, with per-model Chat Completions, Responses, and Anthropic Messages routing.

### Patch Changes

- [#376](https://github.com/aio-proxy/aio-proxy/pull/376) [`c1487e5`](https://github.com/aio-proxy/aio-proxy/commit/c1487e50de8f6b6edde853228d9c8b29e399611b) Thanks @foriLLL - Preserve prompt-cache and reasoning token counts when converting a model
  stream into OpenAI Responses. Cross-protocol Responses usage previously
  reported those fields as 0 even when the upstream model returned them.
- Updated dependencies [[`c0e2cab`](https://github.com/aio-proxy/aio-proxy/commit/c0e2cab47228253c7d8e5e042bcff9397c369430)]:
  - @aio-proxy/plugin-opencode-go@0.25.0
  - @aio-proxy/i18n@0.25.0
  - @aio-proxy/logger@0.25.0
  - @aio-proxy/plugin-sdk@0.25.0
  - @aio-proxy/plugin-claude-code@0.25.0
  - @aio-proxy/plugin-cursor@0.25.0
  - @aio-proxy/plugin-github-copilot@0.25.0
  - @aio-proxy/plugin-google-antigravity@0.25.0
  - @aio-proxy/plugin-kimi-code@0.25.0
  - @aio-proxy/plugin-muse-code@0.25.0
  - @aio-proxy/plugin-openai-chatgpt@0.25.0
  - @aio-proxy/plugin-openrouter@0.25.0
  - @aio-proxy/plugin-xai-grok@0.25.0
  - @aio-proxy/shared@0.25.0
  - @aio-proxy/types@0.25.0

## 0.24.0

### Minor Changes

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`1cb5c9f`](https://github.com/aio-proxy/aio-proxy/commit/1cb5c9f3fc91c5e48ef673eb7be0b9971942386e) Thanks @YePiXpert - Discover Grok OAuth image and video models instead of filtering them from the account catalog. Support image generation/editing and video creation, polling, and content retrieval with the same account. Plugins can optionally declare a video catalog without exposing video-only models as chat models.

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`d50feb0`](https://github.com/aio-proxy/aio-proxy/commit/d50feb0764829686811aaff59b8134e47b493ea4) Thanks @YePiXpert - Add authenticated SOCKS5 outbound proxies and optional primary/backup proxy fallback, disabled by default. Only providers set to inherit use the global policy; independent provider primary/backup settings and direct connections override it. Fallback switches only before a request is sent and never bypasses the proxies.

### Patch Changes

- Updated dependencies [[`1cb5c9f`](https://github.com/aio-proxy/aio-proxy/commit/1cb5c9f3fc91c5e48ef673eb7be0b9971942386e), [`9de6d0e`](https://github.com/aio-proxy/aio-proxy/commit/9de6d0ec7fde99c9de87f993d3c1fb8f890690fe), [`d50feb0`](https://github.com/aio-proxy/aio-proxy/commit/d50feb0764829686811aaff59b8134e47b493ea4)]:
  - @aio-proxy/plugin-sdk@0.24.0
  - @aio-proxy/plugin-xai-grok@0.24.0
  - @aio-proxy/plugin-openai-chatgpt@0.24.0
  - @aio-proxy/types@0.24.0
  - @aio-proxy/i18n@0.24.0
  - @aio-proxy/logger@0.24.0
  - @aio-proxy/plugin-claude-code@0.24.0
  - @aio-proxy/plugin-cursor@0.24.0
  - @aio-proxy/plugin-github-copilot@0.24.0
  - @aio-proxy/plugin-google-antigravity@0.24.0
  - @aio-proxy/plugin-kimi-code@0.24.0
  - @aio-proxy/plugin-muse-code@0.24.0
  - @aio-proxy/plugin-openrouter@0.24.0
  - @aio-proxy/shared@0.24.0

## 0.23.2

### Patch Changes

- [#366](https://github.com/aio-proxy/aio-proxy/pull/366) [`3bf7004`](https://github.com/aio-proxy/aio-proxy/commit/3bf7004feb80ae77ac64030d0255a601e1488a2c) Thanks @YePiXpert - Image generation and editing requests with an omitted or blank model now default to `gpt-image-2.5-sunburst`. Explicit model selections keep their existing routing. API Providers must expose the new default model, or clients must explicitly request a model their Provider supports.
- Updated dependencies []:
  - @aio-proxy/i18n@0.23.2
  - @aio-proxy/logger@0.23.2
  - @aio-proxy/plugin-sdk@0.23.2
  - @aio-proxy/plugin-claude-code@0.23.2
  - @aio-proxy/plugin-cursor@0.23.2
  - @aio-proxy/plugin-github-copilot@0.23.2
  - @aio-proxy/plugin-google-antigravity@0.23.2
  - @aio-proxy/plugin-kimi-code@0.23.2
  - @aio-proxy/plugin-muse-code@0.23.2
  - @aio-proxy/plugin-openai-chatgpt@0.23.2
  - @aio-proxy/plugin-openrouter@0.23.2
  - @aio-proxy/plugin-xai-grok@0.23.2
  - @aio-proxy/shared@0.23.2
  - @aio-proxy/types@0.23.2

## 0.23.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.23.1
  - @aio-proxy/logger@0.23.1
  - @aio-proxy/plugin-sdk@0.23.1
  - @aio-proxy/plugin-claude-code@0.23.1
  - @aio-proxy/plugin-cursor@0.23.1
  - @aio-proxy/plugin-github-copilot@0.23.1
  - @aio-proxy/plugin-google-antigravity@0.23.1
  - @aio-proxy/plugin-kimi-code@0.23.1
  - @aio-proxy/plugin-muse-code@0.23.1
  - @aio-proxy/plugin-openai-chatgpt@0.23.1
  - @aio-proxy/plugin-openrouter@0.23.1
  - @aio-proxy/plugin-xai-grok@0.23.1
  - @aio-proxy/shared@0.23.1
  - @aio-proxy/types@0.23.1

## 0.23.0

### Patch Changes

- Updated dependencies [[`6fd1738`](https://github.com/aio-proxy/aio-proxy/commit/6fd173878a3574113571b2cf8499e679f83e1b96)]:
  - @aio-proxy/types@0.23.0
  - @aio-proxy/plugin-sdk@0.23.0
  - @aio-proxy/plugin-cursor@0.23.0
  - @aio-proxy/plugin-openai-chatgpt@0.23.0
  - @aio-proxy/logger@0.23.0
  - @aio-proxy/plugin-claude-code@0.23.0
  - @aio-proxy/plugin-github-copilot@0.23.0
  - @aio-proxy/plugin-google-antigravity@0.23.0
  - @aio-proxy/plugin-kimi-code@0.23.0
  - @aio-proxy/plugin-muse-code@0.23.0
  - @aio-proxy/plugin-openrouter@0.23.0
  - @aio-proxy/plugin-xai-grok@0.23.0
  - @aio-proxy/i18n@0.23.0
  - @aio-proxy/shared@0.23.0

## 0.22.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.22.1
  - @aio-proxy/logger@0.22.1
  - @aio-proxy/plugin-sdk@0.22.1
  - @aio-proxy/plugin-claude-code@0.22.1
  - @aio-proxy/plugin-cursor@0.22.1
  - @aio-proxy/plugin-github-copilot@0.22.1
  - @aio-proxy/plugin-google-antigravity@0.22.1
  - @aio-proxy/plugin-kimi-code@0.22.1
  - @aio-proxy/plugin-muse-code@0.22.1
  - @aio-proxy/plugin-openai-chatgpt@0.22.1
  - @aio-proxy/plugin-openrouter@0.22.1
  - @aio-proxy/plugin-xai-grok@0.22.1
  - @aio-proxy/shared@0.22.1
  - @aio-proxy/types@0.22.1

## 0.22.0

### Minor Changes

- [#351](https://github.com/aio-proxy/aio-proxy/pull/351) [`c98e10c`](https://github.com/aio-proxy/aio-proxy/commit/c98e10c1decd66972d10561b3e0fdaa5aae84da0) Thanks @baranwang - Add interactive Codex setup with a customizable Provider ID and a choice to keep ChatGPT login via an existing proxy API key or use command authentication. Command authentication uses AIO Proxy device authorization and reuses a still-valid helper token. Setup preserves model settings and can migrate legacy history; removal respects user edits, revokes command credentials, and blocks when the config cannot be restored.

- [#344](https://github.com/aio-proxy/aio-proxy/pull/344) [`2d05095`](https://github.com/aio-proxy/aio-proxy/commit/2d0509557bbb35a14046ab0a5dcc0cc5e9563b4f) Thanks @baranwang - Add Grok Build integration with native AIO Proxy login, automatic credential refresh, installation revocation, and safe configuration removal.

- [#339](https://github.com/aio-proxy/aio-proxy/pull/339) [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789) Thanks @baranwang - Add official OpenAI Videos ports: create, retrieve, content, delete, remix, edits, and extensions.

### Patch Changes

- Updated dependencies [[`c98e10c`](https://github.com/aio-proxy/aio-proxy/commit/c98e10c1decd66972d10561b3e0fdaa5aae84da0), [`2d05095`](https://github.com/aio-proxy/aio-proxy/commit/2d0509557bbb35a14046ab0a5dcc0cc5e9563b4f), [`00a17a3`](https://github.com/aio-proxy/aio-proxy/commit/00a17a399d7bebb58cc929b77923935f3be8927a), [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789)]:
  - @aio-proxy/types@0.22.0
  - @aio-proxy/i18n@0.22.0
  - @aio-proxy/plugin-sdk@0.22.0
  - @aio-proxy/plugin-cursor@0.22.0
  - @aio-proxy/plugin-openai-chatgpt@0.22.0
  - @aio-proxy/logger@0.22.0
  - @aio-proxy/plugin-claude-code@0.22.0
  - @aio-proxy/plugin-github-copilot@0.22.0
  - @aio-proxy/plugin-google-antigravity@0.22.0
  - @aio-proxy/plugin-kimi-code@0.22.0
  - @aio-proxy/plugin-muse-code@0.22.0
  - @aio-proxy/plugin-openrouter@0.22.0
  - @aio-proxy/plugin-xai-grok@0.22.0
  - @aio-proxy/shared@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies [[`9b1547a`](https://github.com/aio-proxy/aio-proxy/commit/9b1547a263492ba9753fea3eb4761ad434d302f8)]:
  - @aio-proxy/plugin-openai-chatgpt@0.21.0
  - @aio-proxy/i18n@0.21.0
  - @aio-proxy/logger@0.21.0
  - @aio-proxy/plugin-sdk@0.21.0
  - @aio-proxy/plugin-claude-code@0.21.0
  - @aio-proxy/plugin-cursor@0.21.0
  - @aio-proxy/plugin-github-copilot@0.21.0
  - @aio-proxy/plugin-google-antigravity@0.21.0
  - @aio-proxy/plugin-kimi-code@0.21.0
  - @aio-proxy/plugin-muse-code@0.21.0
  - @aio-proxy/plugin-openrouter@0.21.0
  - @aio-proxy/plugin-xai-grok@0.21.0
  - @aio-proxy/shared@0.21.0
  - @aio-proxy/types@0.21.0

## 0.20.5

### Patch Changes

- [#337](https://github.com/aio-proxy/aio-proxy/pull/337) [`7ca4736`](https://github.com/aio-proxy/aio-proxy/commit/7ca473664bff145f4f27570c2d4a36bd7179c854) Thanks @baranwang - Reasoning effort now clamps to what the chosen provider actually supports, read from the provider's
  own catalog first and models.dev only as a fallback, so a `max` request reaches a provider that
  supports `max` instead of arriving as `high`. Google Antigravity's variants, including its split
  Low/Medium/High Gemini wires, clamp down instead of failing the request, and an alias asked for more
  effort than its highest variant declares routes to that variant instead of the alias base.
- Updated dependencies [[`7ca4736`](https://github.com/aio-proxy/aio-proxy/commit/7ca473664bff145f4f27570c2d4a36bd7179c854)]:
  - @aio-proxy/types@0.20.5
  - @aio-proxy/plugin-google-antigravity@0.20.5
  - @aio-proxy/plugin-sdk@0.20.5
  - @aio-proxy/plugin-cursor@0.20.5
  - @aio-proxy/plugin-openai-chatgpt@0.20.5
  - @aio-proxy/logger@0.20.5
  - @aio-proxy/plugin-claude-code@0.20.5
  - @aio-proxy/plugin-github-copilot@0.20.5
  - @aio-proxy/plugin-kimi-code@0.20.5
  - @aio-proxy/plugin-muse-code@0.20.5
  - @aio-proxy/plugin-openrouter@0.20.5
  - @aio-proxy/plugin-xai-grok@0.20.5
  - @aio-proxy/i18n@0.20.5
  - @aio-proxy/shared@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.20.4
  - @aio-proxy/logger@0.20.4
  - @aio-proxy/plugin-sdk@0.20.4
  - @aio-proxy/plugin-claude-code@0.20.4
  - @aio-proxy/plugin-cursor@0.20.4
  - @aio-proxy/plugin-github-copilot@0.20.4
  - @aio-proxy/plugin-google-antigravity@0.20.4
  - @aio-proxy/plugin-kimi-code@0.20.4
  - @aio-proxy/plugin-muse-code@0.20.4
  - @aio-proxy/plugin-openai-chatgpt@0.20.4
  - @aio-proxy/plugin-openrouter@0.20.4
  - @aio-proxy/plugin-xai-grok@0.20.4
  - @aio-proxy/shared@0.20.4
  - @aio-proxy/types@0.20.4

## 0.20.3

### Patch Changes

- [#323](https://github.com/aio-proxy/aio-proxy/pull/323) [`6eca232`](https://github.com/aio-proxy/aio-proxy/commit/6eca2326aec9908634e4975448485b9972ea0ee8) Thanks @baranwang - The overview homepage stacks model trend as bars, shows Provider health as a table without filter or column controls, and ranks models by cost or Token.
- Updated dependencies [[`6eca232`](https://github.com/aio-proxy/aio-proxy/commit/6eca2326aec9908634e4975448485b9972ea0ee8), [`7877705`](https://github.com/aio-proxy/aio-proxy/commit/7877705e72bacd55ef197117e71b683888026789)]:
  - @aio-proxy/types@0.20.3
  - @aio-proxy/i18n@0.20.3
  - @aio-proxy/plugin-cursor@0.20.3
  - @aio-proxy/plugin-sdk@0.20.3
  - @aio-proxy/plugin-openai-chatgpt@0.20.3
  - @aio-proxy/logger@0.20.3
  - @aio-proxy/plugin-claude-code@0.20.3
  - @aio-proxy/plugin-github-copilot@0.20.3
  - @aio-proxy/plugin-google-antigravity@0.20.3
  - @aio-proxy/plugin-kimi-code@0.20.3
  - @aio-proxy/plugin-muse-code@0.20.3
  - @aio-proxy/plugin-openrouter@0.20.3
  - @aio-proxy/plugin-xai-grok@0.20.3
  - @aio-proxy/shared@0.20.3

## 0.20.2

### Patch Changes

- Updated dependencies [[`06be481`](https://github.com/aio-proxy/aio-proxy/commit/06be481bd9e14795561b498dd855c8432e243289), [`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da)]:
  - @aio-proxy/plugin-cursor@0.20.2
  - @aio-proxy/types@0.20.2
  - @aio-proxy/plugin-sdk@0.20.2
  - @aio-proxy/plugin-kimi-code@0.20.2
  - @aio-proxy/plugin-muse-code@0.20.2
  - @aio-proxy/plugin-github-copilot@0.20.2
  - @aio-proxy/plugin-openai-chatgpt@0.20.2
  - @aio-proxy/plugin-google-antigravity@0.20.2
  - @aio-proxy/plugin-xai-grok@0.20.2
  - @aio-proxy/logger@0.20.2
  - @aio-proxy/plugin-claude-code@0.20.2
  - @aio-proxy/plugin-openrouter@0.20.2
  - @aio-proxy/i18n@0.20.2
  - @aio-proxy/shared@0.20.2

## 0.20.1

### Patch Changes

- [#311](https://github.com/aio-proxy/aio-proxy/pull/311) [`1018663`](https://github.com/aio-proxy/aio-proxy/commit/1018663bbc459485c25a995a2bfb81454738b3f1) Thanks @baranwang - Rename the built-in Claude Pro/Max plugin to `@aio-proxy/plugin-claude-code`
- Updated dependencies [[`1018663`](https://github.com/aio-proxy/aio-proxy/commit/1018663bbc459485c25a995a2bfb81454738b3f1), [`3c31f50`](https://github.com/aio-proxy/aio-proxy/commit/3c31f505c862b18a314e19cfac580d7a935d0d07)]:
  - @aio-proxy/plugin-claude-code@0.20.1
  - @aio-proxy/plugin-muse-code@0.20.1
  - @aio-proxy/i18n@0.20.1
  - @aio-proxy/logger@0.20.1
  - @aio-proxy/plugin-sdk@0.20.1
  - @aio-proxy/plugin-cursor@0.20.1
  - @aio-proxy/plugin-github-copilot@0.20.1
  - @aio-proxy/plugin-google-antigravity@0.20.1
  - @aio-proxy/plugin-kimi-code@0.20.1
  - @aio-proxy/plugin-openai-chatgpt@0.20.1
  - @aio-proxy/plugin-openrouter@0.20.1
  - @aio-proxy/plugin-xai-grok@0.20.1
  - @aio-proxy/shared@0.20.1
  - @aio-proxy/types@0.20.1

## 0.20.0

### Minor Changes

- [#300](https://github.com/aio-proxy/aio-proxy/pull/300) [`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a) Thanks @baranwang - A running process checks npm `latest` on start, every 24 hours, and when the Dashboard mounts. It persists the result, prompts once per new version (Dashboard sidebar, CLI stderr banner, OS notification), and installs only after Update now or `aio-proxy upgrade`. Leftover `server.autoUpdate` in an existing config is ignored.

- [#305](https://github.com/aio-proxy/aio-proxy/pull/305) [`d036485`](https://github.com/aio-proxy/aio-proxy/commit/d0364851282aaf6aaa56c6dc6bfa515d7e0c3209) Thanks @baranwang - Add a built-in Muse Code OAuth plugin that logs in with a Meta device code, mints a Model API key, and routes Meta models through the OpenAI Responses API.

- [#303](https://github.com/aio-proxy/aio-proxy/pull/303) [`84b206c`](https://github.com/aio-proxy/aio-proxy/commit/84b206c1d2f296748d2b86cedf0ef97c2b65d8e2) Thanks @baranwang - Add a built-in OpenRouter OAuth plugin that signs in with PKCE, mints a durable user-controlled API key, discovers models, and reads remaining key credits. Loopback parse now requires callback `state` only when the opened authorize URL sent `state`, so OpenRouter (no state echo) can finish without weakening ChatGPT or Antigravity CSRF.

- [#301](https://github.com/aio-proxy/aio-proxy/pull/301) [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0) Thanks @baranwang - Add the OpenAI Audio inbound protocol.

- [#308](https://github.com/aio-proxy/aio-proxy/pull/308) [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3) Thanks @baranwang - Subscription quota bars now mark where an even burn would have left the allowance by now, turning
  red when the window is being spent faster than that and drawing nothing while it tracks even. The
  marker appears wherever the provider reports how long the window lasts, which the bundled OAuth
  plugins now do; plugins can opt in through the new optional `OAuthQuotaItem.windowMinutes`. The
  reading is also spoken by the bar's accessible value text.

- [#302](https://github.com/aio-proxy/aio-proxy/pull/302) [`b3b181a`](https://github.com/aio-proxy/aio-proxy/commit/b3b181aebd9a8c36de14dc05076c137e96a49332) Thanks @baranwang - anthropic-claude: add Claude Pro/Max subscription OAuth login, model discovery, and Anthropic runtime

### Patch Changes

- Updated dependencies [[`13a6c91`](https://github.com/aio-proxy/aio-proxy/commit/13a6c9153739049dab5443dd3ac7d570f7e80690), [`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a), [`d036485`](https://github.com/aio-proxy/aio-proxy/commit/d0364851282aaf6aaa56c6dc6bfa515d7e0c3209), [`84b206c`](https://github.com/aio-proxy/aio-proxy/commit/84b206c1d2f296748d2b86cedf0ef97c2b65d8e2), [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0), [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3), [`b3b181a`](https://github.com/aio-proxy/aio-proxy/commit/b3b181aebd9a8c36de14dc05076c137e96a49332), [`1340b97`](https://github.com/aio-proxy/aio-proxy/commit/1340b97cfa5d277a886bbda43ebb4abdbc7fffc6)]:
  - @aio-proxy/plugin-sdk@0.20.0
  - @aio-proxy/plugin-openai-chatgpt@0.20.0
  - @aio-proxy/types@0.20.0
  - @aio-proxy/i18n@0.20.0
  - @aio-proxy/plugin-muse-code@0.20.0
  - @aio-proxy/plugin-openrouter@0.20.0
  - @aio-proxy/shared@0.20.0
  - @aio-proxy/plugin-github-copilot@0.20.0
  - @aio-proxy/plugin-google-antigravity@0.20.0
  - @aio-proxy/plugin-kimi-code@0.20.0
  - @aio-proxy/plugin-cursor@0.20.0
  - @aio-proxy/plugin-xai-grok@0.20.0
  - @aio-proxy/plugin-anthropic-claude@0.20.0
  - @aio-proxy/logger@0.20.0

## 0.19.2

### Patch Changes

- [#291](https://github.com/aio-proxy/aio-proxy/pull/291) [`f71a576`](https://github.com/aio-proxy/aio-proxy/commit/f71a5760db5852f2c340e089c3858ae81da7053c) Thanks @baranwang - Accept OpenAI Responses requests whose tool calls and outputs lost their pairing Context compaction can truncate a conversation between a `function_call` and its `function_call_output`, leaving one side without the other.

- [#291](https://github.com/aio-proxy/aio-proxy/pull/291) [`4f3154e`](https://github.com/aio-proxy/aio-proxy/commit/4f3154e79a3f2bf1d5d23081e8dd099cc7841ecd) Thanks @baranwang - Recover from tool-pairing 400s on the raw passthrough path When the inbound protocol matches the provider's, an OpenAI Responses request is forwarded byte-for-byte and the model path's conversion never runs.

- Updated dependencies [[`4e3f656`](https://github.com/aio-proxy/aio-proxy/commit/4e3f656e4df4d53a171b42ac783e3108ff1468f0), [`981e765`](https://github.com/aio-proxy/aio-proxy/commit/981e765965a881af845aff413db711f779ff2ffb)]:
  - @aio-proxy/plugin-xai-grok@0.19.2
  - @aio-proxy/plugin-openai-chatgpt@0.19.2
  - @aio-proxy/i18n@0.19.2
  - @aio-proxy/logger@0.19.2
  - @aio-proxy/plugin-sdk@0.19.2
  - @aio-proxy/plugin-cursor@0.19.2
  - @aio-proxy/plugin-github-copilot@0.19.2
  - @aio-proxy/plugin-google-antigravity@0.19.2
  - @aio-proxy/plugin-kimi-code@0.19.2
  - @aio-proxy/shared@0.19.2
  - @aio-proxy/types@0.19.2

## 0.19.1

### Patch Changes

- Updated dependencies [[`80f8b9d`](https://github.com/aio-proxy/aio-proxy/commit/80f8b9d10eef15214fc3f55342ccf097fc00b6ef)]:
  - @aio-proxy/plugin-sdk@0.19.1
  - @aio-proxy/logger@0.19.1
  - @aio-proxy/plugin-cursor@0.19.1
  - @aio-proxy/plugin-github-copilot@0.19.1
  - @aio-proxy/plugin-google-antigravity@0.19.1
  - @aio-proxy/plugin-kimi-code@0.19.1
  - @aio-proxy/plugin-openai-chatgpt@0.19.1
  - @aio-proxy/plugin-xai-grok@0.19.1
  - @aio-proxy/i18n@0.19.1
  - @aio-proxy/shared@0.19.1
  - @aio-proxy/types@0.19.1

## 0.19.0

### Patch Changes

- Updated dependencies [[`2e76766`](https://github.com/aio-proxy/aio-proxy/commit/2e7676669a60d42af8d545e8d1614a295fabfae6)]:
  - @aio-proxy/i18n@0.19.0
  - @aio-proxy/logger@0.19.0
  - @aio-proxy/plugin-cursor@0.19.0
  - @aio-proxy/plugin-github-copilot@0.19.0
  - @aio-proxy/plugin-google-antigravity@0.19.0
  - @aio-proxy/plugin-kimi-code@0.19.0
  - @aio-proxy/plugin-openai-chatgpt@0.19.0
  - @aio-proxy/plugin-sdk@0.19.0
  - @aio-proxy/plugin-xai-grok@0.19.0
  - @aio-proxy/shared@0.19.0
  - @aio-proxy/types@0.19.0

## 0.18.1

### Patch Changes

- Updated dependencies [[`e2d8a23`](https://github.com/aio-proxy/aio-proxy/commit/e2d8a2381cb6c9f32dac2c26d2dd476934d2a71c)]:
  - @aio-proxy/plugin-openai-chatgpt@0.18.1
  - @aio-proxy/i18n@0.18.1
  - @aio-proxy/logger@0.18.1
  - @aio-proxy/plugin-cursor@0.18.1
  - @aio-proxy/plugin-github-copilot@0.18.1
  - @aio-proxy/plugin-google-antigravity@0.18.1
  - @aio-proxy/plugin-kimi-code@0.18.1
  - @aio-proxy/plugin-sdk@0.18.1
  - @aio-proxy/plugin-xai-grok@0.18.1
  - @aio-proxy/shared@0.18.1
  - @aio-proxy/types@0.18.1

## 0.18.0

### Patch Changes

- [#273](https://github.com/aio-proxy/aio-proxy/pull/273) [`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3) Thanks @baranwang - Show default routing tiers and same-tier weight percentages in an inset layer beneath each Provider card, including the tier number when there is only one tier.

- Updated dependencies [[`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3), [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664), [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664)]:
  - @aio-proxy/i18n@0.18.0
  - @aio-proxy/types@0.18.0
  - @aio-proxy/plugin-openai-chatgpt@0.18.0
  - @aio-proxy/plugin-sdk@0.18.0
  - @aio-proxy/plugin-cursor@0.18.0
  - @aio-proxy/logger@0.18.0
  - @aio-proxy/plugin-github-copilot@0.18.0
  - @aio-proxy/plugin-google-antigravity@0.18.0
  - @aio-proxy/plugin-kimi-code@0.18.0
  - @aio-proxy/plugin-xai-grok@0.18.0
  - @aio-proxy/shared@0.18.0

## 0.17.0

### Minor Changes

- [#260](https://github.com/aio-proxy/aio-proxy/pull/260) [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f) Thanks @baranwang - Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`fd1c284`](https://github.com/aio-proxy/aio-proxy/commit/fd1c28430f0678bc22a558677feeff3146f7eba6) Thanks @baranwang - Add an About section to the Settings page with the running version, the source repository, and the documentation site, plus a button that checks npm for a newer published release. Move the appearance and language card to the top of the page, and mark the API key label field as optional.

### Patch Changes

- [#269](https://github.com/aio-proxy/aio-proxy/pull/269) [`0934b54`](https://github.com/aio-proxy/aio-proxy/commit/0934b54a8e8dfb1c9c03ceff1f521b7c82ff600f) Thanks @baranwang - Accept OpenAI Responses tool outputs that carry no `call_id`.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`d3eb521`](https://github.com/aio-proxy/aio-proxy/commit/d3eb5215724009b43705a515ca17666097d578f8) Thanks @baranwang - Raise a `SyntaxError` when a config file parses to a non-object root, so a Settings write against `[]` or `null` answers `config_rejected` instead of failing with an unhandled server error.

- [#268](https://github.com/aio-proxy/aio-proxy/pull/268) [`c2acd49`](https://github.com/aio-proxy/aio-proxy/commit/c2acd49f937aa833b8cf7f5937d45cd2a227cd70) Thanks @baranwang - Retry OpenAI Responses raw requests when the upstream rejects an unverifiable reasoning blob with `code: null` and only the message `The encrypted content for item rs_… could not be verified. Reason: Encrypted content could not be decrypted or parsed.`. That variant previously reached the client unchanged because the retry only matched `code: "invalid_encrypted_content"`. A `Signature expired` rejection still commits, since replaying the same body cannot fix it.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`b0e6181`](https://github.com/aio-proxy/aio-proxy/commit/b0e6181122aa8424d90f9533b9deef7f57bb6810) Thanks @baranwang - Derive the recovery-fence action-phase test's sleep from its deadline so a slow acquisition no longer makes it fail on the timeout path it is not testing.

- [#271](https://github.com/aio-proxy/aio-proxy/pull/271) [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd) Thanks @baranwang - dashboard: manage Provider and per-model priority tiers with one drag editor that moves whole tiers, creates tiers at drop slots, and adjusts traffic shares without an add-tier button
- Updated dependencies [[`44a978e`](https://github.com/aio-proxy/aio-proxy/commit/44a978eb2a58a1e36c9c5cd3fd933f082995580b), [`1d688b5`](https://github.com/aio-proxy/aio-proxy/commit/1d688b5090fdbb004435f7e41042464e24885936), [`d4b7388`](https://github.com/aio-proxy/aio-proxy/commit/d4b738816eaa2ad2f32f125cc7238db2e84b85da), [`d371ddc`](https://github.com/aio-proxy/aio-proxy/commit/d371ddcdeaaeb93931739f68f26432f2408ad1cd), [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f), [`fd1c284`](https://github.com/aio-proxy/aio-proxy/commit/fd1c28430f0678bc22a558677feeff3146f7eba6), [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16), [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2), [`2621cb3`](https://github.com/aio-proxy/aio-proxy/commit/2621cb3221abdc8a7d98cbde7eb54e6b35feef37), [`31b4339`](https://github.com/aio-proxy/aio-proxy/commit/31b4339d6b59ca72c0a3b5b33bcd2c339e631f1a), [`4c93909`](https://github.com/aio-proxy/aio-proxy/commit/4c939090f89ac0799768ab356e74310c91940b7a), [`7ecb445`](https://github.com/aio-proxy/aio-proxy/commit/7ecb4452f35b3b1fafa8215d2710e134b60425e7), [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd)]:
  - @aio-proxy/plugin-openai-chatgpt@0.17.0
  - @aio-proxy/plugin-cursor@0.17.0
  - @aio-proxy/plugin-github-copilot@0.17.0
  - @aio-proxy/plugin-google-antigravity@0.17.0
  - @aio-proxy/plugin-kimi-code@0.17.0
  - @aio-proxy/plugin-xai-grok@0.17.0
  - @aio-proxy/plugin-sdk@0.17.0
  - @aio-proxy/types@0.17.0
  - @aio-proxy/i18n@0.17.0
  - @aio-proxy/logger@0.17.0
  - @aio-proxy/shared@0.17.0

## 0.16.0

### Patch Changes

- [#252](https://github.com/aio-proxy/aio-proxy/pull/252) [`142cc1b`](https://github.com/aio-proxy/aio-proxy/commit/142cc1b419b0109585a53f020343d0eb72b6673f) Thanks @wqsworks - core: terminate converted OpenAI Responses stream failures with `response.failed` and normalize cumulative OpenAI-compatible tool argument snapshots.

- [#250](https://github.com/aio-proxy/aio-proxy/pull/250) [`3e3c4bd`](https://github.com/aio-proxy/aio-proxy/commit/3e3c4bdc6acaabe970849961b79a649b1f37a6d5) Thanks @baranwang - Raw OpenAI Responses requests that fail with `invalid_encrypted_content` before any output are now retried once on the same provider. Plaintext encrypted slots become plain text, and opaque reasoning blobs are dropped when that is all that remains, so the client no longer sees a stream that disconnects before completion.
- Updated dependencies [[`a12c9ca`](https://github.com/aio-proxy/aio-proxy/commit/a12c9cabb7481d188786bf22ac5a718b4bf7cca9), [`e5e18af`](https://github.com/aio-proxy/aio-proxy/commit/e5e18af5f48f54c9dcc8e823fbcda137a97ad4b5), [`142cc1b`](https://github.com/aio-proxy/aio-proxy/commit/142cc1b419b0109585a53f020343d0eb72b6673f)]:
  - @aio-proxy/plugin-google-antigravity@0.16.0
  - @aio-proxy/plugin-openai-chatgpt@0.16.0
  - @aio-proxy/plugin-sdk@0.16.0
  - @aio-proxy/logger@0.16.0
  - @aio-proxy/plugin-cursor@0.16.0
  - @aio-proxy/plugin-github-copilot@0.16.0
  - @aio-proxy/plugin-kimi-code@0.16.0
  - @aio-proxy/plugin-xai-grok@0.16.0
  - @aio-proxy/i18n@0.16.0
  - @aio-proxy/shared@0.16.0
  - @aio-proxy/types@0.16.0

## 0.15.0

### Minor Changes

- [#243](https://github.com/aio-proxy/aio-proxy/pull/243) [`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91) Thanks @baranwang - OAuth providers now hide models with `excludedModels` instead of a `models` whitelist. Leftover `models` keys are ignored and no longer restrict exposure — newly discovered catalog ids stay visible unless hidden. Plugin default aliases inherit at runtime and are no longer written into the config file.

### Patch Changes

- Updated dependencies [[`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91)]:
  - @aio-proxy/types@0.15.0
  - @aio-proxy/plugin-sdk@0.15.0
  - @aio-proxy/plugin-cursor@0.15.0
  - @aio-proxy/plugin-openai-chatgpt@0.15.0
  - @aio-proxy/logger@0.15.0
  - @aio-proxy/plugin-github-copilot@0.15.0
  - @aio-proxy/plugin-google-antigravity@0.15.0
  - @aio-proxy/plugin-kimi-code@0.15.0
  - @aio-proxy/plugin-xai-grok@0.15.0
  - @aio-proxy/i18n@0.15.0
  - @aio-proxy/shared@0.15.0

## 0.14.0

### Minor Changes

- [#245](https://github.com/aio-proxy/aio-proxy/pull/245) [`3408993`](https://github.com/aio-proxy/aio-proxy/commit/340899373f0244e6dd240459d6e02d187998961f) Thanks @olivewind - Let AI SDK provider packages be installed from a configurable npm registry in the dashboard, and load model catalogs from packages that expose an optional `listModels` method.

### Patch Changes

- Updated dependencies [[`3408993`](https://github.com/aio-proxy/aio-proxy/commit/340899373f0244e6dd240459d6e02d187998961f)]:
  - @aio-proxy/i18n@0.14.0
  - @aio-proxy/logger@0.14.0
  - @aio-proxy/plugin-cursor@0.14.0
  - @aio-proxy/plugin-github-copilot@0.14.0
  - @aio-proxy/plugin-google-antigravity@0.14.0
  - @aio-proxy/plugin-kimi-code@0.14.0
  - @aio-proxy/plugin-openai-chatgpt@0.14.0
  - @aio-proxy/plugin-sdk@0.14.0
  - @aio-proxy/plugin-xai-grok@0.14.0
  - @aio-proxy/shared@0.14.0
  - @aio-proxy/types@0.14.0

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks @baranwang - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

### Patch Changes

- [#238](https://github.com/aio-proxy/aio-proxy/pull/238) [`99755b5`](https://github.com/aio-proxy/aio-proxy/commit/99755b58b7492f9da4161ac429325dd319ba48f8) Thanks @baranwang - core: preserve stable session affinity across supported language protocols and native Gemini Interactions continuations.
- Updated dependencies [[`99755b5`](https://github.com/aio-proxy/aio-proxy/commit/99755b58b7492f9da4161ac429325dd319ba48f8), [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d)]:
  - @aio-proxy/plugin-sdk@0.13.0
  - @aio-proxy/plugin-kimi-code@0.13.0
  - @aio-proxy/plugin-xai-grok@0.13.0
  - @aio-proxy/types@0.13.0
  - @aio-proxy/i18n@0.13.0
  - @aio-proxy/logger@0.13.0
  - @aio-proxy/plugin-cursor@0.13.0
  - @aio-proxy/plugin-github-copilot@0.13.0
  - @aio-proxy/plugin-google-antigravity@0.13.0
  - @aio-proxy/plugin-openai-chatgpt@0.13.0
  - @aio-proxy/shared@0.13.0

## 0.12.3

### Patch Changes

- [#235](https://github.com/aio-proxy/aio-proxy/pull/235) [`aeec254`](https://github.com/aio-proxy/aio-proxy/commit/aeec254e53904ecf656d055ea9f45029f5bb68a8) Thanks @baranwang - Group dashboard model cost and usage by the requested model alias instead of the upstream model a route resolved to.
- Updated dependencies []:
  - @aio-proxy/i18n@0.12.3
  - @aio-proxy/logger@0.12.3
  - @aio-proxy/plugin-cursor@0.12.3
  - @aio-proxy/plugin-github-copilot@0.12.3
  - @aio-proxy/plugin-google-antigravity@0.12.3
  - @aio-proxy/plugin-kimi-code@0.12.3
  - @aio-proxy/plugin-openai-chatgpt@0.12.3
  - @aio-proxy/plugin-sdk@0.12.3
  - @aio-proxy/plugin-xai-grok@0.12.3
  - @aio-proxy/shared@0.12.3
  - @aio-proxy/types@0.12.3

## 0.12.2

### Patch Changes

- [#233](https://github.com/aio-proxy/aio-proxy/pull/233) [`ccf42a4`](https://github.com/aio-proxy/aio-proxy/commit/ccf42a4555539dd311a0cc36eefd41e75afdd9ac) Thanks @baranwang - Emit completed output-item events for streamed OpenAI Responses reasoning and assistant messages so clients can finalize cross-protocol responses.
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

- [#231](https://github.com/aio-proxy/aio-proxy/pull/231) [`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6) Thanks @baranwang - dashboard: grade traces latency like new-api and show the lightning icon for fast/priority requests

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

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks @baranwang - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks @baranwang - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
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

- [#215](https://github.com/aio-proxy/aio-proxy/pull/215) [`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13) Thanks @baranwang - Add Gemini Interactions as an inbound protocol at `POST /v1beta/interactions`.

- [#212](https://github.com/aio-proxy/aio-proxy/pull/212) [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b) Thanks @baranwang - openai: add Completions and Responses compact ports `POST /v1/completions` and `POST /v1/responses/compact` now use the existing language-generation pipeline.

- [#213](https://github.com/aio-proxy/aio-proxy/pull/213) [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608) Thanks @baranwang - Add OpenAI Images inbound (`POST /v1/images/generations` and `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert.

- [#214](https://github.com/aio-proxy/aio-proxy/pull/214) [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612) Thanks @baranwang - Add inbound OpenAI Embeddings and Gemini embed/batch embed through same-protocol raw, embedding convert, and fallback.

### Patch Changes

- [#217](https://github.com/aio-proxy/aio-proxy/pull/217) [`e0c9ea0`](https://github.com/aio-proxy/aio-proxy/commit/e0c9ea0b6c8cea6329cf2eeefc2dc4ee2675d44c) Thanks @baranwang - Continue OpenAI Responses model fallback across completed hosted-search history and fall back xAI Grok OAuth custom grammar declarations to ordinary function tools with reversible client wire restoration.
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

- [#203](https://github.com/aio-proxy/aio-proxy/pull/203) [`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402) Thanks @baranwang - Add `aio-proxy provider import [path]` to copy supported CPA OAuth auth files into aio-proxy accounts. OAuth plugins can declare typed CPA credential importers through the plugin SDK, and the built-in ChatGPT, Google Antigravity, Kimi Code, and xAI Grok plugins now provide them.

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

- [#199](https://github.com/aio-proxy/aio-proxy/pull/199) [`fcef8e5`](https://github.com/aio-proxy/aio-proxy/commit/fcef8e5af578aee26df0db1b2ebb30bd6e50d3a0) Thanks @baranwang - Keep OpenAI Responses reasoning summaries with preceding tool calls so cross-protocol tool results remain adjacent.
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

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks @baranwang - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks @baranwang - Add managed OpenCode, Pi, and oh-my-pi Agent integrations.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks @baranwang - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab.

- [#190](https://github.com/aio-proxy/aio-proxy/pull/190) [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b) Thanks @baranwang - Add model-level Provider priority and weighted routing, stable-session candidate ordering, routing-v2 diagnostics, and a Dashboard Routing workspace. Provider weight now controls same-priority traffic instead of fixed global order; existing configurations should follow the documented migration table.

### Patch Changes

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e) Thanks @baranwang - An OAuth provider's `models` whitelist is now read and validated from the config file, where it was previously ignored.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1) Thanks @baranwang - Keep per-model metadata edits when saving an OAuth provider also re-authorizes it. The editor saves
  credentials and model metadata in one action; if the credential half required re-authorization, the
  login path rebuilt the provider entry from a patch that had no metadata field, so the metadata half
  of the save was silently discarded.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`237d9cd`](https://github.com/aio-proxy/aio-proxy/commit/237d9cd4f6810b6695a0624b61d7805991507e1e) Thanks @baranwang - Harden the OAuth provider update contract so a partial patch cannot delete a provider's display name, aliases, or model whitelist.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`cd6c5a3`](https://github.com/aio-proxy/aio-proxy/commit/cd6c5a3dd352ea22198d99345a6da3272510caca) Thanks @baranwang - Keep per-model metadata when an OAuth provider is re-authorized. Every re-login rebuilt the provider
  entry from a fixed field list that omitted `metadata`, so re-authorizing from the Dashboard or running
  `provider login` again deleted all per-model overrides — including `extend`, which is how a model
  tracks its models.dev source.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`a3cf9b5`](https://github.com/aio-proxy/aio-proxy/commit/a3cf9b55e0377cd8df102acf3fd9463ff5899207) Thanks @baranwang - A display name that is only whitespace now clears the key on an OAuth provider instead of being written into the config file.

- [#188](https://github.com/aio-proxy/aio-proxy/pull/188) [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc) Thanks @baranwang - core: pin the bundled Bun runtime to 1.4.0 and restore streamed request bodies through HTTP proxies. Bun 1.4.0 ships the `fetch` + `proxy` `ReadableStream` body fix, so `createProxyFetch` no longer buffers the request. Plugin runtime compatibility is now Bun `>=1.4.0`. Compiled macOS binaries are ad-hoc re-signed after `bun build --compile` so they launch on macOS 27. Release runs on macOS so that signature is applied when the CLI is actually published.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7) Thanks @baranwang - Plugin default aliases now respect a provider's `models` whitelist, so a background catalog refresh can no longer insert an alias target outside it and drop the whole provider out of routing.
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

- [#179](https://github.com/aio-proxy/aio-proxy/pull/179) [`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203) Thanks @baranwang - core: select alias targets from effort, thinking, and speed dimensions. A Gemini 1D variant key `off`/`OFF` no longer matches `thinkingLevel: "OFF"`; replace it with `{ "when": { "thinking": false }, "model": "…" }` (or drop the row and use the alias `model`) — shipped Antigravity defaults are unaffected.

- [#177](https://github.com/aio-proxy/aio-proxy/pull/177) [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705) Thanks @baranwang - API providers can declare multi-protocol `endpoints` (per-protocol or shared AI SDK-style base URLs). Raw passthrough now matches any natively supported protocol, Anthropic endpoints accept `auth: "bearer"`, and cross-protocol conversion keeps targeting the primary endpoint.

### Patch Changes

- [#180](https://github.com/aio-proxy/aio-proxy/pull/180) [`4f73aa6`](https://github.com/aio-proxy/aio-proxy/commit/4f73aa69236d458a8ad8c811287fad03d674ad43) Thanks @baranwang - core: accept namespaced custom tools and align replayed Codex custom/function call history to the unique flattened tool name
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

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Accept Anthropic requests that combine disabled thinking with `output_config.effort`. Keep slow models.dev refreshes off the startup path. Resolve model metadata per source (config overrides catalogs). Fix overview day ranges to read `usage_daily` instead of pruned spans.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

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

- [#160](https://github.com/aio-proxy/aio-proxy/pull/160) [`08a579c`](https://github.com/aio-proxy/aio-proxy/commit/08a579cad9b5192820cd42f2cbb6ba18e0bc9e18) Thanks @baranwang - Accept empty OpenAI Responses function-call arguments when converting requests across protocols.
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

- [#157](https://github.com/aio-proxy/aio-proxy/pull/157) [`ba2aeae`](https://github.com/aio-proxy/aio-proxy/commit/ba2aeae4dfae3d932e2a22ac97d816b74d32a5ca) Thanks @baranwang - core: stop rejecting OpenAI Responses `custom_tool_call` history that has no matching custom tool declaration. Codex compaction turns replay prior custom tool calls (e.g. `apply_patch`) while sending `tools: []`, which previously produced a 501 "OpenAI Responses feature is not supported: custom_tool_call". The transform now converts that history like any other tool call.
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

- [#150](https://github.com/aio-proxy/aio-proxy/pull/150) [`52cb5ce`](https://github.com/aio-proxy/aio-proxy/commit/52cb5cef04cd1532dac2a773ee61b4fefd72d54d) Thanks @baranwang - Allow OpenAI Responses requests with image detail hints to fall back across provider protocols.
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

- [#143](https://github.com/aio-proxy/aio-proxy/pull/143) [`5ab65bf`](https://github.com/aio-proxy/aio-proxy/commit/5ab65bf7ef8dd5b74e2589df30b6da7342436cb6) Thanks @baranwang - Support OpenAI Responses instructions and hosted web search on cross-protocol model routes.
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

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`963e395`](https://github.com/aio-proxy/aio-proxy/commit/963e3951a64644441a36b0ae4c9b93d644444d18) Thanks @baranwang - extend: resolve per-model `metadata.extend` into effective merged metadata — inherit a models.dev catalog entry as a base layer, deep-merged under your explicit fields, so cost accounting and model resolution both see the inherited values.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085) Thanks @baranwang - feat: per-provider model metadata & cost overrides Providers can now declare a `metadata` map keyed by upstream model id to override client-facing model metadata (name, description, token limits, capabilities) and cost accounting.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd) Thanks @baranwang - feat: meter image, web-search, and audio usage for per-event and audio fees The proxy now counts generated images and web-search invocations from served responses (OpenAI Responses output items and streamed AI SDK file/tool-call parts) and reads audio token counts from OpenAI-compatible usage.

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

- [#131](https://github.com/aio-proxy/aio-proxy/pull/131) [`1a525e8`](https://github.com/aio-proxy/aio-proxy/commit/1a525e861a0ef77668c3321f75171bb9e2880e9f) Thanks @baranwang - core: fix proxied streaming passthrough dropping the request body.
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

- [#129](https://github.com/aio-proxy/aio-proxy/pull/129) [`c6ecfc0`](https://github.com/aio-proxy/aio-proxy/commit/c6ecfc0dc81e6cb0f0c5cd7b27b79f32cfb0955c) Thanks @baranwang - normalize and downgrade reasoning effort per upstream model capability Inbound reasoning-effort values are now accepted leniently and clamped to what each candidate upstream model actually advertises, on both the raw-passthrough and AI SDK model-invocation paths.

### Patch Changes

- [#127](https://github.com/aio-proxy/aio-proxy/pull/127) [`d95834a`](https://github.com/aio-proxy/aio-proxy/commit/d95834ad85ea0352f5c389497ea008c687a80d64) Thanks @baranwang - core: upgrade the bundled Bun runtime to the 1.4 line so proxied streaming passthrough no longer drops the request body. Bun 1.3.x silently discarded a `ReadableStream` request body when `fetch` used a proxy, so `api` providers with a `proxy` configured hung until timeout on streaming requests (e.g. `openai-response` passthrough). The compiled binary embeds the build-time Bun runtime, so this is delivered by pinning the build toolchain to Bun 1.4.
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

- [#120](https://github.com/aio-proxy/aio-proxy/pull/120) [`38960fd`](https://github.com/aio-proxy/aio-proxy/commit/38960fd9fca94d3e38cb5277a5eb928a3962d96a) Thanks @baranwang - core: accept `role: "system"` messages on the Anthropic Messages endpoint (matching the official SDK's `MessageParam` union) and surface Zod validation path detail in 400 responses without leaking request values
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
