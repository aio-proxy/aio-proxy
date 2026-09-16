# Traces 重设计 — 静态 demo

无构建，直接开：`bun serve.ts` → http://localhost:4311（或直接双击 `index.html`）。

- `index.html` — 列表页：工具条 + 成功/失败堆叠图 + 表格
- `detail.html` — 详情页：Span 瀑布 + 指标 + 分位对比 + 属性列表
- `demo.css` — 设计 token，值直接抄自 `packages/ui/src/styles.css`
- `demo.js` — 主题切换、假数据、SVG 图表（正式实现换成 recharts + `ChartContainer`）

## 三个改动

**1. 进入不自动刷新。** `traces-page.tsx` 的 `useState(true)` 改 `false`；筛选抽屉里的
auto-refresh `Switch` 删掉，换成工具条上的「实时」按钮（Cloudflare 的 ▶ 实时），和时间范围
选择器并排。关掉是默认态，开着才有脉冲圆点。旁边留一个手动刷新。

**2. 成功/失败堆叠图。** 表格上方一张可折叠卡片：图例 chip 显示区间总数（`1,902 成功` /
`57 失败`），点 chip 切换序列并同时过滤表格；柱体成功在下、失败在上，两段之间留 2px 底色
缝隙，顶段 4px 圆角；hover 出 tooltip，点柱体缩放到该桶。

**3. 详情页。** 加两块 Cloudflare 有而我们没有的东西：
- **分位对比条** —「与最近 1 小时内 2,046 个同模型请求相比，处于 p73」，min/p50/p95/max 刻度。
- **属性搜索 + 平铺 key/value 列表**，替代按组折叠，行内 `⋯` 放复制/加为筛选条件。
- Span 瀑布补一条真实时间轴标尺（0ms / 855ms / 1.71s / 2.56s / 3.42s）。

## 配色

status 语义色，不是 categorical 序列。`--chart-1..5` 是单色 teal 阶梯（顺序型），不能拿来表达
成功/失败的对立，所以新增两个 token：

| | 值 | L |
|---|---|---|
| `--chart-success` | `teal-600` | 0.60 |
| `--chart-error` | `red-500` | 0.637 |

一套颜色同时过明暗两模式的六项检查（浅色 surface `#fcfcfb`，深色 `#1a1a19`）：亮度带、彩度
下限、CVD 相邻分离（ΔE 14.7 deutan）、常视觉下限（ΔE 34.1）、对比度 ≥3:1 全部 PASS。
和现有 `trace-status.tsx` 的 teal=成功 / destructive=失败 一致。

## 需要后端配合

**列表接口没有聚合。** `packages/server/src/dashboard-routes/traces/traces.ts` 只有
`GET /` 分页和 `GET /:traceId`，`usage_daily` 是按天 × 模型的 token 汇总，出不了按桶的
成功/失败计数。堆叠图需要新增一个 `GET /histogram`，复用 `TracesQuerySchema` 的全部筛选字段，
外加 `bucket` 粒度，返回 `{ buckets: [{ at, success, error }] }`。详情页的分位对比条同理，
需要一个按模型/时间窗的时延分位聚合。这两块是实现阶段最大的一块工作量。
