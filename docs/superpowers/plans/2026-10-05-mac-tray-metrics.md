# macOS 菜单栏指标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macOS 菜单栏可常驻显示今日 token、今日费用、进行中请求数、实时 tok/s 中用户选择的 1–2 项。

**Architecture:** 服务端新增进程内 `live-metrics`，负责两件事：统计进行中请求数，以及按字符数估算流式吞吐（每个模型单独校准字符与 token 的比例）。它和 `usage_daily` 里的今日累计一起，通过 `GET /dashboard/api/desktop-live` 提供给桌面端。桌面端把偏好保存到本地，由一个常驻的 1 s 循环决定什么时候拉取；拿到数据后用 AppKit 把图标和 1–2 行文字画成模板位图，交给托盘显示。

**Tech Stack:** Bun + TypeScript（Hono、zod、drizzle/bun:sqlite）；Rust（GPUI Kit、tray-icon/muda、objc2-app-kit）。

**Spec:** `docs/superpowers/specs/2026-10-05-mac-tray-metrics-design.md`

## Global Constraints

- **测试命令**：
  - TS 一律跑包脚本：`bun run --cwd packages/<pkg> test:unit`，不要裸 `bun test`。
  - Rust：`cargo test --manifest-path desktop/Cargo.toml`。
- **TS 模块组织**：按 `foo/index.ts`（仅导出）+ `foo/foo.ts` + `foo/foo.test.ts` 组织，不新建 `_test/`。
- **文件大小**：非测试文件超过 400 行先评估拆分，500 行是硬上限。
- **`DesktopLiveV1` 契约**：对象 strict；token 和费用用 `NonNegativeIntegerStringSchema`（整数字符串）。Rust 端按 `u128` 解析，和 `desktop/src/summary.rs` 保持一致。
- **常量**：
  - 吞吐窗口为最近 3 个完整秒。
  - 默认 4 字符/token。
  - EMA α = 0.3，**EMA 的结果**夹在 `0.5..10`。
  - 比例表最多 256 个模型。
  - 今日累计缓存 5 s。
  - 拉取间隔：选了 `tokensPerSecond` 或 `inFlight` 时 1 s；只选今日类指标时 15 s；没选指标时不拉取。
  - 连续失败 3 次显示 `—`。
- **偏好默认值**：`trayMetrics: []`、`trayShowIcon: true`、`trayLabelStyle: "unit"`；最多 2 个指标。
- **菜单文案（英文）**：`Menu Bar Display`、`Today Tokens`、`Tokens per Second`、`Today Cost`、`Requests in Flight`、`Show Icon`、`Labels: Prefix`、`Labels: Unit`。
- **ID**：
  - 指标：`todayTokens`、`tokensPerSecond`、`todayCost`、`inFlight`。
  - 样式：`prefix`、`unit`。
- **平台范围**：
  - 菜单和渲染只做 macOS（`cfg(target_os = "macos")`），Linux 和 Windows 的行为不变。
  - 子菜单只加在托盘的原生菜单里，不进入面板 `⋯` 菜单也在用的 `tray::entries()`。
- **只统计流式请求**：tok/s 只统计客户端请求了流式（`streamRequested`）的 attempt。
- **校准时机**：上游 capture 成功就校准，不等待向客户端转发（egress）完成。
- **检查命令**：每个 TS 改动完成前跑 `bun run check`；全部完成前跑 `bun run preflight`。

## Review Focus

1. **进行中计数泄漏**：请求在响应前抛错、客户端断开、空闲超时、切换到下一个 provider 时，计数都必须回到 0。Task 3 通过 `finish` / `finishFrom` 的真实接口覆盖这些路径。
2. **非流式请求混进 tok/s**：AI SDK 路径对非流式请求也会走 `streamCapture`。Task 4 测试 `stream:false` 时不记录、也不校准。
3. **异常 usage 污染比例**：Task 2 测试 EMA 多次更新后被夹在上下限内，以及 `outputTokens = 0` 时跳过校准。
4. **大整数和跨零点**：今日累计超过 JS 安全整数时不能丢精度，23:59 与 00:01 要读到不同的本地日。Task 5 测试。
5. **菜单栏卡在旧数字**：服务停止、返回 401、实例被替换、面板关闭时，菜单栏都要及时更新。Task 9 用纯状态机测试"何时该拉取""失败如何显示"以及按 epoch 丢弃旧实例的迟到响应；Task 10 在收到 401 或连接失败时触发重新发现和健康检查，各自的检测时限写在 Task 10 里。

---

### Task 1: `DesktopLiveV1` 类型与共享 fixture

**Files:**
- Create: `packages/types/src/desktop-live/index.ts`, `desktop-live.ts`, `desktop-live.test.ts`, `fixtures/v1.json`
- Modify: `packages/types/src/index.ts`（加 `export * from './desktop-live/index';`）

**Interfaces:**
- Produces: `DesktopLiveV1Schema`，以及
  ```ts
  type DesktopLiveV1 = {
    version: 1;
    todayTokens: string;
    todayCostNanoUsd: string;
    inFlight: number;
    outputTokensPerSecond: number;
  };
  ```
  - `inFlight` 为非负整数；`outputTokensPerSecond` 为非负有限数。
  - fixture 内容：`{"version":1,"todayTokens":"1234567","todayCostNanoUsd":"3410000000","inFlight":2,"outputTokensPerSecond":48.3}`。

- [ ] **Step 1: 写失败测试**：`desktop-live.test.ts`
  - fixture 能通过 `parse`。
  - 多一个字段时 `safeParse(...).success === false`。
  - `outputTokensPerSecond: -1` 时失败；`todayTokens: 12`（number 而非字符串）时失败。
- [ ] **Step 2: 运行**：`bun run --cwd packages/types test:unit`，预期 FAIL。
- [ ] **Step 3: 实现**：复用 `../dashboard/index` 的 `NonNegativeIntegerStringSchema`，写法与 `desktop-summary.ts` 相同。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(types): add desktop live metrics contract`

### Task 2: `live-metrics` 核心

**Files:**
- Create: `packages/server/src/live-metrics/index.ts`, `live-metrics.ts`, `live-metrics.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LiveMetrics = {
    readonly requestStarted: () => void;
    readonly requestFinished: () => void;
    readonly recordContent: (modelKey: string, chars: number) => void;
    readonly calibrate: (modelKey: string, chars: number, outputTokens: number) => void;
    readonly snapshot: () => { readonly inFlight: number; readonly outputTokensPerSecond: number };
  };
  export function createLiveMetrics(options?: { readonly now?: () => number }): LiveMetrics; // 默认 Date.now
  export function codePointLength(text: string): number;
  export const liveModelKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`;
  ```

- [ ] **Step 1: 写失败测试**：时钟用可变的 `let t` 注入。
  - `codePointLength('a中😀') === 3`。
  - 同一秒里对 `'p/m'` 两次 `recordContent(…, 120)`，推进到下一秒后速率为 `240 / 4 / 3 = 20`。
  - 推进 4 s 后速率为 `0`；当前这一秒（尚未结束）的字符不计入。
  - 一次 `calibrate('p/m', 200, 100)` 后比例为 `4 + 0.3 × (2 − 4) = 3.4`。随后录入 340 字符，推进一秒，速率 `toBeCloseTo(340 / 3.4 / 3)`。
  - 另一个未校准的模型仍按 4 计算，多模型速率相加。
  - **上限**：对同一模型重复 `calibrate(…, 10_000, 1)` 20 次后比例为 10，速率用 10 换算。
  - **下限**：重复 `calibrate(…, 1, 100)` 20 次后比例为 0.5。
  - `outputTokens = 0` 或 `chars = 0` 时比例不变。
  - 校准 257 个不同模型后，最早更新的那个回到默认比例。
  - `requestFinished()` 多调一次时，`inFlight` 不低于 0。
- [ ] **Step 2: 运行**：`bun run --cwd packages/server test:unit -- src/live-metrics`，预期 FAIL。
- [ ] **Step 3: 实现**：
  - 秒桶：`Map<number, Map<string, number>>`，读写时清理过期的桶。
  - 比例表：`Map<string, number>`，更新时先 delete 再 set，超过 256 时删除第一个。
  - EMA 计算公式：`clamp(prev + α × (sample − prev), 0.5, 10)`。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(server): add in-process live throughput metrics`

### Task 3: 进行中计数接入 trace recorder，`liveMetrics` 装配进 ServerState

**Files:**
- Modify:
  - `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.ts`
    - options 增加 `liveMetrics`。
    - `begin` 中加一，`operation === 'token_count'` 时跳过。
    - 内部 `complete` 在 `state = 'finished'` 之后减一。现有的 `state === 'finished'` 守卫已经保证只执行一次，不需要再加标志。
  - `packages/server/src/server-state/index.ts`：`createRequestServices` 创建 `liveMetrics`，传给 recorder，并作为返回值之一。
  - `packages/server/src/server-state/lifecycle.ts`：
    - `ServerStateParts`（`:149`）的 Pick 增加 `'liveMetrics'`。
    - 调用 `assembleServerState` 的地方传入它。
    - 返回对象（`:180` 起）加上 `liveMetrics: parts.liveMetrics`。
  - `packages/server/src/server-state/types.ts`：`ServerState` 增加 `readonly liveMetrics: LiveMetrics`。
- Test: `request-trace-recorder.test.ts`（已有，追加用例）

**Interfaces:**
- Consumes: Task 2 的 `LiveMetrics`。
- Produces:
  - `createRequestTraceRecorder({ …, liveMetrics?: Pick<LiveMetrics, 'requestStarted' | 'requestFinished'> })`。
  - `state.liveMetrics`：recorder、capture、路由三处共用同一个实例。

- [ ] **Step 1: 写失败测试**：用一个记录调用的 fake 作为 `liveMetrics`，并使用 session 的公开接口 `finish` / `finishFrom`。
  - `begin` 后计数为 1。
  - `finish` 分别以 success、failure、cancelled 结束后回到 0。
  - `finishFrom` 的 Promise resolve 后回到 0；reject 后同样回到 0。
  - 先 `finish` 再 `finishFrom`，或者 `finish` 两次，都只减一次。
  - `operation: 'token_count'` 的请求不计数。
  - **pipeline 集成**：在 `routes/pipeline/model-stream.lifecycle.test.ts` 和 `raw-fallback.test.ts` 的现有 setup 上追加用例，断言 `state.liveMetrics.snapshot().inFlight`：
    - 客户端在流中途取消后回到 0。
    - 上游空闲超时后回到 0。
    - 第一个候选失败、fallback 到第二个候选期间始终为 1（同一请求只计一次），结束后回到 0。
- [ ] **Step 2: 运行**：`bun run --cwd packages/server test:unit -- src/request-tracing src/routes/pipeline`，预期 FAIL。
- [ ] **Step 3: 实现**：按上面 Files 的说明改。
- [ ] **Step 4: 运行**：同上，再跑 `bun run --cwd packages/server test:unit -- src/server-state` 和 `bun run check`，预期 PASS。
- [ ] **Step 5: 提交**：`feat(server): count in-flight generation requests`

### Task 4: 流式内容字符数与校准

**Files:**
- Modify:
  - `packages/server/src/passthrough-usage/content.ts`：**保留** `hasContentDelta` 不变，它仍负责 TTFT 判定。新增 `contentDeltaLength(protocol, eventType, value): number`，返回该事件中文本或推理文本的 `codePointLength` 之和，没有内容时返回 0。
  - `packages/server/src/passthrough-usage/passthrough-usage.ts:39,135-141`：`onContent?: (chars: number) => void`。
    - 走 `hasContentDelta` 分支时传 `contentDeltaLength(...)`。
    - 走 TTFT fallback 分支时传 `0`。
    - 判断条件本身不改。
  - `packages/server/src/usage-capture/passthrough-capture/observation-source.ts`：`onContent: (at: number, chars: number) => void`。
  - `packages/server/src/usage-capture/shared.ts`：`StreamUsageOptions` 和 `PassthroughUsageOptions` 都增加 `readonly live?: boolean`。
  - `packages/server/src/usage-capture/stream-capture.ts:132`：`live` 为真时，`text-delta` 和 `reasoning-delta` 取 `codePointLength(next.value.text)`，记录并累计。`complete()` 中 `finalizeUsage` 返回的 usage 满足 `outputTokens > 0` 时调用 `calibrate`。
  - `packages/server/src/usage-capture/passthrough-capture/passthrough-capture.ts`：同样的规则，`live` 为真时才记录，成功并有 `outputTokens > 0` 时校准。
  - `packages/server/src/usage-capture/usage-capture.ts`：`createUsageCapture({ logger, liveMetrics })` 把 `liveMetrics` 作为第三个参数传给 `streamCapture` 和 `passthroughCapture`。
  - `packages/server/src/server-state/index.ts`：把 Task 3 创建的 `liveMetrics` 传入 `createUsageCapture`。
  - `packages/server/src/routes/pipeline/attempt/model.ts:94`：传 `live: ctx.streamRequested`。
  - `packages/server/src/routes/pipeline/attempt/raw.ts:161`：传入同样的流式标志（实现时先确认 raw attempt 的 ctx 上叫什么名字）。
- Test: `passthrough-usage.test.ts`、`usage-capture.stream.test.ts`、`usage-capture.passthrough.test.ts`（已有，追加用例）

**Interfaces:**
- Consumes: `LiveMetrics['recordContent' | 'calibrate']`、`codePointLength`、`liveModelKey`。
- Produces: `contentDeltaLength(...)`，以及 capture options 上的 `live?: boolean`。

- [ ] **Step 1: 写失败测试**
  - `contentDeltaLength`：
    - 各协议各取一个现有的内容事件 fixture，返回值等于其文本的 code point 数。
    - Anthropic 的 `text_delta` 内容为 `''` 时返回 0，同时 `hasContentDelta` 仍为 true（证明 TTFT 判定没变）。
    - OpenAI-compatible 的一个 chunk 里同时有 `content` 和 `reasoning_content` 时，返回两者之和。
  - 流式捕获（`live: true`）：
    - 输入 `'hello'`、`'世界'` 两个 `text-delta` 和一个 `'ab'` 的 `reasoning-delta`，`recordContent` 收到的总和为 9，`modelKey` 为 `'p/m'`。
    - finish usage 为 `outputTokens: 3` 时，`calibrate('p/m', 9, 3)` 被调用一次。
  - 流式捕获（`live: false`）：同样的输入，`recordContent` 和 `calibrate` 都不被调用。
  - 透传 SSE（OpenAI-compatible，`live: true`）：两个 content chunk 共 7 个字符，`recordContent` 总和为 7；最终 usage 为 `outputTokens: 2` 时调用 `calibrate('p/m', 7, 2)`。
  - 失败、取消、空闲超时时不调用 `calibrate`。
  - 在上游 finish 之前取消，不校准；在上游 finish 之后、向客户端转发时才取消，仍然校准（这是 spec 规定的时机）。
  - **pipeline 接线**：在 `routes/pipeline/model-stream.test.ts` 和 `raw-session.test.ts` 的现有 setup 上，组合 model / raw × `stream: true` / `stream: false` 四种情况。流式时 `snapshot().outputTokensPerSecond` 在推进时钟后大于 0；非流式时为 0。这样两个调用点漏传 `live` 都会让测试失败。
- [ ] **Step 2: 运行**：`bun run --cwd packages/server test:unit -- src/passthrough-usage src/usage-capture src/routes/pipeline`，预期 FAIL。
- [ ] **Step 3: 实现**：按上面 Files 的说明改。
- [ ] **Step 4: 运行**：再跑一遍 `bun run --cwd packages/server test:unit`（整包）。预期全部 PASS，现有的 ttft 测试不改动也能通过。
- [ ] **Step 5: 提交**：`feat(server): feed streamed content into live throughput`

### Task 5: core 今日累计查询

**Files:**
- Create: `packages/core/src/db/trace-store/today-usage/index.ts`, `today-usage.ts`, `today-usage.test.ts`
- Modify:
  - `packages/core/src/db/trace-store/types.ts`：`TraceStore` 增加 `todayUsage`。
  - `packages/core/src/db/trace-store/trace-store.ts`：注册 `todayUsage`。
  - `packages/core/src/db/trace-store/trace-lifecycle/usage-persistence.ts:32`：删除私有的 `localDay`，改用 `../usage-range` 的 `usageLocalDate`，让写入和查询共用同一个函数。
  - `packages/core/src/db/trace-store/index.ts` 和 `packages/core/src/db/index.ts`：公开导出 `usageLocalDate`，让 Task 6 能通过 `@aio-proxy/core/db` 使用它。

**Interfaces:**
- Produces: `todayUsage(db, now: Date): { readonly inputTokens: bigint; readonly outputTokens: bigint; readonly estimatedCostNanoUsd: bigint }`。
  - 查询 `local_day = usageLocalDate(now)` 的所有行，三列都用 `cast(... as text)` 取出。
  - 每个值用 `parseSqliteInteger` 解析，在 JS 里以 `bigint` 累加，不用 SQL 的 `sum()`。

- [ ] **Step 1: 写失败测试**：使用 `desktop-usage.test.ts` 同款内存数据库 setup。
  - 今天两个模型各一行、昨天一行，结果只包含今天两行之和。
  - 两行的 `output_tokens` 都是 `'9007199254740993'`，结果为 `18014398509481986n`（证明没有丢精度）。
  - `now` 分别设为本地 23:59 和次日 00:01，读到两天各自的值。
  - 空表返回三个 `0n`。
- [ ] **Step 2: 运行**：`bun run --cwd packages/core test:unit -- src/db/trace-store/today-usage`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行**：`bun run --cwd packages/core test:unit`（整包，因为改了 usage-persistence），预期 PASS。
- [ ] **Step 5: 提交**：`feat(core): query today's usage totals`

### Task 6: `GET /dashboard/api/desktop-live` 与 changeset

**Files:**
- Create: `packages/server/src/dashboard-routes/desktop-live/index.ts`, `route.ts`, `route.test.ts`
- Modify:
  - `packages/server/src/dashboard-routes/desktop-summary/index.ts`：同时导出 `requireDesktopToken`。
  - `packages/server/src/server/create-routes.ts:181` 之后加 `app.route('/dashboard/api/desktop-live', createDesktopLiveRoute(state));`
- Create: `.changeset/<name>.md`（用 `bun changeset` 生成）

**Interfaces:**
- Consumes: `state.liveMetrics.snapshot()`、`state.traceStore.todayUsage(now)`、`requireDesktopToken`、`DesktopLiveV1Schema`。
- Produces: `createDesktopLiveRoute(state: Pick<ServerState, 'desktopToken' | 'liveMetrics' | 'traceStore'>, options?: { now?: () => Date })`。
  - `todayTokens = String(inputTokens + outputTokens)`。
  - `outputTokensPerSecond` 四舍五入到一位小数。
  - 今日累计在闭包里缓存 5 s。缓存键包含 `usageLocalDate(now)`，跨零点立即失效；时钟回拨时缓存作废。

- [ ] **Step 1: 写失败测试**：沿用 `desktop-summary/route.test.ts` 的 auth fixture。
  - 无 token、错误 token、非 loopback 请求均返回 401。
  - 正确请求的响应能通过 `DesktopLiveV1Schema.parse`，`inFlight` 和速率来自 fake `liveMetrics`。
  - fake `todayUsage` 在 5 s 内只被调用一次，第 6 s 再次调用。
  - 时钟跨过本地零点时立即重新查询。
- [ ] **Step 2: 运行**：`bun run --cwd packages/server test:unit -- src/dashboard-routes/desktop-live`，预期 FAIL。
- [ ] **Step 3: 实现路由并注册**。
- [ ] **Step 4: 运行**：同上，再跑 `bun run check`，预期 PASS。
- [ ] **Step 5: changeset**
  - `bun changeset` 选择 `aio-proxy`、`@aio-proxy/server`、`@aio-proxy/core`、`@aio-proxy/types`，全部为 `minor`。
  - 正文：`The macOS menu bar can show one or two live metrics next to the icon: today's tokens, today's cost, requests in flight, and real-time output tokens per second. Pick them from the menu bar icon's right-click menu.`
- [ ] **Step 6: 提交**：`feat(server): expose desktop live metrics endpoint`

### Task 7: Rust `DesktopLive` 模型

**Files:**
- Create: `desktop/src/live.rs`、`desktop/src/live/tests.rs`（模块组织沿用 `summary.rs` 加 `summary/tests.rs` 的方式）
- Modify: `desktop/src/lib.rs`（加 `pub mod live;`）

**Interfaces:**
- Consumes: Task 1 的 fixture。
- Produces:
  ```rust
  pub struct DesktopLive {
      pub today_tokens: u128,
      pub today_cost_nano_usd: u128,
      pub in_flight: u64,
      pub output_tokens_per_second: f64,
  }
  pub fn parse(body: &[u8]) -> Result<DesktopLive, String>;
  ```
  - 整数字符串的解析方式与 `summary.rs:98` 相同。
  - `version != 1`，或 `output_tokens_per_second` 为负数、非有限数时，返回 `Err`。

- [ ] **Step 1: 写失败测试**
  - `include_str!` 读取 `packages/types/src/desktop-live/fixtures/v1.json`，`parse` 结果为 `today_tokens == 1_234_567`、`output_tokens_per_second == 48.3`。
  - `todayTokens` 为 `"340282366920938463463374607431768211455"`（`u128::MAX`）时能正确解析。
  - `version: 2` 返回 `Err`；`outputTokensPerSecond: -1` 返回 `Err`。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml live::`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(desktop): parse the live metrics response`

### Task 8: 偏好

**Files:**
- Create: `desktop/src/prefs.rs`、`desktop/src/prefs/tests.rs`
- Modify: `desktop/src/lib.rs`；`desktop/src/app.rs`（`AppModel` 增加 `pub prefs: Prefs`，启动时调用 `Prefs::load(&prefs_path(&paths))`）

**Interfaces:**
- Produces:
  ```rust
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub enum TrayMetric { TodayTokens, TokensPerSecond, TodayCost, InFlight }

  #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub enum LabelStyle { Prefix, #[default] Unit }

  #[derive(Clone, PartialEq, Debug)]
  pub struct Prefs { pub tray_metrics: Vec<TrayMetric>, pub tray_show_icon: bool, pub tray_label_style: LabelStyle }

  impl Prefs {
      pub fn load(path: &Path) -> Prefs;
      pub fn save(&self, path: &Path) -> std::io::Result<()>;
      pub fn toggle_metric(&mut self, metric: TrayMetric);
      pub fn shows_icon(&self) -> bool;
  }

  pub const MAX_TRAY_METRICS: usize = 2;
  pub fn prefs_path(paths: &crate::install::Paths) -> PathBuf; // paths.support.join("preferences.json")
  ```
  - `load`：
    - 文件缺失或损坏时返回默认值，并记一条 `crate::log::info`。
    - 未知的指标 ID 丢弃：先反序列化为 `Vec<String>`，再逐个映射。
    - 超过 2 个时只保留前 2 个。
  - `toggle_metric`：已选中则移除；未选中且已满 2 个时不做任何事；其余情况追加到末尾。
  - `shows_icon()`：返回 `tray_show_icon || tray_metrics.is_empty()`。
  - `save`：先写 `preferences.json.tmp`，再 `rename`。

- [ ] **Step 1: 写失败测试**：用临时目录。
  - 文件缺失、内容为 `"{not json"` 时都得到默认值。
  - `["todayTokens","bogus","inFlight","todayCost"]` 解析为 `[TodayTokens, InFlight]`。
  - save 后再 load 得到相同的值。
  - 已有 2 个时 toggle 第 3 个，列表不变；toggle 已选中的项会移除它。
  - 指标为空且 `tray_show_icon = false` 时，`shows_icon() == true`。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml prefs::`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(desktop): persist menu bar display preferences`

### Task 9: 格式化、拉取调度、显示状态

**Files:**
- Create: `desktop/src/tray/metrics.rs`、`desktop/src/tray/metrics/tests.rs`
- Modify: `desktop/src/tray.rs`（加 `mod metrics; pub use metrics::*;`）

**Interfaces:**
- Consumes: `DesktopLive`、`TrayMetric`、`LabelStyle`。
- Produces:
  ```rust
  #[derive(Clone, PartialEq, Eq, Debug)]
  pub struct MetricText { pub label: &'static str, pub value: String, pub unit: &'static str }
  pub fn format_metric(metric: TrayMetric, live: &DesktopLive, style: LabelStyle) -> MetricText;
  pub fn poll_interval(metrics: &[TrayMetric]) -> Option<Duration>; // 1 s / 15 s / None

  /// 决定常驻 1 s 循环的这一拍是否发请求。`epoch` 是 `AppModel.instance_epoch`
  /// (实例每次变化都会递增),不另造实例标识。
  #[derive(Clone, PartialEq, Eq, Debug)] pub struct LiveKey { pub metrics: Vec<TrayMetric>, pub epoch: u64 }
  #[derive(Default)] pub struct LiveSchedule { last: Option<(Instant, LiveKey)>, in_flight: bool }
  impl LiveSchedule {
      /// eligible = 健康 Up && 有 reachable control_url && 有 token
      pub fn due(&mut self, now: Instant, key: &LiveKey, eligible: bool) -> bool;
      pub fn finished(&mut self);
  }

  #[derive(Default)] pub struct LiveDisplay { epoch: u64, last: Option<DesktopLive>, failures: u32, auth_retry_used: bool }
  pub enum LiveView<'a> { Fresh(&'a DesktopLive), Stale(&'a DesktopLive), Unavailable }
  impl LiveDisplay {
      /// 实例变化:清空数据、失败计数与鉴权重试状态。
      pub fn set_epoch(&mut self, epoch: u64);
      /// 以下三个结果方法都带请求发出时的 epoch;与当前 epoch 不同的(旧实例的迟到响应)直接忽略。
      pub fn accept(&mut self, epoch: u64, live: DesktopLive);
      pub fn fail(&mut self, epoch: u64);
      /// 收到 401:返回 true 表示调用方应 rediscover 一次。
      pub fn unauthorized(&mut self, epoch: u64) -> bool;
      pub fn view(&self) -> LiveView<'_>;
  }
  ```
  - `MetricText` 的取值：Prefix 样式下 `label` 有值、`unit` 为空；Unit 样式下 `label` 为空、`unit` 有值。今日费用在 Unit 样式下 value 带 `$` 前缀，unit 为空。
  - `due` 返回 `true` 的条件：`eligible` 为真，**且**当前没有请求在途，**且**满足以下任一条：
    - 从未拉取过；
    - `key` 与上次不同；
    - 距上次已经过了 `poll_interval(key.metrics)`。
  - `due` 返回 `false` 的情况：`eligible` 为假时一律返回 false，并清空 `last`，这样恢复后下一拍会立即拉取；`poll_interval` 为 `None` 时也返回 false。
  - `view()`：`failures == 0` 且有数据时为 `Fresh`；失败 1–2 次且有数据时为 `Stale`；失败 ≥ 3 次或从未有数据时为 `Unavailable`。
  - `unauthorized()`：先计一次失败；在 `auth_retry_used` 为假时把它置为真并返回 true，否则返回 false。`accept` 会把 `auth_retry_used` 重置为假。

- [ ] **Step 1: 写失败测试**：断言 spec 表格里的全部值。
  - `todayTokens`：999 → `999`；1_234_567 → `1.23M`；12_345_678 → `12.3M`；1_234_567_890 → `1.23B`。Unit 样式为 `1.23M tok`，Prefix 样式为 `TOK 1.23M`。
  - `tokensPerSecond`：48.25 → `48.3`；0.0 → `0.0`；123.6 → `124`。
  - `todayCost`（nano USD）：3_410_000_000 → `$3.41`（Unit）或 `USD 3.41`（Prefix）；123_400_000_000 → `$123`。
  - `inFlight`：2 → `2 req` 或 `REQ 2`。
  - `poll_interval`：`[]` → `None`；`[TodayTokens]` → 15 s；`[TodayCost, InFlight]` → 1 s。
  - `LiveSchedule`：
    - 首拍为 true；`finished` 之前的下一拍为 false。
    - 1 s 间隔下，0.5 s 后为 false，1 s 后为 true。
    - 15 s 间隔下，改变 `metrics` 后立即为 true；`epoch` 改变后立即为 true。
    - `eligible = false` 时为 false，恢复为 true 后立即为 true。
    - 指标为空时恒为 false。
  - `LiveDisplay`：
    - accept 后为 Fresh；连续失败 2 次为 Stale；第 3 次为 Unavailable；再次 accept 回到 Fresh。
    - 连续两次 `unauthorized()` 返回 true、false；accept 之后再次 `unauthorized()` 返回 true。
    - 实例 A 的请求在途时切到 B：`set_epoch(B)` 后，A 的 `accept(A, …)` 被忽略，`view()` 为 `Unavailable`；A 的 `fail`、`unauthorized` 同样被忽略，不影响 B 的失败计数和重试锁。
    - `set_epoch` 会清空旧实例遗留的失败计数，以及已用掉的 401 重试机会。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml tray::metrics`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(desktop): format and schedule menu bar metrics`

### Task 10: 常驻 live 循环

**Files:**
- Create: `desktop/src/app/live.rs`
- Modify:
  - `desktop/src/app.rs`：
    - `AppModel` 增加 `pub live: LiveDisplay` 和 `live_schedule: LiveSchedule`。
    - 声明 `mod live;`，并 `pub use live::start as start_live_timer;`。
  - `desktop/src/main.rs:63`：在 `app::start_health_timer(cx);` 之后调用 `app::start_live_timer(cx);`。

**Interfaces:**
- Consumes: `LiveSchedule`、`LiveDisplay`、`live::parse`、`transport::spawn`、`refresh::rediscovers_after`、`super::check_health`、`super::rediscover`；discovery 和 token 的取法与 `app/refresh.rs::summary_request` 相同。
- Produces: `pub fn start(cx: &mut App)`，与 `health::start_timer` 同构，是一个 detached 循环，每 1 s 执行一拍：
  1. 取 `epoch = model.instance_epoch`。如果 `model.live` 记录的 epoch 与它不同，就调用 `set_epoch(epoch)`。
  2. 用 `LiveKey { metrics: prefs.tray_metrics.clone(), epoch }` 判断 `due(now, &key, eligible)`，其中 `eligible = model.health.state() == HealthState::Up && 有 reachable 的 control_url && 有 token`。
  3. 如果 `due(...)` 为 true，就 spawn 一个 `GET /dashboard/api/desktop-live`，请求带上发出时的 `epoch`。结果按以下方式处理，最后都调用 `finished()` 和 `crate::tray::sync(cx)`：
     - 200：`accept(epoch, …)`。
     - 401：如果 `unauthorized(epoch)` 返回 true，调用 `super::rediscover(cx)`。
     - `HttpError::Connect` 或 `UntrustedListener`：`fail(epoch)`。另外，只要 `rediscovers_after(&error, model.gone_rediscovered_at, now)` 为真，就记下时间，再调用 `super::check_health(cx)` 和 `super::rediscover(cx)`。这和 summary 轮询发现服务消失时的处理方式相同，有 5 s 节流。
     - 其他错误：`fail(epoch)`。
  4. 如果 `eligible` 为 false，且显示的不是 `Unavailable`，就调用 `crate::tray::sync(cx)`，让菜单栏立即反映服务停止。

  有了这个循环，健康状态变化、实例替换、Stop/Start、面板开关、偏好修改都不需要单独接线，下一拍会自动按最新状态拉取；旧实例的迟到响应会被 epoch 挡掉。

  **服务停止的检测时限**：
  - 选了 1 s 指标时，连接失败会立刻触发健康检查（节流 5 s），健康检查需要连续两次失败才判定 Down。所以菜单栏约 1 s 后变暗，约 5–10 s 后文字消失。
  - 只选今日类指标时，每 15 s 才拉一次，最长约 30 s 后文字消失。
  - 不改动健康检查本身的 60 s 周期。

- [ ] **Step 1: 实现**：规则已由 Task 9 的纯函数测试覆盖，这里只写胶水代码。
- [ ] **Step 2: 验证**：`cargo test --manifest-path desktop/Cargo.toml` 全绿；`cargo clippy --manifest-path desktop/Cargo.toml -- -D warnings` 无告警。
- [ ] **Step 3: 提交**：`feat(desktop): poll live metrics for the menu bar`

### Task 11: 右键菜单「Menu Bar Display」子菜单（仅托盘）

**Files:**
- Modify:
  - `desktop/src/tray/menu.rs`：
    - `MenuCommand` 新增 `TrayMetric(TrayMetric)`、`ToggleTrayIcon`、`TrayLabels(LabelStyle)`，id 分别为 `tray-metric-today-tokens`、`tray-metric-tokens-per-second`、`tray-metric-today-cost`、`tray-metric-in-flight`、`tray-icon`、`tray-labels-prefix`、`tray-labels-unit`。
    - **不改** `MenuEntry`，因为面板 `footer.rs:44` 和 `tray/menu/tests.rs:11` 都对它做了穷尽匹配，加变体会编译失败。
  - `desktop/src/tray.rs`：
    - `pub fn display_menu_entries(prefs: &Prefs) -> Vec<MenuEntry>`：只用 `Check` 条目和 `Separator`，是纯函数。
    - `native_menu` 增加参数 `display: Option<&[MenuEntry]>`。当它为 `Some` 时，在 `OpenLogs` 项之前插入一个 `tray_icon::menu::Submenu`（标题 `Menu Bar Display`），子项用同一套 `Item`、`Check`、`Separator` 映射。
    - `sync()` 在 macOS 上传 `Some(&display_menu_entries(&model.prefs))`。用于判断菜单是否变化的 `entries` 比较要把 display 条目一并纳入（`Tray` 存 `(entries, display)`）。
    - `run()` 处理新命令：修改 `AppModel.prefs`、`save`（失败时记日志，不弹窗），再调用 `sync`。拉取由 Task 10 的循环在下一拍按新的 key 自动开始。
    - `tray::entries()` 保持不变，所以面板 `⋯` 菜单不受影响。
- Test: `desktop/src/tray/tests.rs`（已有，追加用例）

**Interfaces:**
- Consumes: Task 8 的 `Prefs`。
- Produces: `display_menu_entries(prefs) -> Vec<MenuEntry>`。

- [ ] **Step 1: 写失败测试**
  - 所有新 `MenuCommand` 的 `from_id(cmd.id())` 往返一致。
  - 选中 `[TodayTokens, InFlight]` 时，这两项为 checked 且 enabled，另外两项为 unchecked 且 disabled。
  - 选中为空时，`Show Icon` 为 checked 且 disabled。
  - 两个 Labels 项中只有一个 checked。
  - `entries(model)` 的结果里不包含任何新命令，证明面板菜单不受影响。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml tray::`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行**：预期 PASS，`cargo build` 无错误。
- [ ] **Step 5: 提交**：`feat(desktop): add the menu bar display menu`

### Task 12: AppKit 渲染与托盘接入（macOS）

**Files:**
- Create: `desktop/src/tray/metrics_image.rs`（`#[cfg(target_os = "macos")]`）
- Modify:
  - `desktop/Cargo.toml`：`objc2-app-kit` 增加 features `NSImage`、`NSImageRep`、`NSBitmapImageRep`、`NSFont`、`NSAttributedString`、`NSStringDrawing`、`NSGraphicsContext`、`NSFontDescriptor`；如有需要，`objc2-foundation` 增加 `NSAttributedString`、`NSGeometry`。
  - `desktop/src/tray.rs`：
    - `Tray.shown` 改为 `Option<Shown>`：
      ```rust
      #[derive(Clone, PartialEq, Debug)]
      pub struct Shown {
          state: TrayState,
          color: [u8; 3],
          lines: Vec<MetricText>, // 比较与渲染共用同一份数据;Unavailable 时 value 为 "—"
          show_icon: bool,
          dimmed: bool,
      }
      ```
    - 新增纯函数 `pub fn shown_for(model: &AppModel, color: [u8; 3]) -> Shown`，规则如下：
      - 服务 Down：没有 lines，与现状一致。
      - `Unavailable`：每行为 `—`。
      - `Stale`：`dimmed = true`。
    - `sync()` 在 `Shown` 变化时重绘：有 lines 时调用 `metrics_image::render`，否则调用 `icon_rgba`。

**Interfaces:**
- Consumes: `MetricText`、`LiveView`、`TrayState`、`MARK_PNG`、`DOT`。
- Produces: `pub fn render(lines: &[MetricText], show_icon: bool, state: TrayState, dimmed: bool) -> (Vec<u8>, u32, u32)`，返回 RGBA、宽度和高度（固定 36 px）。
  - 1 行用 12 pt，2 行各 9 pt；字体为 `NSFont::monospacedDigitSystemFontOfSize_weight`。
  - 两行时数值列右对齐，Prefix 样式下标签列左对齐。
  - 图标与文字间距 4 pt（@2x 为 8 px）。
  - `dimmed` 时整体 alpha × 0.4。
  - Attention 圆点：有图标时画在图标右上角，无图标时画在文字块右上角。

- [ ] **Step 1: 写失败测试**：`shown_for`
  - Fresh → Stale，数值不变：两次的 `Shown` 不相等（只有 `dimmed` 不同），保证一定会重绘。
  - Stale → Fresh 时同样不相等。
  - 服务 Down 时 `lines` 为空。
  - 连续失败 3 次后 `lines` 全为 `—`。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml tray::`，预期 FAIL。
- [ ] **Step 3: 实现 `shown_for` 和 `render`**：
  - 用 `NSBitmapImageRep::initWithBitmapDataPlanes…` 创建 RGBA 8 bit 位图。
  - 用 `NSGraphicsContext::graphicsContextWithBitmapImageRep` 创建上下文，设为当前上下文后绘制。
  - 文字用黑色，模板图由系统着色。
- [ ] **Step 4: 运行**：`cargo test` 和 `cargo build` 均通过。
- [ ] **Step 5: 手动验证**：启动桌面开发版（参照 `desktop/README` 或 `run` skill），逐项检查：
  - 默认只显示图标，与改动前一致。
  - 只勾 `Today Tokens`：单行 12 pt 文字。
  - 再勾 `Tokens per Second`：两行；发流式请求时 tok/s 每秒跳动，宽度不抖动；非流式请求不让 tok/s 跳动。
  - 切换 Labels：`TOK 1.23M` 与 `1.23M tok` 互换。
  - 关掉 Show Icon：只剩文字。
  - 亮色和暗色菜单栏下都能看清。
  - 勾选 tok/s 时执行 `aiop stop`：约 1 s 后变暗，约 10 s 内文字消失；`aiop start` 后自动恢复。
  - 在面板打开期间执行 `aiop restart` 替换实例：旧实例的数字不会闪回。
  - 关闭面板后数字照常更新。
  - 重启 app 后偏好保留。
- [ ] **Step 6: 提交**：`feat(desktop): render metrics into the menu bar icon`

### Task 13: 收尾

- [ ] **Step 1**：`bun run build && bun run preflight` 全绿。
- [ ] **Step 2**：`cargo test --manifest-path desktop/Cargo.toml` 和 `cargo clippy --manifest-path desktop/Cargo.toml -- -D warnings` 全绿。
- [ ] **Step 3**：如有格式修复，提交 `chore: format`。
