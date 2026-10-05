# macOS 菜单栏指标设计

## 目标

macOS 菜单栏除品牌图标外，可常驻显示 1–2 个用户选择的指标，参照 Stats / iStat Menus 的上下两行紧凑布局。可选指标：

| ID | 含义 | 来源 |
| --- | --- | --- |
| `todayTokens` | 本地自然日（零点起）输入 + 输出 token，与面板口径一致 | `usage_daily` |
| `todayCost` | 本地自然日估算费用 | `usage_daily.estimated_cost_nano_usd` |
| `inFlight` | 当前进行中的生成请求数 | 服务端内存计数 |
| `tokensPerSecond` | 所有进行中流式请求的实时输出吞吐（含推理） | 服务端内存估算 |

非目标：Linux / Windows 托盘（`tray-icon` 在两者上没有可用的标题或任意宽度图标，子菜单不出现）；面板内的设置 UI；持久化实时吞吐历史；SSE 推送。

## 现状约束

- 托盘仅一个模板图标（Running / Down / Attention），无标题文字（`desktop/src/tray.rs`）。
- 桌面端只在面板打开时每 15 s 轮询 `/dashboard/api/desktop-summary`；面板关闭时只有 60 s 健康检查。
- 现有 `24h` 是滚动窗口，没有"今日"口径；`usage_daily` 已按本地日聚合。
- 全仓库没有 tok/s。上游几乎都只在流结束时给出 usage，流中拿不到真实 token 数。
- `/dashboard/api/events` 的 `trace.*` 事件只有类型定义、无发布者；本设计不依赖它。
- 桌面端无偏好存储。

## 服务端：`live-metrics`

`packages/server/src/live-metrics/` 新模块，进程内单例、随 server state 创建，重启清零。

### 进行中计数

生成请求进入 pipeline 候选循环前 `+1`，trace 结束（成功、失败、取消、空闲超时、客户端断开）时 `-1`。用 `try/finally` 包住整个请求而非单个 attempt，保证每个请求恰好减一次；计数永不低于 0。

### 流式吞吐估算

- **输入**：每个内容增量调用 `recordContent(modelKey, chars)`。
  - AI SDK 路径：`stream-capture.ts` 已识别 `text-delta` / `reasoning-delta`，取其文本长度。
  - 透传路径：`passthrough-usage/content.ts` 保留 `hasContentDelta()` 作为 TTFT 判定（不变），新增仅供指标用的 `contentDeltaLength(): number`，由 `onContent` 回调把长度带出。
  - 只有客户端请求了流式（`streamRequested`）的 attempt 才记录；AI SDK 路径对非流式请求也走 `streamCapture`，由 pipeline 显式传入开关。
  - `chars` 按 Unicode code point 计数（`[...text].length` 的语义，但实现用不分配数组的循环）。
  - `modelKey` 为最终 attempt 的 `providerId/modelId`。
- **分桶**：按秒分桶的环形缓冲，每桶存各 `modelKey` 的字符数；只保留最近 3 个完整秒。
- **速率**：`tokensPerSecond = Σ_model (chars_model_3s / ratio_model) / 3`。无内容时为 0。
- **校准**：上游 capture 成功结束且有真实 `outputTokens > 0` 时（不等待向客户端 egress 完成——比例只描述上游字符与 token 的关系，与 egress 成败无关），用该次 attempt 累计字符数更新 `ratio_model = chars / outputTokens` 的 EMA（α = 0.3）。无样本的模型使用默认 4。EMA 结果夹在 `0.5..10` 防止异常 usage 污染。仅内存保存，最多保留 256 个模型（超出时淘汰最久未更新者）。
- 非流式响应不计入吞吐（它没有"实时"可言），但计入进行中计数。

### 今日累计

`core` 的 `trace-store` 增加 `todayUsage(now)`：读取当前本地日的 `usage_daily` 各行（列为十进制 TEXT），在 JS 中以 `bigint` 求和，返回 `{ inputTokens, outputTokens, estimatedCostNanoUsd }`。写入与查询共用 `usageLocalDate`，确保跨零点一致。结果在 `live-metrics` 中缓存 5 s。进行中请求的 token 不计入今日累计（它们结束时才落库），这与面板一致。

## 接口：`GET /dashboard/api/desktop-live`

- 放在 `packages/server/src/dashboard-routes/desktop-live/`，鉴权与 `desktop-summary` 相同（desktop token，仅 loopback）。
- 响应类型 `DesktopLiveV1` 定义于 `packages/types/src/desktop-live/`，Rust 端在 `desktop/src/summary.rs` 旁边镜像：

```json
{
  "version": 1,
  "todayTokens": "1234567",
  "todayCostNanoUsd": "3410000000",
  "inFlight": 2,
  "outputTokensPerSecond": 48.3
}
```

token 与费用沿用 `DesktopSummaryV1` 的整数字符串约定（`NonNegativeIntegerStringSchema`），对象为 strict。

选择轮询而非 SSE：桌面端 HTTP 客户端是手写的短连接（1 s 连接 / 5 s 总超时），接 SSE 需要新的流式读取与重连；本机每秒一次轮询开销可忽略。

## 桌面端

### 偏好

`~/Library/Application Support/aio-proxy-desktop/preferences.json`（路径与现有 `instance.lock` 同目录）：

```json
{ "trayMetrics": ["todayTokens", "tokensPerSecond"], "trayShowIcon": true }
```

- 默认：`trayMetrics: []`、`trayShowIcon: true`，即老用户升级后外观不变。
- 文件缺失或解析失败时整体回退默认值并记录日志；未知指标 ID 丢弃；超过 2 个时截取前 2 个。
- `trayMetrics` 为空时强制显示图标，忽略 `trayShowIcon`。
- 写入用临时文件 + rename。

### 右键菜单

仅在托盘组装原生菜单时（不进入面板 `⋯` 菜单共用的条目列表）于「Open logs」之前（macOS 限定）加入「Menu Bar Display ▸」子菜单：

- 4 个指标 `CheckMenuItem`（Today Tokens / Tokens per Second / Today Cost / Requests in Flight），勾选顺序即显示顺序（第一个在上）。已勾 2 个时其余未勾项置灰。
- 分隔线
- 「Show Icon」勾选项（无指标时置灰并显示为勾选）

菜单文字跟随现有菜单的英文风格。

### 轮询

一个随 app 启动的常驻 1 s 循环，与面板的 summary 轮询独立。每拍读取偏好、健康状态与 discovery，决定是否发请求（不在各处状态变化点接线）：

- 选中 `tokensPerSecond` 或 `inFlight`：每 1 s 拉一次。
- 仅选今日类指标：15 s。
- 无指标、健康状态非 Up、无 discovery 或 token：不发请求。
- 偏好变化、实例变化或健康恢复 Up 后的下一拍立即拉取。
- 请求失败时保留上一次的值并变暗显示，连续失败 3 次后改为显示 `—`。
- 401：触发一次 rediscovery，成功响应前不再重复触发。
- 连接失败：触发 rediscovery（与 summary 轮询相同的 5 s 节流）。discovery 报告实例不可达时，与健康 Down 同样处理（隐藏文字、图标变暗），不必等 60 s 健康检查。停止检测时限：选了 1 s 指标时为数秒；仅今日指标时约 15 s。
- 健康状态为 Up 但 discovery 不可达时（服务短暂停止后又在健康检查判定 Down 之前启动），live 循环以同样的 5 s 节流主动 rediscover，保证能自动恢复。
- 响应按实例 epoch 标记，并与当前 epoch 比较；实例替换后，旧实例的迟到响应不产生任何显示或恢复副作用。替换到下一拍之间，显示 `—` 而不是旧数字。

### 渲染

`set_title` 只能显示单行系统字号文字，因此整块内容（图标 + 1–2 行文字）由 AppKit 绘制为模板位图后交给 `tray.set_icon`，亮/暗菜单栏由系统着色。

- 新文件 `desktop/src/tray/metrics_image.rs`（macOS 限定）：`NSAttributedString` + `NSFont::monospacedDigitSystemFontOfSize_weight` 绘制到 `NSBitmapImageRep`，导出 RGBA；`objc2-app-kit` 仅需新增 `NSImage`、`NSBitmapImageRep`、`NSFont`、`NSAttributedString`、`NSStringDrawing`、`NSGraphicsContext` feature，不新增依赖。
- 画布高 36 px（18 pt @2x），宽度随内容。1 个指标：单行 12 pt；2 个指标：两行各约 9 pt，标签列左对齐，数值与单位整体左对齐。
- 图标在左，与文字间距 4 pt；`trayShowIcon` 关闭时只有文字。
- 状态：Down 整体 alpha 0.4；Attention 时圆点画在图标右上角，无图标时画在文字块右上角。
- 只在 `(文本, 状态, 是否变暗, 偏好)` 变化时重绘并 `set_icon`，避免每秒提交相同图像。

### 格式化

纯函数 `format_metric(metric, live) -> MetricText`，固定有效位数以减少宽度抖动：

| 指标 | 标签 | 数值 | 单位 |
| --- | --- | --- | --- |
| todayTokens | `TOK` | `1.23M` | `tok` |
| tokensPerSecond | `TPS` | `48.3` | `tok/s` |
| todayCost | `COST` | `$3.41` | 无 |
| inFlight | `REQ` | `2` | `req` |

每行始终显示标签和单位；数据不可用时仅数值替换为 `—`。标签列左对齐，数值与单位作为一个整体左对齐。

数值规则：token 用 `K/M/B` 三位有效数字；tok/s `< 100` 保留一位小数，`≥ 100` 取整；费用 `< $100` 两位小数，否则取整；进行中为整数。

## 测试

- `live-metrics`：3 s 窗口速率与过期；按模型比例换算；EMA 校准与上下限；无样本默认比例；成功、失败、取消、空闲超时后进行中计数都回到 0。
- `contentDeltaLength`：各协议返回值，及现有 TTFT 测试保持通过。
- `queryTodayUsage`：只取当前本地日，跨零点切换。
- `desktop-live` 路由：鉴权与响应结构（沿用 `desktop-summary/route.test.ts` 的模式）。
- Rust：偏好解析与回退、最多 2 个规则、`format_metric` 各分支、轮询间隔选择。位图渲染不做像素断言，手动在 macOS 亮/暗菜单栏下验证。

## 发布

一条 `minor` changeset，目标 `aio-proxy`、`@aio-proxy/server`、`@aio-proxy/core`、`@aio-proxy/types`：macOS 菜单栏可显示今日 token、今日费用、进行中请求数和实时 tok/s 中的 1–2 项。
