# 调用链详情页改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/superpowers/specs/2026-09-16-traces-page-redesign-design.md` 第二节改造调用链详情页：瀑布图加刻度尺和搜索、右栏换成状态行 + 指标网格 + 分位对比条 + 可搜索属性表、请求/响应两个 tab 换成逐跳抓包。

**Architecture:** 列表页（第一节）已经全部落地，本计划只动详情页。新增两个只读聚合接口：`GET /dashboard/api/traces/:traceId/percentile`（core 里走 SQL，和 `trace-summary.ts` 同一套写法）和 `GET /dashboard/api/traces/:traceId/wire`（server 里流式单遍扫当天那一个日志文件，不落库不建索引）。前端全部在 `packages/dashboard/src/modules/traces/` 内部展开，不新增模块。

**Tech Stack:** Bun + Drizzle（bun-sqlite）、Hono + zod validator、React 19 + TanStack Query/Router、shadcn（Base UI + lucide）、rstest + @testing-library/react。

## Global Constraints

- 用户可见自然语言文案必须走 `packages/i18n/messages/*.json`（5 个 locale：`en` / `ja` / `ko` / `zh-Hans` / `zh-Hant`），嵌套 JSON，调用形式 `m['dashboard.traces.x']()`；改完跑 `bun run i18n:compile`。
- 以下字面量保持不翻译、不进 i18n：`HTTP`、`Token`、`TTFT`、`Provider`、协议名、模型 ID、Provider ID、`p50`、`p95`。
- `packages/dashboard` 每个 `.tsx` 只允许一个组件，箭头函数 + `React.FC<XProps>`，props 用 `interface <Component>Props`，文件名 kebab-case 与组件同名。
- 模块只有六个子目录（`services` / `hooks` / `components` / `stores` / `templates` / `lib`）；`lib` 里不许 import React、不许调 dashboard client。
- 组件不许直接 `fetch`；所有请求走 `services/traces-service` 里的 typed Hono client。
- 有 colocated 测试的模块用同名目录：`foo/index.ts` + `foo/foo.ts` + `foo/foo.test.ts`。
- 手写非测试实现文件 400 行要评估拆分、500 行是硬上限。
- 成败口径只有一处定义：`packages/core/src/db/trace-store/trace-filters.ts` 的 `SUCCEEDED` / `FAILED`。任何新聚合都复用它，不要再写一遍 `statusCode` 判断。
- 每个任务结束前跑 `bun run check` 加上受影响包的 `test:unit`。

## 事实基线（写代码前先认这些）

- 类型：`DashboardTraceSummary`（一行摘要）、`DashboardTraceSpan`、`DashboardTraceDetail = { trace, spans, diagnostics? }`，全在 `packages/types/src/trace.ts`。
- `DashboardTraceSpan` 只有 `traceId / spanId / parentSpanId? / name / kind / startedAt / endedAt / durationMs / otelStatusCode / terminationReason? / errorType? / errorCode? / attributes / events / links`。Provider、模型、attempt 序号这些**只在 `attributes` 里**。
- 属性键定义在 `packages/server/src/request-tracing/semantic.ts` 的 `attributeName`，本计划要用到的：
  - `aio_proxy.attempt.index` / `aio_proxy.provider.id` / `gen_ai.request.model` / `gen_ai.response.model`
  - `aio_proxy.response.ttft_ms` / `aio_proxy.response.upstream_headers_ms`
  - `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens`
  - `http.status_code` / `error.type` / `aio_proxy.error.code`
- span 名字在 `spanName`，attempt span 是 `aio_proxy.provider.attempt`。
- 日志文件：`@logtape/file` 的 `getTimeRotatingFileSink`，默认按天滚动，文件名是**本地时区**的 `YYYY-MM-DD.log`（不是 `.jsonl`，spec 里的写法要按这个纠正），目录 `config.server.logging?.dir ?? join(aioHome(), 'logs')`。
- 每行是 `jsonLinesFormatter` 的输出，形状：
  ```json
  {"@timestamp":"2026-09-17T09:34:29.460Z","level":"DEBUG","message":"...","logger":"aio-proxy.server","properties":{"event":"request.body_chunk","requestId":"req-1","direction":"inbound","sequence":0,"text":"hello"}}
  ```
  服务端事件字段全在 `properties` 里。
- 抓包事件的字段（`packages/server/src/server-log.ts`）：
  - `request.inbound_snapshot`：`requestId` / `inboundProtocol` / `method` / `url` / `headers`
  - `request.upstream_snapshot`：`requestId` / `attemptIndex` / `providerId` / `modelId` / `method` / `url` / `headers`
  - `request.upstream_result`：`requestId` / `attemptIndex` / `providerId` / `modelId` / `durationMs` / (`outcome:'response'` + `statusCode` + `headers` | `outcome:'exception'` + `errorType`)
  - `request.body_chunk`：`requestId` / `direction`（`inbound` | `upstream_request` | `upstream_response`）/ `attemptIndex?` / `sequence` / `text`
  - `request.body_terminal`：同上标识 + `sequence` / `byteLength` / `outcome`（`complete` | `cancelled` | `error`）/ `errorType?`
  - `Authorization` / `x-api-key` 在写日志时已经被换成 `[REDACTED]`，读侧不用再脱敏。
- **没有** `inbound_response` 方向 —— 入站那一跳只有请求体，它的「响应」只能用常开的 allowlist 诊断（`detail.diagnostics.response`）。
- 抓包只在 `server.logging.enabled === true` 且 `level === 'debug'` 时才有；`SERVER_LOG_LEVEL` 里这五个事件都是 `debug`。
- 现有前端：`templates/trace-detail-page` 持有 `selectedSpanId`；`components/trace-detail-tabs` 三个 tab；`components/span-waterfall` 四列表头 + `trace-waterfall-row`；`components/span-detail-panel` 里属性是 `<pre>{JSON.stringify(...)}</pre>`；`components/trace-http-diagnostics` 渲染 allowlist 诊断；`lib/trace-layout` 的 `layoutTraceSpans(spans, now)` 给出 `depth / offsetRatio / widthRatio / durationMs`。
- 通用格式化：`@/lib/format-duration` 的 `formatDuration`；占位符 `TRACE_PLACEHOLDER`（`lib/trace-display-constants.ts`）。
- query key 在 `packages/dashboard/src/lib/query-keys.ts`，已有 `trace(traceId)` / `traces` / `tracesAll` / `tracesSummary`。

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `packages/dashboard/src/modules/traces/lib/trace-waterfall-ticks/` | 由总时长算 0/25/50/75/100% 刻度 |
| `packages/dashboard/src/modules/traces/components/span-waterfall/waterfall-ruler.tsx` | 刻度尺条 |
| `packages/dashboard/src/modules/traces/lib/span-metrics/` | 从选中 span + trace 摘要提炼状态行和指标网格要的值 |
| `packages/dashboard/src/modules/traces/components/span-detail-panel/span-status-row.tsx` | HTTP 徽章 + `provider · model` |
| `packages/dashboard/src/modules/traces/components/span-detail-panel/span-metric-grid.tsx` | 六格指标 |
| `packages/dashboard/src/modules/traces/lib/span-attribute-rows/` | 属性扁平化 + 搜索过滤 + 可转筛选条件的键映射 |
| `packages/dashboard/src/modules/traces/components/span-detail-panel/span-attribute-table.tsx` | 属性搜索框 + kv 列表 |
| `packages/dashboard/src/modules/traces/components/span-detail-panel/span-attribute-row.tsx` | 单行 + hover `⋯` 菜单 |
| `packages/core/src/db/trace-store/trace-percentile/` | 分位聚合 SQL |
| `packages/dashboard/src/modules/traces/components/trace-percentile-bar/` | 分位对比条 |
| `packages/server/src/dashboard-routes/traces/wire-log/` | 读当天日志文件重组逐跳抓包 |
| `packages/dashboard/src/modules/traces/components/trace-hop-selector/` | 一排 hop chip |
| `packages/dashboard/src/modules/traces/components/trace-wire-panel/` | 某一跳的请求行 + headers + body |
| `packages/dashboard/src/modules/traces/components/trace-wire-unavailable/` | 降级说明块 |

**修改**：`packages/types/src/trace.ts`、`packages/core/src/db/trace-store/{trace-store.ts,types.ts,index.ts}`、`packages/server/src/dashboard-routes/traces/traces.ts`、`packages/dashboard/src/lib/query-keys.ts`、`packages/dashboard/src/modules/traces/services/traces-service/traces-service.ts`、`packages/dashboard/src/modules/traces/hooks/`、`components/span-waterfall/span-waterfall.tsx`、`components/span-detail-panel/span-detail-panel.tsx`、`components/trace-detail-tabs/trace-detail-tabs.tsx`、`packages/i18n/messages/*.json`。

---
### Task 1: 瀑布图刻度尺 + span 名称搜索

**Files:**
- Create: `packages/dashboard/src/modules/traces/lib/trace-waterfall-ticks/{index.ts,trace-waterfall-ticks.ts,trace-waterfall-ticks.test.ts}`
- Create: `packages/dashboard/src/modules/traces/components/span-waterfall/waterfall-ruler.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/span-waterfall/span-waterfall.tsx`
- Modify: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`

**Interfaces:**
- Consumes: `layoutTraceSpans(spans, now)` → `readonly TraceSpanLayout[]`（`lib/trace-layout`），`formatDuration(ms)`（`@/lib/format-duration`）。
- Produces: `createWaterfallTicks(totalDurationMs: number): readonly { ratio: number; durationMs: number }[]`，恒定返回 5 项（ratio 0 / .25 / .5 / .75 / 1）。

- [ ] **Step 1: 写失败测试**

`lib/trace-waterfall-ticks/trace-waterfall-ticks.test.ts`：

```ts
import { describe, expect, it } from '@rstest/core';

import { createWaterfallTicks } from './trace-waterfall-ticks';

describe('createWaterfallTicks', () => {
  it('按四分位切总时长', () => {
    expect(createWaterfallTicks(2000)).toEqual([
      { ratio: 0, durationMs: 0 },
      { ratio: 0.25, durationMs: 500 },
      { ratio: 0.5, durationMs: 1000 },
      { ratio: 0.75, durationMs: 1500 },
      { ratio: 1, durationMs: 2000 },
    ]);
  });

  it('总时长为 0 时刻度也不塌成 NaN', () => {
    expect(createWaterfallTicks(0).map((tick) => tick.durationMs)).toEqual([0, 0, 0, 0, 0]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

`bun run --filter @aio-proxy/dashboard test:unit` — 预期 `Cannot find module './trace-waterfall-ticks'`。

- [ ] **Step 3: 实现**

`lib/trace-waterfall-ticks/trace-waterfall-ticks.ts`：

```ts
export interface WaterfallTick {
  readonly ratio: number;
  readonly durationMs: number;
}

const ratios = [0, 0.25, 0.5, 0.75, 1] as const;

export const createWaterfallTicks = (totalDurationMs: number): readonly WaterfallTick[] => {
  const total = Math.max(0, totalDurationMs);
  return ratios.map((ratio) => ({ ratio, durationMs: total * ratio }));
};
```

`lib/trace-waterfall-ticks/index.ts`：

```ts
export { createWaterfallTicks, type WaterfallTick } from './trace-waterfall-ticks';
```

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 刻度尺组件**

`components/span-waterfall/waterfall-ruler.tsx`。它只占瀑布列那一格，所以外面由 `span-waterfall` 放进同一套 grid：

```tsx
import { formatDuration } from '@/lib/format-duration';

import { createWaterfallTicks } from '../../lib/trace-waterfall-ticks';

interface WaterfallRulerProps {
  readonly totalDurationMs: number;
}

export const WaterfallRuler: React.FC<WaterfallRulerProps> = ({ totalDurationMs }) => (
  <div className="relative h-4 border-b" aria-hidden="true">
    {createWaterfallTicks(totalDurationMs).map((tick) => (
      <span
        key={tick.ratio}
        className="absolute bottom-0 flex h-full items-end border-l pl-1 font-mono text-[10px] text-muted-foreground tabular-nums"
        style={
          tick.ratio === 1
            ? { right: 0, borderLeft: 'none', borderRight: '1px solid', paddingLeft: 0, paddingRight: '0.25rem' }
            : { left: `${tick.ratio * 100}%` }
        }
      >
        {formatDuration(tick.durationMs)}
      </span>
    ))}
  </div>
);
```

`aria-hidden` 是刻意的：刻度是给眼睛看的装饰，每行 Button 的 `aria-label` 已经带了 span 名称，总时长在右侧列里也念得到。

- [ ] **Step 6: 搜索框 + 刻度尺接进 span-waterfall**

改 `components/span-waterfall/span-waterfall.tsx`：搜索是这个卡片自己的显示偏好，state 留在组件内，不上提到 template，不进 URL。

```tsx
import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan } from '@aio-proxy/types';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@aio-proxy/ui/components/input-group';
import { SearchIcon } from 'lucide-react';
import { useState } from 'react';

import { layoutTraceSpans } from '../../lib/trace-layout';
import { TraceWaterfallRow } from './trace-waterfall-row';
import { WaterfallRuler } from './waterfall-ruler';

export const SpanWaterfall: React.FC<SpanWaterfallProps> = ({ spans, selectedSpanId, now = new Date(), onSelect }) => {
  const [query, setQuery] = useState('');
  const rows = layoutTraceSpans(spans, now);
  const needle = query.trim().toLowerCase();
  const visible = needle === '' ? rows : rows.filter((row) => row.name.toLowerCase().includes(needle));
  // 刻度尺按根 span 的总时长画，不跟着搜索结果缩放 —— 每行的 offsetRatio/widthRatio
  // 本来就是相对整条调用链算的，刻度一缩放就对不上柱子了。
  const totalDurationMs = rows.find((row) => row.depth === 0)?.durationMs ?? 0;
  ...
};
```

卡片头部放 `CardTitle` + 搜索 `InputGroup`（`placeholder` 用 `m['dashboard.traces.span_search_placeholder']()`，`aria-label` 用同一条）。表头那一行的第二格（瀑布列）里塞 `<WaterfallRuler totalDurationMs={totalDurationMs} />`，其余三格保持原有文字标签。列表渲染 `visible`；`visible.length === 0` 时渲染一行 `m['dashboard.traces.span_search_empty']()`。

- [ ] **Step 7: i18n**

五个 locale 的 `dashboard.traces` 下加 `span_search_placeholder` / `span_search_empty`。中文：`搜索 span 名称` / `没有匹配的 span`。跑 `bun run i18n:compile`。

- [ ] **Step 8: 校验**

`bun run check` + `bun run --filter @aio-proxy/dashboard test:unit`。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(dashboard): 瀑布图加时间刻度尺和 span 名称搜索"
```

---
### Task 2: 右栏状态行 + 指标网格

`span.attributes` 的键名是 OTel 语义约定的字符串标识符，dashboard 不能 import `@aio-proxy/server` 的内部模块（它的 `exports` 只开了 `.`），所以在 dashboard 里落一份只含用得到的那几个键的常量表。这些值必须和 `packages/server/src/request-tracing/semantic.ts` 的 `attributeName` 逐字一致。

**Files:**
- Create: `packages/dashboard/src/modules/traces/lib/trace-attribute-names/{index.ts,trace-attribute-names.ts}`
- Create: `packages/dashboard/src/modules/traces/lib/span-metrics/{index.ts,span-metrics.ts,span-metrics.test.ts}`
- Create: `packages/dashboard/src/modules/traces/components/span-detail-panel/span-status-row.tsx`
- Create: `packages/dashboard/src/modules/traces/components/span-detail-panel/span-metric-grid.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/span-detail-panel/span-detail-panel.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/trace-detail-tabs/trace-detail-tabs.tsx`
- Modify: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`

**Interfaces:**
- Consumes: `DashboardTraceSpan`、`DashboardTraceSummary`、`formatDuration`、`TRACE_PLACEHOLDER`。
- Produces `lib/trace-attribute-names`：

```ts
export const traceAttribute = {
  attemptIndex: 'aio_proxy.attempt.index',
  providerId: 'aio_proxy.provider.id',
  finalProviderId: 'aio_proxy.route.final_provider_id',
  requestModel: 'gen_ai.request.model',
  responseModel: 'gen_ai.response.model',
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  ttftMs: 'aio_proxy.response.ttft_ms',
  upstreamHeadersMs: 'aio_proxy.response.upstream_headers_ms',
  httpStatusCode: 'http.status_code',
} as const;
```

- Produces `lib/span-metrics`：

```ts
export interface SpanMetrics {
  readonly httpStatus: number | undefined;
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
  readonly durationMs: number;
  readonly ttftMs: number | undefined;
  readonly upstreamMs: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly attemptCount: number | undefined;
}

export const readSpanMetrics: (input: {
  readonly span: DashboardTraceSpan;
  readonly spans: readonly DashboardTraceSpan[];
  readonly trace: DashboardTraceSummary;
}) => SpanMetrics;
```

取值规则（先 span 自己的 attributes，再退到 trace 行）：

| 字段 | 来源 |
|---|---|
| `httpStatus` | `span.attributes['http.status_code']` → `trace.finalHttpStatus` |
| `providerId` | `span.attributes['aio_proxy.provider.id']` → `span.attributes['aio_proxy.route.final_provider_id']` → `trace.finalProviderId` |
| `modelId` | `span.attributes['gen_ai.response.model']` → `['gen_ai.request.model']` → `trace.finalModelId` → `trace.requestedModelId` |
| `durationMs` | `span.durationMs`（永远取 span 自己的） |
| `ttftMs` | `span.attributes['aio_proxy.response.ttft_ms']` → 选中的是根 span 时退到 `trace.ttftMs` |
| `upstreamMs` | `span.attributes['aio_proxy.response.upstream_headers_ms']` |
| `inputTokens` / `outputTokens` | 对应 usage attribute → 根 span 时退到 `trace.usage?.inputTokens` / `outputTokens` |
| `attemptCount` | `spans` 里 `name === 'aio_proxy.provider.attempt'` 的条数，为 0 时 `undefined` |

只接受 `typeof value === 'number' && Number.isFinite(value)` 的数字和非空字符串，其余一律 `undefined`。

- [ ] **Step 1: 写失败测试**

`lib/span-metrics/span-metrics.test.ts` 至少覆盖三条行为：attempt span 上直接取到 provider/model/ttft；根 span 上 attributes 缺失时退到 trace 行；`attemptCount` 数的是 `aio_proxy.provider.attempt` 的条数而不是全部 span。用最小 fixture 手搓 `DashboardTraceSpan` / `DashboardTraceSummary` 对象（字段照 `packages/types/src/trace.ts`）。

- [ ] **Step 2: 跑测试确认失败**

`bun run --filter @aio-proxy/dashboard test:unit`

- [ ] **Step 3: 实现两个 lib 模块并跑通测试**

- [ ] **Step 4: 状态行组件**

`components/span-detail-panel/span-status-row.tsx`：左边 HTTP 状态徽章（`Badge`，2xx/3xx 用 `variant="secondary"`，>=400 或 `span.otelStatusCode === 'ERROR'` 用 `variant="destructive"`，没有状态码时渲染现有的 `<TraceStatus item={span} />`），右边 `provider · model` —— 两个都是标识符，原样不翻译，缺失用 `TRACE_PLACEHOLDER`。中间的 `·` 只在两边都有值时出现。

- [ ] **Step 5: 指标网格组件**

`components/span-detail-panel/span-metric-grid.tsx`：`grid grid-cols-2 gap-x-4 gap-y-3` 六格，顺序照 spec —— 总时长 / 首字时延 / 上游耗时 / 输入 Token / 输出 Token / 尝试次数。每格上面是 `text-xs text-muted-foreground` 的标签、下面是 `font-mono tabular-nums` 的值。时长走 `formatDuration`，Token 和次数走 `new Intl.NumberFormat(getLocale())`，`undefined` 一律 `TRACE_PLACEHOLDER`。格子数量恒定六个，不因为没值就塌掉 —— 位置稳定比省空间重要。

- [ ] **Step 6: 接进 span-detail-panel**

`SpanDetailPanelProps` 加 `readonly trace: DashboardTraceSummary;` 和 `readonly spans: readonly DashboardTraceSpan[];`，由 `trace-detail-tabs.tsx` 传 `detail.trace` / `detail.spans`。卡片内容自上而下：span 名称 + kind（保留）→ `SpanStatusRow` → `SpanMetricGrid` →（Task 4 的分位条插在这里）→ 现有的 `Tabs`（属性 / 事件 / 链接，Task 3 换掉属性那一页）。删掉原来那张 `<dl>` 里和指标网格重复的 `duration`，`traceId` / `spanId` / `parentSpanId` / 时间戳这些标识信息留着。

- [ ] **Step 7: i18n**

`dashboard.traces` 下加 `span_metric_total` / `span_metric_ttft` / `span_metric_upstream` / `span_metric_input_tokens` / `span_metric_output_tokens` / `span_metric_attempts`。中文：`总时长` / `首字时延` / `上游耗时` / `输入 Token` / `输出 Token` / `尝试次数`。跑 `bun run i18n:compile`。

- [ ] **Step 8: 校验**

`bun run check` + `bun run --filter @aio-proxy/dashboard test:unit`（`templates/trace-detail-page/trace-detail-page.test.tsx` 会因为 props 变化需要同步改）。

- [ ] **Step 9: Commit**

```bash
git add -A && git commit -m "feat(dashboard): span 详情换成状态行加指标网格"
```

---
### Task 3: 扁平可搜索属性表 + 行操作

现在属性是 `<pre>{JSON.stringify(span.attributes, null, 2)}</pre>`，几十个键要靠肉眼扫。换成搜索框 + 扁平 key/value 列表，每行 hover 出 `⋯` 菜单（复制值 / 加为筛选条件）。

**Files:**
- Create: `packages/dashboard/src/modules/traces/lib/span-attribute-rows/{index.ts,span-attribute-rows.ts,span-attribute-rows.test.ts}`
- Create: `packages/dashboard/src/modules/traces/components/span-detail-panel/span-attribute-table.tsx`
- Create: `packages/dashboard/src/modules/traces/components/span-detail-panel/span-attribute-row.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/span-detail-panel/span-detail-panel.tsx`
- Modify: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`

**Interfaces:**
- Consumes: `traceAttribute`（Task 2 的 `lib/trace-attribute-names`）、`TraceFilterPatch`（`lib/trace-search`）。
- Produces:

```ts
export interface SpanAttributeRow {
  readonly key: string;
  readonly value: string;
  readonly filter: TraceFilterPatch | undefined;
}

export const toSpanAttributeRows: (
  attributes: Readonly<Record<string, unknown>>,
  query: string,
) => readonly SpanAttributeRow[];
```

规则：

- 按 `key` 升序（`localeCompare`），保证顺序稳定。
- 值格式化：字符串原样；数字/布尔 `String(value)`；数组 `join(', ')`；其余 `JSON.stringify`。
- `query` 去空格转小写后同时匹配 key 和 value 的子串；空串返回全部。
- `filter` 只在这张白名单上有映射时给出，其余是 `undefined`（那一行的菜单里就不出现「加为筛选条件」）：

| attribute | `TraceFilterPatch` 字段 |
|---|---|
| `aio_proxy.provider.id` / `aio_proxy.route.final_provider_id` | `finalProviderId` |
| `gen_ai.request.model` | `requestedModelId` |
| `gen_ai.response.model` | `finalModelId` |
| `http.status_code` | `finalHttpStatus`（数字） |
| `aio_proxy.protocol.inbound` | `inboundProtocol` |
| `aio_proxy.session.source` | `sessionSource` |
| `aio_proxy.session.id` | `sessionId` |
| `aio_proxy.request.id` | `requestId` |

映射表照 `traceSearchSchema` 的字段名写死，别猜：能筛的只有 schema 里存在的那些键。

- [ ] **Step 1: 写失败测试**

`span-attribute-rows.test.ts` 覆盖：按键排序；数组值拼成 `a, b`；`query` 同时匹配 key 和 value；`http.status_code` 映射出 `{ finalHttpStatus: 429 }`（数字不是字符串）；`aio_proxy.provider.kind` 这类没映射的键 `filter === undefined`。

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现并跑通**

- [ ] **Step 4: 单行组件**

`components/span-detail-panel/span-attribute-row.tsx`：`grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)_auto]`，键用 `font-mono text-xs text-muted-foreground break-all`，值 `font-mono text-xs break-all`，第三格是 `DropdownMenu`（trigger 是 `Button variant="ghost" size="icon-sm"` + `MoreHorizontalIcon`，`aria-label` 走 i18n）。菜单项：复制值（`navigator.clipboard.writeText(row.value)`，成功后 `toast`）、加为筛选条件（`row.filter !== undefined` 才渲染，点了调 `onFilter(row.filter)`）。trigger 平时 `opacity-0`，`group-hover:opacity-100 focus-visible:opacity-100` —— 键盘走到也要能看见。

- [ ] **Step 5: 表格组件**

`components/span-detail-panel/span-attribute-table.tsx`：顶部搜索 `InputGroup`（`query` 是本组件的 local state），下面 `max-h-80 overflow-auto` 的行列表，空结果渲染 `m['dashboard.traces.attributes_empty']()`。props：`readonly attributes`、`readonly onFilter: (patch: TraceFilterPatch) => void`。

- [ ] **Step 6: 跳转筛选**

`onFilter` 一路传到 `templates/trace-detail-page`，那里用 TanStack Router 的 `useNavigate()` 跳回列表页：`navigate({ to: '/traces', search: (prev) => withTraceFilters(resolveTraceSearch(prev), patch) })` —— 具体写法照 `templates/traces-page` 里现有的 navigate 调用抄，别自己发明一套 search 序列化。

- [ ] **Step 7: 换掉 `<pre>`**

`span-detail-panel.tsx` 里 `TabsContent value="attributes"` 换成 `<SpanAttributeTable ... />`。事件和链接那两页不动（spec 明确说 span events 从没埋过点，不在本次范围）。

- [ ] **Step 8: i18n**

加 `attributes_search_placeholder` / `attributes_empty` / `attribute_actions` / `copy_value` / `copy_value_done` / `add_as_filter`。中文：`搜索属性` / `没有匹配的属性` / `属性操作` / `复制值` / `已复制` / `加为筛选条件`。跑 `bun run i18n:compile`。

- [ ] **Step 9: 校验 + Commit**

`bun run check` + dashboard `test:unit`，然后：

```bash
git add -A && git commit -m "feat(dashboard): span 属性换成可搜索的扁平列表"
```

---
### Task 4: 分位对比条

「与最近 1 小时内 N 个 `<model>` 请求相比 — 处于 pXX」。聚合走 SQL，样本不足 30 条时整块不渲染。

**Files:**
- Modify: `packages/types/src/trace.ts`
- Create: `packages/core/src/db/trace-store/trace-percentile/{index.ts,trace-percentile.ts,trace-percentile.test.ts}`
- Modify: `packages/core/src/db/trace-store/{types.ts,trace-store.ts}`
- Modify: `packages/server/src/dashboard-routes/traces/traces.ts`
- Modify: `packages/dashboard/src/lib/query-keys.ts`
- Modify: `packages/dashboard/src/modules/traces/services/traces-service/traces-service.ts`
- Create: `packages/dashboard/src/modules/traces/hooks/use-trace-percentile-query.ts`
- Create: `packages/dashboard/src/modules/traces/components/trace-percentile-bar/{index.ts,trace-percentile-bar.tsx}`
- Modify: `packages/dashboard/src/modules/traces/components/span-detail-panel/span-detail-panel.tsx`
- Modify: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`

**Interfaces:**
- Produces（`packages/types/src/trace.ts`，紧跟在 `DashboardTraceSummaryResponseSchema` 后面）：

```ts
// 分位对比只在「有意义」时才有值：同模型、同一小时窗口、成功且已结束的调用链
// 够 30 条才给结果，不够就 null，前端整块不渲染而不是画个空条。
export const DashboardTracePercentileSchema = z
  .object({
    modelId: z.string().min(1),
    windowMinutes: z.number().int().positive(),
    sampleCount: z.number().int().min(0),
    durationMs: z.number().min(0),
    percentile: z.number().min(0).max(100),
    minMs: z.number().min(0),
    maxMs: z.number().min(0),
    p50Ms: z.number().min(0),
    p95Ms: z.number().min(0),
  })
  .strict();

export const DashboardTracePercentileResponseSchema = z
  .object({ comparison: DashboardTracePercentileSchema.nullable() })
  .strict();
```

同时导出 `DashboardTracePercentile` / `DashboardTracePercentileResponse` 两个 `z.output` 类型。

- Produces（core）：`percentile(db, traceId, now): DashboardTracePercentileResponse`，在 `TraceStore` 上加 `readonly percentile: (traceId: string, now: Date) => DashboardTracePercentileResponse;`，`createTraceStore` 里接上。

SQL 口径（全部只看根 span，`isNull(traceSpan.parentSpanId)`）：

- 目标行：`traceId` 对应的根 span，取 `finalModelId` 和 `endedAt - startedAt`。目标行没结束、没有 `finalModelId`，或者本身不满足 `SUCCEEDED` 时，直接返回 `{ comparison: null }`。
- 样本集：`SUCCEEDED` + `finalModelId = 目标模型` + `startedAt >= now - 3600_000` + `startedAt <= now`。命中 `trace_span_root_model_started_idx`。
- 一条聚合 SQL 拿 `count(*)` / `min(d)` / `max(d)` / `sum(case when d < 目标 then 1 else 0 end)`，其中 `d = ended_at - started_at`。
- `percentile = sampleCount === 0 ? 0 : (lower / sampleCount) * 100`，四舍五入到整数。
- p50 / p95 各一条 `select d ... order by d limit 1 offset n`，`n = Math.min(sampleCount - 1, Math.floor(sampleCount * 0.5 | 0.95))`。
- `sampleCount < 30` → `{ comparison: null }`。窗口和门槛写成模块顶部的 `WINDOW_MS = 3_600_000` / `MIN_SAMPLES = 30` 常量，别散在表达式里。

复用 `SUCCEEDED`，不要重写状态码判断（Global Constraints）。

- [ ] **Step 1: 写失败测试**

`trace-percentile/trace-percentile.test.ts`，用 `trace-store.test-support.ts` 里现成的建库/写 trace 辅助（照 `overview/overview.test.ts` 的写法）。覆盖四条：29 条样本返回 `null`；30 条返回非 null 且 `sampleCount === 30`；目标是最慢的那条时 `percentile` 接近 100；别的模型的调用链不进样本。

- [ ] **Step 2: 跑测试确认失败**

`bun run --filter @aio-proxy/core test:unit`

- [ ] **Step 3: 实现 core 模块 + 注册到 `TraceStore`，跑通测试**

- [ ] **Step 4: 路由**

`packages/server/src/dashboard-routes/traces/traces.ts` 加 `GET /:traceId/percentile`，照同文件里 `GET /:traceId` 的写法：同一套 traceId 校验（32 位 hex）、同一个 store 取法、同样的错误响应。返回 `DashboardTracePercentileResponseSchema` 的形状。trace 不存在时和 `GET /:traceId` 一样 404。

- [ ] **Step 5: 服务端测试**

在 traces 路由现有的测试文件里加一条：写够样本后请求该端点，断言 `comparison` 非空且 `modelId` 正确；样本不足时 `comparison === null`。`bun run --filter @aio-proxy/server test:unit`。

- [ ] **Step 6: 前端服务 + hook**

`query-keys.ts` 加 `tracePercentile: (traceId: string) => ['dashboard', 'traces', traceId, 'percentile']`。`traces-service.ts` 加 `fetchTracePercentile(traceId)`，走 typed Hono client。`hooks/use-trace-percentile-query.ts` 照 `use-trace-query.ts` 的写法，`staleTime` 给 60_000 —— 这是一小时窗口的聚合，不必跟着刷新。

- [ ] **Step 7: 组件**

`components/trace-percentile-bar/trace-percentile-bar.tsx`：props 只有 `readonly comparison: DashboardTracePercentile | null | undefined;`，`null` / `undefined` 一律返回 `null`（不渲染骨架、不渲染占位 —— spec 明确要求样本不足时整块消失）。渲染：

- 一行说明：`m['dashboard.traces.percentile_caption']({ count, model, percentile })`，`model` 是模型 ID 原样不翻译。
- 一根 `relative h-2 rounded-full bg-muted` 的条：p50 / p95 各一根 `absolute w-px bg-border` 的刻度（位置按 `(pXXMs - minMs) / (maxMs - minMs)`），本次位置一个 `absolute size-3 -translate-x-1/2 rounded-full bg-primary` 的点。`maxMs === minMs` 时所有比例按 0 算，别除出 NaN。
- 条两端 `text-xs text-muted-foreground` 标 `formatDuration(minMs)` / `formatDuration(maxMs)`，刻度标签 `p50` / `p95` 不翻译。

- [ ] **Step 8: 挂到右栏**

`span-detail-panel.tsx` 在 `SpanMetricGrid` 和 `Tabs` 之间插 `<TracePercentileBar comparison={...} />`。查询在 `templates/trace-detail-page` 里发起（组件不碰 hook 之外的东西也行，但 hook 调用点放在 template 更符合现有写法），把结果透传下来。

- [ ] **Step 9: i18n**

加 `percentile_caption`，中文：`与最近 {count} 个 {model} 请求相比 — 处于 p{percentile}`，其余 locale 照译。跑 `bun run i18n:compile`。

- [ ] **Step 10: 校验 + Commit**

`bun run preflight`，然后：

```bash
git add -A && git commit -m "feat(dashboard): span 详情加同模型延迟分位对比"
```

---
### Task 5: 逐跳抓包接口

从当天那一个日志文件里按 `requestId` 捞出该次请求的线级抓包，按跳重组。不落库、不建索引、不预加载。

**Files:**
- Modify: `packages/types/src/trace.ts`
- Create: `packages/server/src/dashboard-routes/traces/wire-log/{index.ts,wire-log.ts,wire-log.test.ts}`
- Modify: `packages/server/src/dashboard-routes/traces/traces.ts`

**Interfaces:**
- Produces（`packages/types/src/trace.ts`）：

```ts
const DashboardTraceWireBodySchema = z
  .object({
    text: z.string(),
    byteLength: z.number().int().min(0).optional(),
    outcome: z.enum(['complete', 'cancelled', 'error']).optional(),
  })
  .strict();

export const DashboardTraceWireHopSchema = z
  .object({
    // 'inbound' | `attempt-${attemptIndex}`
    id: z.string().min(1),
    kind: z.enum(['inbound', 'attempt']),
    attemptIndex: z.number().int().min(0).optional(),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    request: z
      .object({
        method: z.string().min(1).optional(),
        url: z.string().min(1).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: DashboardTraceWireBodySchema.optional(),
      })
      .strict()
      .optional(),
    response: z
      .object({
        statusCode: z.number().int().optional(),
        errorType: z.string().min(1).optional(),
        durationMs: z.number().min(0).optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: DashboardTraceWireBodySchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const DashboardTraceWireResponseSchema = z
  .object({
    available: z.boolean(),
    // disabled: server.logging.enabled 不是 true；level: 级别不是 debug；missing: 当天日志文件已经滚掉了
    reason: z.enum(['disabled', 'level', 'missing']).optional(),
    retentionDays: z.number().int().positive().optional(),
    hops: z.array(DashboardTraceWireHopSchema),
  })
  .strict();
```

同时导出对应的 `z.output` 类型。

- Produces（server）：

```ts
export const readTraceWireLog: (input: {
  readonly requestId: string;
  readonly startedAt: Date;
  readonly logging: { readonly enabled?: boolean; readonly dir?: string; readonly level?: string; readonly retentionDays?: number } | undefined;
  readonly logDir: string;
}) => Promise<DashboardTraceWireResponse>;
```

实现要点（按顺序短路）：

1. `logging?.enabled !== true` → `{ available: false, reason: 'disabled', hops: [] }`。
2. `logging?.level !== 'debug'` → `reason: 'level'`。这五个事件都是 debug 级，非 debug 时文件里根本没有它们。
3. 文件名按 **本地时区** 从 `startedAt` 拼：`${yyyy}-${MM}-${dd}.log`（`getTimeRotatingFileSink` 就是这么滚的，spec 里写的 `*.jsonl` 是错的）。用 `date-fns` 的 `format(startedAt, 'yyyy-MM-dd')`，别用 `toISOString().slice(0, 10)` —— 那是 UTC，跨零点会读错文件。
4. `Bun.file(path)`，`await file.exists()` 为假 → `reason: 'missing'`，并带上 `retentionDays`（`logging.retentionDays ?? 3`）给前端写文案。
5. 存在则 `file.stream()` + `TextDecoder({ stream: true })` 逐块解码，用一个字符串 carry buffer 按 `\n` 切行 —— **不许 `await file.text()`**，那会把几百 MB 全读进内存。每行 `JSON.parse` 包 try/catch（写日志时进程可能被 kill，末行可能是半条），失败就跳过。
6. 只处理 `properties.requestId === requestId` 且 `properties.event` 在那五个抓包事件里的行。
7. 分组键：`inbound_snapshot` 和 `direction === 'inbound'` 的 body 归 `inbound`；其余按 `attemptIndex` 归 `attempt-${n}`。`direction === 'upstream_request'` 进 `request.body`，`'upstream_response'` 进 `response.body`。
8. body 按 `sequence` 升序拼接 `text`（同一 direction 内）；`body_terminal` 给出 `byteLength` 和 `outcome`。
9. `upstream_result` 填 `response.statusCode` / `headers` / `durationMs`，`outcome === 'exception'` 时填 `errorType`。
10. 返回的 `hops` 顺序固定：`inbound` 在前，attempt 按 `attemptIndex` 升序。
11. 凭据在写日志时已经是 `[REDACTED]`，读侧不再脱敏。
12. 单文件单遍扫描是刻意取舍 —— 手动点开的排查 tab，几百 MB 读一遍零点几秒可以接受。真出现性能问题再谈索引。

- [ ] **Step 1: 写失败测试**

`wire-log/wire-log.test.ts`：用 `Bun.write` 在临时目录造一个 `YYYY-MM-DD.log`，每行是 `jsonLinesFormatter` 的真实形状（`{"@timestamp":...,"level":"DEBUG","message":"...","logger":"aio-proxy.server","properties":{...}}`）。覆盖：

- 入站 + 两次 attempt 的完整文件重组出三跳，顺序 `inbound` / `attempt-0` / `attempt-1`。
- `body_chunk` 乱序写入（sequence 2、0、1）也能按序拼回。
- 别的 `requestId` 的行不进结果。
- 半条 JSON 的末行不抛异常。
- `enabled: false` / `level: 'info'` / 文件不存在各自的 `reason`。

- [ ] **Step 2: 跑测试确认失败**

`bun run --filter @aio-proxy/server test:unit`

- [ ] **Step 3: 实现并跑通**

`wire-log.ts` 超过 300 行就把「解析一行 → 事件对象」和「事件流 → hops」拆成 `wire-log/parse-line.ts` 和 `wire-log/build-hops.ts`（私有模块，不从上层 barrel 导出）。

- [ ] **Step 4: 路由**

`traces.ts` 加 `GET /:traceId/wire`：先 `state.traceStore.find(traceId)` 拿 `trace.requestId` 和 `trace.startedAt`（trace 不存在 404），再调 `readTraceWireLog`，日志目录 `state.currentConfig().server.logging?.dir ?? join(aioHome(), 'logs')`（和 `packages/cli/src/boot-proxy-server` 里同一套默认值），响应加 `cache-control: no-store`。

- [ ] **Step 5: 路由测试 + 校验 + Commit**

在 `traces.test.ts` 里加一条：logging 关闭时端点返回 `available: false` / `reason: 'disabled'`。然后 `bun run check` + server/types 的 `test:unit`：

```bash
git add -A && git commit -m "feat(server): 调用链详情提供逐跳抓包接口"
```

---
### Task 6: hop 选择器 + body 渲染 + 降级态

`请求` / `响应` 两个 tab 现在只显示入站那一组 allowlist 诊断。改成每个 tab 顶部一排 hop chip，选中后显示该跳的请求行 + headers + body。

**Files:**
- Modify: `packages/dashboard/src/lib/query-keys.ts`
- Modify: `packages/dashboard/src/modules/traces/services/traces-service/traces-service.ts`
- Create: `packages/dashboard/src/modules/traces/hooks/use-trace-wire-query.ts`
- Create: `packages/dashboard/src/modules/traces/lib/trace-hops/{index.ts,trace-hops.ts,trace-hops.test.ts}`
- Create: `packages/dashboard/src/modules/traces/components/trace-hop-selector/{index.ts,trace-hop-selector.tsx}`
- Create: `packages/dashboard/src/modules/traces/components/trace-wire-panel/{index.ts,trace-wire-panel.tsx}`
- Create: `packages/dashboard/src/modules/traces/components/trace-wire-unavailable/{index.ts,trace-wire-unavailable.tsx}`
- Create: `packages/dashboard/src/modules/traces/components/trace-detail-tabs/trace-wire-tab.tsx`
- Modify: `packages/dashboard/src/modules/traces/components/trace-detail-tabs/trace-detail-tabs.tsx`
- Modify: `packages/i18n/messages/{en,ja,ko,zh-Hans,zh-Hant}.json`

**Interfaces:**
- Consumes: `DashboardTraceWireResponse` / `DashboardTraceWireHop`（Task 5）、`DashboardTraceDetail`、`traceAttribute`（Task 2）。
- Produces `lib/trace-hops`：

```ts
export interface TraceHopChip {
  readonly id: string;
  readonly label: string;          // 'claude-cli' / 'anthropic-primary' 这类标识符，调用方自己拼前缀文案
  readonly kind: 'inbound' | 'attempt';
  readonly attemptIndex: number | undefined;
  readonly failed: boolean;
}

export const toTraceHopChips: (input: {
  readonly spans: readonly DashboardTraceSpan[];
  readonly trace: DashboardTraceSummary;
}) => readonly TraceHopChip[];
```

**chip 列表来自 span，不来自抓包** —— 这是降级态还能列出每一跳的关键：attempt span 常开，抓包只在 debug 才有。规则：

- 第一项恒定是 `inbound`，`label` 取 `trace.session?.source ?? trace.inboundProtocol`，`failed` 按 `trace.otelStatusCode === 'ERROR'`。
- 其余是 `spans` 里 `name === 'aio_proxy.provider.attempt'` 的，按 `attributes['aio_proxy.attempt.index']` 升序；`label` 取 `attributes['aio_proxy.provider.id']`，缺失时退到 `attempt-${index}`；`failed` 按 `span.otelStatusCode === 'ERROR'`。

- [ ] **Step 1: 写失败测试**

`lib/trace-hops/trace-hops.test.ts`：入站永远在第一位；attempt 按 index 升序而不是数组顺序；没有 `provider.id` 时 label 退到 `attempt-1`；attempt span 的 `ERROR` 反映到 `failed`。

- [ ] **Step 2: 跑测试确认失败，然后实现并跑通**

- [ ] **Step 3: 服务 + hook**

`query-keys.ts` 加 `traceWire: (traceId: string) => ['dashboard', 'traces', traceId, 'wire']`。`traces-service.ts` 加 `fetchTraceWire(traceId)`。`hooks/use-trace-wire-query.ts` 带 `enabled` 参数 —— **切到该 tab 才请求**（spec 明确要求不预加载），`staleTime: Infinity`（日志是历史文件，不会变）。

- [ ] **Step 4: hop 选择器**

`components/trace-hop-selector/trace-hop-selector.tsx`：一排 `Button size="sm"`，选中的用 `variant="secondary"`、其余 `variant="outline"`，`aria-pressed` 标选中。每个 chip 里一个 `size-1.5 rounded-full` 的圆点，`failed` 用 `bg-chart-error`、否则 `bg-chart-success` —— 和列表页分桶图同一套状态色。chip 文案：入站是 `m['dashboard.traces.hop_inbound']({ label })`，attempt 是 `m['dashboard.traces.hop_attempt']({ index, label })`（`index` 从 1 起数给人看）。外层 `role="group"` + `aria-label`。

- [ ] **Step 5: 抓包面板**

`components/trace-wire-panel/trace-wire-panel.tsx`：props `readonly side: 'request' | 'response';` + `readonly hop: DashboardTraceWireHop | undefined;`。渲染

- 请求行：`side === 'request'` 时 `{method} {url}`（`font-mono`，`break-all`）；`side === 'response'` 时 HTTP 状态 + `formatDuration(durationMs)`，`errorType` 存在时用 `Badge variant="destructive"` 显示。
- headers：`<dl>` 两列，键 `font-mono text-xs text-muted-foreground`。
- body：`max-h-96 overflow-auto rounded-2xl bg-muted p-3 font-mono text-xs whitespace-pre-wrap wrap-break-word` 的 `<pre>`。`outcome !== 'complete'` 时上方加一行 `m['dashboard.traces.wire_body_truncated']()`；body 缺失时该区块整段不渲染。
- `hop === undefined`（这一跳在抓包里没有对应记录）时只渲染 `m['dashboard.traces.wire_hop_empty']()`。

**入站的响应侧例外**：抓包里没有 `inbound` 方向的响应体（`request-logging/wire.ts` 只记三种 direction），所以 `side === 'response'` 且选中入站时，改用现有的 `TraceHttpDiagnostics side="response"` 渲染 allowlist 诊断。这块常开、不依赖 debug。

- [ ] **Step 6: tab 内容组件**

`components/trace-detail-tabs/trace-wire-tab.tsx`：持有 `selectedHopId` 的 local state（默认第一项），组合 `TraceHopSelector` + `TraceWirePanel`；`available === false` 时 body 位置渲染 `TraceWireUnavailable`（chip 一排照旧显示 —— 元数据来自 span）。props：`side`、`detail`、`wire`（`DashboardTraceWireResponse | undefined`）。

- [ ] **Step 7: 降级说明块**

`components/trace-wire-unavailable/trace-wire-unavailable.tsx`：`Empty` 组件（`@aio-proxy/ui/components/empty`）里一段说明 + 一个跳设置页的 `Link`。文案按 `reason` 分：`disabled` / `level` 都指向「需要 `server.logging.enabled: true` 且 `level: debug`」，`missing` 指向「日志只保留 {days} 天」。不静默隐藏、不显示空列表 —— 这是默认配置下的常态，必须说清楚为什么没有。

- [ ] **Step 8: 换掉两个 tab**

`trace-detail-tabs.tsx` 的 `request` / `response` 两个 `TabsContent` 换成 `<TraceWireTab side=... />`。用 `Tabs` 的受控 `value` 记住当前 tab，只有当前 tab 是 `request` 或 `response` 时才把 `enabled: true` 传给 `useTraceWireQuery` —— 两个 tab 共用同一个 query（同一个 traceId 同一份数据，key 相同，TanStack Query 自己去重）。

- [ ] **Step 9: i18n**

加 `hop_inbound` / `hop_attempt` / `hops_label` / `wire_body_truncated` / `wire_hop_empty` / `wire_unavailable_debug` / `wire_unavailable_retention` / `wire_open_settings`。中文分别：`入站 {label}` / `尝试{index} {label}` / `请求链路` / `内容未完整记录` / `这一跳没有抓包记录` / `需要把 server.logging.enabled 设为 true、level 设为 debug 才会记录线级抓包。` / `日志只保留 {days} 天，这条调用链的抓包已经滚掉了。` / `打开设置`。跑 `bun run i18n:compile`。

- [ ] **Step 10: 校验 + Commit**

`bun run preflight`，然后：

```bash
git add -A && git commit -m "feat(dashboard): 请求响应两个 tab 换成逐跳抓包"
```

---

## 收尾

- [ ] 更新 `docs/superpowers/specs/2026-09-16-traces-page-redesign-design.md` 2.3 节里的 `~/.aio-proxy/logs/*.jsonl`，改成 `<logDir>/YYYY-MM-DD.log`（本地时区按天滚动）。
- [ ] 写一个 changeset，同时列 `@aio-proxy/core` / `@aio-proxy/server` / `@aio-proxy/dashboard` 影响到的内部包和产品包 `aio-proxy`（`minor`）。一段话说清用户看到什么：详情页的瀑布图有了时间刻度和搜索、右栏有了同模型延迟分位对比、请求/响应两个 tab 能逐跳看到线级抓包。
- [ ] `bun run preflight` 全绿后按 `superpowers:finishing-a-development-branch` 收尾。
