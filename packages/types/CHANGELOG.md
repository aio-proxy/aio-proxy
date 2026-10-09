# @aio-proxy/types

## 0.42.0

### Minor Changes

- [#499](https://github.com/aio-proxy/aio-proxy/pull/499) [`3758dc9`](https://github.com/aio-proxy/aio-proxy/commit/3758dc9ed72259d33df567cf69e8ef86c59d5ca9) Thanks @olivewind - Track shared proxy usage by named API key with an independent user ranking, whole-dashboard user filtering and caller attribution in traces. The ranking is shown when API key access is enabled, including for a single user. Saving keys requires unique labels, and a config file cannot reuse the same key ID. Caller identity survives key rotation and usage history remains available after traces expire.

- [#498](https://github.com/aio-proxy/aio-proxy/pull/498) [`a2c3d0e`](https://github.com/aio-proxy/aio-proxy/commit/a2c3d0e304db29be37a7284202e17ac3373f0dbb) Thanks @baranwang - Add the OpenAI Decisions API for predicate, choice, and score evaluations. Same-protocol requests pass through, including inline and HTTP(S) images; other evaluation providers share SystemOne routing, fallback, and conversion. Usage includes cache pricing, converted responses always include the full usage object, and evaluations that cannot be converted are still billed. Plugins can recognize the new Decisions protocol.

## 0.41.1

No changes in this release.

## 0.41.0

### Minor Changes

- [#494](https://github.com/aio-proxy/aio-proxy/pull/494) [`855383c`](https://github.com/aio-proxy/aio-proxy/commit/855383cd5f462aa5ad9bab48aab81d4123dcd659) Thanks @baranwang - The macOS menu bar can show one or two live metrics next to the icon: today's tokens, today's cost, requests in flight, and real-time output tokens per second. Pick them from the menu bar icon's right-click menu.

## 0.40.0

No changes in this release.

## 0.39.1

### Patch Changes

- [#491](https://github.com/aio-proxy/aio-proxy/pull/491) [`d5218bf`](https://github.com/aio-proxy/aio-proxy/commit/d5218bfaf68e0af8d9b97cc09ac90b3ebe2f8593) Thanks @baranwang - Allow large image histories and compressed recovery requests with a configurable 256 MiB request limit, including ChatGPT and Provider body transforms. Bound body logs independently to 64 MiB per hop and direction while preserving full forwarding, request diagnostics, and privacy protections.

## 0.39.0

### Minor Changes

- [#477](https://github.com/aio-proxy/aio-proxy/pull/477) [`94024af`](https://github.com/aio-proxy/aio-proxy/commit/94024af667f4b691cef234a3f305d6561c5a9192) Thanks @baranwang - `aiop agent configure claude-code` points Claude Code at aio-proxy by merging `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` into the global `~/.claude/settings.json`, leaving every other setting in place. Without proxy API keys it writes a placeholder token so Claude Code stops using its claude.ai login; with keys you choose one, in the terminal or on the Dashboard's Agents page. `agent list` shows the integration, and `agent remove claude-code` restores only those two keys.

- [#486](https://github.com/aio-proxy/aio-proxy/pull/486) [`a59559d`](https://github.com/aio-proxy/aio-proxy/commit/a59559db8ba07d62f1f2b8dab50a77b5fba272b8) Thanks @baranwang - ChatGPT and GitHub Copilot Providers can use the sign-in Codex or Copilot already keeps on this machine instead of a browser login; aio-proxy keeps Codex signed in when it refreshes, and removing the Provider never signs the tool out.

- [#483](https://github.com/aio-proxy/aio-proxy/pull/483) [`13ff41d`](https://github.com/aio-proxy/aio-proxy/commit/13ff41dba0d21ef4ec79589e0598d1973fb72f64) Thanks @baranwang - New opt-in `router.selection: quota-reset` (also a switch on the Dashboard Routing page): within each Provider priority tier, the subscription whose quota allowance expires soonest is tried first instead of the weighted draw, so allowance is not left to lapse on one subscription while another is drained. Session affinity still takes precedence, Providers without quota data follow in their weighted order, and the routing list and model details show measured traffic shares without deviation warnings. Nothing changes while the setting stays `weighted`.

- [#484](https://github.com/aio-proxy/aio-proxy/pull/484) [`b2e7941`](https://github.com/aio-proxy/aio-proxy/commit/b2e7941313846cea0c6e179f64c73cc137565e13) Thanks @baranwang - API and discoverable AI SDK Providers can set `syncModels: true` to follow upstream model lists without editing the config: models refresh every hour or on demand in the Dashboard, upstream outages and empty responses keep the last good list, and `excludedModels` hides exact model IDs while aliases can still target them. The Dashboard supports switching between manual and synced models, hiding models, and viewing the last refreshed time; hand-written `models` lists work as before.

### Patch Changes

- [#478](https://github.com/aio-proxy/aio-proxy/pull/478) [`dd47aa2`](https://github.com/aio-proxy/aio-proxy/commit/dd47aa2333b53934df5b65deec9d72894c629bfa) Thanks @baranwang - The dashboard no longer offers Repair for a Codex or Grok Build integration whose managed fields you edited. Setup deliberately does not overwrite your edits, so Repair always failed with "Something went wrong". The card now tells you to remove the integration (your edits are kept) and configure it again, and setup that hits edited fields reports exactly that instead of an unknown error.

## 0.38.0

No changes in this release.

## 0.37.0

No changes in this release.

## 0.36.1

No changes in this release.

## 0.36.0

### Minor Changes

- [#456](https://github.com/aio-proxy/aio-proxy/pull/456) [`dcb1ebd`](https://github.com/aio-proxy/aio-proxy/commit/dcb1ebd82b6fddd964c3083c83ff3c2d57c275be) Thanks @baranwang - `aio-proxy service start` now starts a loaded-but-stopped launchd service, `service restart` waits for the old job to unload, and a service whose binary was removed no longer respawns in a loop. A stopping proxy exits within 3 seconds. Groundwork for the macOS desktop app: a private `desktop-token` file in the proxy home, a local summary endpoint and a discovery command. An app-managed install never self-upgrades (the Dashboard hides "Update now" there), and `aio-proxy upgrade` never restarts an app-owned service.

## 0.35.1

No changes in this release.

## 0.35.0

### Minor Changes

- [#440](https://github.com/aio-proxy/aio-proxy/pull/440) [`76e2bc6`](https://github.com/aio-proxy/aio-proxy/commit/76e2bc6a2405ab48dca41ffcfbcc22189602d349) Thanks @baranwang - Routing groups models by vendor and shows each model's failover tiers (T1, T2, …) with every Provider's share, drift, and why one is left out. A model's page shows its route, traffic, and model info and pricing, which follow an automatically matched reference model unless overridden. Providers' default routing uses the same tiers with typed weights: 0 parks a Provider, and moving it between tiers keeps its weight, bringing a parked one back at 1.

## 0.34.0

### Minor Changes

- [#442](https://github.com/aio-proxy/aio-proxy/pull/442) [`6dbb50d`](https://github.com/aio-proxy/aio-proxy/commit/6dbb50deb8a3f7540802e67484056c5bfcfecd54) Thanks @baranwang - The dashboard has a new Agents page listing OpenCode, Pi, oh-my-pi, Codex, and Grok Build with their local status and authorizations. When the dashboard is opened on the machine running aio-proxy, each Agent can be configured, updated, repaired, or removed with one click, Codex through a setup form, and the device approval happens on the same page. Remote browsers and containers see read-only state and a link to each Agent's setup guide.

## 0.33.4

No changes in this release.

## 0.33.3

No changes in this release.

## 0.33.2

No changes in this release.

## 0.33.1

No changes in this release.

## 0.33.0

### Minor Changes

- [#422](https://github.com/aio-proxy/aio-proxy/pull/422) [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568) Thanks @baranwang - ChatGPT OAuth now offers optional Guardian approval strategies that evaluate with a selected System One Provider and model. The default keeps Codex behavior, and supported System One decisions can be final or send denials to the original model for review; unavailable evaluations fall back safely.

## 0.32.0

No changes in this release.

## 0.31.0

No changes in this release.

## 0.30.0

### Minor Changes

- [#404](https://github.com/aio-proxy/aio-proxy/pull/404) [`69867fc`](https://github.com/aio-proxy/aio-proxy/commit/69867fc1cf275d3f72f4ebea41a0ad8b4f398493) Thanks @baranwang - Settings can send the traces aio-proxy already records to OTLP endpoints. Add a destination URL, choose JSON or protobuf, and set headers. Export stays on when a destination fails, and the local traces page is unchanged.

## 0.29.0

### Minor Changes

- [#399](https://github.com/aio-proxy/aio-proxy/pull/399) [`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d) Thanks @baranwang - Trace timelines now use stable start ordering, standard HTTP and GenAI semantics, redacted upstream URLs, and accurate provider, failover, TTFT, and usage attribution. OAuth runtimes can explicitly declare their GenAI provider identity; raw transports can declare upstream URL templates, while converted calls omit templates unless authoritative transport metadata is available.

## 0.28.0

### Minor Changes

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`2841175`](https://github.com/aio-proxy/aio-proxy/commit/2841175f2d07089d13beaa629857227cbcd9d0d4) Thanks @baranwang - 调用链详情改为整页三个标签页。「详情」是带时间刻度的瀑布图和选中 span 的状态、耗时、Token 与可筛选属性；同模型同操作的成功样本够了，结束后才给延迟分位。计 token 调用链也能按请求模型筛选。属性加筛选时按这条调用链当天。
  「请求」「响应」按跳列出站和每次上游发送。抓包需 debug 日志，按启动时的配置读（热重载改 level/目录要等重启）；未开启、过期或缺天会说明原因。还在跑时详情会刷新，结束后再抓一次完整日志，跨零点才写完的正文也会扫到。视频请求和响应都不落正文。无正文的 GET/HEAD 记空终态，打开时不再误扫下一天。OAuth 的 `code`、`jwt` / `X-JWT` 会打码；相对 Location（`?token=`、`../jobs`）保持原路径写法。
  失败跳显示失败，清理未读正文不会把成功跳画成取消。客户端取消只留下异常类型时，那一跳仍是取消。取消的调用链不进成功/失败柱和延迟分位。未映射的上游异常也会留下推理层的尝试次数。

- [#382](https://github.com/aio-proxy/aio-proxy/pull/382) [`25f9ec0`](https://github.com/aio-proxy/aio-proxy/commit/25f9ec0be50b28f8f5cc75f20a250e8b0bbc8ed7) Thanks @baranwang - 调用链列表页进入时不再自动轮询，工具栏新增「实时」开关，时间范围选择器从筛选抽屉移到工具栏常驻。表格上方新增按时间分桶的成功/失败堆叠柱状图：图例显示区间总数并直接充当状态筛选，点击柱体把时间范围收窄到该桶，折叠状态记在本地。表格的「状态」列移到 HTTP 之后。

- [#394](https://github.com/aio-proxy/aio-proxy/pull/394) [`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334) Thanks @baranwang - Evaluate with TypeSafe System One. `POST /v1/systemone` routes System One requests like any other model request, with priority and weight failover and System One-shaped errors. Every answered evaluation records usage, so this traffic now bills. The dashboard offers the new `typesafe-systemone` protocol for providers and traces, and reports newer bundled AI SDK provider versions.

## 0.27.1

No changes in this release.

## 0.27.0

No changes in this release.

## 0.26.0

No changes in this release.

## 0.25.0

No changes in this release.

## 0.24.0

### Minor Changes

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`d50feb0`](https://github.com/aio-proxy/aio-proxy/commit/d50feb0764829686811aaff59b8134e47b493ea4) Thanks @YePiXpert - Add authenticated SOCKS5 outbound proxies and optional primary/backup proxy fallback, disabled by default. Only providers set to inherit use the global policy; independent provider primary/backup settings and direct connections override it. Fallback switches only before a request is sent and never bypasses the proxies.

## 0.23.2

No changes in this release.

## 0.23.1

No changes in this release.

## 0.23.0

### Minor Changes

- [#357](https://github.com/aio-proxy/aio-proxy/pull/357) [`6fd1738`](https://github.com/aio-proxy/aio-proxy/commit/6fd173878a3574113571b2cf8499e679f83e1b96) Thanks @baranwang - Add `server.requireApiKey` to turn caller key enforcement off without deleting the configured keys, with a matching switch in Settings; when it is off on a non-loopback bind the proxy logs a warning. Settings now shows the configured caller keys as they are authored — including `{{env.NAME}}` templates — instead of `****`, so a key can be read back, edited, and copied rather than only replaced.

## 0.22.1

No changes in this release.

## 0.22.0

### Minor Changes

- [#351](https://github.com/aio-proxy/aio-proxy/pull/351) [`c98e10c`](https://github.com/aio-proxy/aio-proxy/commit/c98e10c1decd66972d10561b3e0fdaa5aae84da0) Thanks @baranwang - Add interactive Codex setup with a customizable Provider ID and a choice to keep ChatGPT login via an existing proxy API key or use command authentication. Command authentication uses AIO Proxy device authorization and reuses a still-valid helper token. Setup preserves model settings and can migrate legacy history; removal respects user edits, revokes command credentials, and blocks when the config cannot be restored.

- [#344](https://github.com/aio-proxy/aio-proxy/pull/344) [`2d05095`](https://github.com/aio-proxy/aio-proxy/commit/2d0509557bbb35a14046ab0a5dcc0cc5e9563b4f) Thanks @baranwang - Add Grok Build integration with native AIO Proxy login, automatic credential refresh, installation revocation, and safe configuration removal.

- [#339](https://github.com/aio-proxy/aio-proxy/pull/339) [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789) Thanks @baranwang - Add official OpenAI Videos ports: create, retrieve, content, delete, remix, edits, and extensions.

## 0.21.0

No changes in this release.

## 0.20.5

### Patch Changes

- [#337](https://github.com/aio-proxy/aio-proxy/pull/337) [`7ca4736`](https://github.com/aio-proxy/aio-proxy/commit/7ca473664bff145f4f27570c2d4a36bd7179c854) Thanks @baranwang - Reasoning effort now clamps to what the chosen provider actually supports, read from the provider's
  own catalog first and models.dev only as a fallback, so a `max` request reaches a provider that
  supports `max` instead of arriving as `high`. Google Antigravity's variants, including its split
  Low/Medium/High Gemini wires, clamp down instead of failing the request, and an alias asked for more
  effort than its highest variant declares routes to that variant instead of the alias base.

## 0.20.4

No changes in this release.

## 0.20.3

### Patch Changes

- [#323](https://github.com/aio-proxy/aio-proxy/pull/323) [`6eca232`](https://github.com/aio-proxy/aio-proxy/commit/6eca2326aec9908634e4975448485b9972ea0ee8) Thanks @baranwang - The overview homepage stacks model trend as bars, shows Provider health as a table without filter or column controls, and ranks models by cost or Token.

## 0.20.2

### Patch Changes

- [#316](https://github.com/aio-proxy/aio-proxy/pull/316) [`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da) Thanks @baranwang - The plugin SDK now exports shared abortableSleep and dedupeQuotaItemIds helpers, preserving OAuth cancellation reasons and provider-specific quota IDs. Removed unused UI and internal wrappers, plus the unused AioModelMessage and AioStreamPart schemas and associated types from @aio-proxy/types.

## 0.20.1

No changes in this release.

## 0.20.0

### Minor Changes

- [#300](https://github.com/aio-proxy/aio-proxy/pull/300) [`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a) Thanks @baranwang - A running process checks npm `latest` on start, every 24 hours, and when the Dashboard mounts. It persists the result, prompts once per new version (Dashboard sidebar, CLI stderr banner, OS notification), and installs only after Update now or `aio-proxy upgrade`. Leftover `server.autoUpdate` in an existing config is ignored.

- [#301](https://github.com/aio-proxy/aio-proxy/pull/301) [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0) Thanks @baranwang - Add the OpenAI Audio inbound protocol.

## 0.19.2

No changes in this release.

## 0.19.1

No changes in this release.

## 0.19.0

## 0.18.1

## 0.18.0

### Patch Changes

- [#273](https://github.com/aio-proxy/aio-proxy/pull/273) [`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3) Thanks @baranwang - Show default routing tiers and same-tier weight percentages in an inset layer beneath each Provider card, including the tier number when there is only one tier.

## 0.17.0

### Minor Changes

- [#260](https://github.com/aio-proxy/aio-proxy/pull/260) [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f) Thanks @baranwang - Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16) Thanks @baranwang - Add, relabel, and remove API keys from Settings, including a one-click generator for a fresh random key. Stored keys stay masked and are never sent back to the browser, and authored `{{env.NAME}}` key templates survive a write unchanged. Key writes carry the revision of the key list they were made against, so a write is rejected with `409 stale_api_keys` when the config changed underneath instead of silently rewriting a different key.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2) Thanks @baranwang - Set and clear the Dashboard password from Settings. The password is stored only as an Argon2id hash, and changing it signs out every existing session.

### Patch Changes

- [#271](https://github.com/aio-proxy/aio-proxy/pull/271) [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd) Thanks @baranwang - dashboard: manage Provider and per-model priority tiers with one drag editor that moves whole tiers, creates tiers at drop slots, and adjusts traffic shares without an add-tier button

## 0.16.0

## 0.15.0

### Minor Changes

- [#243](https://github.com/aio-proxy/aio-proxy/pull/243) [`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91) Thanks @baranwang - OAuth providers now hide models with `excludedModels` instead of a `models` whitelist. Leftover `models` keys are ignored and no longer restrict exposure — newly discovered catalog ids stay visible unless hidden. Plugin default aliases inherit at runtime and are no longer written into the config file.

## 0.14.0

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks @baranwang - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

## 0.12.3

## 0.12.2

## 0.12.1

### Patch Changes

- [#231](https://github.com/aio-proxy/aio-proxy/pull/231) [`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6) Thanks @baranwang - dashboard: grade traces latency like new-api and show the lightning icon for fast/priority requests

  Chat Completions `service_tier` now maps onto the speed routing axis (`priority`/`fast` → fast, `flex` → flex), matching Responses.

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks @baranwang - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks @baranwang - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.

## 0.11.2

## 0.11.1

## 0.11.0

### Minor Changes

- [#215](https://github.com/aio-proxy/aio-proxy/pull/215) [`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13) Thanks @baranwang - Add Gemini Interactions as an inbound protocol at `POST /v1beta/interactions`.

- [#213](https://github.com/aio-proxy/aio-proxy/pull/213) [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608) Thanks @baranwang - Add OpenAI Images inbound (`POST /v1/images/generations` and `POST /v1/images/edits`) with same-protocol raw passthrough and `imageModel` convert.

## 0.10.0

## 0.9.1

### Patch Changes

- [#195](https://github.com/aio-proxy/aio-proxy/pull/195) [`1a1c519`](https://github.com/aio-proxy/aio-proxy/commit/1a1c519422c9be44a770646539803c929b5b9e43) Thanks @baranwang - Change the default local log retention from 14 days to 3 days.

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks @baranwang - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks @baranwang - The dashboard API connection editor can now select multiple protocols and give each one its own address. Saving writes the existing `endpoints` config instead of dropping it.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks @baranwang - Add managed OpenCode, Pi, and oh-my-pi Agent integrations.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks @baranwang - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab.

- [#190](https://github.com/aio-proxy/aio-proxy/pull/190) [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b) Thanks @baranwang - Add model-level Provider priority and weighted routing, stable-session candidate ordering, routing-v2 diagnostics, and a Dashboard Routing workspace. Provider weight now controls same-priority traffic instead of fixed global order; existing configurations should follow the documented migration table.

### Patch Changes

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8) Thanks @baranwang - Fix the provider editor silently corrupting alias variants that match on thinking or speed, and let the Dashboard author those conditions instead of only effort names.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks @baranwang - The provider editor now loads an unsaved model catalog with HTTP QUERY, and leftover kind-switch fields no longer block that request.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5) Thanks @baranwang - types: list a provider's own model ids before its aliases. The derived route list that feeds `/v1/models`,
  each provider's `clientModels`, and the provider editor's exposure preview put alias names first, so a
  provider that renames one model pushed that alias above the models the user actually typed into the
  whitelist. Direct ids now come first and aliases follow, in configuration order. Which models a provider
  exposes is unchanged — only the order of the listing.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250) Thanks @baranwang - The provider editor's Model aliases block now offers a Sync plugin aliases button for OAuth providers whose plugin ships default aliases.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7) Thanks @baranwang - Plugin default aliases now respect a provider's `models` whitelist, so a background catalog refresh can no longer insert an alias target outside it and drop the whole provider out of routing.

- [#184](https://github.com/aio-proxy/aio-proxy/pull/184) [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309) Thanks @baranwang - Cursor first-login now writes family aliases from AvailableModels, so clients can request names like `claude-sonnet-4-6` / `grok-4.6` and match thinking, effort, and speed onto the live wire slug.

## 0.8.0

### Minor Changes

- [#179](https://github.com/aio-proxy/aio-proxy/pull/179) [`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203) Thanks @baranwang - core: select alias targets from effort, thinking, and speed dimensions. A Gemini 1D variant key `off`/`OFF` no longer matches `thinkingLevel: "OFF"`; replace it with `{ "when": { "thinking": false }, "model": "…" }` (or drop the row and use the alias `model`) — shipped Antigravity defaults are unaffected.

- [#177](https://github.com/aio-proxy/aio-proxy/pull/177) [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705) Thanks @baranwang - API providers can declare multi-protocol `endpoints` (per-protocol or shared AI SDK-style base URLs). Raw passthrough now matches any natively supported protocol, Anthropic endpoints accept `auth: "bearer"`, and cross-protocol conversion keeps targeting the primary endpoint.

- [#176](https://github.com/aio-proxy/aio-proxy/pull/176) [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9) Thanks @baranwang - Allow authenticated remote model API access with labeled caller API keys.

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Accept Anthropic requests that combine disabled thinking with `output_config.effort`. Keep slow models.dev refreshes off the startup path. Resolve model metadata per source (config overrides catalogs). Fix overview day ranges to read `usage_daily` instead of pruned spans.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

## 0.6.4

## 0.6.3

## 0.6.2

## 0.6.1

## 0.6.0

### Minor Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085) Thanks @baranwang - feat: per-provider model metadata & cost overrides Providers can now declare a `metadata` map keyed by upstream model id to override client-facing model metadata (name, description, token limits, capabilities) and cost accounting.

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd) Thanks @baranwang - feat: meter image, web-search, and audio usage for per-event and audio fees The proxy now counts generated images and web-search invocations from served responses (OpenAI Responses output items and streamed AI SDK file/tool-call parts) and reads audio token counts from OpenAI-compatible usage.

### Patch Changes

- [#135](https://github.com/aio-proxy/aio-proxy/pull/135) [`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee) Thanks @baranwang - Fix model-metadata projection and billing gaps: - `/v1/models` now reflects per-provider config metadata overrides — capabilities, `limit.output` (max tokens), and modalities — not just the display name and context window.

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.0

## 0.3.0

## 0.2.1

## 0.2.0
