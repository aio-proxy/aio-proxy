# macOS 菜单栏指标 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** macOS 菜单栏可常驻显示今日 token、今日费用、进行中请求数、实时 tok/s 中用户选择的 1–2 项。

**Architecture:** 服务端新增进程内 `live-metrics`（进行中计数 + 按字符估算并按模型校准的流式吞吐），配合 `usage_daily` 的今日累计，经 `GET /dashboard/api/desktop-live` 暴露。桌面端持久化偏好、按所选指标 1 s / 15 s 轮询，用 AppKit 把图标与 1–2 行文字渲染为模板位图交给托盘。

**Tech Stack:** Bun + TypeScript（Hono、zod、drizzle/bun:sqlite）；Rust（GPUI Kit、tray-icon/muda、objc2-app-kit）。

**Spec:** `docs/superpowers/specs/2026-10-05-mac-tray-metrics-design.md`

## Global Constraints

- TS 测试一律跑包脚本：`bun run --cwd packages/<pkg> test:unit`（不要裸 `bun test`）。Rust：`cargo test --manifest-path desktop/Cargo.toml`。
- 新 TS 模块按 `foo/index.ts`（仅导出）+ `foo/foo.ts` + `foo/foo.test.ts` 组织；不新建 `_test/`。
- 文件超过 400 行先评估拆分；500 行硬上限（非测试）。
- `DesktopLiveV1` 对象 strict；token/费用用 `NonNegativeIntegerStringSchema`（整数字符串）。
- 常量：吞吐窗口 3 个完整秒；默认 4 字符/token；EMA α = 0.3；比例夹在 `0.5..10`；最多 256 个模型；今日累计缓存 5 s；轮询 1 s（含 `tokensPerSecond` 或 `inFlight`）/ 15 s（仅今日类）/ 不轮询（无指标）；连续失败 3 次显示 `—`。
- 偏好默认 `trayMetrics: []`、`trayShowIcon: true`、`trayLabelStyle: "unit"`；最多 2 个指标。
- 菜单文案（英文）：`Menu Bar Display`、`Today Tokens`、`Tokens per Second`、`Today Cost`、`Requests in Flight`、`Show Icon`、`Labels: Prefix`、`Labels: Unit`。
- 指标 ID：`todayTokens`、`tokensPerSecond`、`todayCost`、`inFlight`；样式 ID：`prefix`、`unit`。
- 菜单与渲染仅 macOS（`cfg(target_os = "macos")`）；Linux/Windows 行为不变。
- 每个 TS 改动完成前跑 `bun run check`；全部完成前跑 `bun run preflight`。

## Review Focus

1. **请求永不 `complete` 时进行中计数泄漏**：服务端在响应前抛错或客户端提前断开时，计数仍必须回到 0。Task 3 测试成功、失败、取消三条路径，并测试同一 session 重复 `complete` 只减一次。
2. **异常 usage 污染比例**：上游报 `outputTokens` 极小或为 0 时，tok/s 不能飙到天文数字。Task 2 测试比例被夹在上下限内，以及 `outputTokens = 0` 时跳过校准。
3. **跨零点**：23:59 与 00:01 读到的今日累计属于不同的本地日。Task 5 测试。
4. **偏好文件损坏、未知 ID 或超过 2 个指标**：都要回退或截断，不能崩溃。Task 8 测试。
5. **服务停止或返回 401 时菜单栏卡在旧数字上**：Task 9 测试失败计数的状态机，以及健康状态非 Up 时停止轮询。

---

### Task 1: `DesktopLiveV1` 类型与共享 fixture

**Files:**
- Create: `packages/types/src/desktop-live/index.ts`, `desktop-live.ts`, `desktop-live.test.ts`, `fixtures/v1.json`
- Modify: `packages/types/src/index.ts`（加 `export * from './desktop-live/index';`）

**Interfaces:**
- Produces: `DesktopLiveV1Schema`, `type DesktopLiveV1 = { version: 1; todayTokens: string; todayCostNanoUsd: string; inFlight: number; outputTokensPerSecond: number }`。`inFlight` 是非负整数；`outputTokensPerSecond` 是非负有限数。fixture 内容：`{"version":1,"todayTokens":"1234567","todayCostNanoUsd":"3410000000","inFlight":2,"outputTokensPerSecond":48.3}`。

- [ ] **Step 1: 写失败测试**：`desktop-live.test.ts`
  - fixture 能通过 `DesktopLiveV1Schema.parse`。
  - 多一个字段时 `safeParse(...).success === false`（strict）。
  - `outputTokensPerSecond: -1` 时失败；`todayTokens: 12`（number 而非字符串）时失败。
- [ ] **Step 2: 运行**：`bun run --cwd packages/types test:unit`，预期 FAIL（模块不存在）。
- [ ] **Step 3: 实现**：schema 放在 `desktop-live.ts`，复用 `../dashboard/index` 的 `NonNegativeIntegerStringSchema`，写法与 `desktop-summary.ts` 相同。
- [ ] **Step 4: 运行**：同上，预期 PASS。
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
  export function createLiveMetrics(options?: { readonly now?: () => number }): LiveMetrics; // now 默认 Date.now
  export function codePointLength(text: string): number;
  export const liveModelKey = (providerId: string, modelId: string) => `${providerId}/${modelId}`;
  ```

- [ ] **Step 1: 写失败测试**：时钟用可变的 `let t` 注入。
  - `codePointLength('a中😀') === 3`。
  - 在同一秒里对同一模型 `recordContent('p/m', 120)` 两次，时钟推进到下一秒后，`snapshot().outputTokensPerSecond` 应为 `240 / 4 / 3 = 20`（默认比例 4）。
  - 时钟推进 4 s 后速率为 `0`（窗口过期）。
  - 当前这一秒（尚未结束）的字符不计入。
  - `calibrate('p/m', 200, 100)` 一次后比例为 `4 + 0.3 × (2 − 4) = 3.4`。随后录入 340 字符，推进一秒，速率 `≈ 340 / 3.4 / 3`，用 `toBeCloseTo`。
  - 未校准的另一模型仍按 4 计算，多模型速率相加。
  - `calibrate('p/m', 10_000, 1)` 后比例被夹到 10；`calibrate('p/m', 1, 100)` 后比例被夹到 0.5；`outputTokens = 0` 或 `chars = 0` 时忽略。
  - 校准 257 个不同模型后，最早更新的那个回到默认比例。
  - `requestFinished()` 多调一次时，`inFlight` 不低于 0。
- [ ] **Step 2: 运行**：`bun run --cwd packages/server test:unit -- src/live-metrics`，预期 FAIL。
- [ ] **Step 3: 实现**。
  - 桶：`Map<number /* epochSecond */, Map<string, number>>`，每次写入或读取时删掉 `< currentSecond − 3` 的桶。
  - 比例：`Map<string, number>`，利用插入顺序实现 LRU；更新时先 delete 再 set，超过 256 时删除第一个。
  - `codePointLength` 用 `for…of` 计数，不分配数组。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(server): add in-process live throughput metrics`

### Task 3: 进行中计数接入 trace recorder，`liveMetrics` 挂入 server state

**Files:**
- Modify:
  - `packages/server/src/request-tracing/request-trace-recorder/request-trace-recorder.ts`：options 增加 `liveMetrics`；`begin` 中加一，`complete` 的 `state = 'finished'` 之后减一。
  - `packages/server/src/server-state/index.ts`：`createRequestServices` 里创建 `liveMetrics`，传给 recorder 并返回它（Task 4 再把它传给 `createUsageCapture`）；在 `ServerState` 对象上暴露。
  - `packages/server/src/server-state/types.ts`：`ServerState` 增加 `readonly liveMetrics: LiveMetrics`。
- Test: `request-trace-recorder.test.ts`（已有，追加用例）

**Interfaces:**
- Consumes: Task 2 的 `LiveMetrics`。
- Produces: `createRequestTraceRecorder({ …, liveMetrics?: Pick<LiveMetrics, 'requestStarted' | 'requestFinished'> })`；`state.liveMetrics`。

- [ ] **Step 1: 写失败测试**：用一个记录调用的 fake 作为 `liveMetrics`。
  - 普通请求 `begin` 后计数为 1；分别以 success、failure、cancelled 结束后回到 0。
  - 对同一 session 调两次 `complete`，只减一次。
  - `operation: 'token_count'` 的请求不计数（它不是生成请求）。
- [ ] **Step 2: 运行**：`bun run --cwd packages/server test:unit -- src/request-tracing`，预期 FAIL。
- [ ] **Step 3: 实现**：按上面 Files 的说明改；`token_count` 判断沿用 `input.operation === 'token_count'`。
- [ ] **Step 4: 运行**：同上，再跑 `bun run --cwd packages/server test:unit -- src/server-state`，预期 PASS。
- [ ] **Step 5: 提交**：`feat(server): count in-flight generation requests`

### Task 4: 流式内容字符数与校准

**Files:**
- Modify:
  - `packages/server/src/passthrough-usage/content.ts`：`hasContentDelta(...): boolean` 改为 `contentDeltaLength(...): number`。各协议的私有 helper 改为返回文本的 `codePointLength`；无内容返回 0。
  - `packages/server/src/passthrough-usage/passthrough-usage.ts:39,135-141`：`onContent?: (chars: number) => void`。内容增量传长度；TTFT fallback 分支传 `0`。
  - `packages/server/src/usage-capture/passthrough-capture/observation-source.ts`：`onContent: (at: number, chars: number) => void`。
  - `packages/server/src/usage-capture/passthrough-capture/passthrough-capture.ts`：累计 `chars` 并调用 `recordContent`；成功结束且最终 usage 的 `outputTokens > 0` 时调用 `calibrate`。
  - `packages/server/src/usage-capture/stream-capture.ts:132`：`text-delta`、`reasoning-delta` 取 `next.value.text` 的长度。成功结束（`complete()` 中 `finalizeUsage` 之后）同样校准。
  - `packages/server/src/usage-capture/usage-capture.ts`：`createUsageCapture({ logger, liveMetrics })` 把 `liveMetrics` 作为第三个参数传给 `streamCapture` 和 `passthroughCapture`。
- Test: `passthrough-usage.test.ts`、`usage-capture.stream.test.ts`、`usage-capture.passthrough.test.ts`（已有，追加用例）

**Interfaces:**
- Consumes: `LiveMetrics['recordContent' | 'calibrate']`、`codePointLength`、`liveModelKey`。
- Produces: `contentDeltaLength(protocol, eventType, value): number`（替换 `hasContentDelta`，所有调用点一起改）。

- [ ] **Step 1: 写失败测试**
  - 各协议各取一个现有的内容事件 fixture，`contentDeltaLength` 返回的值等于其文本的 code point 数；`message_start`、`ping` 这类事件返回 0。
  - 流式捕获：两个 `text-delta`（`'hello'`、`'世界'`）加一个 `reasoning-delta`（`'ab'`），fake `liveMetrics` 收到的 `recordContent` 总和为 9，`modelKey` 为 `'p/m'`。在 finish usage `outputTokens: 3` 时，`calibrate('p/m', 9, 3)` 被调用一次。
  - 透传 SSE（OpenAI-compatible）：两个 content chunk 共 7 个字符，`recordContent` 总和为 7；最终 usage 的 `outputTokens: 2` 时调用 `calibrate('p/m', 7, 2)`。
  - 失败、取消、空闲超时时不调用 `calibrate`。
- [ ] **Step 2: 运行**：`bun run --cwd packages/server test:unit -- src/passthrough-usage src/usage-capture`，预期 FAIL。
- [ ] **Step 3: 实现**：按上面 Files 的说明改。现有 TTFT 测试必须不改动就能通过，用来证明行为没变。
- [ ] **Step 4: 运行**：同上，预期 PASS（包括所有现有 ttft、passthrough 测试）。
- [ ] **Step 5: 提交**：`feat(server): feed streamed content into live throughput`

### Task 5: core 今日累计查询

**Files:**
- Create: `packages/core/src/db/trace-store/today-usage/index.ts`, `today-usage.ts`, `today-usage.test.ts`
- Modify:
  - `packages/core/src/db/trace-store/types.ts`：`TraceStore` 增加 `todayUsage`。
  - `packages/core/src/db/trace-store/trace-store.ts`：注册 `todayUsage`。

**Interfaces:**
- Produces: `todayUsage(db, now: Date): { readonly inputTokens: bigint; readonly outputTokens: bigint; readonly estimatedCostNanoUsd: bigint }`。对 `usage_daily` 中 `local_day = usageLocalDate(now)` 的所有 `model_dimension` 行求和，没有行时全为 `0n`。`usageLocalDate` 来自 `../usage-range`，它与 `usage-persistence.ts` 的 `localDay` 输出格式相同。

- [ ] **Step 1: 写失败测试**：使用 `desktop-usage.test.ts` 同款内存数据库 setup。
  - 插入今天两个模型的行、昨天一行，结果只包含今天两行之和。
  - `now` 设为本地 `23:59` 和次日 `00:01` 时分别读到两天各自的值。
  - 空表返回三个 `0n`。
- [ ] **Step 2: 运行**：`bun run --cwd packages/core test:unit -- src/db/trace-store/today-usage`，预期 FAIL。
- [ ] **Step 3: 实现**：一条 `select sum(...)`，用 `parseSqliteInteger` 解析。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(core): query today's usage totals`

### Task 6: `GET /dashboard/api/desktop-live` 与 changeset

**Files:**
- Create: `packages/server/src/dashboard-routes/desktop-live/index.ts`, `route.ts`, `route.test.ts`
- Modify:
  - `packages/server/src/dashboard-routes/desktop-summary/index.ts`：同时导出 `requireDesktopToken`。
  - `packages/server/src/server/create-routes.ts:181` 之后加 `app.route('/dashboard/api/desktop-live', createDesktopLiveRoute(state));`
- Create: `.changeset/<name>.md`（用 `bun changeset` 生成）。

**Interfaces:**
- Consumes: `state.liveMetrics.snapshot()`、`state.traceStore.todayUsage(now)`、`requireDesktopToken`、`DesktopLiveV1Schema`。
- Produces: `createDesktopLiveRoute(state: Pick<ServerState, 'desktopToken' | 'liveMetrics' | 'traceStore'>, options?: { now?: () => Date })`。
  - `todayTokens = String(inputTokens + outputTokens)`。
  - `outputTokensPerSecond` 四舍五入到一位小数。
  - 今日累计在闭包里缓存 5 s，时钟回拨时作废。缓存键包含本地日，跨零点立即失效。

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
- Produces: `pub struct DesktopLive { pub today_tokens: u64, pub today_cost_nano_usd: u64, pub in_flight: u64, pub output_tokens_per_second: f64 }` 和 `pub fn parse(body: &[u8]) -> Result<DesktopLive, String>`。
  - 字段以 camelCase 反序列化；字符串字段解析成 `u64`；`version != 1` 返回 `Err`。

- [ ] **Step 1: 写失败测试**
  - `include_str!` 读取 `packages/types/src/desktop-live/fixtures/v1.json`，`parse` 结果为 `today_tokens == 1_234_567`、`output_tokens_per_second == 48.3`。
  - `version: 2` 返回 `Err`。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml live::`，预期 FAIL。
- [ ] **Step 3: 实现**：serde 反序列化，数字字符串用 `parse::<u64>`。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(desktop): parse the live metrics response`

### Task 8: 偏好

**Files:**
- Create: `desktop/src/prefs.rs`、`desktop/src/prefs/tests.rs`
- Modify: `desktop/src/lib.rs`

**Interfaces:**
- Produces:
  ```rust
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub enum TrayMetric { TodayTokens, TokensPerSecond, TodayCost, InFlight }
  #[derive(Clone, Copy, PartialEq, Eq, Debug, Default, Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
  pub enum LabelStyle { Prefix, #[default] Unit }
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
  - `load` 时，文件缺失或损坏返回默认值并 `crate::log::info`。未知指标 ID 丢弃（先反序列化为 `Vec<String>` 再逐个映射），超过 2 个截取前 2 个。
  - `toggle_metric`：已选中则移除；未选中且已满 2 个时不做任何事；否则追加到末尾。
  - `shows_icon()` 的值为 `tray_show_icon || tray_metrics.is_empty()`。
  - `save` 先写 `preferences.json.tmp` 再 `rename`。

- [ ] **Step 1: 写失败测试**：用临时目录。
  - 文件缺失时得到默认值。
  - 写入 `"{not json"` 后得到默认值。
  - `["todayTokens","bogus","inFlight","todayCost"]` 解析为 `[TodayTokens, InFlight]`。
  - save 后 load 往返相等。
  - 已有 2 个时 toggle 第 3 个不变化；toggle 已选中的项会移除它。
  - 空列表且 `tray_show_icon = false` 时 `shows_icon() == true`。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml prefs::`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(desktop): persist menu bar display preferences`

### Task 9: 格式化、轮询间隔、显示状态

**Files:**
- Create: `desktop/src/tray/metrics.rs`、`desktop/src/tray/metrics/tests.rs`
- Modify: `desktop/src/tray.rs`（加 `mod metrics; pub use metrics::*;`）

**Interfaces:**
- Consumes: `DesktopLive`、`TrayMetric`、`LabelStyle`、`HealthState`。
- Produces:
  ```rust
  pub struct MetricText { pub label: &'static str, pub value: String, pub unit: &'static str }
  pub fn format_metric(metric: TrayMetric, live: &DesktopLive, style: LabelStyle) -> MetricText;
  pub fn poll_interval(metrics: &[TrayMetric]) -> Option<Duration>; // 1 s / 15 s / None
  #[derive(Default)] pub struct LiveDisplay { last: Option<DesktopLive>, failures: u32 }
  pub enum LiveView<'a> { Fresh(&'a DesktopLive), Stale(&'a DesktopLive), Unavailable }
  impl LiveDisplay {
      pub fn accept(&mut self, live: DesktopLive);
      pub fn fail(&mut self);
      pub fn view(&self) -> LiveView<'_>;
  }
  ```
  - `MetricText` 的取值：Prefix 样式下 `label` 有值、`unit` 为空；Unit 样式下 `label` 为空、`unit` 有值。今日费用在 Unit 样式下的 value 带 `$` 前缀，unit 为空。
  - `view()`：`failures == 0` 且有数据时为 `Fresh`；失败 1–2 次且有数据时为 `Stale`；失败 ≥ 3 次或从未有数据时为 `Unavailable`。

- [ ] **Step 1: 写失败测试**：断言 spec 表格里的全部值。
  - `todayTokens`：999 → `999`；1_234_567 → `1.23M`；12_345_678 → `12.3M`；1_234_567_890 → `1.23B`。Unit 样式拼出 `1.23M tok`，Prefix 样式拼出 `TOK 1.23M`。
  - `tokensPerSecond`：48.25 → `48.3`；0.0 → `0.0`；123.6 → `124`。
  - `todayCost`（nano USD）：3_410_000_000 → `$3.41`（Unit）或 `USD 3.41`（Prefix）；123_400_000_000 → `$123`。
  - `inFlight`：2 → `2 req` 或 `REQ 2`。
  - `poll_interval`：`[]` → `None`；`[TodayTokens]` → 15 s；`[TodayCost, InFlight]` → 1 s。
  - `LiveDisplay`：accept 后为 Fresh；连续失败 2 次为 Stale；第 3 次为 Unavailable；再次 accept 回到 Fresh。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml tray::metrics`，预期 FAIL。
- [ ] **Step 3: 实现**：三位有效数字用 `{:.2}`、`{:.1}`、`{:.0}`，按数量级选择。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(desktop): format menu bar metrics`

### Task 10: 右键菜单「Menu Bar Display」子菜单

**Files:**
- Modify:
  - `desktop/src/tray/menu.rs`：`MenuEntry::Submenu { label: String, entries: Vec<MenuEntry> }`。`MenuCommand` 新增 `TrayMetric(TrayMetric)`、`ToggleTrayIcon`、`TrayLabels(LabelStyle)`。id 分别为 `tray-metric-today-tokens`、`tray-metric-tokens-per-second`、`tray-metric-today-cost`、`tray-metric-in-flight`、`tray-icon`、`tray-labels-prefix`、`tray-labels-unit`。
  - `desktop/src/tray.rs`：`native_menu` 支持 `Submenu`（使用 `tray_icon::menu::Submenu`）。macOS 上 `entries()` 把子菜单插在 `OpenLogs` 项之前。`run()` 处理新命令：修改 `AppModel.prefs`、`save`、`sync`，再调用 Task 11 的 `live::restart(cx)`。
  - `desktop/src/app.rs`：`AppModel` 增加 `pub prefs: Prefs`，启动时调用 `Prefs::load(&prefs_path(&paths))`。
- Test: `desktop/src/tray/tests.rs`（已有，追加用例）

**Interfaces:**
- Consumes: Task 8 的 `Prefs`。
- Produces: `pub fn display_menu(prefs: &Prefs) -> MenuEntry`（纯函数，供测试使用）。

- [ ] **Step 1: 写失败测试**
  - 所有新 `MenuCommand` 的 `from_id(cmd.id())` 往返一致。
  - 选中 `[TodayTokens, InFlight]` 时，这两项为 checked 且 enabled，另外两项为 unchecked 且 disabled。
  - 选中为空时，`Show Icon` 为 checked 且 disabled。
  - 两个 Labels 项中只有一个 checked。
- [ ] **Step 2: 运行**：`cargo test --manifest-path desktop/Cargo.toml tray::`，预期 FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行**：预期 PASS。
- [ ] **Step 5: 提交**：`feat(desktop): add the menu bar display menu`

### Task 11: live 轮询 glue

**Files:**
- Create: `desktop/src/app/live.rs`
- Modify: `desktop/src/app.rs`
  - `AppModel` 增加 `pub live: LiveDisplay` 和 `live_task: Option<Task<()>>`。
  - 健康状态变为 Up 时调用 `live::restart`；变为非 Up 时 drop `live_task`。

**Interfaces:**
- Consumes: `poll_interval`、`LiveDisplay`、`live::parse`、`transport::spawn`，以及 `app/refresh.rs::summary_request` 同款的 discovery、token 取法。
- Produces: `pub fn restart(cx: &mut App)`。
  - 先 drop 旧任务。
  - `poll_interval` 为 `None` 或健康状态非 Up 时直接返回。
  - 否则立即拉一次 `GET /dashboard/api/desktop-live`，之后按间隔循环。每次结果调用 `accept` 或 `fail`（401 和非 2xx 都算 `fail`），然后 `crate::tray::sync(cx)`。
  - 401 不触发重新发现：面板的 summary 轮询和健康检查已负责处理 token 变更。

- [ ] **Step 1: 实现**：这部分是 GPUI 与网络的胶水层，规则由 Task 9 的纯函数测试覆盖；循环写法参照 `arm_timer`，用 `cx.background_executor().timer(interval)`。
- [ ] **Step 2: 验证**：`cargo test --manifest-path desktop/Cargo.toml` 全绿；`cargo clippy --manifest-path desktop/Cargo.toml -- -D warnings` 无告警。
- [ ] **Step 3: 提交**：`feat(desktop): poll live metrics for the menu bar`

### Task 12: AppKit 渲染与托盘接入（macOS）

**Files:**
- Create: `desktop/src/tray/metrics_image.rs`（`#[cfg(target_os = "macos")]`）
- Modify:
  - `desktop/Cargo.toml`：`objc2-app-kit` 增加 features `NSImage`、`NSImageRep`、`NSBitmapImageRep`、`NSFont`、`NSAttributedString`、`NSStringDrawing`、`NSGraphicsContext`、`NSFontDescriptor`；如有需要，`objc2-foundation` 增加 `NSAttributedString`、`NSGeometry`。
  - `desktop/src/tray.rs`：`Tray.shown` 改成 `Option<Shown>`，其中 `struct Shown { state: TrayState, color: [u8; 3], lines: Vec<String>, show_icon: bool }`。`sync()` 根据 `AppModel.prefs` 与 `live.view()` 生成每行文本：
    - `Unavailable` 时每行为 `—`。
    - `Stale` 时按 Down 的方式变暗。
    - 服务 Down 时不显示文字，只显示变暗的图标，与现状一致。
  - 有文字时调用 `metrics_image::render`，否则仍用 `icon_rgba`。只在 `Shown` 变化时才 `set_icon_with_as_template`。

**Interfaces:**
- Consumes: `MetricText`、`TrayState`、`MARK_PNG`、`DOT`。
- Produces: `pub fn render(lines: &[MetricText], show_icon: bool, state: TrayState, dimmed: bool) -> (Vec<u8>, u32, u32)`，返回 RGBA、宽度和高度（固定 36 px）。
  - 1 行时用 12 pt 字体，2 行时各 9 pt。
  - 字体用 `NSFont::monospacedDigitSystemFontOfSize_weight`。
  - 两行时数值列右对齐；Prefix 样式下标签列左对齐。
  - 图标与文字间距 4 pt（@2x 为 8 px）。
  - Attention 圆点：有图标时画在图标右上角，无图标时画在文字块右上角。

- [ ] **Step 1: 实现**：通过 `NSBitmapImageRep::initWithBitmapDataPlanes…` 创建 RGBA 8 bit、预乘 alpha 的位图；`NSGraphicsContext::graphicsContextWithBitmapImageRep` 设为当前上下文后绘制。文字颜色为黑色，因为模板图由系统着色。
- [ ] **Step 2: 自动验证**：`cargo build --manifest-path desktop/Cargo.toml` 和 `cargo test --manifest-path desktop/Cargo.toml`。
- [ ] **Step 3: 手动验证**：用 `bun run` 启动桌面开发版（参照 `desktop/README` 或 `run` skill），逐项检查：
  - 默认只显示图标，与改动前一致。
  - 只勾 `Today Tokens` 时显示单行 12 pt 文字。
  - 勾 `Today Tokens` 和 `Tokens per Second` 时显示两行，发请求期间 tok/s 每秒跳动，宽度不抖动。
  - 切换 Labels 时显示 `TOK 1.23M` 或 `1.23M tok`。
  - 关掉 Show Icon 后只剩文字。
  - 亮色和暗色菜单栏下都能看清。
  - `aiop stop` 后变暗，文字消失。
  - 重启 app 后偏好保留。
- [ ] **Step 4: 提交**：`feat(desktop): render metrics into the menu bar icon`

### Task 13: 收尾

- [ ] **Step 1**：`bun run build && bun run preflight` 全绿。
- [ ] **Step 2**：`cargo test --manifest-path desktop/Cargo.toml` 和 `cargo clippy --manifest-path desktop/Cargo.toml -- -D warnings` 全绿。
- [ ] **Step 3**：如有格式修复，提交 `chore: format`。
