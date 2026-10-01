# @aio-proxy/dashboard

## 0.36.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/brand@0.36.1
  - @aio-proxy/i18n@0.36.1
  - @aio-proxy/plugin-sdk@0.36.1
  - @aio-proxy/server@0.36.1
  - @aio-proxy/types@0.36.1
  - @aio-proxy/ui@0.36.1

## 0.36.0

### Minor Changes

- [#456](https://github.com/aio-proxy/aio-proxy/pull/456) [`dcb1ebd`](https://github.com/aio-proxy/aio-proxy/commit/dcb1ebd82b6fddd964c3083c83ff3c2d57c275be) Thanks @baranwang - `aio-proxy service start` now starts a loaded-but-stopped launchd service, `service restart` waits for the old job to unload, and a service whose binary was removed no longer respawns in a loop. A stopping proxy exits within 3 seconds. Groundwork for the macOS desktop app: a private `desktop-token` file in the proxy home, a local summary endpoint and a discovery command. An app-managed install never self-upgrades (the Dashboard hides "Update now" there), and `aio-proxy upgrade` never restarts an app-owned service.

### Patch Changes

- [#457](https://github.com/aio-proxy/aio-proxy/pull/457) [`98aa84c`](https://github.com/aio-proxy/aio-proxy/commit/98aa84c42b513080f18edf43d7bc4ac8dbb924c5) Thanks @baranwang - The dashboard now waits out a brief server restart instead of showing "Dashboard unavailable" until reloaded. On the Routing page, token limits and prices follow the dashboard language (`128K`, `$2.00`) instead of the system one, traffic charts name Providers instead of showing their IDs, API Providers no longer list their protocol, and an empty traffic chart gets a proper empty state. Mixed CJK and Latin text is now auto-spaced.
- Updated dependencies [[`dcb1ebd`](https://github.com/aio-proxy/aio-proxy/commit/dcb1ebd82b6fddd964c3083c83ff3c2d57c275be), [`4869672`](https://github.com/aio-proxy/aio-proxy/commit/4869672879e888f4d07fa9efe385d588dbd0e80b), [`98aa84c`](https://github.com/aio-proxy/aio-proxy/commit/98aa84c42b513080f18edf43d7bc4ac8dbb924c5)]:
  - @aio-proxy/server@0.36.0
  - @aio-proxy/types@0.36.0
  - @aio-proxy/i18n@0.36.0
  - @aio-proxy/ui@0.36.0
  - @aio-proxy/plugin-sdk@0.36.0
  - @aio-proxy/brand@0.36.0

## 0.35.1

### Patch Changes

- [#451](https://github.com/aio-proxy/aio-proxy/pull/451) [`ab6524f`](https://github.com/aio-proxy/aio-proxy/commit/ab6524f69e2c48b2cd3039407916e07d43fd24f9) Thanks [@baranwang](https://github.com/baranwang)! - The dashboard Plugins page now shows Plugins as cards with search and All / Enabled / Failed / Built-in filters. A banner calls out Plugins that failed to load and jumps straight to them, and Add Plugin opens a compact dialog instead of a drawer.
- Updated dependencies []:
  - @aio-proxy/brand@0.35.1
  - @aio-proxy/i18n@0.35.1
  - @aio-proxy/plugin-sdk@0.35.1
  - @aio-proxy/server@0.35.1
  - @aio-proxy/types@0.35.1
  - @aio-proxy/ui@0.35.1

## 0.35.0

### Minor Changes

- [#440](https://github.com/aio-proxy/aio-proxy/pull/440) [`76e2bc6`](https://github.com/aio-proxy/aio-proxy/commit/76e2bc6a2405ab48dca41ffcfbcc22189602d349) Thanks @baranwang - Routing groups models by vendor and shows each model's failover tiers (T1, T2, …) with every Provider's share, drift, and why one is left out. A model's page shows its route, traffic, and model info and pricing, which follow an automatically matched reference model unless overridden. Providers' default routing uses the same tiers with typed weights: 0 parks a Provider, and moving it between tiers keeps its weight, bringing a parked one back at 1.

### Patch Changes

- [#440](https://github.com/aio-proxy/aio-proxy/pull/440) [`5a02aa1`](https://github.com/aio-proxy/aio-proxy/commit/5a02aa1360cc391ed99421e461bed5a558b40840) Thanks @baranwang - The Agents installations table no longer has a Columns menu for hiding columns; every column is always shown.

- [#440](https://github.com/aio-proxy/aio-proxy/pull/440) [`0250a99`](https://github.com/aio-proxy/aio-proxy/commit/0250a99f2f5b98d40ec54a76560b21268eaa3008) Thanks @baranwang - API and AI SDK Providers now show a plain API or package icon across the dashboard. API Providers no longer show protocol logos that looked like the upstream vendor, and AI SDK Providers no longer show the first letter of their name. Protocols and packages are still listed next to the name.
- Updated dependencies [[`c867d58`](https://github.com/aio-proxy/aio-proxy/commit/c867d58f4c660b4f9882447faba42bb38501b533), [`76e2bc6`](https://github.com/aio-proxy/aio-proxy/commit/76e2bc6a2405ab48dca41ffcfbcc22189602d349)]:
  - @aio-proxy/server@0.35.0
  - @aio-proxy/types@0.35.0
  - @aio-proxy/plugin-sdk@0.35.0
  - @aio-proxy/brand@0.35.0
  - @aio-proxy/i18n@0.35.0
  - @aio-proxy/ui@0.35.0

## 0.34.0

### Minor Changes

- [#442](https://github.com/aio-proxy/aio-proxy/pull/442) [`6dbb50d`](https://github.com/aio-proxy/aio-proxy/commit/6dbb50deb8a3f7540802e67484056c5bfcfecd54) Thanks @baranwang - The dashboard has a new Agents page listing OpenCode, Pi, oh-my-pi, Codex, and Grok Build with their local status and authorizations. When the dashboard is opened on the machine running aio-proxy, each Agent can be configured, updated, repaired, or removed with one click, Codex through a setup form, and the device approval happens on the same page. Remote browsers and containers see read-only state and a link to each Agent's setup guide.

### Patch Changes

- [#437](https://github.com/aio-proxy/aio-proxy/pull/437) [`5dea413`](https://github.com/aio-proxy/aio-proxy/commit/5dea4139c4567284858ae04c8636dd961e47af72) Thanks @baranwang - Agent authorization is completed on a single screen: the footer always offers stacked approve and deny buttons, disabled until the code entry is complete. Completing the code resolves it automatically — the request appears as a panel above the entry, a failed resolve shows an alert, and a code carried in a URL is simply pre-filled into the same flow. Approving or denying shows the final outcome, and expired, used, or already decided codes are reported with a toast.
- Updated dependencies [[`5dea413`](https://github.com/aio-proxy/aio-proxy/commit/5dea4139c4567284858ae04c8636dd961e47af72), [`6dbb50d`](https://github.com/aio-proxy/aio-proxy/commit/6dbb50deb8a3f7540802e67484056c5bfcfecd54), [`b2fb4a4`](https://github.com/aio-proxy/aio-proxy/commit/b2fb4a4c6fb246ee56502063ed410be19aad4f44)]:
  - @aio-proxy/i18n@0.34.0
  - @aio-proxy/ui@0.34.0
  - @aio-proxy/server@0.34.0
  - @aio-proxy/types@0.34.0
  - @aio-proxy/plugin-sdk@0.34.0
  - @aio-proxy/brand@0.34.0

## 0.33.4

### Patch Changes

- Updated dependencies [[`aab9a9a`](https://github.com/aio-proxy/aio-proxy/commit/aab9a9aabf02664dc973e1afdb1c9daab911be65)]:
  - @aio-proxy/i18n@0.33.4
  - @aio-proxy/server@0.33.4
  - @aio-proxy/brand@0.33.4
  - @aio-proxy/plugin-sdk@0.33.4
  - @aio-proxy/types@0.33.4
  - @aio-proxy/ui@0.33.4

## 0.33.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.33.3
  - @aio-proxy/brand@0.33.3
  - @aio-proxy/i18n@0.33.3
  - @aio-proxy/plugin-sdk@0.33.3
  - @aio-proxy/types@0.33.3
  - @aio-proxy/ui@0.33.3

## 0.33.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.33.2
  - @aio-proxy/brand@0.33.2
  - @aio-proxy/i18n@0.33.2
  - @aio-proxy/plugin-sdk@0.33.2
  - @aio-proxy/types@0.33.2
  - @aio-proxy/ui@0.33.2

## 0.33.1

### Patch Changes

- Updated dependencies [[`20b7733`](https://github.com/aio-proxy/aio-proxy/commit/20b7733ce0b7a6276e82bbfc582bb25923aac37a)]:
  - @aio-proxy/server@0.33.1
  - @aio-proxy/brand@0.33.1
  - @aio-proxy/i18n@0.33.1
  - @aio-proxy/plugin-sdk@0.33.1
  - @aio-proxy/types@0.33.1
  - @aio-proxy/ui@0.33.1

## 0.33.0

### Minor Changes

- [#422](https://github.com/aio-proxy/aio-proxy/pull/422) [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568) Thanks @baranwang - ChatGPT OAuth now offers optional Guardian approval strategies that evaluate with a selected System One Provider and model. The default keeps Codex behavior, and supported System One decisions can be final or send denials to the original model for review; unavailable evaluations fall back safely.

### Patch Changes

- [#420](https://github.com/aio-proxy/aio-proxy/pull/420) [`a85a7e0`](https://github.com/aio-proxy/aio-proxy/commit/a85a7e02e1c89f7311cd11cb961ec2f1db9885d1) Thanks @baranwang - Match OAuth service names in the trace list to the table body text, so they no longer appear heavier than the surrounding columns.
- Updated dependencies [[`de76673`](https://github.com/aio-proxy/aio-proxy/commit/de76673fe07ae3be9f3d7e3a84d1bd541ca07479), [`24a1468`](https://github.com/aio-proxy/aio-proxy/commit/24a14688083a14639af225a0d8d908373cf8f568)]:
  - @aio-proxy/plugin-sdk@0.33.0
  - @aio-proxy/types@0.33.0
  - @aio-proxy/server@0.33.0
  - @aio-proxy/i18n@0.33.0
  - @aio-proxy/brand@0.33.0
  - @aio-proxy/ui@0.33.0

## 0.32.0

### Patch Changes

- [#417](https://github.com/aio-proxy/aio-proxy/pull/417) [`2a7f9c0`](https://github.com/aio-proxy/aio-proxy/commit/2a7f9c0bdd5f2a8528659fd2b5d41914ea9d5d8c) Thanks @baranwang - Show OAuth service names alongside account labels in the trace list, so requests using the same email can be distinguished by their upstream provider.
- Updated dependencies [[`af0b53f`](https://github.com/aio-proxy/aio-proxy/commit/af0b53fe8acabc74a15818dbce1847ed3510554a), [`80983cd`](https://github.com/aio-proxy/aio-proxy/commit/80983cdb7dcf9368388c5d9cc9b86ceea3b6322f)]:
  - @aio-proxy/server@0.32.0
  - @aio-proxy/brand@0.32.0
  - @aio-proxy/i18n@0.32.0
  - @aio-proxy/plugin-sdk@0.32.0
  - @aio-proxy/types@0.32.0
  - @aio-proxy/ui@0.32.0

## 0.31.0

### Patch Changes

- [#411](https://github.com/aio-proxy/aio-proxy/pull/411) [`38b4c2d`](https://github.com/aio-proxy/aio-proxy/commit/38b4c2d47697aee41c12f5b6ab4fc28cd1d2d8b0) Thanks @baranwang - The OpenTelemetry destination form is now translated. Header rows can be removed, and only the first header or API key row shows field labels.

- [#409](https://github.com/aio-proxy/aio-proxy/pull/409) [`fd01333`](https://github.com/aio-proxy/aio-proxy/commit/fd01333243b264180db8480a1220909b39af72ae) Thanks @baranwang - The trace list and the trace detail header show a Provider by its configured name, or account label, with the Provider ID on hover. They no longer draw the provider mark next to that name.
- Updated dependencies [[`f0b3105`](https://github.com/aio-proxy/aio-proxy/commit/f0b3105e4dc74a674303c89e1d2eb2e106b7b12b), [`24209ab`](https://github.com/aio-proxy/aio-proxy/commit/24209ab085ab5155cb37055383b77e5ef11e9c9a), [`38b4c2d`](https://github.com/aio-proxy/aio-proxy/commit/38b4c2d47697aee41c12f5b6ab4fc28cd1d2d8b0)]:
  - @aio-proxy/plugin-sdk@0.31.0
  - @aio-proxy/server@0.31.0
  - @aio-proxy/i18n@0.31.0
  - @aio-proxy/brand@0.31.0
  - @aio-proxy/types@0.31.0
  - @aio-proxy/ui@0.31.0

## 0.30.0

### Minor Changes

- [#404](https://github.com/aio-proxy/aio-proxy/pull/404) [`69867fc`](https://github.com/aio-proxy/aio-proxy/commit/69867fc1cf275d3f72f4ebea41a0ad8b4f398493) Thanks @baranwang - Settings can send the traces aio-proxy already records to OTLP endpoints. Add a destination URL, choose JSON or protobuf, and set headers. Export stays on when a destination fails, and the local traces page is unchanged.

### Patch Changes

- [#402](https://github.com/aio-proxy/aio-proxy/pull/402) [`739e846`](https://github.com/aio-proxy/aio-proxy/commit/739e8465e605c866bcfaaedb1ba05ef1a81db8d4) Thanks @baranwang - Trace detail is titled with the request's root operation, such as `POST /v1/responses`. Failed spans in the timeline no longer show an alert icon next to the name.

- [#402](https://github.com/aio-proxy/aio-proxy/pull/402) [`e9e80c0`](https://github.com/aio-proxy/aio-proxy/commit/e9e80c0cd7224886d1e04a0c98f0547803cd0ccf) Thanks @baranwang - Trace list and trace detail show a Provider the same way the providers page does: its configured name, or account label, with the Provider ID on hover. The list column is labeled Provider. An ID missing from the catalog, or a catalog that failed to load, stays as the Provider ID.
- Updated dependencies [[`23faacb`](https://github.com/aio-proxy/aio-proxy/commit/23faacb68ea76edfc0f379e602f16023ad749b46), [`69867fc`](https://github.com/aio-proxy/aio-proxy/commit/69867fc1cf275d3f72f4ebea41a0ad8b4f398493)]:
  - @aio-proxy/i18n@0.30.0
  - @aio-proxy/types@0.30.0
  - @aio-proxy/server@0.30.0
  - @aio-proxy/plugin-sdk@0.30.0
  - @aio-proxy/brand@0.30.0
  - @aio-proxy/ui@0.30.0

## 0.29.0

### Minor Changes

- [#399](https://github.com/aio-proxy/aio-proxy/pull/399) [`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d) Thanks @baranwang - Trace timelines now use stable start ordering, standard HTTP and GenAI semantics, redacted upstream URLs, and accurate provider, failover, TTFT, and usage attribution. OAuth runtimes can explicitly declare their GenAI provider identity; raw transports can declare upstream URL templates, while converted calls omit templates unless authoritative transport metadata is available.

### Patch Changes

- Updated dependencies [[`571c394`](https://github.com/aio-proxy/aio-proxy/commit/571c3944b9345196468a241212618def08955d9d)]:
  - @aio-proxy/plugin-sdk@0.29.0
  - @aio-proxy/server@0.29.0
  - @aio-proxy/types@0.29.0
  - @aio-proxy/brand@0.29.0
  - @aio-proxy/i18n@0.29.0
  - @aio-proxy/ui@0.29.0

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

- Updated dependencies [[`c81d4af`](https://github.com/aio-proxy/aio-proxy/commit/c81d4afed84aca4a891180187f5f43b8fcc4e60c), [`2841175`](https://github.com/aio-proxy/aio-proxy/commit/2841175f2d07089d13beaa629857227cbcd9d0d4), [`25f9ec0`](https://github.com/aio-proxy/aio-proxy/commit/25f9ec0be50b28f8f5cc75f20a250e8b0bbc8ed7), [`9b016b3`](https://github.com/aio-proxy/aio-proxy/commit/9b016b37234aec0607d92a84362dd0ee8ab10a15), [`54e1619`](https://github.com/aio-proxy/aio-proxy/commit/54e161907a466d958695320e71c80f9c7a2e770c), [`21d30e3`](https://github.com/aio-proxy/aio-proxy/commit/21d30e321b902e2fba11801b23ce87aad6207334)]:
  - @aio-proxy/server@0.28.0
  - @aio-proxy/i18n@0.28.0
  - @aio-proxy/types@0.28.0
  - @aio-proxy/ui@0.28.0
  - @aio-proxy/plugin-sdk@0.28.0
  - @aio-proxy/brand@0.28.0

## 0.27.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/brand@0.27.1
  - @aio-proxy/i18n@0.27.1
  - @aio-proxy/plugin-sdk@0.27.1
  - @aio-proxy/server@0.27.1
  - @aio-proxy/types@0.27.1
  - @aio-proxy/ui@0.27.1

## 0.27.0

### Minor Changes

- [#390](https://github.com/aio-proxy/aio-proxy/pull/390) [`37ac185`](https://github.com/aio-proxy/aio-proxy/commit/37ac185ab77e4f4d4b59e541f7f4399217a0f801) Thanks @baranwang - The Dashboard login now persists in the browser, so opening a new tab or restarting the browser no longer asks for the password again. The login renews itself while you keep using the Dashboard, so visiting at least once every 6 days keeps you signed in, and an unused login expires after seven days. Logging out in one tab logs out every other tab, and changing `server.password` still invalidates the login on every device immediately.

- [#383](https://github.com/aio-proxy/aio-proxy/pull/383) [`bafe0fa`](https://github.com/aio-proxy/aio-proxy/commit/bafe0fa2277d32ff502cf03f0cdb7e96c7970c30) Thanks @baranwang - Quota details put this window's used API-equivalent spend on the reset row. Hover it for the exact used amount and an estimated period total from used versus remaining quota. That estimate is local API equivalent, not a vendor balance.

### Patch Changes

- Updated dependencies [[`37ac185`](https://github.com/aio-proxy/aio-proxy/commit/37ac185ab77e4f4d4b59e541f7f4399217a0f801), [`bafe0fa`](https://github.com/aio-proxy/aio-proxy/commit/bafe0fa2277d32ff502cf03f0cdb7e96c7970c30)]:
  - @aio-proxy/server@0.27.0
  - @aio-proxy/i18n@0.27.0
  - @aio-proxy/brand@0.27.0
  - @aio-proxy/plugin-sdk@0.27.0
  - @aio-proxy/types@0.27.0
  - @aio-proxy/ui@0.27.0

## 0.26.0

### Minor Changes

- [#380](https://github.com/aio-proxy/aio-proxy/pull/380) [`3b81cd0`](https://github.com/aio-proxy/aio-proxy/commit/3b81cd0bf7b7746f539652f21efac70ee5e4720e) Thanks @baranwang, @YePiXpert - Quota details show this instance's API-equivalent spend for each OAuth window. It is not the vendor balance.

### Patch Changes

- [#377](https://github.com/aio-proxy/aio-proxy/pull/377) [`7e02db8`](https://github.com/aio-proxy/aio-proxy/commit/7e02db80b0be294c5a02b2e7b7d2350d666868c5) Thanks @baranwang - Settings → About now shows only one version action at a time. When a newer release is available, the row keeps "Update now" and hides "Check for updates". After a failed or unavailable install, both stay so the user can recheck or retry.
- Updated dependencies [[`3b81cd0`](https://github.com/aio-proxy/aio-proxy/commit/3b81cd0bf7b7746f539652f21efac70ee5e4720e)]:
  - @aio-proxy/server@0.26.0
  - @aio-proxy/i18n@0.26.0
  - @aio-proxy/brand@0.26.0
  - @aio-proxy/plugin-sdk@0.26.0
  - @aio-proxy/types@0.26.0
  - @aio-proxy/ui@0.26.0

## 0.25.0

### Patch Changes

- Updated dependencies [[`d94e381`](https://github.com/aio-proxy/aio-proxy/commit/d94e38184a5e10f11f0cefd113e9919a5e094cff)]:
  - @aio-proxy/server@0.25.0
  - @aio-proxy/brand@0.25.0
  - @aio-proxy/i18n@0.25.0
  - @aio-proxy/plugin-sdk@0.25.0
  - @aio-proxy/types@0.25.0
  - @aio-proxy/ui@0.25.0

## 0.24.0

### Minor Changes

- [#370](https://github.com/aio-proxy/aio-proxy/pull/370) [`d50feb0`](https://github.com/aio-proxy/aio-proxy/commit/d50feb0764829686811aaff59b8134e47b493ea4) Thanks @YePiXpert - Add authenticated SOCKS5 outbound proxies and optional primary/backup proxy fallback, disabled by default. Only providers set to inherit use the global policy; independent provider primary/backup settings and direct connections override it. Fallback switches only before a request is sent and never bypasses the proxies.

### Patch Changes

- Updated dependencies [[`1cb5c9f`](https://github.com/aio-proxy/aio-proxy/commit/1cb5c9f3fc91c5e48ef673eb7be0b9971942386e), [`d50feb0`](https://github.com/aio-proxy/aio-proxy/commit/d50feb0764829686811aaff59b8134e47b493ea4), [`9de6d0e`](https://github.com/aio-proxy/aio-proxy/commit/9de6d0ec7fde99c9de87f993d3c1fb8f890690fe)]:
  - @aio-proxy/plugin-sdk@0.24.0
  - @aio-proxy/server@0.24.0
  - @aio-proxy/types@0.24.0
  - @aio-proxy/i18n@0.24.0
  - @aio-proxy/brand@0.24.0
  - @aio-proxy/ui@0.24.0

## 0.23.2

### Patch Changes

- [#365](https://github.com/aio-proxy/aio-proxy/pull/365) [`f4d4ed1`](https://github.com/aio-proxy/aio-proxy/commit/f4d4ed10166dfa1379e31b19938f64e64488e97a) Thanks @YePiXpert - Preserve the full upstream URL when creating or editing single-protocol API endpoints in the Dashboard. Gateways such as Command Code now retain their required path prefixes after saving; existing legacy single-protocol configurations retain their original URL behavior.
- Updated dependencies []:
  - @aio-proxy/server@0.23.2
  - @aio-proxy/brand@0.23.2
  - @aio-proxy/i18n@0.23.2
  - @aio-proxy/plugin-sdk@0.23.2
  - @aio-proxy/types@0.23.2
  - @aio-proxy/ui@0.23.2

## 0.23.1

### Patch Changes

- [#362](https://github.com/aio-proxy/aio-proxy/pull/362) [`1658708`](https://github.com/aio-proxy/aio-proxy/commit/1658708238094422610bcae1f05bbebd08186d97) Thanks @baranwang - Fix manual OAuth callback submission in the Dashboard without navigating the editor page.
- Updated dependencies []:
  - @aio-proxy/brand@0.23.1
  - @aio-proxy/i18n@0.23.1
  - @aio-proxy/plugin-sdk@0.23.1
  - @aio-proxy/server@0.23.1
  - @aio-proxy/types@0.23.1
  - @aio-proxy/ui@0.23.1

## 0.23.0

### Minor Changes

- [#357](https://github.com/aio-proxy/aio-proxy/pull/357) [`6fd1738`](https://github.com/aio-proxy/aio-proxy/commit/6fd173878a3574113571b2cf8499e679f83e1b96) Thanks @baranwang - Add `server.requireApiKey` to turn caller key enforcement off without deleting the configured keys, with a matching switch in Settings; when it is off on a non-loopback bind the proxy logs a warning. Settings now shows the configured caller keys as they are authored — including `{{env.NAME}}` templates — instead of `****`, so a key can be read back, edited, and copied rather than only replaced.

### Patch Changes

- Updated dependencies [[`6fd1738`](https://github.com/aio-proxy/aio-proxy/commit/6fd173878a3574113571b2cf8499e679f83e1b96)]:
  - @aio-proxy/types@0.23.0
  - @aio-proxy/server@0.23.0
  - @aio-proxy/plugin-sdk@0.23.0
  - @aio-proxy/brand@0.23.0
  - @aio-proxy/i18n@0.23.0
  - @aio-proxy/ui@0.23.0

## 0.22.1

### Patch Changes

- [#355](https://github.com/aio-proxy/aio-proxy/pull/355) [`6484bef`](https://github.com/aio-proxy/aio-proxy/commit/6484bef7a020406a4ced6ea40dc027167d88cbf9) Thanks @olivewind - Fix the settings page crashing when adding an API key through an HTTP connection to a remote host.
- Updated dependencies []:
  - @aio-proxy/brand@0.22.1
  - @aio-proxy/i18n@0.22.1
  - @aio-proxy/plugin-sdk@0.22.1
  - @aio-proxy/server@0.22.1
  - @aio-proxy/types@0.22.1
  - @aio-proxy/ui@0.22.1

## 0.22.0

### Minor Changes

- [#339](https://github.com/aio-proxy/aio-proxy/pull/339) [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789) Thanks @baranwang - Add official OpenAI Videos ports: create, retrieve, content, delete, remix, edits, and extensions.

### Patch Changes

- Updated dependencies [[`c98e10c`](https://github.com/aio-proxy/aio-proxy/commit/c98e10c1decd66972d10561b3e0fdaa5aae84da0), [`2d05095`](https://github.com/aio-proxy/aio-proxy/commit/2d0509557bbb35a14046ab0a5dcc0cc5e9563b4f), [`00a17a3`](https://github.com/aio-proxy/aio-proxy/commit/00a17a399d7bebb58cc929b77923935f3be8927a), [`834f9b3`](https://github.com/aio-proxy/aio-proxy/commit/834f9b359f29b229e3930a0b435200d805361789), [`4c57408`](https://github.com/aio-proxy/aio-proxy/commit/4c574088a806967bab32485a7dc0e4d72affe899)]:
  - @aio-proxy/types@0.22.0
  - @aio-proxy/server@0.22.0
  - @aio-proxy/i18n@0.22.0
  - @aio-proxy/plugin-sdk@0.22.0
  - @aio-proxy/brand@0.22.0
  - @aio-proxy/ui@0.22.0

## 0.21.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.21.0
  - @aio-proxy/brand@0.21.0
  - @aio-proxy/i18n@0.21.0
  - @aio-proxy/plugin-sdk@0.21.0
  - @aio-proxy/types@0.21.0
  - @aio-proxy/ui@0.21.0

## 0.20.5

### Patch Changes

- [#336](https://github.com/aio-proxy/aio-proxy/pull/336) [`9817de6`](https://github.com/aio-proxy/aio-proxy/commit/9817de664952238e234e000d81daccb8a0b39d8c) Thanks @baranwang - Update status is now reported by toast instead of wrapped text inside the sidebar card and the About row. The "Update now" button no longer sits permanently disabled next to "Check for updates" — it appears only when a newer release is available, an install is running, a restart is pending, or an install failed. The restart notice stays until dismissed.
- Updated dependencies [[`7ca4736`](https://github.com/aio-proxy/aio-proxy/commit/7ca473664bff145f4f27570c2d4a36bd7179c854)]:
  - @aio-proxy/types@0.20.5
  - @aio-proxy/server@0.20.5
  - @aio-proxy/plugin-sdk@0.20.5
  - @aio-proxy/brand@0.20.5
  - @aio-proxy/i18n@0.20.5
  - @aio-proxy/ui@0.20.5

## 0.20.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/brand@0.20.4
  - @aio-proxy/i18n@0.20.4
  - @aio-proxy/plugin-sdk@0.20.4
  - @aio-proxy/server@0.20.4
  - @aio-proxy/types@0.20.4
  - @aio-proxy/ui@0.20.4

## 0.20.3

### Patch Changes

- [#323](https://github.com/aio-proxy/aio-proxy/pull/323) [`6eca232`](https://github.com/aio-proxy/aio-proxy/commit/6eca2326aec9908634e4975448485b9972ea0ee8) Thanks @baranwang - The overview homepage stacks model trend as bars, shows Provider health as a table without filter or column controls, and ranks models by cost or Token.
- Updated dependencies [[`6eca232`](https://github.com/aio-proxy/aio-proxy/commit/6eca2326aec9908634e4975448485b9972ea0ee8)]:
  - @aio-proxy/types@0.20.3
  - @aio-proxy/i18n@0.20.3
  - @aio-proxy/server@0.20.3
  - @aio-proxy/plugin-sdk@0.20.3
  - @aio-proxy/brand@0.20.3
  - @aio-proxy/ui@0.20.3

## 0.20.2

### Patch Changes

- [#315](https://github.com/aio-proxy/aio-proxy/pull/315) [`adb01e8`](https://github.com/aio-proxy/aio-proxy/commit/adb01e84078ccad4ec34f0fd13ef10a79f10f604) Thanks @baranwang - The About card now uses the same row spacing as the other settings groups. Check for updates is hidden as soon as an update starts. After a successful install, aio-proxy restarts itself and the dashboard reloads instead of asking you to restart by hand.

- [#316](https://github.com/aio-proxy/aio-proxy/pull/316) [`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da) Thanks @baranwang - The plugin SDK now exports shared abortableSleep and dedupeQuotaItemIds helpers, preserving OAuth cancellation reasons and provider-specific quota IDs. Removed unused UI and internal wrappers, plus the unused AioModelMessage and AioStreamPart schemas and associated types from @aio-proxy/types.
- Updated dependencies [[`3b4c12e`](https://github.com/aio-proxy/aio-proxy/commit/3b4c12e0e3f5b502cacf4c22aa9a88188608c3da)]:
  - @aio-proxy/types@0.20.2
  - @aio-proxy/ui@0.20.2
  - @aio-proxy/plugin-sdk@0.20.2
  - @aio-proxy/server@0.20.2
  - @aio-proxy/brand@0.20.2
  - @aio-proxy/i18n@0.20.2

## 0.20.1

### Patch Changes

- [#312](https://github.com/aio-proxy/aio-proxy/pull/312) [`757c270`](https://github.com/aio-proxy/aio-proxy/commit/757c270f88a6a13e5bab6cf56ab6aad3f1a03280) Thanks @baranwang - The pace mark on a subscription quota bar now explains itself on hover instead of relying on a
  browser tooltip, and its outline is thicker so the mark stays legible where it sits on top of the
  filled part of the bar.
- Updated dependencies []:
  - @aio-proxy/server@0.20.1
  - @aio-proxy/brand@0.20.1
  - @aio-proxy/i18n@0.20.1
  - @aio-proxy/plugin-sdk@0.20.1
  - @aio-proxy/types@0.20.1
  - @aio-proxy/ui@0.20.1

## 0.20.0

### Minor Changes

- [#300](https://github.com/aio-proxy/aio-proxy/pull/300) [`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a) Thanks @baranwang - A running process checks npm `latest` on start, every 24 hours, and when the Dashboard mounts. It persists the result, prompts once per new version (Dashboard sidebar, CLI stderr banner, OS notification), and installs only after Update now or `aio-proxy upgrade`. Leftover `server.autoUpdate` in an existing config is ignored.

- [#301](https://github.com/aio-proxy/aio-proxy/pull/301) [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0) Thanks @baranwang - Add the OpenAI Audio inbound protocol.

- [#308](https://github.com/aio-proxy/aio-proxy/pull/308) [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3) Thanks @baranwang - Subscription quota bars now mark where an even burn would have left the allowance by now, turning
  red when the window is being spent faster than that and drawing nothing while it tracks even. The
  marker appears wherever the provider reports how long the window lasts, which the bundled OAuth
  plugins now do; plugins can opt in through the new optional `OAuthQuotaItem.windowMinutes`. The
  reading is also spoken by the bar's accessible value text.

### Patch Changes

- Updated dependencies [[`13a6c91`](https://github.com/aio-proxy/aio-proxy/commit/13a6c9153739049dab5443dd3ac7d570f7e80690), [`692795c`](https://github.com/aio-proxy/aio-proxy/commit/692795c49f26e93e93af79cb611043a1e82c307a), [`84b206c`](https://github.com/aio-proxy/aio-proxy/commit/84b206c1d2f296748d2b86cedf0ef97c2b65d8e2), [`681b039`](https://github.com/aio-proxy/aio-proxy/commit/681b039164281d7ab28c09ce1a61aae064caa6a0), [`8b02edd`](https://github.com/aio-proxy/aio-proxy/commit/8b02edd711a54102661c41199a60f10396f7dce3)]:
  - @aio-proxy/plugin-sdk@0.20.0
  - @aio-proxy/server@0.20.0
  - @aio-proxy/types@0.20.0
  - @aio-proxy/i18n@0.20.0
  - @aio-proxy/brand@0.20.0
  - @aio-proxy/ui@0.20.0

## 0.19.2

### Patch Changes

- [#296](https://github.com/aio-proxy/aio-proxy/pull/296) [`46087fb`](https://github.com/aio-proxy/aio-proxy/commit/46087fb5ab1d28295e9912d8873e2ef574963c2a) Thanks @baranwang - dashboard: point the Settings documentation link at https://aioproxy.dev

- [#292](https://github.com/aio-proxy/aio-proxy/pull/292) [`4f4e324`](https://github.com/aio-proxy/aio-proxy/commit/4f4e324c4625a1d4582d4292b7b9e3e96cbdabb6) Thanks @baranwang - On the OAuth provider editor, put Connection above Identity and fill a blank display name from the account label after a successful login.

- [#293](https://github.com/aio-proxy/aio-proxy/pull/293) [`cf45f02`](https://github.com/aio-proxy/aio-proxy/commit/cf45f0222aa85754e64f19dee184228769c97ddd) Thanks @baranwang - Render the AIO Proxy wordmark from vector geometry instead of a webfont The dashboard logo drew "Proxy" with an SVG `<text>` element styled `font-heading font-semibold`.

- Updated dependencies [[`83c67f1`](https://github.com/aio-proxy/aio-proxy/commit/83c67f1cf670752e14ebf66bc95ab0799923b48e), [`4f3154e`](https://github.com/aio-proxy/aio-proxy/commit/4f3154e79a3f2bf1d5d23081e8dd099cc7841ecd), [`cf45f02`](https://github.com/aio-proxy/aio-proxy/commit/cf45f0222aa85754e64f19dee184228769c97ddd)]:
  - @aio-proxy/server@0.19.2
  - @aio-proxy/brand@0.19.2
  - @aio-proxy/ui@0.19.2
  - @aio-proxy/i18n@0.19.2
  - @aio-proxy/plugin-sdk@0.19.2
  - @aio-proxy/types@0.19.2

## 0.19.1

### Patch Changes

- Updated dependencies [[`80f8b9d`](https://github.com/aio-proxy/aio-proxy/commit/80f8b9d10eef15214fc3f55342ccf097fc00b6ef)]:
  - @aio-proxy/plugin-sdk@0.19.1
  - @aio-proxy/server@0.19.1
  - @aio-proxy/i18n@0.19.1
  - @aio-proxy/types@0.19.1
  - @aio-proxy/ui@0.19.1

## 0.19.0

### Minor Changes

- [#282](https://github.com/aio-proxy/aio-proxy/pull/282) [`d3bec51`](https://github.com/aio-proxy/aio-proxy/commit/d3bec51577cb5e4fbb057b459acbf76acea3b828) Thanks @baranwang - Make the Provider editor's catalog button actually re-fetch an OAuth Provider's model list. It only ever re-read the persisted catalog, so until the plugin's TTL expired — six hours for ChatGPT — the button silently redrew the same rows. It now forces a rediscovery upstream, waits for the new catalog to be readable, and reports failures instead of looking like a success. Disabled OAuth Providers can be refreshed this way too; they are still never rediscovered on a timer.

### Patch Changes

- [#276](https://github.com/aio-proxy/aio-proxy/pull/276) [`2e76766`](https://github.com/aio-proxy/aio-proxy/commit/2e7676669a60d42af8d545e8d1614a295fabfae6) Thanks @baranwang - Make a quota reset redemption legible while it happens.

- Updated dependencies [[`d3bec51`](https://github.com/aio-proxy/aio-proxy/commit/d3bec51577cb5e4fbb057b459acbf76acea3b828), [`2e76766`](https://github.com/aio-proxy/aio-proxy/commit/2e7676669a60d42af8d545e8d1614a295fabfae6)]:
  - @aio-proxy/server@0.19.0
  - @aio-proxy/i18n@0.19.0
  - @aio-proxy/ui@0.19.0
  - @aio-proxy/plugin-sdk@0.19.0
  - @aio-proxy/types@0.19.0

## 0.18.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.18.1
  - @aio-proxy/i18n@0.18.1
  - @aio-proxy/plugin-sdk@0.18.1
  - @aio-proxy/types@0.18.1
  - @aio-proxy/ui@0.18.1

## 0.18.0

### Minor Changes

- [#274](https://github.com/aio-proxy/aio-proxy/pull/274) [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664) Thanks @baranwang - Redeem ChatGPT rate-limit reset credits from the Dashboard.

### Patch Changes

- [#273](https://github.com/aio-proxy/aio-proxy/pull/273) [`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3) Thanks @baranwang - Keep dragged tier headers visible while Provider and model routing tier contents smoothly collapse and expand.

- [#273](https://github.com/aio-proxy/aio-proxy/pull/273) [`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3) Thanks @baranwang - Show default routing tiers and same-tier weight percentages in an inset layer beneath each Provider card, including the tier number when there is only one tier.

- Updated dependencies [[`9608e07`](https://github.com/aio-proxy/aio-proxy/commit/9608e070b5faf585cf591fa007e190e7493362c3), [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664), [`1cf2838`](https://github.com/aio-proxy/aio-proxy/commit/1cf2838bb8cec1ed8e3354646b1b39d2695d3664)]:
  - @aio-proxy/i18n@0.18.0
  - @aio-proxy/types@0.18.0
  - @aio-proxy/server@0.18.0
  - @aio-proxy/plugin-sdk@0.18.0
  - @aio-proxy/ui@0.18.0

## 0.17.0

### Minor Changes

- [#260](https://github.com/aio-proxy/aio-proxy/pull/260) [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f) Thanks @baranwang - Refresh an OAuth Provider's credential on demand from the dashboard Provider card menu.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`fd1c284`](https://github.com/aio-proxy/aio-proxy/commit/fd1c28430f0678bc22a558677feeff3146f7eba6) Thanks @baranwang - Add an About section to the Settings page with the running version, the source repository, and the documentation site, plus a button that checks npm for a newer published release. Move the appearance and language card to the top of the page, and mark the API key label field as optional.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16) Thanks @baranwang - Add, relabel, and remove API keys from Settings, including a one-click generator for a fresh random key. Stored keys stay masked and are never sent back to the browser, and authored `{{env.NAME}}` key templates survive a write unchanged. Key writes carry the revision of the key list they were made against, so a write is rejected with `409 stale_api_keys` when the config changed underneath instead of silently rewriting a different key.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2) Thanks @baranwang - Set and clear the Dashboard password from Settings. The password is stored only as an Argon2id hash, and changing it signs out every existing session.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`4c93909`](https://github.com/aio-proxy/aio-proxy/commit/4c939090f89ac0799768ab356e74310c91940b7a) Thanks @baranwang - Move appearance and language into Settings as an "Appearance & language" card and drop the sidebar dropdowns, so every preference has one entry point.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`7ecb445`](https://github.com/aio-proxy/aio-proxy/commit/7ecb4452f35b3b1fafa8215d2710e134b60425e7) Thanks @baranwang - Add a "Reload config" action to Settings that re-reads the config file on demand and surfaces the failing reload stage. Host, port, and log level still require a restart.

### Patch Changes

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`9b80f0c`](https://github.com/aio-proxy/aio-proxy/commit/9b80f0cbb813a709a42638915224d81f1e16241e) Thanks @baranwang - Build the Settings About rows from the shadcn `Item` primitive so the repository and documentation rows are clickable end to end instead of only through their chevron.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`962e433`](https://github.com/aio-proxy/aio-proxy/commit/962e433bc648cb44604ed98423ecec3c17a6b721) Thanks @baranwang - Store a new API key exactly as entered instead of trimming it, including a key made up entirely of whitespace, and author every submitted key even when a retained row already holds that credential.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`2621cb3`](https://github.com/aio-proxy/aio-proxy/commit/2621cb3221abdc8a7d98cbde7eb54e6b35feef37) Thanks @baranwang - Keep an unsaved API key when another writer's change forces a settings refetch, so a rejected save no longer discards the only copy of a generated key. Localize every config reload failure stage instead of interpolating the server's internal stage identifier into the translated message.

- [#261](https://github.com/aio-proxy/aio-proxy/pull/261) [`31b4339`](https://github.com/aio-proxy/aio-proxy/commit/31b4339d6b59ca72c0a3b5b33bcd2c339e631f1a) Thanks @baranwang - Report an API key row that has a label but no key instead of silently dropping it, so saving no longer succeeds without persisting the key.

- [#271](https://github.com/aio-proxy/aio-proxy/pull/271) [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd) Thanks @baranwang - dashboard: manage Provider and per-model priority tiers with one drag editor that moves whole tiers, creates tiers at drop slots, and adjusts traffic shares without an add-tier button
- Updated dependencies [[`d3eb521`](https://github.com/aio-proxy/aio-proxy/commit/d3eb5215724009b43705a515ca17666097d578f8), [`b7d9520`](https://github.com/aio-proxy/aio-proxy/commit/b7d9520cdc280d1b6785c53d4d079b5db2d5311f), [`9b80f0c`](https://github.com/aio-proxy/aio-proxy/commit/9b80f0cbb813a709a42638915224d81f1e16241e), [`fd1c284`](https://github.com/aio-proxy/aio-proxy/commit/fd1c28430f0678bc22a558677feeff3146f7eba6), [`962e433`](https://github.com/aio-proxy/aio-proxy/commit/962e433bc648cb44604ed98423ecec3c17a6b721), [`2c6da7a`](https://github.com/aio-proxy/aio-proxy/commit/2c6da7a8ccd7246bcc81daf83001e046ce376e16), [`6d02c87`](https://github.com/aio-proxy/aio-proxy/commit/6d02c876980ee55963fd0db6298adffe23bc42a2), [`2621cb3`](https://github.com/aio-proxy/aio-proxy/commit/2621cb3221abdc8a7d98cbde7eb54e6b35feef37), [`31b4339`](https://github.com/aio-proxy/aio-proxy/commit/31b4339d6b59ca72c0a3b5b33bcd2c339e631f1a), [`4c93909`](https://github.com/aio-proxy/aio-proxy/commit/4c939090f89ac0799768ab356e74310c91940b7a), [`7ecb445`](https://github.com/aio-proxy/aio-proxy/commit/7ecb4452f35b3b1fafa8215d2710e134b60425e7), [`fe76256`](https://github.com/aio-proxy/aio-proxy/commit/fe762564e204fb81535ed99fc82dfbff72c63e0d), [`cef9deb`](https://github.com/aio-proxy/aio-proxy/commit/cef9deb1441d7c22cf64b412fb6a311bac1f761a), [`5c7f017`](https://github.com/aio-proxy/aio-proxy/commit/5c7f01716a840a8f02850b08bcd3ad7cf254f740), [`8150738`](https://github.com/aio-proxy/aio-proxy/commit/815073848e78ed7195f7f6d97077f3b495d103bd)]:
  - @aio-proxy/server@0.17.0
  - @aio-proxy/plugin-sdk@0.17.0
  - @aio-proxy/types@0.17.0
  - @aio-proxy/i18n@0.17.0
  - @aio-proxy/ui@0.17.0

## 0.16.0

### Patch Changes

- Updated dependencies [[`142cc1b`](https://github.com/aio-proxy/aio-proxy/commit/142cc1b419b0109585a53f020343d0eb72b6673f), [`3e3c4bd`](https://github.com/aio-proxy/aio-proxy/commit/3e3c4bdc6acaabe970849961b79a649b1f37a6d5)]:
  - @aio-proxy/plugin-sdk@0.16.0
  - @aio-proxy/server@0.16.0
  - @aio-proxy/i18n@0.16.0
  - @aio-proxy/types@0.16.0
  - @aio-proxy/ui@0.16.0

## 0.15.0

### Minor Changes

- [#243](https://github.com/aio-proxy/aio-proxy/pull/243) [`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91) Thanks @baranwang - OAuth providers now hide models with `excludedModels` instead of a `models` whitelist. Leftover `models` keys are ignored and no longer restrict exposure — newly discovered catalog ids stay visible unless hidden. Plugin default aliases inherit at runtime and are no longer written into the config file.

### Patch Changes

- Updated dependencies [[`1daece3`](https://github.com/aio-proxy/aio-proxy/commit/1daece3dd2dad3ddfe86c12784ef379e99424c91)]:
  - @aio-proxy/types@0.15.0
  - @aio-proxy/server@0.15.0
  - @aio-proxy/plugin-sdk@0.15.0
  - @aio-proxy/i18n@0.15.0
  - @aio-proxy/ui@0.15.0

## 0.14.0

### Minor Changes

- [#245](https://github.com/aio-proxy/aio-proxy/pull/245) [`3408993`](https://github.com/aio-proxy/aio-proxy/commit/340899373f0244e6dd240459d6e02d187998961f) Thanks @olivewind - Let AI SDK provider packages be installed from a configurable npm registry in the dashboard, and load model catalogs from packages that expose an optional `listModels` method.

### Patch Changes

- Updated dependencies [[`3408993`](https://github.com/aio-proxy/aio-proxy/commit/340899373f0244e6dd240459d6e02d187998961f)]:
  - @aio-proxy/i18n@0.14.0
  - @aio-proxy/server@0.14.0
  - @aio-proxy/plugin-sdk@0.14.0
  - @aio-proxy/types@0.14.0
  - @aio-proxy/ui@0.14.0

## 0.13.0

### Minor Changes

- [#239](https://github.com/aio-proxy/aio-proxy/pull/239) [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d) Thanks @baranwang - Redesign the dashboard Provider list as a card grid and surface OAuth remaining quota.

### Patch Changes

- [#241](https://github.com/aio-proxy/aio-proxy/pull/241) [`1299208`](https://github.com/aio-proxy/aio-proxy/commit/129920850794518d0089762bb015eeac12e4de71) Thanks @baranwang - Fix Dashboard OAuth authorization windows. Device-code providers now navigate the window opened on the
  authorize click instead of leaving a blank tab that only loaded after switching back to the dashboard,
  and the authorization panel no longer opens a second window on top of it — providers that authorize by
  URL, such as Cursor, opened two authorization pages.
- Updated dependencies [[`07413a1`](https://github.com/aio-proxy/aio-proxy/commit/07413a116385e94e20e2c722ecdb32c0b97d52b6), [`99755b5`](https://github.com/aio-proxy/aio-proxy/commit/99755b58b7492f9da4161ac429325dd319ba48f8), [`672e0db`](https://github.com/aio-proxy/aio-proxy/commit/672e0dbb4eb0d81b965164b05d7a83dc9db23cda), [`b1f5bff`](https://github.com/aio-proxy/aio-proxy/commit/b1f5bff2f2e92abfd54b90fb32b29b4b145e8c1d)]:
  - @aio-proxy/ui@0.13.0
  - @aio-proxy/plugin-sdk@0.13.0
  - @aio-proxy/server@0.13.0
  - @aio-proxy/types@0.13.0
  - @aio-proxy/i18n@0.13.0

## 0.12.3

### Patch Changes

- Updated dependencies [[`e735323`](https://github.com/aio-proxy/aio-proxy/commit/e7353232a59b83235f88948a72f94fa5e6219e87), [`c8dd136`](https://github.com/aio-proxy/aio-proxy/commit/c8dd1369bc9b08570bb74c77befca449272abfb0)]:
  - @aio-proxy/server@0.12.3
  - @aio-proxy/i18n@0.12.3
  - @aio-proxy/plugin-sdk@0.12.3
  - @aio-proxy/types@0.12.3
  - @aio-proxy/ui@0.12.3

## 0.12.2

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.12.2
  - @aio-proxy/i18n@0.12.2
  - @aio-proxy/plugin-sdk@0.12.2
  - @aio-proxy/types@0.12.2
  - @aio-proxy/ui@0.12.2

## 0.12.1

### Patch Changes

- [#231](https://github.com/aio-proxy/aio-proxy/pull/231) [`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6) Thanks @baranwang - dashboard: grade traces latency like new-api and show the lightning icon for fast/priority requests

  Chat Completions `service_tier` now maps onto the speed routing axis (`priority`/`fast` → fast, `flex` → flex), matching Responses.

- Updated dependencies [[`70756e3`](https://github.com/aio-proxy/aio-proxy/commit/70756e3fe1bd63be4871bd2dc9901b159db47de6)]:
  - @aio-proxy/types@0.12.1
  - @aio-proxy/server@0.12.1
  - @aio-proxy/i18n@0.12.1
  - @aio-proxy/plugin-sdk@0.12.1
  - @aio-proxy/ui@0.12.1

## 0.12.0

### Minor Changes

- [#226](https://github.com/aio-proxy/aio-proxy/pull/226) [`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2) Thanks @baranwang - Configure model metadata once per exposed model at `router.models.<slug>.metadata`, including `extend`, with per-Provider `cost` and `limit` overrides under `router.models.<slug>.providers.<id>`.

### Patch Changes

- [#228](https://github.com/aio-proxy/aio-proxy/pull/228) [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca) Thanks @baranwang - Upgrade Zod to 4.5 and compile inbound protocol request schemas with `z.compile()` (except OpenAI Responses, whose unknown-item transform logs). Upgrade es-toolkit to 1.52. Use `isPlainObject` for JSON and other plain data. Structural plugin/SDK contracts that may be class instances use `isRecord` from the published `@aio-proxy/shared` leaf package. Replace spread-Set arrays with `uniq` in packages that already depend on es-toolkit.
- Updated dependencies [[`9c16d0b`](https://github.com/aio-proxy/aio-proxy/commit/9c16d0b56a954563a296e5363869d5bae12ffda2), [`2cb5333`](https://github.com/aio-proxy/aio-proxy/commit/2cb5333493e582b676e34565246cfa0defb24dca)]:
  - @aio-proxy/plugin-sdk@0.12.0
  - @aio-proxy/server@0.12.0
  - @aio-proxy/types@0.12.0
  - @aio-proxy/i18n@0.12.0
  - @aio-proxy/ui@0.12.0

## 0.11.2

### Patch Changes

- [#224](https://github.com/aio-proxy/aio-proxy/pull/224) [`2bb3f13`](https://github.com/aio-proxy/aio-proxy/commit/2bb3f13f1be3707125777d080878850ef52bb865) Thanks @baranwang - Fix the routing share slider thumb so it follows the updated weight.
- Updated dependencies []:
  - @aio-proxy/i18n@0.11.2
  - @aio-proxy/plugin-sdk@0.11.2
  - @aio-proxy/server@0.11.2
  - @aio-proxy/types@0.11.2
  - @aio-proxy/ui@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.11.1
  - @aio-proxy/i18n@0.11.1
  - @aio-proxy/plugin-sdk@0.11.1
  - @aio-proxy/types@0.11.1
  - @aio-proxy/ui@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [[`4ce6cee`](https://github.com/aio-proxy/aio-proxy/commit/4ce6cee2412a13cc18d250af52335f456ad1db13), [`64718ae`](https://github.com/aio-proxy/aio-proxy/commit/64718aea31a3a26ef691443246163713278b5e2b), [`b6e65cd`](https://github.com/aio-proxy/aio-proxy/commit/b6e65cddeaab8ce356f1d5f7c0f0f7e98a401608), [`84901fd`](https://github.com/aio-proxy/aio-proxy/commit/84901fd5fd54ad95418ef74bb578f5b210e30612), [`e0c9ea0`](https://github.com/aio-proxy/aio-proxy/commit/e0c9ea0b6c8cea6329cf2eeefc2dc4ee2675d44c)]:
  - @aio-proxy/types@0.11.0
  - @aio-proxy/plugin-sdk@0.11.0
  - @aio-proxy/server@0.11.0
  - @aio-proxy/i18n@0.11.0
  - @aio-proxy/ui@0.11.0

## 0.10.0

### Minor Changes

- [#202](https://github.com/aio-proxy/aio-proxy/pull/202) [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1) Thanks @baranwang - dashboard: edit model routing in a drawer by dragging priority tiers and traffic weights

### Patch Changes

- Updated dependencies [[`076c67b`](https://github.com/aio-proxy/aio-proxy/commit/076c67ba698c4cd7a3756ef370adc7a62a530402), [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1), [`6880a93`](https://github.com/aio-proxy/aio-proxy/commit/6880a93b087b81aaade64a95a6bd14fe7db4c8f1)]:
  - @aio-proxy/plugin-sdk@0.10.0
  - @aio-proxy/i18n@0.10.0
  - @aio-proxy/server@0.10.0
  - @aio-proxy/types@0.10.0
  - @aio-proxy/ui@0.10.0

## 0.9.1

### Patch Changes

- [#198](https://github.com/aio-proxy/aio-proxy/pull/198) [`af389a5`](https://github.com/aio-proxy/aio-proxy/commit/af389a50b57f123c71965cd337185cb8185629e1) Thanks @baranwang - Serve dashboard public files such as `/dashboard/favicon.svg` from the built assets instead of the SPA fallback.
- Updated dependencies [[`2e19250`](https://github.com/aio-proxy/aio-proxy/commit/2e192507075833219fff1bec8379f4144b383c84), [`af389a5`](https://github.com/aio-proxy/aio-proxy/commit/af389a50b57f123c71965cd337185cb8185629e1), [`1a1c519`](https://github.com/aio-proxy/aio-proxy/commit/1a1c519422c9be44a770646539803c929b5b9e43)]:
  - @aio-proxy/server@0.9.1
  - @aio-proxy/types@0.9.1
  - @aio-proxy/i18n@0.9.1
  - @aio-proxy/plugin-sdk@0.9.1
  - @aio-proxy/ui@0.9.1

## 0.9.0

### Minor Changes

- [#189](https://github.com/aio-proxy/aio-proxy/pull/189) [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54) Thanks @baranwang - Generate Antigravity default aliases from live model discovery and insert newly seen logical ids on refresh.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks @baranwang - The dashboard API connection editor can now select multiple protocols and give each one its own address. Saving writes the existing `endpoints` config instead of dropping it.

- [#187](https://github.com/aio-proxy/aio-proxy/pull/187) [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b) Thanks @baranwang - Add managed OpenCode, Pi, and oh-my-pi Agent integrations.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca) Thanks @baranwang - Redesign the provider editor into a single page shared by api, ai-sdk, and oauth providers: five fixed sections, a persistent exposure/validation rail, an in-place two-stage OAuth authorization flow, inline alias editing, a routing weight slider, and a visual model-metadata tab.

- [#190](https://github.com/aio-proxy/aio-proxy/pull/190) [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b) Thanks @baranwang - Add model-level Provider priority and weighted routing, stable-session candidate ordering, routing-v2 diagnostics, and a Dashboard Routing workspace. Provider weight now controls same-priority traffic instead of fixed global order; existing configurations should follow the documented migration table.

### Patch Changes

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f8947e7`](https://github.com/aio-proxy/aio-proxy/commit/f8947e78bc3ec3c7ccfa04e6c82606d7fa7989d9) Thanks @baranwang - Author provider aliases as inline rows in the Models section instead of through a staged drawer.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8) Thanks @baranwang - Fix the provider editor silently corrupting alias variants that match on thinking or speed, and let the Dashboard author those conditions instead of only effort names.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`6560946`](https://github.com/aio-proxy/aio-proxy/commit/65609463e6ede5798787c54614d716f2120e8148) Thanks @baranwang - Align the provider editor's conditional variant rows with the prototype.

- [#182](https://github.com/aio-proxy/aio-proxy/pull/182) [`bf6e779`](https://github.com/aio-proxy/aio-proxy/commit/bf6e779aad3d64f0edb4cdb4662f1063f1c6b279) Thanks @baranwang - Replace the dashboard JSON editor's Monaco runtime with CodeMirror 6 while keeping schema validation, completion, and hover on vscode-json-languageservice.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9) Thanks @baranwang - The provider editor now loads an unsaved model catalog with HTTP QUERY, and leftover kind-switch fields no longer block that request.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b71e13c`](https://github.com/aio-proxy/aio-proxy/commit/b71e13c8c991d3482a5446fdbd980ffc37a73ae1) Thanks @baranwang - Align the model metadata drawer with the editor demo. Visual-tab labels are prose
  again (reasoning, context window, cache read, and so on) instead of config key
  paths, and the JSON tab names a schema field when the draft is an object Zod
  rejects instead of claiming it is not JSON. A failed models.dev slug catalog
  response now surfaces as an error with Retry, rather than an empty catalog.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`21883d3`](https://github.com/aio-proxy/aio-proxy/commit/21883d33ab3ceb0081e123aaa985f42b4622f33d) Thanks @baranwang - Clear up the wording around testing a provider in the Dashboard's provider editor.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00) Thanks @baranwang - Give Dashboard OAuth loopback a styled completion page with a close button, and lock the plugin account form as soon as authorization starts.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`1dcaf2d`](https://github.com/aio-proxy/aio-proxy/commit/1dcaf2d27278874035494b320690b43dfc5334fa) Thanks @baranwang - Show an OAuth provider's models as enabled when its whitelist is empty. An empty whitelist exposes the
  whole discovered catalog at runtime, but the editor rendered every model unchecked — and the first
  click then saved a one-model whitelist, silently disabling everything else.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`30113ac`](https://github.com/aio-proxy/aio-proxy/commit/30113ac44315a690a30360121fe196f1104a69be) Thanks @baranwang - Stop OAuth reauthorize from writing the provider while alias names still collide. The editor already blocked Save; reauthorize went through `save()` without that check, so last-wins serialization could drop a colliding row from the config.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1) Thanks @baranwang - Keep per-model metadata edits when saving an OAuth provider also re-authorizes it. The editor saves
  credentials and model metadata in one action; if the credential half required re-authorization, the
  login path rebuilt the provider entry from a patch that had no metadata field, so the metadata half
  of the save was silently discarded.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`798e1e2`](https://github.com/aio-proxy/aio-proxy/commit/798e1e2c230dd925f6a2df1741b52ee75c955852) Thanks @baranwang - Fold the provider editor's advanced fields into collapsed accordions. The closed bars show the current proxy mode, header count, and rewrite-rule count, and the copy now says "request rewrites" throughout.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`cff1a38`](https://github.com/aio-proxy/aio-proxy/commit/cff1a38dda0e9c6e3c0be008580f8144f62ea725) Thanks @baranwang - Fix what the provider editor tells you about its own identity and connection.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`35dacf3`](https://github.com/aio-proxy/aio-proxy/commit/35dacf3cfbd006598e0f1f7a4082f1f2399971c6) Thanks @baranwang - Stop the provider editor offering a save it will reject, and rebuild its footer and section strip to match the rest of the page.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`3cb3b81`](https://github.com/aio-proxy/aio-proxy/commit/3cb3b8135f109c0eb6ee9fab138e83ee32136ae0) Thanks @baranwang - Tighten the provider editor's extra request headers into a single compact row and put the proxy address on its own field. Copy now says "additional request headers" and "use a specific proxy".

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`165d4c1`](https://github.com/aio-proxy/aio-proxy/commit/165d4c1ef27a9519ff6a76387c1740643c038db1) Thanks @baranwang - Make the provider editor's section jump links usable from a keyboard.
  Clicking a section in the nav strip or a link in the save footer now moves keyboard focus into that
  section, not just the viewport — previously focus stayed behind, so the next Tab continued from the
  strip or from Cancel/Save rather than from the section the user asked for. The nav strip is announced as
  the form's section list instead of claiming to be "Edit Provider" even while creating one.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`e3ff7aa`](https://github.com/aio-proxy/aio-proxy/commit/e3ff7aa430a1a0d4429aa93e34f7e77836063c83) Thanks @baranwang - Align the provider editor's models section with the prototype.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`d50d78d`](https://github.com/aio-proxy/aio-proxy/commit/d50d78d7dcdac086fb529dfbafca425ce2281e62) Thanks @baranwang - Fix three provider-editor model regressions.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c73de2d`](https://github.com/aio-proxy/aio-proxy/commit/c73de2d1bd7c849a239d8e6a3fe139f7b6be4da6) Thanks @baranwang - Align the provider editor's right rail with the prototype. The model-test controls
  disappear when nothing is testable instead of leaving a disabled full-width button,
  the visible "Model to test" label becomes an accessible name only, and a pending
  test keeps the same button copy with a spinner instead of swapping in a second
  string. The exposure panel title is "Model list", its empty state says which names
  will appear, and a disabled provider folds that reason into the same sentence.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`02c0a8b`](https://github.com/aio-proxy/aio-proxy/commit/02c0a8bc9b53175e72e2cc432275a04f8fb934dc) Thanks @baranwang - Four provider-editor follow-ups.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`6fb3a79`](https://github.com/aio-proxy/aio-proxy/commit/6fb3a799f2abd3ee6f4fd11b01a7040be226257f) Thanks @baranwang - Fix four provider editor defects found by a re-survey against the design prototype.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ef90e90`](https://github.com/aio-proxy/aio-proxy/commit/ef90e90173a91816649d5c76053caf776b30e5dc) Thanks @baranwang - Make the provider editor's section dots agree with its Save button, and fix the section hints. A section
  missing a required field is red, one waiting on an authorization round trip is amber, a finished one stays
  primary — and any section that is not finished blocks Save. Hint counts also read "1 model" rather than
  "1 models", and an OAuth provider whose empty whitelist exposes its whole upstream catalog now says so
  instead of "0 models".

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ecb6e0c`](https://github.com/aio-proxy/aio-proxy/commit/ecb6e0c74220388cc4dd51445e994b0cef0865a5) Thanks @baranwang - Let the provider Routing section type any weight or priority. Clearing a field means absent, which the
  router treats as weight `1` and priority `0`. The editor shows an empty box for an absent value so it
  is distinguishable from an authored `0`.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`b1bcb8d`](https://github.com/aio-proxy/aio-proxy/commit/b1bcb8dc140edff15f9534a8058dd038a2ee5717) Thanks @baranwang - Stop the Dashboard provider editor from deleting a hand-written `endpoints` list.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`4c33182`](https://github.com/aio-proxy/aio-proxy/commit/4c33182e52533af7b613df3e67c82a3cba09cdb0) Thanks @baranwang - Fit each request transform action on one line and stop leaving a blank space where a remove action would show a value.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`ea6b1c9`](https://github.com/aio-proxy/aio-proxy/commit/ea6b1c98ca4c9a9ba35b39de91df4b1b25165135) Thanks @baranwang - Make request transform rules shorter to scan and stop showing the condition builder to rules that do not have a condition.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`0a93cfd`](https://github.com/aio-proxy/aio-proxy/commit/0a93cfd509c919280fcfea53528e1a706edd36d5) Thanks @baranwang - Make the request-transform value editor easier to read and fill in.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`e86cff1`](https://github.com/aio-proxy/aio-proxy/commit/e86cff1401ae66805faee73f5fa990a5249d52fb) Thanks @baranwang - Reduce the provider editor's Routing section to priority and weight number inputs. The attempt-order
  preview is gone, as is the provider-level enabled switch; a provider is enabled or disabled from the
  providers list. Creating an API or AI SDK provider now writes an explicit weight of `1` and priority
  of `0`, matching the router defaults.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`c22a6ec`](https://github.com/aio-proxy/aio-proxy/commit/c22a6ec1e96f9b6e1b014f8601609565bef6ca23) Thanks @baranwang - Fix a Dashboard defect in the request transform stage editor. Nested expression arguments all rendered the
  same accessible name — an outer and an inner argument were both just "Field" — leaving screen reader users
  with no way to tell which control they were on. Each argument control is now named by its argument path
  ("Argument 1 → Field", "Argument 2 → Argument 1 → Field"), following the path the expression editor already
  tracks internally.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250) Thanks @baranwang - The provider editor's Model aliases block now offers a Sync plugin aliases button for OAuth providers whose plugin ships default aliases.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`f75367e`](https://github.com/aio-proxy/aio-proxy/commit/f75367ebf14dfd6a47c86c19f0851f27065c6876) Thanks @baranwang - Align the request-transform condition builder and value editor with the demo: computed values show a live expression preview, the expression tree gets its indent, argument markers and connector lines, and condition groups and rows get their own cards instead of a fixed 768px block.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`476b0a8`](https://github.com/aio-proxy/aio-proxy/commit/476b0a8133f3c2a46e710e682006bf8074170bb5) Thanks @baranwang - Align the request-transform editor shell with the demo: one dotted path
  input, usable structure buttons on an invalid rule, and JSON-mode copy
  for unsupported or non-array drafts.

  Empty path values no longer encode as a whole-body replacement. Existing
  `$set: { 'request.body': … }` configs stay byte-identical and open in the
  JSON tab.

- [#181](https://github.com/aio-proxy/aio-proxy/pull/181) [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7) Thanks @baranwang - Plugin default aliases now respect a provider's `models` whitelist, so a background catalog refresh can no longer insert an alias target outside it and drop the whole provider out of routing.
- Updated dependencies [[`f8947e7`](https://github.com/aio-proxy/aio-proxy/commit/f8947e78bc3ec3c7ccfa04e6c82606d7fa7989d9), [`3f0e371`](https://github.com/aio-proxy/aio-proxy/commit/3f0e3719028e1a506b2dffd81982c2def32d1db8), [`6560946`](https://github.com/aio-proxy/aio-proxy/commit/65609463e6ede5798787c54614d716f2120e8148), [`87126aa`](https://github.com/aio-proxy/aio-proxy/commit/87126aadb95151258c8d1a4e52e0f3e854ee0e54), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`ed5f7b7`](https://github.com/aio-proxy/aio-proxy/commit/ed5f7b78654738c9ca75178e2a060d3be628782b), [`b1d9481`](https://github.com/aio-proxy/aio-proxy/commit/b1d948127f8f289a588aa3c9fe4ae7329b8d06b9), [`f25104e`](https://github.com/aio-proxy/aio-proxy/commit/f25104ea345daeb6f4ec07f5db8fe505e6ca5da6), [`e770d49`](https://github.com/aio-proxy/aio-proxy/commit/e770d49dc76fb2036a07fc948cba243f49edcd2b), [`b71e13c`](https://github.com/aio-proxy/aio-proxy/commit/b71e13c8c991d3482a5446fdbd980ffc37a73ae1), [`2797531`](https://github.com/aio-proxy/aio-proxy/commit/2797531548755924713f880e6ef0cbcb00923bf5), [`21883d3`](https://github.com/aio-proxy/aio-proxy/commit/21883d33ab3ceb0081e123aaa985f42b4622f33d), [`ebaeb73`](https://github.com/aio-proxy/aio-proxy/commit/ebaeb73a04968dcb97a435a4037394a08e831a00), [`b0cdf26`](https://github.com/aio-proxy/aio-proxy/commit/b0cdf2696d3b8125d4d7c5a4df239a45bbe0dcc1), [`798e1e2`](https://github.com/aio-proxy/aio-proxy/commit/798e1e2c230dd925f6a2df1741b52ee75c955852), [`cff1a38`](https://github.com/aio-proxy/aio-proxy/commit/cff1a38dda0e9c6e3c0be008580f8144f62ea725), [`35dacf3`](https://github.com/aio-proxy/aio-proxy/commit/35dacf3cfbd006598e0f1f7a4082f1f2399971c6), [`3cb3b81`](https://github.com/aio-proxy/aio-proxy/commit/3cb3b8135f109c0eb6ee9fab138e83ee32136ae0), [`165d4c1`](https://github.com/aio-proxy/aio-proxy/commit/165d4c1ef27a9519ff6a76387c1740643c038db1), [`e3ff7aa`](https://github.com/aio-proxy/aio-proxy/commit/e3ff7aa430a1a0d4429aa93e34f7e77836063c83), [`c73de2d`](https://github.com/aio-proxy/aio-proxy/commit/c73de2d1bd7c849a239d8e6a3fe139f7b6be4da6), [`6fb3a79`](https://github.com/aio-proxy/aio-proxy/commit/6fb3a799f2abd3ee6f4fd11b01a7040be226257f), [`c5b04c1`](https://github.com/aio-proxy/aio-proxy/commit/c5b04c183b0a9669f518bcb18f38019e96d3a8ca), [`ef90e90`](https://github.com/aio-proxy/aio-proxy/commit/ef90e90173a91816649d5c76053caf776b30e5dc), [`ecb6e0c`](https://github.com/aio-proxy/aio-proxy/commit/ecb6e0c74220388cc4dd51445e994b0cef0865a5), [`b1bcb8d`](https://github.com/aio-proxy/aio-proxy/commit/b1bcb8dc140edff15f9534a8058dd038a2ee5717), [`5be2d7c`](https://github.com/aio-proxy/aio-proxy/commit/5be2d7c0c1f2e9d844b33ce17b3fcefc78afd62e), [`4c33182`](https://github.com/aio-proxy/aio-proxy/commit/4c33182e52533af7b613df3e67c82a3cba09cdb0), [`ea6b1c9`](https://github.com/aio-proxy/aio-proxy/commit/ea6b1c98ca4c9a9ba35b39de91df4b1b25165135), [`0a93cfd`](https://github.com/aio-proxy/aio-proxy/commit/0a93cfd509c919280fcfea53528e1a706edd36d5), [`e86cff1`](https://github.com/aio-proxy/aio-proxy/commit/e86cff1401ae66805faee73f5fa990a5249d52fb), [`f2d1122`](https://github.com/aio-proxy/aio-proxy/commit/f2d1122b6a946a302902070b288c9093d091808b), [`c22a6ec`](https://github.com/aio-proxy/aio-proxy/commit/c22a6ec1e96f9b6e1b014f8601609565bef6ca23), [`bf7a1cc`](https://github.com/aio-proxy/aio-proxy/commit/bf7a1cce861313f8294822bb78e2d573c658c250), [`f75367e`](https://github.com/aio-proxy/aio-proxy/commit/f75367ebf14dfd6a47c86c19f0851f27065c6876), [`476b0a8`](https://github.com/aio-proxy/aio-proxy/commit/476b0a8133f3c2a46e710e682006bf8074170bb5), [`4bddead`](https://github.com/aio-proxy/aio-proxy/commit/4bddead355c37861e89dd57cf2a6a3514d4b35dc), [`60996d3`](https://github.com/aio-proxy/aio-proxy/commit/60996d3f0927636a3531c01fce35ba30015973a7), [`9b6f0a3`](https://github.com/aio-proxy/aio-proxy/commit/9b6f0a3f26d6bb22fc20298dc203825dca818309)]:
  - @aio-proxy/i18n@0.9.0
  - @aio-proxy/types@0.9.0
  - @aio-proxy/plugin-sdk@0.9.0
  - @aio-proxy/server@0.9.0
  - @aio-proxy/ui@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [[`667d232`](https://github.com/aio-proxy/aio-proxy/commit/667d2322171b9e41ebdb6ae727701ef7b3866203), [`3975995`](https://github.com/aio-proxy/aio-proxy/commit/3975995850c0bd7c8282d25387bd56c2f9b3c705), [`b5e40ce`](https://github.com/aio-proxy/aio-proxy/commit/b5e40ceaa0d60eb5fee734c63fb92c9794c3ebc9)]:
  - @aio-proxy/server@0.8.0
  - @aio-proxy/types@0.8.0
  - @aio-proxy/i18n@0.8.0
  - @aio-proxy/plugin-sdk@0.8.0
  - @aio-proxy/ui@0.8.0

## 0.7.0

### Minor Changes

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Dashboard control plane: overview/diagnostics/activity APIs, redesigned traces, rolling 52-week Token heatmap, range-scoped diagnostics and KPI deltas, Provider table + OAuth config, and authenticated Settings/Plugins management.

- [#175](https://github.com/aio-proxy/aio-proxy/pull/175) [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5) Thanks @baranwang - Plugins move display identity into descriptor metadata (`displayName` / `accountLabel`; remove legacy `label` and OAuth capability icons). Add Cursor account OAuth/provider support. Normalize OpenAI Responses errors to `response.failed` for Codex.

### Patch Changes

- Updated dependencies [[`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5), [`a218496`](https://github.com/aio-proxy/aio-proxy/commit/a218496f461450d1e87757c2aed9770e75b9a6e5)]:
  - @aio-proxy/server@0.7.0
  - @aio-proxy/types@0.7.0
  - @aio-proxy/i18n@0.7.0
  - @aio-proxy/ui@0.7.0
  - @aio-proxy/plugin-sdk@0.7.0

## 0.6.4

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.6.4
  - @aio-proxy/i18n@0.6.4
  - @aio-proxy/plugin-sdk@0.6.4
  - @aio-proxy/types@0.6.4
  - @aio-proxy/ui@0.6.4

## 0.6.3

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.6.3
  - @aio-proxy/i18n@0.6.3
  - @aio-proxy/plugin-sdk@0.6.3
  - @aio-proxy/types@0.6.3
  - @aio-proxy/ui@0.6.3

## 0.6.2

### Patch Changes

- Updated dependencies [[`04ed2df`](https://github.com/aio-proxy/aio-proxy/commit/04ed2dff458272169af2bf04c36cfc09372f6557)]:
  - @aio-proxy/server@0.6.2
  - @aio-proxy/i18n@0.6.2
  - @aio-proxy/plugin-sdk@0.6.2
  - @aio-proxy/types@0.6.2
  - @aio-proxy/ui@0.6.2

## 0.6.1

### Patch Changes

- [#138](https://github.com/aio-proxy/aio-proxy/pull/138) [`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7) Thanks @baranwang - Add the Rspress documentation site and its shared UI foundation.
- Updated dependencies [[`0ac7bd1`](https://github.com/aio-proxy/aio-proxy/commit/0ac7bd11bdf3334aee3bb46576f4b61e2ac24ee7)]:
  - @aio-proxy/i18n@0.6.1
  - @aio-proxy/ui@0.6.1
  - @aio-proxy/server@0.6.1
  - @aio-proxy/plugin-sdk@0.6.1
  - @aio-proxy/types@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [[`963e395`](https://github.com/aio-proxy/aio-proxy/commit/963e3951a64644441a36b0ae4c9b93d644444d18), [`abf31a4`](https://github.com/aio-proxy/aio-proxy/commit/abf31a4c2eaa5c6fedf7dd9831f00e54d2fef8ee), [`f15d8d3`](https://github.com/aio-proxy/aio-proxy/commit/f15d8d301a2172eff687bd414cc9a05b7cab4085), [`465fa49`](https://github.com/aio-proxy/aio-proxy/commit/465fa494bc0446e11b68b0922b29ba2c15880c37), [`6963859`](https://github.com/aio-proxy/aio-proxy/commit/6963859bed52fbb6e56060015bf37c97a9f0abfd)]:
  - @aio-proxy/server@0.6.0
  - @aio-proxy/types@0.6.0
  - @aio-proxy/i18n@0.6.0
  - @aio-proxy/plugin-sdk@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies [[`39d1b19`](https://github.com/aio-proxy/aio-proxy/commit/39d1b1927055fa483c9d09d82b6e5e76100eee95)]:
  - @aio-proxy/i18n@0.5.2
  - @aio-proxy/server@0.5.2
  - @aio-proxy/plugin-sdk@0.5.2
  - @aio-proxy/types@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/server@0.5.1
  - @aio-proxy/i18n@0.5.1
  - @aio-proxy/plugin-sdk@0.5.1
  - @aio-proxy/types@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [[`7856451`](https://github.com/aio-proxy/aio-proxy/commit/7856451f2434912a619e1c72aca44a1ccd1aaf43)]:
  - @aio-proxy/server@0.5.0
  - @aio-proxy/i18n@0.5.0
  - @aio-proxy/plugin-sdk@0.5.0
  - @aio-proxy/types@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`2d1d035`](https://github.com/aio-proxy/aio-proxy/commit/2d1d03580db04a8ff957df3b3dd17d0879599282)]:
  - @aio-proxy/i18n@0.4.0
  - @aio-proxy/server@0.4.0
  - @aio-proxy/plugin-sdk@0.4.0
  - @aio-proxy/types@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [[`5a6deb7`](https://github.com/aio-proxy/aio-proxy/commit/5a6deb759ed7c748369db2dee814d2686dcd2e8d)]:
  - @aio-proxy/server@0.3.0
  - @aio-proxy/i18n@0.3.0
  - @aio-proxy/plugin-sdk@0.3.0
  - @aio-proxy/types@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.2.1
  - @aio-proxy/plugin-sdk@0.2.1
  - @aio-proxy/server@0.2.1
  - @aio-proxy/types@0.2.1

## 0.2.0

### Patch Changes

- Updated dependencies []:
  - @aio-proxy/i18n@0.2.0
  - @aio-proxy/plugin-sdk@0.2.0
  - @aio-proxy/server@0.2.0
  - @aio-proxy/types@0.2.0
