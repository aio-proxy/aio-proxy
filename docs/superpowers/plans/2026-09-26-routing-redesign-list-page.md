# Routing 重新设计 · 列表页实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/routing` 从「一张表 + 一行文字 summary」改成可 triage 的列表：健康概览条可点即筛、按 lab 分组、每行用双层份额条同时表达配置意图与实际结果。

**Architecture:** 纯 dashboard 包改动，消费上一份计划已落地的数据层（`DashboardRoutingModel.catalog` 与两个 traffic 端点）。筛选状态放 URL search params，风险判定与份额计算是 `lib/` 里的纯函数。编辑入口**暂不动** —— 现有 `RoutingEditorDrawer` 保留，详情页是下一份计划的事。

**Tech Stack:** React · TanStack Router / Query / Table · Zod · shadcn（Base UI）· `@aio-proxy/i18n` · rstest

## Global Constraints

- **代码注释一律写英文。** 本计划代码块里的中文注释是意图说明，落地时用英文写出同样的理由。
- 所有命令从仓库根目录运行。dashboard 测试跑 `bun run --filter @aio-proxy/dashboard test`。
- **不要编字面值。** 本计划引用的每个组件签名、属性名、辅助函数都已对着源码核过（见各任务的 Interfaces）。若落地时发现与源码不符，**停下来报告**，不要猜着改 —— 上一份计划有 11 处字面值出错的记录。
- 遵守 `packages/dashboard/AGENTS.md`：六个模块桶（`services` / `hooks` / `components` / `stores` / `templates` / `lib`）、每个 `.tsx` 一个组件、`React.FC<XProps>` + `interface XProps`、文件名 kebab-case 对应组件名。
- 用户可见文案**全部**走 i18n。新键加到 `packages/i18n/messages/*.json`（嵌套 JSON），调用形如 `m['dashboard.routing.x']()`，改完跑 `bun run i18n:compile`。`N/A`、model ID、Provider ID 这类可以内联。
- 表格必须 TanStack Table + shadcn `Table`。这里数据是客户端全量的，**不适用** AGENTS.md 里 server-paginated 的例外条款，排序/筛选/列可见性照常开。
- 通用工具优先 `es-toolkit`，窄导入。
- 计数在 wire 上是十进制字符串，前端用 `BigInt()` 解码（沿用 `decodeUsageOverview`）。
- `p95LatencyMs` 为 `null` 表示无样本，**不是** 0。
- 手写非测试文件 500 行上限，400 行即评估拆分。
- 完成前跑 `bun run preflight`。

## 数据层已提供什么（不要重复实现）

| 契约 | 形状 |
|---|---|
| `DashboardRoutingModel.catalog?` | `{ readonly lab: string; readonly releaseDate?: string }`，冷缓存或无厂商信息时缺失 |
| `GET /dashboard/api/routing/traffic?range=` | `{ range, rangeStart, rangeEnd, models: [{ modelId, providers: [{ providerId, finalCount, attemptCount, successCount, p95LatencyMs }] }] }` |
| `GET /dashboard/api/routing/traffic/buckets?range=&model=` | 本计划**不用**，留给详情页 |

range 枚举是 `UsageOverviewRangeSchema`：`'24h' | '7d' | '14d' | '30d'`。

**三条从数据层带过来的硬约束，直接决定本计划的正确性：**

1. **成功率必须算 `successCount / attemptCount`，绝不能除以 `finalCount`。** root-only trace 会让两者不一致。
2. **实际份额 = `finalCount / Σ finalCount`（同 tier 内）**，与配置份额同分母才可比。
3. **两个响应的 `modelId` 不同键空间，两边都可能有对不上的行。** traffic 的 `modelId` 是 `requested_model_id`：Provider 限定路由（`myprov/gpt-5`）会被记下但不是 inventory 的键；从 config 删掉的模型还会保留 45 天流量。本计划必须显式处理，见 Task 3。

## File Structure

| 文件 | 职责 |
|---|---|
| `lib/routing-search/`（新） | URL search schema + resolve/serialize/patch |
| `lib/routing-traffic/`（新） | 实际份额计算、与配置份额对齐、对不上的行的策略 |
| `lib/routing-risk/`（新） | 三类风险判定 + 偏离阈值 |
| `services/routing-traffic-service.ts`（新） | traffic queryOptions + BigInt 解码 |
| `components/routing-health-strip.tsx`（新） | 4 个 stat tile，后 3 个可点即筛 |
| `components/routing-share-bar.tsx`（新） | 双层份额条 + tooltip |
| `components/routing-lab-group-row.tsx`（新） | lab 分组标题行 |
| `components/routing-table-columns.tsx`（改） | 新列定义 |
| `components/routing-table.tsx`（改） | 分组行渲染 + 排序 |
| `templates/routing-page.tsx`（改） | 三个 query 装配、降级、筛选联动 |
| `routes/routing/index.tsx`（改） | `validateSearch` |
| `lib/query-keys.ts`（改） | traffic query key |

---

### Task 1: URL 搜索参数

**Files:**
- Create: `packages/dashboard/src/modules/routing/lib/routing-search/index.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-search/routing-search.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-search/routing-search.test.ts`
- Modify: `packages/dashboard/src/routes/routing/index.tsx`

**Interfaces:**
- Consumes: 无。
- Produces: `RoutingSearch`、`routingSearchSchema`、`RoutingRiskFilter`、`ROUTING_RISK_FILTERS`、`withRoutingFilters(search, patch)`、`toggleRoutingRisk(search, risk)`。Task 5 与 Task 8 消费。

**为什么筛选放 URL：** 详情页（下一份计划）是独立路由，每修一个模型都要离开列表再回来。若筛选是组件内 state，每次往返都清空 triage 结果。

**照抄的先例：** `packages/dashboard/src/modules/traces/lib/trace-search/trace-search.ts`。要点有两个，必须照搬：每个字段都带 `.catch(undefined)`（URL 畸形时降级为「无筛选」而不是抛错让整页白屏），以及 `routes/traces/index.tsx` 里 `createFileRoute({ validateSearch, search: { middlewares: [stripSearchParams(...)] } })` 的写法 —— `stripSearchParams` 让默认值不出现在 URL 里。

- [ ] **Step 1: 写失败测试**

创建 `routing-search.test.ts`：

```ts
import { expect, test } from '@rstest/core';

import { ROUTING_RISK_FILTERS, routingSearchSchema, toggleRoutingRisk, withRoutingFilters } from './routing-search';

test('defaults to no filters and a 24h window', () => {
  expect(routingSearchSchema.parse({})).toEqual({ range: '24h' });
});

test('drops an unparseable filter instead of failing the whole page', () => {
  // A hand-edited or stale URL must degrade to "no filter", never throw: throwing here
  // would blank the route rather than showing an unfiltered list.
  expect(routingSearchSchema.parse({ risk: 'not-a-risk', lab: '', range: '90d' })).toEqual({ range: '24h' });
});

test('keeps a valid risk, lab and range', () => {
  expect(routingSearchSchema.parse({ risk: 'no-eligible', lab: 'anthropic', range: '7d' })).toEqual({
    risk: 'no-eligible',
    lab: 'anthropic',
    range: '7d',
  });
});

test('enumerates exactly the three clickable risks', () => {
  expect([...ROUTING_RISK_FILTERS]).toEqual(['no-eligible', 'single-point', 'deviating']);
});

test('toggling the active risk clears it and switching risks replaces it', () => {
  const base = routingSearchSchema.parse({ risk: 'no-eligible' });

  expect(toggleRoutingRisk(base, 'no-eligible').risk).toBeUndefined();
  expect(toggleRoutingRisk(base, 'single-point').risk).toBe('single-point');
});

test('patching a filter leaves the others alone and clears with undefined', () => {
  const base = routingSearchSchema.parse({ risk: 'deviating', lab: 'openai', range: '7d' });

  expect(withRoutingFilters(base, { lab: undefined })).toEqual({ risk: 'deviating', range: '7d' });
  expect(withRoutingFilters(base, { lab: 'google' }).risk).toBe('deviating');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/lib/routing-search/`
Expected: FAIL —— `Cannot find module './routing-search'`。

- [ ] **Step 3: 实现**

创建 `routing-search.ts`：

```ts
import { UsageOverviewRangeSchema } from '@aio-proxy/types';
import { z } from 'zod';

/** The three risks the health strip can filter by. Ordered as the strip renders them. */
export const ROUTING_RISK_FILTERS = ['no-eligible', 'single-point', 'deviating'] as const;

export type RoutingRiskFilter = (typeof ROUTING_RISK_FILTERS)[number];

// Every field catches: a hand-edited or stale URL must degrade to "no filter" rather than
// throwing, which would blank the route instead of showing an unfiltered list.
export const routingSearchSchema = z.object({
  risk: z.enum(ROUTING_RISK_FILTERS).optional().catch(undefined),
  lab: z.string().trim().min(1).optional().catch(undefined),
  range: UsageOverviewRangeSchema.catch('24h'),
});

export type RoutingSearch = z.output<typeof routingSearchSchema>;

export type RoutingFilterPatch = {
  readonly [Key in keyof RoutingSearch]?: RoutingSearch[Key] | undefined;
};

/** Clearing a filter means removing the key, so `stripSearchParams` keeps it out of the URL. */
export const withRoutingFilters = (search: RoutingSearch, patch: RoutingFilterPatch): RoutingSearch => {
  const next: Record<string, unknown> = { ...search, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
  }
  return next as RoutingSearch;
};

/** Clicking the active tile clears the filter; clicking another replaces it. */
export const toggleRoutingRisk = (search: RoutingSearch, risk: RoutingRiskFilter): RoutingSearch =>
  withRoutingFilters(search, { risk: search.risk === risk ? undefined : risk });
```

创建 `index.ts`：

```ts
export * from './routing-search';
```

改 `packages/dashboard/src/routes/routing/index.tsx`，照 `routes/traces/index.tsx` 的结构：

```tsx
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';

import { routingSearchSchema } from '@/modules/routing/lib/routing-search';
import { RoutingPage } from '@/modules/routing/templates/routing-page';

export const Route = createFileRoute('/routing/')({
  validateSearch: routingSearchSchema,
  // `24h` is the default window, so it stays out of the URL.
  search: { middlewares: [stripSearchParams({ range: '24h' })] },
  component: RoutingPage,
});
```

`RoutingPage` 这一步**先不改签名** —— 它继续自己读 `Route.useSearch()`，在 Task 8 装配时接上。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/lib/routing-search/`
Expected: PASS，6 个 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/lib/routing-search packages/dashboard/src/routes/routing/index.tsx
git commit -m "feat(dashboard): put routing list filters in the URL"
```

---

### Task 2: traffic service

**Files:**
- Create: `packages/dashboard/src/modules/routing/services/routing-traffic-service.ts`
- Create: `packages/dashboard/src/modules/routing/services/routing-traffic-service.test.ts`
- Modify: `packages/dashboard/src/lib/query-keys.ts`

**Interfaces:**
- Consumes: Task 1 的 `RoutingSearch['range']`。
- Produces: `routingTrafficQueryOptions(range)`、`decodeRoutingTraffic(wire)`、`RoutingTrafficData`、`RoutingTrafficProviderTotals`。Task 3 与 Task 8 消费。

**已核实的字面值**（用 `bun run lint:types` 实测过一个 probe，通过）：
- 客户端访问路径是 `dashboardClient.dashboard.api.routing.traffic.$get({ query: { range } })`，`dashboardClient` 从 `@/lib/dashboard-client` 具名导入（不是 `createDashboardClient()`，那是 `usage-service.ts` 的写法，本任务照它）。
- 响应字段是 `range` / `rangeStart` / `rangeEnd` / `models`，provider 条目是 `providerId` / `finalCount` / `attemptCount` / `successCount` / `p95LatencyMs`。

**解码约定：** 三个计数在 wire 上是十进制字符串，照 `decodeUsageOverview` 用 `BigInt()`。`p95LatencyMs` 已经是 `number | null`，**不要**动它，`null` 是「无样本」而非 0。

- [ ] **Step 1: 写失败测试**

创建 `routing-traffic-service.test.ts`：

```ts
import { expect, test } from '@rstest/core';

import { decodeRoutingTraffic } from './routing-traffic-service';

const wire = {
  range: '24h' as const,
  rangeStart: '2026-09-25T08:00:00.000Z',
  rangeEnd: '2026-09-26T08:00:00.000Z',
  models: [
    {
      modelId: 'anthropic/claude-sonnet-4.5',
      providers: [
        { providerId: 'primary', finalCount: '0', attemptCount: '2', successCount: '0', p95LatencyMs: 60 },
        { providerId: 'fallback', finalCount: '9007199254740993', attemptCount: '2', successCount: '2', p95LatencyMs: null },
      ],
    },
  ],
};

test('decodes counts past the JS safe-integer boundary', () => {
  const decoded = decodeRoutingTraffic(wire);
  const fallback = decoded.models[0]?.providers[1];

  // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2: Number() would round it to ...992.
  expect(fallback?.finalCount).toBe(9_007_199_254_740_993n);
  expect(decoded.models[0]?.providers[0]?.attemptCount).toBe(2n);
});

test('keeps a null p95 as null rather than coercing it to zero', () => {
  // 0 would read as "zero latency"; absent and instant are different facts.
  expect(decodeRoutingTraffic(wire).models[0]?.providers[1]?.p95LatencyMs).toBeNull();
  expect(decodeRoutingTraffic(wire).models[0]?.providers[0]?.p95LatencyMs).toBe(60);
});

test('passes the window bounds through untouched', () => {
  expect(decodeRoutingTraffic(wire)).toMatchObject({ range: '24h', rangeStart: wire.rangeStart, rangeEnd: wire.rangeEnd });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/services/routing-traffic-service`
Expected: FAIL —— `Cannot find module './routing-traffic-service'`。

- [ ] **Step 3: 实现**

在 `packages/dashboard/src/lib/query-keys.ts` 的 `routingModels` 之后加一行（保持该文件的字母序）：

```ts
  routingTraffic: (range: string) => ['routing', 'traffic', range],
```

创建 `routing-traffic-service.ts`：

```ts
import type { UsageOverviewRange } from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

type RoutingTrafficWire = InferResponseType<typeof dashboardClient.dashboard.api.routing.traffic.$get, 200>;

/** Counts arrive as decimal strings because SQLite integers can exceed the JS safe-integer
 * range; decode with BigInt, the same way decodeUsageOverview does. `p95LatencyMs` stays as
 * given: `null` means no sample, which is a different fact from zero latency. */
export const decodeRoutingTraffic = (wire: RoutingTrafficWire) => ({
  ...wire,
  models: wire.models.map((model) => ({
    ...model,
    providers: model.providers.map((provider) => ({
      providerId: provider.providerId,
      finalCount: BigInt(provider.finalCount),
      attemptCount: BigInt(provider.attemptCount),
      successCount: BigInt(provider.successCount),
      p95LatencyMs: provider.p95LatencyMs,
    })),
  })),
});

export type RoutingTrafficData = ReturnType<typeof decodeRoutingTraffic>;
export type RoutingTrafficProviderTotals = RoutingTrafficData['models'][number]['providers'][number];

export const routingTrafficQueryOptions = (range: UsageOverviewRange) =>
  queryOptions({
    queryKey: queryKeys.routingTraffic(range),
    queryFn: async (): Promise<RoutingTrafficData> => {
      const response = await dashboardClient.dashboard.api.routing.traffic.$get({ query: { range } });
      if (!response.ok) throw new Error(`routing traffic failed: ${response.status}`);
      return decodeRoutingTraffic(await response.json());
    },
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/services/routing-traffic-service`
Expected: PASS，3 个 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/services/routing-traffic-service.ts packages/dashboard/src/modules/routing/services/routing-traffic-service.test.ts packages/dashboard/src/lib/query-keys.ts
git commit -m "feat(dashboard): add the routing traffic query"
```

---

### Task 3: 实际份额与配置份额对齐

**Files:**
- Create: `packages/dashboard/src/modules/routing/lib/routing-traffic/index.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-traffic/routing-traffic.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-traffic/routing-traffic.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `RoutingTrafficData` / `RoutingTrafficProviderTotals`；`DashboardRoutingModel`（已有 `tiers: readonly { priority, providers: readonly { providerId, weight, share }[] }[]`）。
- Produces: `indexRoutingTraffic(traffic)`、`tierActualShares(tier, totals)`、`modelTrafficSummary(totals)`、类型 `RoutingTrafficIndex` / `RoutingTierShare`。Task 4、6、7 消费。

这是本计划**最容易写错**的一块，三条规则都来自数据层，不可自创：

1. **实际份额 = `finalCount / Σ finalCount`，Σ 只在同一个 tier 的成员内取。** 与配置 `share` 同分母才可比。整个模型取分母会让 tier 2 的兜底流量稀释 tier 1 的比例。
2. **成功率 = `successCount / attemptCount`。** 绝不能除以 `finalCount` —— root-only trace 会让两者不一致。`attemptCount === 0n` 时成功率是 `null`（未知），不是 0。
3. **两个响应的 `modelId` 不同键空间，两边都可能对不上。** traffic 用 `requested_model_id`：Provider 限定路由会记下 `myprov/gpt-5` 这种不在 inventory 里的键；从 config 删掉的模型还留着 45 天流量。**策略：以 inventory 为准，traffic 里匹配不上的行直接丢弃。** 若把它们算进分母，份额就错了。inventory 里没有 traffic 的模型 → 无实际数据，不是 0 流量。

- [ ] **Step 1: 写失败测试**

创建 `routing-traffic.test.ts`：

```ts
import { expect, test } from '@rstest/core';

import { indexRoutingTraffic, modelTrafficSummary, tierActualShares } from './routing-traffic';

const totals = (providerId: string, final: bigint, attempt: bigint, success: bigint, p95: number | null = 10) => ({
  providerId,
  finalCount: final,
  attemptCount: attempt,
  successCount: success,
  p95LatencyMs: p95,
});

const traffic = {
  range: '24h' as const,
  rangeStart: '2026-09-25T08:00:00.000Z',
  rangeEnd: '2026-09-26T08:00:00.000Z',
  models: [
    {
      modelId: 'sonnet',
      providers: [totals('primary', 93n, 100n, 50n), totals('fallback', 7n, 7n, 7n)],
    },
    // Traffic for a model the inventory no longer serves: it must never reach a denominator.
    { modelId: 'myprov/deleted', providers: [totals('primary', 1_000n, 1_000n, 1_000n)] },
  ],
};

const tier = {
  priority: 30,
  providers: [
    { providerId: 'primary', weight: 1, share: 0.5 },
    { providerId: 'fallback', weight: 1, share: 0.5 },
  ],
} as const;

test('computes actual share against the same tier the configured share uses', () => {
  const index = indexRoutingTraffic(traffic);
  const shares = tierActualShares(tier, index.get('sonnet'));

  // 93 / (93 + 7) — the tier's own members only.
  expect(shares.find((entry) => entry.providerId === 'primary')?.actualShare).toBeCloseTo(0.93, 5);
  expect(shares.find((entry) => entry.providerId === 'fallback')?.actualShare).toBeCloseTo(0.07, 5);
});

test('reports success rate over attempts, never over final ownership', () => {
  const index = indexRoutingTraffic(traffic);
  const shares = tierActualShares(tier, index.get('sonnet'));

  // primary served 93 but succeeded on only 50 of its 100 attempts. Dividing by finalCount
  // would report 0.54 and hide that half its attempts failed.
  expect(shares.find((entry) => entry.providerId === 'primary')?.successRate).toBeCloseTo(0.5, 5);
});

test('leaves success rate unknown rather than zero when nothing was attempted', () => {
  const index = indexRoutingTraffic({ ...traffic, models: [{ modelId: 'sonnet', providers: [totals('primary', 1n, 0n, 0n, null)] }] });
  const shares = tierActualShares(tier, index.get('sonnet'));

  expect(shares.find((entry) => entry.providerId === 'primary')?.successRate).toBeNull();
});

test('yields no shares when the model has no traffic at all', () => {
  // Absent is not zero: the bar must render without a thin overlay rather than a 0% overlay.
  expect(tierActualShares(tier, undefined)).toEqual([]);
});

test('drops traffic rows the inventory does not serve', () => {
  const index = indexRoutingTraffic(traffic);

  // The row exists in the index (keyed by requested model id) but a tier that does not name
  // it can never pull it into a denominator.
  expect(index.has('myprov/deleted')).toBe(true);
  const shares = tierActualShares(tier, index.get('sonnet'));
  expect(shares.map((entry) => entry.providerId).sort()).toEqual(['fallback', 'primary']);
});

test('summarises a model over every tier for the traffic column', () => {
  const index = indexRoutingTraffic(traffic);

  expect(modelTrafficSummary(index.get('sonnet'))).toEqual({
    finalCount: 100n,
    attemptCount: 107n,
    successCount: 57n,
    successRate: 57 / 107,
  });
});

test('summarises nothing for a model with no traffic', () => {
  expect(modelTrafficSummary(undefined)).toBeUndefined();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/lib/routing-traffic/`
Expected: FAIL —— `Cannot find module './routing-traffic'`。

- [ ] **Step 3: 实现**

创建 `routing-traffic.ts`：

```ts
import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { RoutingTrafficData, RoutingTrafficProviderTotals } from '../../services/routing-traffic-service';

export type RoutingTrafficIndex = ReadonlyMap<string, readonly RoutingTrafficProviderTotals[]>;

export type RoutingTierShare = {
  readonly providerId: string;
  /** finalCount over the tier's own total. Comparable with the configured `share`. */
  readonly actualShare: number;
  /** successCount / attemptCount. `null` when nothing was attempted — unknown, not zero. */
  readonly successRate: number | null;
  readonly p95LatencyMs: number | null;
  readonly finalCount: bigint;
};

export type RoutingTrafficSummary = {
  readonly finalCount: bigint;
  readonly attemptCount: bigint;
  readonly successCount: bigint;
  readonly successRate: number | null;
};

/** Keyed by the traffic response's `modelId`, which is `requested_model_id` — a different key
 * space from the routing inventory in both directions. Callers look models up by inventory id,
 * so a traffic row the inventory no longer serves simply never matches and never reaches a
 * denominator. Counting it would corrupt every share on the page. */
export const indexRoutingTraffic = (traffic: RoutingTrafficData): RoutingTrafficIndex =>
  new Map(traffic.models.map((model) => [model.modelId, model.providers]));

const rate = (numerator: bigint, denominator: bigint): number | null =>
  denominator === 0n ? null : Number(numerator) / Number(denominator);

/** Actual share is computed over the tier's own members, matching the denominator the configured
 * share already uses. Taking it over the whole model would let a tier-2 fallback dilute tier 1. */
export const tierActualShares = (
  tier: DashboardRoutingModel['tiers'][number],
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
): readonly RoutingTierShare[] => {
  if (totals === undefined) return [];
  const members = tier.providers.flatMap((entry) => {
    const found = totals.find((row) => row.providerId === entry.providerId);
    return found === undefined ? [] : [found];
  });
  const denominator = members.reduce((sum, row) => sum + row.finalCount, 0n);
  return members.map((row) => ({
    providerId: row.providerId,
    actualShare: denominator === 0n ? 0 : Number(row.finalCount) / Number(denominator),
    successRate: rate(row.successCount, row.attemptCount),
    p95LatencyMs: row.p95LatencyMs,
    finalCount: row.finalCount,
  }));
};

/** Whole-model totals for the list's traffic column. `undefined` means no traffic at all, which
 * the column renders as "no traffic" rather than as zeros. */
export const modelTrafficSummary = (
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
): RoutingTrafficSummary | undefined => {
  if (totals === undefined) return undefined;
  const finalCount = totals.reduce((sum, row) => sum + row.finalCount, 0n);
  const attemptCount = totals.reduce((sum, row) => sum + row.attemptCount, 0n);
  const successCount = totals.reduce((sum, row) => sum + row.successCount, 0n);
  return { finalCount, attemptCount, successCount, successRate: rate(successCount, attemptCount) };
};
```

创建 `index.ts`：

```ts
export * from './routing-traffic';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/lib/routing-traffic/`
Expected: PASS，7 个 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/lib/routing-traffic
git commit -m "feat(dashboard): align actual routing share with the configured denominator"
```

---

### Task 4: 风险判定与偏离阈值

**Files:**
- Create: `packages/dashboard/src/modules/routing/lib/routing-risk/index.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-risk/routing-risk.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-risk/routing-risk.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RoutingRiskFilter`；Task 3 的 `RoutingTrafficIndex` / `tierActualShares`；`DashboardRoutingModel`（`eligibleProviderCount`、`tiers`）。
- Produces: `DEVIATION_THRESHOLD`、`DEVIATION_MIN_SAMPLE`、`configuredRisks(model)`、`isDeviating(model, totals)`、`modelRisks(model, totals)`、`countRoutingRisks(models, index)`。Task 6、7、8 消费。

**两类风险的可用性不同，这是设计的一部分，不是实现细节：**
- `no-eligible`（`eligibleProviderCount === 0`）与 `single-point`（`=== 1`）只依赖 inventory，**随列表一起就有**。
- `deviating` 依赖 traffic query。traffic 还没到 → 未知；traffic 失败 → 未知。**未知不等于「没有偏离」**，所以概览条对它显示加载态或隐藏整块，绝不显示 0。

**阈值：** 同 tier 内任一 provider 的 `|实际份额 − 配置份额| ≥ 0.15`，**且**该模型 `finalCount ≥ 50`。样本不足一律不报 —— 否则阈值本身成为噪音源。两个数都是我拍的，没有依据，上线后按真实数据调；所以它们是命名常量而不是散落的字面量。

- [ ] **Step 1: 写失败测试**

创建 `routing-risk.test.ts`：

```ts
import { expect, test } from '@rstest/core';

import { DEVIATION_MIN_SAMPLE, DEVIATION_THRESHOLD, configuredRisks, countRoutingRisks, isDeviating } from './routing-risk';

const model = (over: Partial<Parameters<typeof configuredRisks>[0]> = {}) =>
  ({
    modelId: 'sonnet',
    revision: 'rev-1',
    baselineProviderIds: [],
    providerCount: 2,
    eligibleProviderCount: 2,
    hasOverrides: false,
    tiers: [
      {
        priority: 30,
        providers: [
          { providerId: 'primary', weight: 1, share: 0.5 },
          { providerId: 'fallback', weight: 1, share: 0.5 },
        ],
      },
    ],
    providers: [],
    ...over,
  }) as Parameters<typeof configuredRisks>[0];

const totals = (final: bigint, providerId: string) => ({
  providerId,
  finalCount: final,
  attemptCount: final,
  successCount: final,
  p95LatencyMs: 10,
});

test('classifies the two config-derived risks from eligibility alone', () => {
  expect(configuredRisks(model({ eligibleProviderCount: 0 }))).toEqual(['no-eligible']);
  expect(configuredRisks(model({ eligibleProviderCount: 1 }))).toEqual(['single-point']);
  expect(configuredRisks(model({ eligibleProviderCount: 2 }))).toEqual([]);
});

test('flags a split that ran far from its configuration', () => {
  // Configured 50/50, observed 93/7 over a large sample.
  expect(isDeviating(model(), [totals(93n, 'primary'), totals(7n, 'fallback')])).toBe(true);
});

test('stays silent when the sample is too small to mean anything', () => {
  // Same 93/7 ratio, but only 10 requests: the threshold would be pure noise here.
  expect(isDeviating(model(), [totals(9n, 'primary'), totals(1n, 'fallback')])).toBe(false);
});

test('stays silent when the split matches its configuration', () => {
  expect(isDeviating(model(), [totals(50n, 'primary'), totals(50n, 'fallback')])).toBe(false);
});

test('reports deviation as unknown rather than false when traffic is absent', () => {
  // A missing traffic query must never read as "no deviation".
  expect(isDeviating(model(), undefined)).toBeUndefined();
});

test('counts config risks always and deviation only once traffic is known', () => {
  const models = [model({ modelId: 'a', eligibleProviderCount: 0 }), model({ modelId: 'b' })];
  const index = new Map([['b', [totals(93n, 'primary'), totals(7n, 'fallback')]]]);

  expect(countRoutingRisks(models, index)).toEqual({ 'no-eligible': 1, 'single-point': 0, deviating: 1 });
  // Without an index the deviation count is unknown, not zero.
  expect(countRoutingRisks(models, undefined)).toEqual({ 'no-eligible': 1, 'single-point': 0, deviating: undefined });
});

test('pins the thresholds as named constants so they are tunable in one place', () => {
  expect(DEVIATION_THRESHOLD).toBe(0.15);
  expect(DEVIATION_MIN_SAMPLE).toBe(50n);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/lib/routing-risk/`
Expected: FAIL —— `Cannot find module './routing-risk'`。

- [ ] **Step 3: 实现**

创建 `routing-risk.ts`：

```ts
import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { RoutingRiskFilter } from '../routing-search';
import { type RoutingTrafficIndex, modelTrafficSummary, tierActualShares } from '../routing-traffic';
import type { RoutingTrafficProviderTotals } from '../../services/routing-traffic-service';

/** Percentage points of divergence, within one tier, before a model is called deviating.
 * Chosen by judgement rather than measurement — tune against real traffic. */
export const DEVIATION_THRESHOLD = 0.15;

/** Below this many served requests the ratio is noise, so no deviation is reported at all. */
export const DEVIATION_MIN_SAMPLE = 50n;

/** Risks derivable from configuration alone, so they are available the moment the list renders. */
export const configuredRisks = (model: DashboardRoutingModel): readonly RoutingRiskFilter[] => {
  if (model.eligibleProviderCount === 0) return ['no-eligible'];
  if (model.eligibleProviderCount === 1) return ['single-point'];
  return [];
};

/** `undefined` means unknown — traffic has not arrived or failed. Never conflate that with
 * `false`, which would claim the model is behaving as configured. */
export const isDeviating = (
  model: DashboardRoutingModel,
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
): boolean | undefined => {
  if (totals === undefined) return undefined;
  const summary = modelTrafficSummary(totals);
  if (summary === undefined || summary.finalCount < DEVIATION_MIN_SAMPLE) return false;
  return model.tiers.some((tier) => {
    const actual = tierActualShares(tier, totals);
    return tier.providers.some((configured) => {
      const observed = actual.find((entry) => entry.providerId === configured.providerId);
      return observed !== undefined && Math.abs(observed.actualShare - configured.share) >= DEVIATION_THRESHOLD;
    });
  });
};

export const modelRisks = (
  model: DashboardRoutingModel,
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
): readonly RoutingRiskFilter[] =>
  isDeviating(model, totals) === true ? [...configuredRisks(model), 'deviating'] : configuredRisks(model);

export type RoutingRiskCounts = {
  readonly 'no-eligible': number;
  readonly 'single-point': number;
  /** `undefined` while traffic is unknown, so the tile can show a loading state instead of 0. */
  readonly deviating: number | undefined;
};

export const countRoutingRisks = (
  models: readonly DashboardRoutingModel[],
  index: RoutingTrafficIndex | undefined,
): RoutingRiskCounts => ({
  'no-eligible': models.filter((model) => model.eligibleProviderCount === 0).length,
  'single-point': models.filter((model) => model.eligibleProviderCount === 1).length,
  deviating:
    index === undefined ? undefined : models.filter((model) => isDeviating(model, index.get(model.modelId)) === true).length,
});
```

创建 `index.ts`：

```ts
export * from './routing-risk';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/lib/routing-risk/`
Expected: PASS，7 个 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/lib/routing-risk
git commit -m "feat(dashboard): classify routing risks and the deviation threshold"
```

---

### Task 5: 排序、lab 分组、筛选

**Files:**
- Create: `packages/dashboard/src/modules/routing/lib/routing-rows/index.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-rows/routing-rows.ts`
- Create: `packages/dashboard/src/modules/routing/lib/routing-rows/routing-rows.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `RoutingSearch`；Task 3 的 `RoutingTrafficIndex`；Task 4 的 `modelRisks`。
- Produces: `UNKNOWN_LAB`、`labOf(model)`、`sortRoutingModels(models)`、`filterRoutingModels(models, search, index)`、`labOptions(models)`。Task 7、8 消费。

**排序规则（全定义，缺一个实现就会瞎猜）：** lab 升序 → `releaseDate` **降序**（新模型在前）→ `modelId` 升序兜底。
- 缺 `catalog` 的归「未知」组，该组**排最后**（不是按字母混进去）。
- 组内缺 `releaseDate` 的排该组最后。
- `releaseDate` **按字符串比较，不 parse Date**：`YYYY-MM` 与 `YYYY-MM-DD` 混排时字典序结果本就合理，且避开时区偏移。

排序不依赖 provider 健康状态，所以行的位置稳定可预测 —— 这是用户明确选择「可点筛选 + 字母序」而不是「问题优先排序」的原因。

- [ ] **Step 1: 写失败测试**

创建 `routing-rows.test.ts`：

```ts
import { expect, test } from '@rstest/core';

import { UNKNOWN_LAB, filterRoutingModels, labOf, labOptions, sortRoutingModels } from './routing-rows';

const model = (modelId: string, catalog?: { lab: string; releaseDate?: string }, eligible = 2) =>
  ({
    modelId,
    revision: 'r',
    baselineProviderIds: [],
    providerCount: 2,
    eligibleProviderCount: eligible,
    hasOverrides: false,
    tiers: [],
    providers: [],
    ...(catalog === undefined ? {} : { catalog }),
  }) as Parameters<typeof labOf>[0];

test('groups a model with no catalog under a single unknown lab', () => {
  expect(labOf(model('x'))).toBe(UNKNOWN_LAB);
  expect(labOf(model('y', { lab: 'openai' }))).toBe('openai');
});

test('orders by lab, then newest release first, then model id', () => {
  const sorted = sortRoutingModels([
    model('z-old', { lab: 'openai', releaseDate: '2026-01' }),
    model('a-new', { lab: 'openai', releaseDate: '2026-08' }),
    model('claude', { lab: 'anthropic', releaseDate: '2026-05' }),
  ]);

  expect(sorted.map((entry) => entry.modelId)).toEqual(['claude', 'a-new', 'z-old']);
});

test('sinks the unknown lab to the very end, not into alphabetical order', () => {
  // 'unknown' would sort between 'openai' and 'zhipu' alphabetically; it must not.
  const sorted = sortRoutingModels([model('mystery'), model('gpt', { lab: 'openai' }), model('glm', { lab: 'zhipu' })]);

  expect(sorted.map((entry) => entry.modelId)).toEqual(['gpt', 'glm', 'mystery']);
});

test('sinks a model with no release date to the end of its own lab', () => {
  const sorted = sortRoutingModels([
    model('undated', { lab: 'openai' }),
    model('dated', { lab: 'openai', releaseDate: '2026-02' }),
  ]);

  expect(sorted.map((entry) => entry.modelId)).toEqual(['dated', 'undated']);
});

test('compares release dates as strings across mixed precision', () => {
  // '2026-03-15' > '2026-03' lexicographically, which is the sensible reading, and parsing
  // either into a Date would introduce a timezone shift.
  const sorted = sortRoutingModels([
    model('month', { lab: 'openai', releaseDate: '2026-03' }),
    model('day', { lab: 'openai', releaseDate: '2026-03-15' }),
  ]);

  expect(sorted.map((entry) => entry.modelId)).toEqual(['day', 'month']);
});

test('filters by lab and by a config-derived risk', () => {
  const models = [model('a', { lab: 'openai' }, 0), model('b', { lab: 'anthropic' }), model('c')];

  expect(filterRoutingModels(models, { range: '24h', lab: 'openai' }, undefined).map((m) => m.modelId)).toEqual(['a']);
  expect(filterRoutingModels(models, { range: '24h', risk: 'no-eligible' }, undefined).map((m) => m.modelId)).toEqual(['a']);
  expect(filterRoutingModels(models, { range: '24h', lab: UNKNOWN_LAB }, undefined).map((m) => m.modelId)).toEqual(['c']);
});

test('yields nothing for a deviation filter while traffic is unknown', () => {
  // Filtering by deviation with no traffic must not silently fall back to "everything".
  const models = [model('a', { lab: 'openai' })];

  expect(filterRoutingModels(models, { range: '24h', risk: 'deviating' }, undefined)).toEqual([]);
});

test('offers each lab once, with unknown last', () => {
  const models = [model('a'), model('b', { lab: 'openai' }), model('c', { lab: 'openai' }), model('d', { lab: 'anthropic' })];

  expect(labOptions(models)).toEqual(['anthropic', 'openai', UNKNOWN_LAB]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/lib/routing-rows/`
Expected: FAIL —— `Cannot find module './routing-rows'`。

- [ ] **Step 3: 实现**

创建 `routing-rows.ts`：

```ts
import type { DashboardRoutingModel } from '@aio-proxy/types';

import { modelRisks } from '../routing-risk';
import type { RoutingSearch } from '../routing-search';
import type { RoutingTrafficIndex } from '../routing-traffic';

/** The bucket for a model models.dev cannot place: a cold catalog, or a record that names no
 * maker. Sorted last rather than alphabetically, so it never lands between two real labs. */
export const UNKNOWN_LAB = 'unknown';

export const labOf = (model: DashboardRoutingModel): string => model.catalog?.lab ?? UNKNOWN_LAB;

const compareLab = (left: string, right: string): number => {
  if (left === right) return 0;
  if (left === UNKNOWN_LAB) return 1;
  if (right === UNKNOWN_LAB) return -1;
  return left.localeCompare(right);
};

// Release dates are compared as strings on purpose: models.dev mixes `YYYY-MM` and
// `YYYY-MM-DD`, lexicographic order is already sensible across both, and parsing into a Date
// would introduce a timezone shift. A missing date sinks to the end of its own lab.
const compareReleaseDate = (left: string | undefined, right: string | undefined): number => {
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right.localeCompare(left);
};

/** lab ascending, then newest release first, then model id. Independent of Provider health, so a
 * row's position stays predictable between visits. */
export const sortRoutingModels = (models: readonly DashboardRoutingModel[]): readonly DashboardRoutingModel[] =>
  [...models].sort(
    (left, right) =>
      compareLab(labOf(left), labOf(right)) ||
      compareReleaseDate(left.catalog?.releaseDate, right.catalog?.releaseDate) ||
      left.modelId.localeCompare(right.modelId),
  );

export const filterRoutingModels = (
  models: readonly DashboardRoutingModel[],
  search: RoutingSearch,
  index: RoutingTrafficIndex | undefined,
): readonly DashboardRoutingModel[] =>
  models.filter((model) => {
    if (search.lab !== undefined && labOf(model) !== search.lab) return false;
    if (search.risk === undefined) return true;
    return modelRisks(model, index?.get(model.modelId)).includes(search.risk);
  });

/** Every lab present, each once, unknown last — the same order the table groups in. */
export const labOptions = (models: readonly DashboardRoutingModel[]): readonly string[] =>
  [...new Set(models.map(labOf))].sort(compareLab);
```

创建 `index.ts`：

```ts
export * from './routing-rows';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/lib/routing-rows/`
Expected: PASS，8 个 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/lib/routing-rows
git commit -m "feat(dashboard): order and filter routing models by lab"
```

---

### Task 6: i18n 键与健康概览条

**Files:**
- Modify: `packages/i18n/messages/en.json` · `ja.json` · `ko.json` · `zh-Hans.json` · `zh-Hant.json`
- Create: `packages/dashboard/src/modules/routing/components/routing-health-strip.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-health-strip.test.tsx`

**Interfaces:**
- Consumes: Task 4 的 `RoutingRiskCounts`；Task 1 的 `RoutingRiskFilter` / `ROUTING_RISK_FILTERS`。
- Produces: `RoutingHealthStrip`，props `{ total: number; counts: RoutingRiskCounts; active: RoutingRiskFilter | undefined; onToggle: (risk: RoutingRiskFilter) => void }`。Task 8 消费。

**已核实可复用：** `Badge` / `Button` / `Card` / `CardContent` 来自 `@aio-proxy/ui/components/*`。不要自造 badge 或 button 外观 —— DESIGN.md 明令禁止在产品页重复这些样式。

**三条行为规则：**
1. 第一块「模型总数」只读、不可点。后三块是 toggle。
2. `counts.deviating === undefined` 时第四块显示**加载态且不可点** —— 绝不显示 `0`，那会谎报「没有偏离」。
3. 激活块要有 `aria-pressed` 与可见选中态；颜色不能是唯一信号（DESIGN.md）。

- [ ] **Step 1: 加 i18n 键**

在 `packages/i18n/messages/en.json` 的 `dashboard.routing` 对象下新增以下键；另外四个语言文件加同样的键，值按各自语言翻译（`zh-Hans` 参考括号内）。

```
health.total                 Models                        (模型)
health.no_eligible           No eligible Provider          (无可用 Provider)
health.single_point          Single point, no failover      (单点，无 failover)
health.deviating             Diverged from config           (实际偏离配置)
health.deviating_pending     Measuring                      (统计中)
risk.no_eligible             No eligible Provider           (无可用 Provider)
risk.single_point            Single point                   (单点)
risk.deviating               Diverged                       (偏离)
lab.unknown                  Unknown lab                    (未知厂商)
lab.filter_label             Lab                            (厂商)
lab.filter_all               All labs                       (全部厂商)
lab.model_count              {count} models                 ({count} 个模型)
lab.risk_count               {count} need attention         ({count} 个需处理)
share.configured             Configured                     (配置)
share.actual                 Actual                         (实际)
share.tier                   Tier {value}                   (第 {value} 层)
traffic.none                 No traffic                     (无流量)
traffic.success_rate         {value} success                (成功率 {value})
table.col_traffic            Traffic                        (流量)
```

跑 `bun run i18n:compile`。

- [ ] **Step 2: 写失败测试**

创建 `routing-health-strip.test.tsx`，照 `packages/dashboard/src/modules/routing/components/routing-table.test.tsx` 的 render 方式（同一个 rstest + `@testing-library/react` 组合）：

```tsx
import { expect, rs, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { RoutingHealthStrip } from './routing-health-strip';

const counts = { 'no-eligible': 3, 'single-point': 41, deviating: 7 } as const;

test('shows every count and marks the active filter pressed', () => {
  render(<RoutingHealthStrip total={217} counts={counts} active="no-eligible" onToggle={() => {}} />);

  expect(screen.getByText('217')).toBeInTheDocument();
  expect(screen.getByRole('button', { pressed: true })).toHaveTextContent('3');
});

test('toggles the risk it was clicked with', () => {
  const onToggle = rs.fn();
  render(<RoutingHealthStrip total={1} counts={counts} active={undefined} onToggle={onToggle} />);

  screen.getByText('41').closest('button')?.click();

  expect(onToggle).toHaveBeenCalledWith('single-point');
});

test('never renders zero for an unmeasured deviation count', () => {
  // A traffic query that has not landed or has failed is unknown, not "no deviation".
  render(<RoutingHealthStrip total={1} counts={{ ...counts, deviating: undefined }} active={undefined} onToggle={() => {}} />);

  expect(screen.queryByText('0')).not.toBeInTheDocument();
  expect(screen.getByText(/Measuring|统计中/u)).toBeInTheDocument();
});

test('does not let an unmeasured deviation tile be filtered by', () => {
  const onToggle = rs.fn();
  render(<RoutingHealthStrip total={1} counts={{ ...counts, deviating: undefined }} active={undefined} onToggle={onToggle} />);

  screen.getByText(/Measuring|统计中/u).closest('button')?.click();

  expect(onToggle).not.toHaveBeenCalled();
});

test('leaves the total tile unclickable', () => {
  render(<RoutingHealthStrip total={217} counts={counts} active={undefined} onToggle={() => {}} />);

  // Three clickable risks, and the total is not one of them.
  expect(screen.getAllByRole('button')).toHaveLength(3);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-health-strip`
Expected: FAIL —— `Cannot find module './routing-health-strip'`。

- [ ] **Step 4: 实现**

创建 `routing-health-strip.tsx`。一个 `React.FC<RoutingHealthStripProps>`，用 `Card` + `CardContent` 包一个四列网格。总数块是普通 `div`；三个风险块是 `Button variant="ghost"`，带 `aria-pressed={active === risk}`，选中时加可见的下边框或背景（用 shadcn 语义 token，不要硬编码颜色）。`deviating` 为 `undefined` 时该块渲染 `m['dashboard.routing.health.deviating_pending']()` 并 `disabled`。

数字用 `Intl.NumberFormat` 渲染即可；**不要**为此改 `KpiNumber` 的 `Format` 联合。若你判断 `KpiNumber` 恰好支持纯整数格式，可以用它并在报告里说明。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-health-strip`
Expected: PASS，5 个 test 全绿。

- [ ] **Step 6: 提交**

```bash
git add packages/i18n/messages packages/dashboard/src/modules/routing/components/routing-health-strip.tsx packages/dashboard/src/modules/routing/components/routing-health-strip.test.tsx
git commit -m "feat(dashboard): add the routing health strip"
```

---

### Task 7: 双层份额条

**Files:**
- Create: `packages/dashboard/src/modules/routing/components/routing-share-bar.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-share-bar.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `RoutingTierShare`；`DashboardRoutingModel['tiers']`。
- Produces: `RoutingShareBar`，props `{ tiers: DashboardRoutingModel['tiers']; actual: readonly RoutingTierShare[] | undefined }`。Task 8 用在 `route` 列里。

**规则：** 粗条 = 配置份额（按 tier 顺序拼接，tier 之间留间隔），细条 = 实际份额。`actual === undefined` 时**只渲染粗条**，不渲染 0 宽度的细条 —— 缺失与零是两件事，一条 0 宽细条会被读成「实际份额为零」。每段带 tooltip 给 providerId 与百分比。`tiers` 为空数组时整体渲染成一个「已禁用」badge（沿用现有 `m['dashboard.routing.table.disabled']()`）。

- [ ] **Step 1: 写失败测试**

创建 `routing-share-bar.test.tsx`：

```tsx
import { expect, test } from '@rstest/core';
import { render, screen } from '@testing-library/react';

import { RoutingShareBar } from './routing-share-bar';

const tiers = [
  {
    priority: 30,
    providers: [
      { providerId: 'primary', weight: 1, share: 0.5 },
      { providerId: 'fallback', weight: 1, share: 0.5 },
    ],
  },
] as const;

const actual = [
  { providerId: 'primary', actualShare: 0.93, successRate: 0.5, p95LatencyMs: 60, finalCount: 93n },
  { providerId: 'fallback', actualShare: 0.07, successRate: 1, p95LatencyMs: 10, finalCount: 7n },
] as const;

test('draws a configured segment per provider with its share in the label', () => {
  render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  expect(screen.getByLabelText(/primary/u)).toBeInTheDocument();
  expect(screen.getByLabelText(/fallback/u)).toBeInTheDocument();
});

test('omits the actual overlay entirely when traffic is unknown', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={undefined} />);

  // Absent is not zero: a 0-width overlay would read as "actual share is zero".
  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(0);
});

test('draws the actual overlay once traffic is known', () => {
  const { container } = render(<RoutingShareBar tiers={tiers} actual={actual} />);

  expect(container.querySelectorAll('[data-testid="routing-share-actual"]')).toHaveLength(1);
});

test('renders a disabled badge when no tier has an eligible provider', () => {
  render(<RoutingShareBar tiers={[]} actual={undefined} />);

  expect(screen.getByText(/Disabled|禁用/u)).toBeInTheDocument();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-share-bar`
Expected: FAIL —— `Cannot find module './routing-share-bar'`。

- [ ] **Step 3: 实现**

创建 `routing-share-bar.tsx`，一个 `React.FC<RoutingShareBarProps>`：

- 外层按 tier 渲染成一列（或一行带间隔），每个 tier 一组条。
- 配置条：`div` 容器 + 每个 provider 一段，宽度 `${share * 100}%`，`aria-label` 含 providerId 与 `m['dashboard.routing.share.configured']()` 加百分比。
- 实际条：仅当 `actual` 不为 `undefined` 时渲染，容器加 `data-testid="routing-share-actual"`，段宽用 `actualShare`，`aria-label` 用 `m['dashboard.routing.share.actual']()`。
- 用 `Tooltip` 展示每段的 providerId + 百分比；颜色用 shadcn 语义 token，不要硬编码。
- `tiers.length === 0` 时直接返回 `<Badge variant="outline">{m['dashboard.routing.table.disabled']()}</Badge>`。

百分比格式化复用 `formatRoutingShare`（`../lib/routing-summary`，已存在，返回形如 `50%` 的字符串）。**先确认它的签名**是 `(share: number) => string`；若不符，停下来报告。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-share-bar`
Expected: PASS，4 个 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/components/routing-share-bar.tsx packages/dashboard/src/modules/routing/components/routing-share-bar.test.tsx
git commit -m "feat(dashboard): draw configured and actual routing share together"
```

---

### Task 8: 表格列与 lab 分组行

**Files:**
- Create: `packages/dashboard/src/modules/routing/components/routing-lab-group-row.tsx`
- Modify: `packages/dashboard/src/modules/routing/components/routing-table-columns.tsx`
- Modify: `packages/dashboard/src/modules/routing/components/routing-table.tsx`
- Modify: `packages/dashboard/src/modules/routing/components/routing-table.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `RoutingTrafficIndex` / `modelTrafficSummary` / `tierActualShares`；Task 4 的 `configuredRisks`；Task 5 的 `labOf`；Task 7 的 `RoutingShareBar`。
- Produces: `RoutingLabGroupRow`（props `{ lab: string; modelCount: number; riskCount: number; columnCount: number }`）、改写后的 `createRoutingColumns(options)` 与 `RoutingTable`。Task 9 装配。

**已核实的字面值：**
- `tableHead(label: () => string, className?: string)` 来自 `@/components/data-table/table-head`，返回吃 `{ column }` 的渲染函数；列 `meta` 形状是 `{ label?: () => string; className?: string }`。
- `useDataTable(data, columns, { getRowId })` 返回 `{ table }`，已带 sorting / pagination（pageSize 10）/ globalFilter / columnVisibility。表格里用 `table.FlexRender`（现有 `routing-table.tsx` 就是这么渲染 header 与 cell 的）。
- `ProviderIdLabel`（`@/components/provider-id-label`）props 是 `{ providerId, className?, providers?, plugins?, mark? }`，**并且它自己降级**：`providers` 缺失或 id 不在其中时渲染纯文本。Providers 列用它，**不要**直接用 `ProviderAvatar` —— 那个需要 `icon`，routing DTO 里没有。
- 现有列 id：`modelId` / `route` / `providers` / `overrides` / `actions`；`formatRoutingTiers` 在 `../lib/routing-summary`。

**列改动：**
| 列 | 改动 |
|---|---|
| `modelId` | 追加 lab 名、`releaseDate`、风险 chip（`configuredRisks` + 传入的 deviating 标记）、覆写 chip |
| `route` | 文字 summary 换成 `RoutingShareBar` |
| `providers` | `2 / 3` 换成 `ProviderIdLabel` 叠放 + 计数 |
| `traffic`（新） | 请求数 + 成功率；无流量时渲染 `m['dashboard.routing.traffic.none']()` |
| `overrides` / `actions` | 不变（编辑入口仍是现有 drawer） |

**排序交给 `sortRoutingModels` 而不是表格。** 传给 `useDataTable` 的 data 已经排好序；`modelId` 列的 `enableSorting` 保持默认，用户手动点排序会覆盖分组顺序 —— 这是可接受的，但**分组行只在未手动排序时渲染**（`table.state.sorting.length === 0`），否则分组标题会和乱序的行对不上。这条必须实现，并用测试钉住。

**分组行渲染：** 遍历 `table.getRowModel().rows`，当 `labOf(row.original)` 与上一行不同时，先插一个 `RoutingLabGroupRow`（一个 `TableRow` + 一个 `colSpan={columnCount}` 的 `TableCell`）。分页跨组时新页顶部会自然重复标题行，因为每页都从「上一行 undefined」开始。

- [ ] **Step 1: 写失败测试**

在现有 `routing-table.test.tsx` 追加：

```tsx
test('groups rows by lab and repeats the header on each page', () => {
  render(
    <RoutingTable
      models={[
        modelFixture('gpt-5', { lab: 'openai' }),
        modelFixture('claude', { lab: 'anthropic' }),
      ]}
      traffic={undefined}
      onEdit={() => {}}
    />,
  );

  expect(screen.getByText('anthropic')).toBeInTheDocument();
  expect(screen.getByText('openai')).toBeInTheDocument();
});

test('drops the lab group headers once the user sorts a column', () => {
  // A group header above manually reordered rows would label the wrong rows.
  render(<RoutingTable models={[modelFixture('gpt-5', { lab: 'openai' })]} traffic={undefined} onEdit={() => {}} />);

  screen.getByRole('button', { name: /Model ID|模型/u }).click();

  expect(screen.queryByText('openai')).not.toBeInTheDocument();
});

test('shows no-traffic rather than zeros when traffic is absent', () => {
  render(<RoutingTable models={[modelFixture('gpt-5', { lab: 'openai' })]} traffic={undefined} onEdit={() => {}} />);

  expect(screen.getByText(/No traffic|无流量/u)).toBeInTheDocument();
});
```

`modelFixture(modelId, catalog)` 照该文件既有 fixture 的构造方式扩展，加一个可选 `catalog` 参数。若该文件没有这样的 helper，先提取一个再加测试。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-table`
Expected: FAIL —— `RoutingTable` 还不接受 `traffic` prop，分组行与 traffic 列都不存在。

- [ ] **Step 3: 实现**

创建 `routing-lab-group-row.tsx`：一个 `React.FC<RoutingLabGroupRowProps>`，渲染 `<TableRow><TableCell colSpan={columnCount}>` 内含 lab 名（`UNKNOWN_LAB` 时显示 `m['dashboard.routing.lab.unknown']()`）、`m['dashboard.routing.lab.model_count']({ count: modelCount })`，以及 `riskCount > 0` 时的一个 `Badge`（`m['dashboard.routing.lab.risk_count']({ count: riskCount })`）。用 `muted` 背景，不要硬编码颜色。

`riskCount` 由 `RoutingTable` 按组算出：该 lab 下 `modelRisks(model, traffic?.get(model.modelId)).length > 0` 的模型数。**注意它遵守与概览条相同的可用性规则** —— traffic 未到时只计配置派生的两类风险，偏离项在 traffic 到达后才补进来，所以这个数字会从小变大，而不是一开始谎报 0。

改 `routing-table-columns.tsx`：`createRoutingColumns` 改为接收一个 options 对象（`{ onEdit, traffic }`，`traffic: RoutingTrafficIndex | undefined`），按上表调整五列并新增 `traffic` 列。每列的 `meta.label` 保留，这样列可见性菜单仍能用。

改 `routing-table.tsx`：props 增加 `traffic: RoutingTrafficIndex | undefined`；把 `columns` 的 `useMemo` 依赖加上 `traffic`；在 `TableBody` 里按上面的规则插分组行；`columnCount` 用 `table.getVisibleFlatColumns().length`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/`
Expected: PASS，既有 routing-table 测试与三个新 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/components
git commit -m "feat(dashboard): group the routing table by lab and show traffic"
```

---

### Task 9: 页面装配与降级

**Files:**
- Modify: `packages/dashboard/src/modules/routing/templates/routing-page.tsx`
- Modify: `packages/dashboard/src/modules/routing/templates/routing-page.test.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-lab-filter.tsx`

**Interfaces:**
- Consumes: 前八个任务的全部产出。
- Produces: 完成的 `/routing` 页。

**这一步的核心是「两个 query 不互相阻塞」，而且它是显式行为而不是 loading 兜底：**
- routing models 先到 → 立刻渲染列表与粗条，`traffic` 传 `undefined`。
- traffic 到达 → 补细条、traffic 列、偏离计数。
- **traffic 失败 → 列表完全可用**，只是没有细条、traffic 列显示无流量、偏离 tile 隐藏。**绝不因为 traffic 失败而让整页报错或空白。**

`routing-page.tsx` 现在是 98 行，加装配逻辑后注意 400 行线；若逼近就把 query 编排提到 `hooks/use-routing-list.ts`。

- [ ] **Step 1: 写失败测试**

在 `routing-page.test.tsx` 追加（该文件已有的 mock 方式照搬）：

```tsx
test('renders the list from routing models alone when traffic has not landed', () => {
  // The models query resolving first must not be gated on traffic.
  mockRoutingModels({ writable: true, models: [modelFixture('gpt-5', { lab: 'openai' })] });
  mockRoutingTrafficPending();

  render(<RoutingPage />);

  expect(screen.getByTestId('routing-row-gpt-5')).toBeInTheDocument();
  expect(screen.getByText(/Measuring|统计中/u)).toBeInTheDocument();
});

test('keeps the list fully usable when the traffic query fails', () => {
  // Explicit degradation: a failed traffic query costs the thin bars and the deviation tile,
  // never the page.
  mockRoutingModels({ writable: true, models: [modelFixture('gpt-5', { lab: 'openai' })] });
  mockRoutingTrafficError();

  render(<RoutingPage />);

  expect(screen.getByTestId('routing-row-gpt-5')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
```

若该文件还没有 `mockRoutingTrafficPending` / `mockRoutingTrafficError` 这类 helper，按它既有的 mock 风格加。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/templates/`
Expected: FAIL —— 页面还没有概览条，也没有接 traffic query。

- [ ] **Step 3: 实现**

创建 `routing-lab-filter.tsx`：一个 shadcn `Select`（`@aio-proxy/ui/components/select`），选项来自 `labOptions(models)`，外加一个「全部厂商」选项（`m['dashboard.routing.lab.filter_all']()`）。`UNKNOWN_LAB` 显示成 `m['dashboard.routing.lab.unknown']()`。值变化时调 `onChange(lab | undefined)`。

改 `routing-page.tsx`：

1. 读 search：`const search = Route.useSearch()`、`const navigate = Route.useNavigate()`。**注意**：模板从 `@/routes/routing/index` 导入 `Route` 会形成路由↔模板的循环引用；照 `traces` 的做法，让**路由**读 search 并作为 props 传给模板。所以 `RoutingPage` 的 props 变成 `{ search: RoutingSearch; onSearchChange: (next: RoutingSearch) => void }`，`routes/routing/index.tsx` 负责读取与 `navigate`。这一步要同时改 Task 1 里那个只加了 `validateSearch` 的路由文件。
2. 两个 query：`useRoutingQuery()`（已有）与 `useQuery(routingTrafficQueryOptions(search.range))`。
3. `const index = trafficQuery.data === undefined ? undefined : indexRoutingTraffic(trafficQuery.data)` —— `isError` 时也是 `undefined`，这样「失败」与「未到达」走同一条降级路径。
4. `const visible = filterRoutingModels(sortRoutingModels(models), search, index)`。
5. 渲染 `RoutingHealthStrip`（`counts={countRoutingRisks(models, index)}`，注意**总数与计数都用未筛选的 `models`**，否则点了筛选后数字会自己缩水）、`RoutingLabFilter`、`RoutingTable models={visible} traffic={index}`。
6. `onToggle` 调 `toggleRoutingRisk`，lab 变化调 `withRoutingFilters`，都经 `onSearchChange`。
7. 现有的 `RoutingEditorDrawer` 接线**原样保留**。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/`
Expected: PASS，模块内全部测试绿。

- [ ] **Step 5: 全量门禁**

Run: `bun run build && bun run lint:types && bun run format:check && bun run test`
Expected: build 20/20、`lint:types` exit 0、格式无差异、全部测试绿。

- [ ] **Step 6: 提交**

```bash
git add packages/dashboard/src/modules/routing packages/dashboard/src/routes/routing
git commit -m "feat(dashboard): assemble the routing list page"
```

---

## 不在本计划范围内

- **详情页**：splat 路由 `routes/routing/$.tsx`、四个 tab、未保存守卫、删除 `RoutingEditorDrawer` —— 下一份计划。本计划结束时编辑入口仍是现有抽屉，页面是可用的中间状态。
- **changeset**：按 spec 的交付章节，整个重新设计合并前写**一份**，同时指向 `aio-proxy` 与四个内部包。本计划不写。
- **`lab` 为聚合商的展示**：数据层已保证 `lab` 只会是真实厂商（无厂商信息时 `catalog` 缺失，归入「未知」组），所以本计划无需特殊处理。

## 已知风险

- **`routes/routing/index.tsx` 与模板的 props 契约在 Task 1 与 Task 9 之间改了两次。** Task 1 只加 `validateSearch`，Task 9 才把 search 提成 props。这是故意的（Task 1 不该被模板重构阻塞），但执行时要记得 Task 9 会回头改那个文件。
- **手动排序与分组行互斥**（Task 8）。若审查认为「排序后仍显示分组行」更好，那是产品决定，不是实现细节 —— 停下来问。
- **本计划引用的每个外部签名都已核实**，但 `formatRoutingShare`、`KpiNumber` 的 `Format` 联合、`routing-page.test.tsx` 的 mock helper 三处是「按既有风格扩展」而非逐字核对过的。落地时若不符，**报告而不是猜**。









