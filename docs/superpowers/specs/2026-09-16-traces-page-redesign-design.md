# 调用链页面改版

日期：2026-09-16
静态 demo：`docs/superpowers/demos/traces-redesign/`（`bun run docs/superpowers/demos/traces-redesign/serve.ts`）

## 背景

现在的调用链页面进入即开启实时轮询，只有一张表，看不出「这段时间里错了多少」。
参考 Cloudflare Observability 的 Logs / Trace 两屏，做三件事：进入不轮询、表上方加成功/失败堆叠图、
详情页补齐每一跳的抓包。

## 一、列表页

### 1.1 进入不自动刷新

`traces-page.tsx:45` 的 `useState(true)` 改为 `useState(false)`。轮询开关留在筛选抽屉底部不变，
另外在工具栏加一个「实时」按钮作为主入口 —— 开启时才有脉冲圆点，关闭时是静态的。
两处绑同一个 state。

### 1.2 工具栏

一排三个控件：`筛选`（打开现有的 `TracesFilters` 抽屉）· 时间范围选择器 · `实时`。
不新增通用搜索框 —— 检索条件已经全在抽屉里，再放一个搜索框会出现两套语义不清的入口。
`筛选` 按钮带 `aria-expanded` / `aria-controls` 指向抽屉。

### 1.3 Events 卡片

表格上方一张卡片，可折叠。折叠状态存 localStorage —— 这是个人显示偏好，不该进 URL 被分享出去。

- **图形**：按时间分桶的堆叠柱状图。成功在下、失败在上。
- **图例**：`● 成功 18,307` / `● 失败 93` 两个 chip，显示区间总数。点击即筛选，写入 URL 上的
  `outcome` 字段（`success` / `error`），列表和图共用这一个字段，不新开一条并行的过滤链路。
  这里刻意不用抽屉里的 `otelStatusCode`：成功的根 span 记的是 OTel `UNSET` 而不是 `OK`，
  按状态码筛会把全部成功调用链漏掉。`outcome` 是「人看到的成败」，和状态码不是一回事。
- **交互**：hover 出 tooltip（桶时间 + 两个系列的值）；点击某个桶把时间范围收窄到该桶。
- **颜色**：状态色，不是分类色。`--chart-success` 取各自 surface 上还合规的最亮一档
  （白底 `teal-500`、暗底 `teal-600`），`--chart-error: var(--color-red-500)`，
  明暗两套都过了 `validate_palette.js` 六项检查。失败永远是红色，不参与分类色轮转。
- **标记规格**：柱宽上限 24px，柱间留类目带的 20%、堆叠段之间留 2px 表面间隙，两段都收 4px 圆角
  （绝大多数桶没有失败，只给顶段加圆角会让整张图变成一排平头柱子）。

实现用 recharts + `@aio-proxy/ui/components/chart` 的 `ChartContainer`/`ChartTooltip`/`ChartLegend`，
参照 `model-usage-trend.tsx` 的写法。demo 里的手写 SVG 只是占位。

### 1.4 表格

列不动，十列全保留（`startedAt` / `traceId` / 状态 / 协议 / 请求模型 / Provider / HTTP /
延迟 / Token / 花费）。唯一调整：`状态` 从第三列移到 `HTTP` 之后，让「结果」相关的三列挨在一起。

服务端分页的约束不变 —— 不加客户端排序、列显隐、当前页过滤。

### 1.5 新增接口

图表需要聚合，不能靠翻页算。新增 `GET /dashboard/api/traces/summary`，
接受和 `GET /dashboard/api/traces` 相同的过滤参数，外加 `bucket` 粒度，
返回 `{ buckets: [{ at, success, error }], totals: { success, error } }`。

实现放 `packages/core/src/db/trace-store/overview/`，跟 `activity.ts` 一样直接走 SQL 分组，
不要在 JS 里遍历行。粒度由时间跨度推导（1h → 1min，24h → 30min，7d → 1h，45d → 1d）。

## 二、详情页

顶部三个 tab 不变：`详情 | 请求 | 响应`。

### 2.1 详情

左右两栏。左栏是 span 瀑布图，加一条真实时间刻度尺（0ms / 25% / 50% / 75% / 总时长）和
span 名称搜索框。右栏是选中 span 的详情，从上到下：

1. 状态行：HTTP 状态徽章 + `provider · model`
2. 指标网格：总时长 / 首字时延 / 上游耗时 / 输入 Token / 输出 Token / 尝试次数
3. **分位对比条**（新增）：「与最近 1 小时内 N 个 <model> 请求相比 — 处于 pXX」，
   条上标 p50 / p95 刻度和本次的位置，两端是最小值 / 最大值。
   走下面 1.5 的同一个聚合模块，新增 `GET /dashboard/api/traces/:traceId/percentile`，
   按该 trace 的最终模型和最近 1 小时窗口算。样本不足 30 条时整块不渲染，不显示占位。
4. 属性搜索 + 扁平 key/value 列表，每行 hover 出 `⋯` 操作（复制值、加为筛选条件）

左栏不放任何切换器。

### 2.2 请求 / 响应

这两个 tab 现在只显示入站那一组。改成每个 tab 顶部一排 **hop 选择器**，
一跳一个 chip：`入站 claude-cli` · `尝试1 anthropic-primary` · `尝试2 anthropic-backup`，
chip 上的圆点用状态色标成功/失败。选中后下方显示该跳的请求行 + headers + body。

这么放是因为数据本来就是这个形状 —— `request-logging/wire.ts` 记的就是
入站一组、每次 attempt 一组的请求/响应对，全部带 `providerId` / `modelId` / `attemptIndex`。
不新开「日志」tab：那会和这两个 tab 的内容大面积重复。

### 2.3 抓包从哪来

`server.logging.enabled: true` 且 `level: debug` 时，`createObservedFetch` 与 `observeInboundRequest`
已经把完整线级抓包写进 `~/.aio-proxy/logs/*.jsonl`（`jsonLinesFormatter`，按天滚动）：

| event | 内容 |
|---|---|
| `request.inbound_snapshot` | 入站 method / url / headers |
| `request.upstream_snapshot` | 每次 attempt 的上游 method / url / headers |
| `request.body_chunk` | 请求体/响应体，`direction` 区分三种，SSE 按帧一行 |
| `request.upstream_result` | status + durationMs，或 exception |
| `request.body_terminal` | byteLength + `complete` / `cancelled` / `error` |

全部带 `requestId`，而 `requestId` 就在 trace 行上（`packages/types/src/trace.ts:45`），join key 现成。

新增 `GET /dashboard/api/traces/:traceId/wire`：

- 从 trace 行取 `requestId` 和 `startedAt`
- **只扫 `startedAt` 当天那一个滚动文件**，按 `requestId` 过滤
- 按 `attemptIndex` 分组，按 `sequence` 重组 `body_chunk`
- 不建索引、不落库、不预加载；切到该 tab 才请求

单文件单遍扫描是刻意的取舍：几百 MB 的日志 Bun 读一遍零点几秒，对一个手动点开的排查 tab 可以接受。
真出现性能问题再谈索引。

### 2.4 降级态

抓包关闭或超出保留期时，hop 选择器只剩「入站」一项（元数据来自常开的 allowlist 诊断，不依赖 debug），
body 位置显示说明块：需要 `server.logging.enabled: true` + `level: debug`，
且只保留 `retentionDays` 天（默认 3 天），附一个跳转设置页的链接。

不静默隐藏、不显示空列表 —— 这是默认配置下的常态，必须说清楚为什么没有。

**已知落差**：日志默认保留 3 天，调用链保留 45 天。四天前的调用链一定没有抓包。
不在本次改动里对齐两者，只在降级态文案里讲明白。

## 三、不做

- span events（`packages/types/src/trace.ts` 里有 schema，但 `request-trace-recorder.ts:121`
  写死 `events: []`，从没埋过点）。要做是 core/server 的独立工作，和本次改版无关。
- 日志检索索引。
- 对齐日志与调用链的保留期。
- 图表的分类色扩展 —— 成功/失败是状态色，永远两色。

## 四、i18n

新增文案全部走 `packages/i18n/messages/*.json`，改完跑 `bun run i18n:compile`。
`HTTP`、`Token`、`Provider`、模型 ID、协议名保持原样不翻译。
