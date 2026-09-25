# Routing 重新设计 · 数据层实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 dashboard routing 页提供两样它现在拿不到的数据：每个模型的 models.dev catalog 事实（lab、发布日期），以及按「模型 × Provider」聚合的实际流量与成功率。

**Architecture:** `DashboardRoutingModel` 增加一个 `catalog` 字段，由既有的 `lookupCachedModel()` 在服务端派生，零新增请求。流量走两个新的 dashboard 端点，数据源是 `trace_span`（`usage_daily` 是单维度表，给不出交叉），需要为 attempt span 补一条 partial index。

**Tech Stack:** Bun · TypeScript · Zod（`matchesDto` 模式）· Drizzle ORM + bun:sqlite · Hono · `bun:test`

## Global Constraints

- **代码注释一律写英文。** 本计划代码块里的中文注释是**意图说明**，不是要逐字抄进源码的字面内容——落地时把同样的理由用英文写出来。仓库里英文注释是绝对主流（types 3% / core 2% / server 4% 的文件含中文注释），新代码不要逆着这个惯例走。注释解释约束与理由，不复述代码。
- 所有命令从仓库根目录运行。这是 Bun workspace + Turborepo monorepo。
- **model id 绝不进 URL 路径段。** `IdSchema = z.string().min(1)`，model id 可含斜杠（OpenRouter 风格 id 字面就是 `anthropic/claude-sonnet-4.5`）。一律用查询参数。
- **range 枚举复用既有 `UsageOverviewRangeSchema`**（`'24h' | '7d' | '14d' | '30d'`）。不新造枚举。不支持 `90d`：`trace_span` 保留窗口是 45 天。
- **域语言：** models.dev 把厂商前缀称作 `providerId`，但本仓库 **Provider ID 专指上游 provider**。新字段必须叫 `lab`，任何标识符、注释、测试名里都不得把它写成 provider。
- 手写非测试文件 500 行上限，400 行即评估拆分。`packages/server/src/model-routing/inventory.ts` 已 280 行，因此 catalog 派生逻辑单独成文件。
- colocated 测试用同名目录：`foo/index.ts`、`foo/foo.ts`、`foo/foo.test.ts`。
- 通用集合/对象/字符串工具优先 `es-toolkit`，窄导入（`es-toolkit/array` 等）。
- 计数在 wire 上是十进制字符串（与既有 usage wire 一致，前端用 `BigInt()` 解码）。
- 完成前跑 `bun run preflight`。

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/types/src/dashboard/routing/routing.ts`（改） | `DashboardRoutingCatalog` + 挂到 `DashboardRoutingModel` |
| `packages/types/src/dashboard/routing/traffic.ts`（新） | 两个流量端点的 DTO 与 schema |
| `packages/types/src/dashboard/routing/index.ts`（改） | 导出 traffic |
| `packages/core/src/db/trace-store/routing-traffic/`（新） | 聚合查询（总量 + 分桶） |
| `packages/core/src/db/trace-store/types.ts`（改） | `TraceStore` 增加两个方法与查询类型 |
| `packages/core/src/db/trace-store/trace-store.ts`（改） | 接线 |
| `packages/server/src/model-routing/catalog-facts.ts`（新） | modelId → `{ lab, releaseDate }` |
| `packages/server/src/model-routing/inventory.ts`（改） | 调用 catalog-facts |
| `packages/server/src/dashboard-routes/routing/routing.ts`（改） | 两个流量端点 |

---

### Task 1: `catalog` 字段进 routing DTO

**Files:**
- Modify: `packages/types/src/dashboard/routing/routing.ts`
- Test: `packages/types/src/dashboard/routing/routing.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `DashboardRoutingCatalog = { readonly lab: string; readonly releaseDate?: string }`、`DashboardRoutingCatalogSchema`、`DashboardRoutingModel.catalog?: DashboardRoutingCatalog`。Task 5 生产这个值，Task 6 之后由 dashboard 消费。

`DashboardRoutingModelSchema` 用的是 `z.strictObject`，所以在实现前加 fixture 字段一定会失败——这正是我们要的红灯。

- [ ] **Step 1: 写失败测试**

在 `routing.test.ts` 的 `model` fixture 上加 `catalog`（紧跟 `metadata` 之后）：

```ts
const model = {
  modelId: 'openai/gpt-5',
  metadata: { name: 'GPT-5', cost: { input: 2 } },
  catalog: { lab: 'openai', releaseDate: '2026-06' },
  revision: 'rev-1',
  baselineProviderIds: ['primary'],
  providerCount: 1,
  eligibleProviderCount: 1,
  hasOverrides: true,
  tiers: [{ priority: 30, providers: [{ providerId: 'primary', weight: 2, share: 1 }] }],
  providers: [readyProvider],
} as const;
```

在 `describe` 块内新增一个 test（放在 `'enumerates routing mutation error codes'` 之前）：

```ts
test('treats catalog as optional and requires a lab when present', () => {
  const response = schema('DashboardRoutingModelsResponseSchema');
  const { catalog: _catalog, ...withoutCatalog } = model;

  expect(response.parse({ writable: true, models: [withoutCatalog] })).toEqual({
    writable: true,
    models: [withoutCatalog],
  });
  expect(response.safeParse({ writable: true, models: [{ ...model, catalog: { releaseDate: '2026-06' } }] }).success).toBe(
    false,
  );
  expect(response.parse({ writable: true, models: [{ ...model, catalog: { lab: 'openai' } }] })).toEqual({
    writable: true,
    models: [{ ...model, catalog: { lab: 'openai' } }],
  });
});
```

并在最后那个 readonly 测试里加一行断言与对应的期望值：

```ts
const catalogIsReadonly: AllKeysReadonly<NonNullable<DashboardRoutingModel['catalog']>> = true;
```

把 `catalogIsReadonly` 加入该测试的数组，并在期望数组末尾多加一个 `true`。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/types/src/dashboard/routing/routing.test.ts`
Expected: FAIL —— `catalog` 是 `strictObject` 未识别的键，`parses a complete routing models response` 与新测试都报错。

- [ ] **Step 3: 实现**

在 `routing.ts` 中 `DashboardRoutingNumber` 之后加类型：

```ts
/** models.dev 目录派生的客观事实。与 `metadata`（用户在 config 中授权的覆写）分离：
 * 未授权时 `metadata` 为 undefined，因此不能用它排序或展示厂商归属。
 * `lab` 是模型厂商（openai、anthropic）。models.dev 内部称其为 providerId，
 * 但本仓库 Provider ID 专指上游 provider，两者不可混名。 */
export type DashboardRoutingCatalog = {
  readonly lab: string;
  readonly releaseDate?: string;
};
```

在 `DashboardRoutingModel` 的 `metadata` 之后加字段：

```ts
  readonly catalog?: DashboardRoutingCatalog;
```

在 `DashboardRoutingNumberSchema` 之后加 schema：

```ts
export const DashboardRoutingCatalogSchema = matchesDto<DashboardRoutingCatalog>()(
  z.strictObject({
    lab: z.string().min(1),
    // models.dev 给的是 YYYY-MM 或 YYYY-MM-DD，两种都原样透传：
    // 消费端按字符串比较排序，不解析为 Date，以免引入时区偏移。
    releaseDate: z.string().min(1).optional(),
  }),
);
```

在 `DashboardRoutingModelSchema` 的 `metadata` 行之后加：

```ts
    catalog: DashboardRoutingCatalogSchema.optional(),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/types/src/dashboard/routing/routing.test.ts`
Expected: PASS，全部 test 绿。

- [ ] **Step 5: 提交**

```bash
git add packages/types/src/dashboard/routing/routing.ts packages/types/src/dashboard/routing/routing.test.ts
git commit -m "feat(types): add catalog facts to the routing model DTO"
```

---

### Task 2: 流量端点的 DTO

**Files:**
- Create: `packages/types/src/dashboard/routing/traffic.ts`
- Create: `packages/types/src/dashboard/routing/traffic.test.ts`
- Modify: `packages/types/src/dashboard/routing/index.ts`

**Interfaces:**
- Consumes: `UsageOverviewRange` / `UsageOverviewRangeSchema`（来自 `packages/types/src/usage.ts`，已存在）
- Produces: `DashboardRoutingTrafficResponse`、`DashboardRoutingTrafficModel`、`DashboardRoutingTrafficProvider`、`DashboardRoutingTrafficBucketsResponse`、`DashboardRoutingTrafficBucket` 及各自 `*Schema`。Task 4 生产这些形状，Task 6 序列化它们。

计数在 wire 上是十进制字符串，与既有 usage wire 一致（`decodeUsageOverview` 用 `BigInt()` 解码）。`p95LatencyMs` 在样本为空时是 `null`，不是 `0`——`0` 会谎报「零延迟」。

- [ ] **Step 1: 写失败测试**

创建 `packages/types/src/dashboard/routing/traffic.test.ts`：

```ts
import { describe, expect, test } from 'bun:test';

import * as dashboard from '../index';

const provider = {
  providerId: 'primary',
  finalCount: '120',
  attemptCount: '140',
  successCount: '125',
  p95LatencyMs: 1_240,
} as const;

describe('dashboard routing traffic contracts', () => {
  test('parses a totals response and keeps counts as decimal strings', () => {
    const totals = Reflect.get(dashboard, 'DashboardRoutingTrafficResponseSchema') as {
      parse: (value: unknown) => unknown;
    };
    const value = {
      range: '24h',
      rangeStart: '2026-09-24T08:00:00.000Z',
      rangeEnd: '2026-09-25T08:00:00.000Z',
      models: [{ modelId: 'anthropic/claude-sonnet-4.5', providers: [provider] }],
    };

    expect(totals.parse(value)).toEqual(value);
  });

  test('allows a null p95 when a provider has no completed attempt', () => {
    const totals = Reflect.get(dashboard, 'DashboardRoutingTrafficResponseSchema') as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const base = {
      range: '7d',
      rangeStart: '2026-09-18T00:00:00.000Z',
      rangeEnd: '2026-09-25T08:00:00.000Z',
      models: [{ modelId: 'gpt-5-codex', providers: [{ ...provider, p95LatencyMs: null }] }],
    };

    expect(totals.safeParse(base).success).toBe(true);
    expect(totals.safeParse({ ...base, range: '90d' }).success).toBe(false);
    expect(totals.safeParse({ ...base, models: [{ modelId: 'x', providers: [{ ...provider, finalCount: 120 }] }] }).success).toBe(
      false,
    );
  });

  test('parses a buckets response for one model', () => {
    const buckets = Reflect.get(dashboard, 'DashboardRoutingTrafficBucketsResponseSchema') as {
      parse: (value: unknown) => unknown;
    };
    const value = {
      range: '24h',
      modelId: 'anthropic/claude-sonnet-4.5',
      rangeStart: '2026-09-24T08:00:00.000Z',
      rangeEnd: '2026-09-25T08:00:00.000Z',
      bucketUnit: 'hour',
      providerIds: ['primary', 'fallback'],
      buckets: [{ key: '2026-09-24T08:00:00.000Z', values: { primary: '5', fallback: '1' } }],
    };

    expect(buckets.parse(value)).toEqual(value);
  });
});
```

readonly 断言**不放在这个文件**：`routing.test.ts` 已经有 `Equal` / `ReadonlyKeys` / `AllKeysReadonly` 三个类型级 helper 和一个集中的 readonly 测试，在这里重写一遍就是逐字复制一段逻辑。改为在 `routing.test.ts` 的 `'keeps public routing DTO properties and mutation providers readonly'` 测试里追加四行断言与四个 `true`：

```ts
    const trafficProviderIsReadonly: AllKeysReadonly<DashboardRoutingTrafficProvider> = true;
    const trafficModelIsReadonly: AllKeysReadonly<DashboardRoutingTrafficModel> = true;
    const trafficTotalsIsReadonly: AllKeysReadonly<DashboardRoutingTrafficResponse> = true;
    const trafficBucketsIsReadonly: AllKeysReadonly<DashboardRoutingTrafficBucketsResponse> = true;
```

并在该文件的 type import 中加入这四个类型（从 `'./traffic'` 导入）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/types/src/dashboard/routing/traffic.test.ts`
Expected: FAIL —— `Cannot find module './traffic'`。

- [ ] **Step 3: 实现**

创建 `packages/types/src/dashboard/routing/traffic.ts`：

```ts
import { z } from 'zod';

import { IdSchema } from '../../common';
import { type UsageOverviewRange, UsageOverviewRangeSchema } from '../../usage';
// Counts travel as decimal strings, matching the existing usage wire: SQLite integers can
// exceed the JS safe-integer range, so the frontend decodes them with BigInt(). Reuse the
// exported schema rather than re-spelling the regex — it is stricter (it rejects `007`).
import { NonNegativeIntegerStringSchema } from '../dashboard';

const matchesDto =
  <Dto>() =>
  <Schema extends z.ZodType<Dto>>(schema: Schema): Schema =>
    schema;

// 计数以十进制字符串上线，与既有 usage wire 一致：SQLite 的整数可超出 JS
// 安全整数范围，前端统一用 BigInt() 解码。**复用 `../dashboard` 导出的
// `NonNegativeIntegerStringSchema`，不要在这里另写一个正则**——既有那条更严（拒绝 `007`），
// 而 CLAUDE.md 要求新增工具前先搜代码库。

export type DashboardRoutingTrafficProvider = {
  readonly providerId: string;
  /** 该 Provider 最终承接的请求数（root span 的 final_provider_id）。实际份额的分子。 */
  readonly finalCount: string;
  /** 该 Provider 被尝试的次数，含失败后被 failover 掉的尝试。 */
  readonly attemptCount: string;
  readonly successCount: string;
  /** 样本为空时为 null，绝不用 0 代替——0 会被读成「零延迟」。 */
  readonly p95LatencyMs: number | null;
};

export type DashboardRoutingTrafficModel = {
  readonly modelId: string;
  readonly providers: readonly DashboardRoutingTrafficProvider[];
};

export type DashboardRoutingTrafficResponse = {
  readonly range: UsageOverviewRange;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly models: readonly DashboardRoutingTrafficModel[];
};

export type DashboardRoutingTrafficBucket = {
  readonly key: string;
  readonly values: Readonly<Record<string, string>>;
};

export type DashboardRoutingTrafficBucketsResponse = {
  readonly range: UsageOverviewRange;
  readonly modelId: string;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly bucketUnit: 'hour' | 'day';
  /** 该区间内出现过的 Provider ID，供图表固定系列顺序。 */
  readonly providerIds: readonly string[];
  readonly buckets: readonly DashboardRoutingTrafficBucket[];
};

export const DashboardRoutingTrafficProviderSchema = matchesDto<DashboardRoutingTrafficProvider>()(
  z.strictObject({
    providerId: IdSchema,
    finalCount: NonNegativeIntegerStringSchema,
    attemptCount: NonNegativeIntegerStringSchema,
    successCount: NonNegativeIntegerStringSchema,
    p95LatencyMs: z.number().int().min(0).nullable(),
  }),
);

export const DashboardRoutingTrafficModelSchema = matchesDto<DashboardRoutingTrafficModel>()(
  z.strictObject({
    modelId: IdSchema,
    providers: z.array(DashboardRoutingTrafficProviderSchema).readonly(),
  }),
);

export const DashboardRoutingTrafficResponseSchema = matchesDto<DashboardRoutingTrafficResponse>()(
  z.strictObject({
    range: UsageOverviewRangeSchema,
    rangeStart: z.iso.datetime(),
    rangeEnd: z.iso.datetime(),
    models: z.array(DashboardRoutingTrafficModelSchema).readonly(),
  }),
);

export const DashboardRoutingTrafficBucketSchema = matchesDto<DashboardRoutingTrafficBucket>()(
  z.strictObject({
    key: z.string().min(1),
    values: z.record(IdSchema, NonNegativeIntegerStringSchema).readonly(),
  }),
);

export const DashboardRoutingTrafficBucketsResponseSchema = matchesDto<DashboardRoutingTrafficBucketsResponse>()(
  z.strictObject({
    range: UsageOverviewRangeSchema,
    modelId: IdSchema,
    rangeStart: z.iso.datetime(),
    rangeEnd: z.iso.datetime(),
    bucketUnit: z.enum(['hour', 'day']),
    providerIds: z.array(IdSchema).readonly(),
    buckets: z.array(DashboardRoutingTrafficBucketSchema).readonly(),
  }),
);
```

在 `packages/types/src/dashboard/routing/index.ts` 追加一行：

```ts
export * from './traffic';
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/types/src/dashboard/routing/`
Expected: PASS，`routing.test.ts` 与 `traffic.test.ts` 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/types/src/dashboard/routing/traffic.ts packages/types/src/dashboard/routing/traffic.test.ts packages/types/src/dashboard/routing/index.ts
git commit -m "feat(types): add routing traffic DTOs"
```

---

### Task 3: 已取消 —— 不需要新索引

**跳过这个任务。** 原计划在此处为 attempt span 加一条 partial index `trace_span_attempt_ended_idx`。已用 `EXPLAIN QUERY PLAN` 实测证伪，并已回退（commit `eeb4505f6` revert 了 `f2a158ccb`）。

**证据：**

- 原查询把范围过滤放在 `attempt.ended_at`。此时无论索引是 `(attempt_index, ended_at)` 还是 `(ended_at) WHERE attempt_index IS NOT NULL`，planner **都不用它**，而是从 root 驱动：
  `SEARCH root USING INDEX trace_span_root_model_started_idx (parent_span_id=? AND requested_model_id>?)` —— **完全没有时间谓词**，等于扫遍 45 天里所有 `requested_model_id` 非空的 root span。
- 把范围过滤改到 `root.ended_at` 后，planner 用上**已经存在**的索引：
  `SEARCH root USING INDEX trace_span_root_ended_idx (parent_span_id=? AND ended_at>? AND ended_at<?)` —— 真正的时间区间 seek。而且加不加新索引，执行计划**完全相同**。
- 仓库里没有任何 `ANALYZE`，因此 SQLite 没有统计信息，skip-scan 永远不可能生效 —— `(attempt_index, ended_at)` 无法服务裸 `ended_at` 范围。这是结构性的，不是统计信息的偶然。

**顺带修掉的一个正确性 bug：** 原设计里 `attemptRows` 按 `attempt.ended_at` 过滤，而 `finalRows` 按 root 的 `ended_at` 过滤 —— 同一个窗口的两个份额用了**两套时间基准**，窗口边界上会出现「attempt 计入了但 final 没计入」。Task 5 现在两个查询统一以 `root.ended_at` 为准。

**另一个教训（给未来真需要生成迁移的任务）：** 本任务原本的提交命令是 `git add packages/core/src/db/schema/trace-span.ts packages/core/src/db/migrations`，但 `migrations.manifest.ts` 位于 `packages/core/src/db/` 下、是 `migrations/` 目录的**兄弟**而不是其成员，因此那条命令从不 stage 它。实测后果：提交出的树里 manifest 缺少新迁移，`runtime migrations match the committed Drizzle journal` 在干净检出上会失败；而当时测试通过只是因为工作区里有未提交的 manifest。生成迁移后必须显式 `git add packages/core/src/db/migrations.manifest.ts`。


---

### Task 4: 抽出 usage range 解析（纯重构）

**Files:**
- Create: `packages/core/src/db/trace-store/usage-range/index.ts`
- Create: `packages/core/src/db/trace-store/usage-range/usage-range.ts`
- Create: `packages/core/src/db/trace-store/usage-range/usage-range.test.ts`
- Modify: `packages/core/src/db/trace-store/usage-overview/usage-overview.ts`（删除私有 `resolveRange` / `bucketKeys` / `localDate` / `pad`，改为导入）

**Interfaces:**
- Consumes: `UsageOverviewRange`（`@aio-proxy/types`）
- Produces:
  - `type ResolvedUsageRange = { readonly start: Date; readonly end: Date; readonly bucketUnit: 'hour' | 'day' }`
  - `type UsageRangeBucket = { readonly identity: string | number; readonly key: string }`
  - `resolveUsageRange(range: UsageOverviewRange, now: Date): ResolvedUsageRange`
  - `usageBucketKeys(range: UsageOverviewRange, start: Date, end: Date): readonly UsageRangeBucket[]`
  - `usageLocalDate(value: Date): string`

  Task 5 全部要用。

**为什么先做这步：** `24h` / `7d` / `14d` / `30d` 的边界与分桶算法现在是 `usage-overview.ts` 的私有函数。Task 5 需要同一套算法，复制一份意味着「7d 是什么」会有两个定义，日后必然漂移。CLAUDE.md 要求新增工具前先搜代码库，这里正确的做法是抽出而非重写。

`ChartBucket`（`usage-overview/aggregation.ts`）与 `UsageRangeBucket` 结构相同，`aggregation.ts` **不需要改动**。

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/db/trace-store/usage-range/usage-range.test.ts`：

```ts
import { expect, test } from 'bun:test';

import { resolveUsageRange, usageBucketKeys, usageLocalDate } from './usage-range';

const NOW = new Date('2026-09-25T08:30:00.000Z');

test('resolves 24h as a rolling hour window and day ranges as aligned local midnights', () => {
  const hourly = resolveUsageRange('24h', NOW);
  expect(hourly.bucketUnit).toBe('hour');
  expect(hourly.end).toEqual(NOW);
  expect(NOW.getTime() - hourly.start.getTime()).toBe(24 * 60 * 60 * 1000);

  for (const [range, days] of [
    ['7d', 7],
    ['14d', 14],
    ['30d', 30],
  ] as const) {
    const resolved = resolveUsageRange(range, NOW);
    expect(resolved.bucketUnit).toBe('day');
    expect(resolved.end).toEqual(NOW);
    expect(resolved.start.getHours()).toBe(0);
    expect(resolved.start.getMinutes()).toBe(0);
    const expected = new Date(NOW);
    expected.setHours(0, 0, 0, 0);
    expected.setDate(expected.getDate() - (days - 1));
    expect(usageLocalDate(resolved.start)).toBe(usageLocalDate(expected));
  }
});

test('emits a dense bucket key list so charts never render gaps', () => {
  const hourly = resolveUsageRange('24h', NOW);
  const hourKeys = usageBucketKeys('24h', hourly.start, hourly.end);
  expect(hourKeys).toHaveLength(24);
  expect(hourKeys.map(({ identity }) => identity)).toEqual(Array.from({ length: 24 }, (_, index) => index));

  const daily = resolveUsageRange('14d', NOW);
  const dayKeys = usageBucketKeys('14d', daily.start, daily.end);
  expect(dayKeys).toHaveLength(14);
  expect(dayKeys[0]?.identity).toBe(usageLocalDate(daily.start));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/src/db/trace-store/usage-range/`
Expected: FAIL —— `Cannot find module './usage-range'`。

- [ ] **Step 3: 实现**

创建 `packages/core/src/db/trace-store/usage-range/usage-range.ts`：

```ts
import type { UsageOverviewRange } from '@aio-proxy/types';

export type ResolvedUsageRange = {
  readonly start: Date;
  readonly end: Date;
  readonly bucketUnit: 'hour' | 'day';
};

/** `identity` 是 SQL 侧的分组值（小时是 0..23 的偏移，天是本地日期串），
 * `key` 是给图表用的 ISO 标签。两者必须成对，否则分桶对不上。 */
export type UsageRangeBucket = {
  readonly identity: string | number;
  readonly key: string;
};

export function resolveUsageRange(range: UsageOverviewRange, now: Date): ResolvedUsageRange {
  if (range === '24h') {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now, bucketUnit: 'hour' };
  }
  let days = 30;
  if (range === '7d') days = 7;
  else if (range === '14d') days = 14;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start, end: now, bucketUnit: 'day' };
}

export function usageBucketKeys(
  range: UsageOverviewRange,
  start: Date,
  end: Date,
): readonly UsageRangeBucket[] {
  if (range === '24h') {
    return Array.from({ length: 24 }, (_, index) => ({
      identity: index,
      key: new Date(start.getTime() + index * 60 * 60 * 1000).toISOString(),
    }));
  }
  const keys: UsageRangeBucket[] = [];
  const day = new Date(start);
  while (day <= end) {
    keys.push({ identity: usageLocalDate(day), key: day.toISOString() });
    day.setDate(day.getDate() + 1);
  }
  return keys;
}

export function usageLocalDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
```

创建 `packages/core/src/db/trace-store/usage-range/index.ts`：

```ts
export * from './usage-range';
```

在 `packages/core/src/db/trace-store/usage-overview/usage-overview.ts` 中：

1. 加导入：

```ts
import { resolveUsageRange, usageBucketKeys } from '../usage-range';
```

2. 删除文件末尾的私有 `resolveRange`、`bucketKeys`、`localDate`、`pad` 四个函数。
3. 把 `resolveRange(query.range, now)` 改为 `resolveUsageRange(query.range, now)`，`bucketKeys(query.range, start, end)` 改为 `usageBucketKeys(query.range, start, end)`。
4. 若 `ChartBucket` 的导入因此不再被使用，从 `./aggregation` 的 import 中移除它。

- [ ] **Step 4: 跑测试确认通过（含既有回归）**

Run: `bun test packages/core/src/db/trace-store/usage-range/ packages/core/src/db/trace-store/usage-overview/`
Expected: PASS。既有的 usage-overview 测试是这次重构的安全网，必须原样绿。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/db/trace-store/usage-range packages/core/src/db/trace-store/usage-overview/usage-overview.ts
git commit -m "refactor(core): extract usage range resolution for reuse"
```

---

### Task 5: 按「模型 × Provider」聚合流量

**Files:**
- Create: `packages/core/src/db/trace-store/routing-traffic/index.ts`
- Create: `packages/core/src/db/trace-store/routing-traffic/routing-traffic.ts`
- Create: `packages/core/src/db/trace-store/routing-traffic/routing-traffic.test.ts`
- Modify: `packages/core/src/db/trace-store/types.ts`
- Modify: `packages/core/src/db/trace-store/trace-store.ts`

**Interfaces:**
- Consumes: Task 2 的 DTO；Task 4 的 `resolveUsageRange` / `usageBucketKeys` / `usageLocalDate`
- Produces:
  - `type RoutingTrafficQuery = { readonly range: UsageOverviewRange; readonly now?: Date }`
  - `type RoutingTrafficBucketsQuery = RoutingTrafficQuery & { readonly modelId: string }`
  - `TraceStore.routingTraffic(query: RoutingTrafficQuery): DashboardRoutingTrafficResponse`
  - `TraceStore.routingTrafficBuckets(query: RoutingTrafficBucketsQuery): DashboardRoutingTrafficBucketsResponse`

  Task 7 调用这两个方法。

**两个维度来自两类行，必须 join `trace_id`：** root span 带 `requested_model_id` 与 `final_provider_id`；attempt span 带 `provider_id` 与 `termination_reason`。attempt span 的 `parent_span_id` 指向 inference span 而**不是** root span（见 `overview.test.ts` 的 seed 方式），所以只能按 `trace_id` 关联，不能按父子关系。

**三个查询统一以 `root.ended_at` 为时间基准。** 不要改成 `attempt.ended_at`：那会让同一个窗口出现两套时间基准（窗口边界上 attempt 计入而 final 不计入），并且让 planner 拿不到驱动表上的时间谓词，退化成扫满整个 45 天保留窗口。已用 `EXPLAIN QUERY PLAN` 实测，详见已取消的 Task 3。

- [ ] **Step 1: 写失败测试**

创建 `packages/core/src/db/trace-store/routing-traffic/routing-traffic.test.ts`：

```ts
import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { StoredSpan, TraceStore } from '../types';

const NOW = new Date('2026-09-25T08:00:00.000Z');

type AttemptSeed = {
  readonly providerId: string;
  readonly durationMs: number;
  readonly outcome?: 'success' | 'failure';
};

type TraceSeed = {
  readonly id: number;
  readonly requestedModelId: string;
  readonly attempts: readonly AttemptSeed[];
  readonly endedAt?: Date;
  /** 覆盖最终承接者。用于构造没有 attempt span 的 root-only trace。 */
  readonly finalProviderId?: string;
};

function seedTrace(store: TraceStore, seed: TraceSeed): void {
  const traceId = seed.id.toString(16).padStart(32, '0');
  const spanId = seed.id.toString(16).padStart(16, '0');
  const endedAt = seed.endedAt ?? NOW;
  const startedAt = new Date(endedAt.getTime() - 1_000);
  const finalProviderId =
    seed.finalProviderId ?? seed.attempts.findLast(({ outcome }) => outcome !== 'failure')?.providerId;
  const attributes = {
    'aio_proxy.request.id': `request-${seed.id}`,
    'aio_proxy.protocol.inbound': 'openai-response',
    'gen_ai.request.model': seed.requestedModelId,
    ...(finalProviderId === undefined
      ? {}
      : { 'aio_proxy.route.final_provider_id': finalProviderId, 'gen_ai.response.model': seed.requestedModelId }),
  };
  store.startRoot(rootStart({ traceId, spanId, requestId: `request-${seed.id}`, startedAt, attributes }));
  const inference = rootSpan({
    traceId,
    spanId: seed.id.toString(16).padStart(16, 'f'),
    parentSpanId: spanId,
    name: 'aio_proxy.inference',
    startedAt,
    endedAt,
    attributes,
  });
  const attempts: StoredSpan[] = seed.attempts.map((attempt, index) => {
    const failed = attempt.outcome === 'failure';
    return attemptSpan({
      traceId,
      // attempt 挂在 inference span 下，不是 root：聚合只能按 trace_id 关联。
      parentSpanId: inference.spanId,
      spanId: `${seed.id.toString(16)}${index.toString(16)}`.padStart(16, 'a'),
      startedAt: new Date(endedAt.getTime() - attempt.durationMs),
      endedAt,
      statusCode: failed ? 2 : 0,
      attributes: {
        'aio_proxy.attempt.index': index,
        'aio_proxy.provider.id': attempt.providerId,
        ...(failed ? { 'aio_proxy.termination.reason': 'failure' } : {}),
      },
    });
  });
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt, endedAt, attributes }), inference, ...attempts],
      summary:
        finalProviderId === undefined
          ? { terminationReason: 'failure' as const }
          : { finalProviderId, finalModelId: seed.requestedModelId },
    }),
  );
}

function withStore(run: (store: TraceStore) => void): void {
  const handle = openTestDb();
  try {
    run(createTraceStore(handle.db));
  } finally {
    handle.close();
  }
}

test('separates attempts from final ownership so a failed-over Provider keeps its failure rate', () => {
  withStore((store) => {
    // primary 两次全失败并 failover 给 fallback；fallback 两次都成功。
    seedTrace(store, {
      id: 1,
      requestedModelId: 'anthropic/claude-sonnet-4.5',
      attempts: [
        { providerId: 'primary', durationMs: 50, outcome: 'failure' },
        { providerId: 'fallback', durationMs: 80 },
      ],
    });
    seedTrace(store, {
      id: 2,
      requestedModelId: 'anthropic/claude-sonnet-4.5',
      attempts: [
        { providerId: 'primary', durationMs: 60, outcome: 'failure' },
        { providerId: 'fallback', durationMs: 90 },
      ],
    });

    const traffic = store.routingTraffic({ range: '24h', now: NOW });
    const model = traffic.models.find(({ modelId }) => modelId === 'anthropic/claude-sonnet-4.5');
    const byId = new Map(model?.providers.map((entry) => [entry.providerId, entry]));

    // 实际份额的分子只看谁最终承接：primary 一次都没承接。
    expect(byId.get('primary')).toMatchObject({ finalCount: '0', attemptCount: '2', successCount: '0' });
    expect(byId.get('fallback')).toMatchObject({ finalCount: '2', attemptCount: '2', successCount: '2' });
    expect(byId.get('primary')?.p95LatencyMs).toBeGreaterThan(0);
  });
});

test('reports a null p95 and omits traces whose window falls outside the range', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 3,
      requestedModelId: 'gpt-5-codex',
      attempts: [{ providerId: 'primary', durationMs: 10 }],
      endedAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
    });

    expect(store.routingTraffic({ range: '24h', now: NOW }).models).toEqual([]);
    expect(
      store.routingTraffic({ range: '7d', now: NOW }).models.find(({ modelId }) => modelId === 'gpt-5-codex'),
    ).toBeDefined();
  });
});

test('counts a root-only trace toward final ownership while leaving attempt metrics empty', () => {
  withStore((store) => {
    // 没有 attempt span 的 trace（异常但可能发生）：它确实被 primary 承接了，
    // 所以必须计入 finalCount，否则实际份额会被少算——而实际份额是这个页面的头号数字。
    // attemptCount / successCount 是 attempt 级指标，此时留空；p95 为 null 而非 0。
    // 由此 successCount 与 finalCount 在这一种情况下会不一致：消费端的成功率
    // 必须算 successCount / attemptCount，绝不能除以 finalCount。
    seedTrace(store, { id: 5, requestedModelId: 'gpt-5-codex', attempts: [], finalProviderId: 'primary' });

    const model = store
      .routingTraffic({ range: '24h', now: NOW })
      .models.find(({ modelId }) => modelId === 'gpt-5-codex');

    expect(model?.providers).toEqual([
      { providerId: 'primary', finalCount: '1', attemptCount: '0', successCount: '0', p95LatencyMs: null },
    ]);
  });
});

test('buckets one model densely by Provider', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 4,
      requestedModelId: 'anthropic/claude-sonnet-4.5',
      attempts: [{ providerId: 'fallback', durationMs: 30 }],
    });

    const buckets = store.routingTrafficBuckets({
      range: '24h',
      modelId: 'anthropic/claude-sonnet-4.5',
      now: NOW,
    });

    expect(buckets.bucketUnit).toBe('hour');
    expect(buckets.buckets).toHaveLength(24);
    expect(buckets.providerIds).toEqual(['fallback']);
    expect(buckets.buckets.some(({ values }) => values['fallback'] === '1')).toBe(true);
    // 空桶必须存在且为 0，否则图表会出现缺口。
    expect(buckets.buckets.every(({ values }) => typeof values['fallback'] === 'string')).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/core/src/db/trace-store/routing-traffic/`
Expected: FAIL —— `store.routingTraffic is not a function`。

---

- [ ] **Step 3: 实现聚合**

创建 `packages/core/src/db/trace-store/routing-traffic/routing-traffic.ts`：

```ts
import type { Database, SQLQueryBindings } from 'bun:sqlite';

import type {
  DashboardRoutingTrafficBucketsResponse,
  DashboardRoutingTrafficModel,
  DashboardRoutingTrafficProvider,
  DashboardRoutingTrafficResponse,
} from '@aio-proxy/types';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';

import type { RoutingTrafficBucketsQuery, RoutingTrafficQuery } from '../types';
import { type ResolvedUsageRange, resolveUsageRange, usageBucketKeys } from '../usage-range';

type IterableDatabase = BunSQLiteDatabase & { readonly $client: Database };

// token_count 探针 span 也带 attempt_index 与 provider_id，但它不是一次生成尝试；
// 计入会虚高尝试数并压低成功率。与 overview/diagnostics.ts 的同一条排除保持一致。
const SKIPPED_SPAN_NAME = 'aio_proxy.token_count.candidate_skipped';

type RawAttemptRow = {
  readonly modelId: string;
  readonly providerId: string;
  readonly attemptCount: string;
  readonly successCount: string;
  readonly durations: string;
};

type RawFinalRow = {
  readonly modelId: string;
  readonly providerId: string;
  readonly finalCount: string;
};

type RawBucketRow = {
  readonly bucket: string | number;
  readonly providerId: string;
  readonly finalCount: string;
};

type Accumulated = {
  finalCount: string;
  attemptCount: string;
  successCount: string;
  p95LatencyMs: number | null;
};

export function routingTraffic(db: BunSQLiteDatabase, query: RoutingTrafficQuery): DashboardRoutingTrafficResponse {
  const range = resolveUsageRange(query.range, query.now ?? new Date());
  const models = new Map<string, Map<string, Accumulated>>();

  for (const row of attemptRows(db, range)) {
    const accumulated = entry(models, row.modelId, row.providerId);
    accumulated.attemptCount = row.attemptCount;
    accumulated.successCount = row.successCount;
    accumulated.p95LatencyMs = percentile95(row.durations);
  }
  for (const row of finalRows(db, range)) {
    entry(models, row.modelId, row.providerId).finalCount = row.finalCount;
  }

  return {
    range: query.range,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    models: [...models]
      .map(([modelId, providers]): DashboardRoutingTrafficModel => ({
        modelId,
        providers: [...providers]
          .map(([providerId, value]): DashboardRoutingTrafficProvider => ({ providerId, ...value }))
          .sort((left, right) => left.providerId.localeCompare(right.providerId)),
      }))
      .sort((left, right) => left.modelId.localeCompare(right.modelId)),
  };
}

export function routingTrafficBuckets(
  db: BunSQLiteDatabase,
  query: RoutingTrafficBucketsQuery,
): DashboardRoutingTrafficBucketsResponse {
  const range = resolveUsageRange(query.range, query.now ?? new Date());
  const byBucket = new Map<string | number, Map<string, string>>();
  const providerIds = new Set<string>();

  for (const row of bucketRows(db, range, query.modelId)) {
    providerIds.add(row.providerId);
    const values = byBucket.get(row.bucket) ?? new Map<string, string>();
    values.set(row.providerId, row.finalCount);
    byBucket.set(row.bucket, values);
  }

  const ordered = [...providerIds].sort((left, right) => left.localeCompare(right));
  return {
    range: query.range,
    modelId: query.modelId,
    rangeStart: range.start.toISOString(),
    rangeEnd: range.end.toISOString(),
    bucketUnit: range.bucketUnit,
    providerIds: ordered,
    // 空桶补 '0'：缺键会让堆叠图出现缺口而不是一段零高度。
    buckets: usageBucketKeys(query.range, range.start, range.end).map(({ identity, key }) => ({
      key,
      values: Object.fromEntries(ordered.map((id) => [id, byBucket.get(identity)?.get(id) ?? '0'])),
    })),
  };
}

function entry(
  models: Map<string, Map<string, Accumulated>>,
  modelId: string,
  providerId: string,
): Accumulated {
  const providers = models.get(modelId) ?? new Map<string, Accumulated>();
  models.set(modelId, providers);
  const existing = providers.get(providerId);
  if (existing !== undefined) return existing;
  const created: Accumulated = { finalCount: '0', attemptCount: '0', successCount: '0', p95LatencyMs: null };
  providers.set(providerId, created);
  return created;
}

function percentile95(durations: string): number | null {
  const parsed = (JSON.parse(durations) as number[]).sort((left, right) => left - right);
  if (parsed.length === 0) return null;
  return parsed[Math.ceil(parsed.length * 0.95) - 1] ?? null;
}

function attemptRows(db: BunSQLiteDatabase, range: ResolvedUsageRange): RawAttemptRow[] {
  return all<RawAttemptRow>(
    db,
    // Drive from the root span and filter on ITS ended_at. Two reasons, both verified:
    // 1. Correctness — finalRows windows on the root's ended_at too, so both halves of a
    //    share comparison must use the same time basis or an edge trace lands in one and
    //    not the other.
    // 2. Plan — this is the only shape SQLite can narrow by time here. It uses the existing
    //    trace_span_root_ended_idx (parent_span_id=? AND ended_at>? AND ended_at<?).
    //    Filtering on attempt.ended_at instead yields no time predicate on the driving
    //    table at all, scanning the whole retention window.
    `select root.requested_model_id as modelId,
      attempt.provider_id as providerId,
      cast(count(*) as text) as attemptCount,
      cast(count(case when attempt.termination_reason is null then 1 end) as text) as successCount,
      json_group_array(max(0, attempt.ended_at - attempt.started_at)) as durations
    from trace_span root
      join trace_span attempt on attempt.trace_id = root.trace_id
        and attempt.attempt_index is not null
        and attempt.provider_id is not null
        and attempt.name != ?
    where root.parent_span_id is null
      and root.ended_at >= ? and root.ended_at <= ?
      and root.requested_model_id is not null
    group by root.requested_model_id, attempt.provider_id`,
    [SKIPPED_SPAN_NAME, range.start.getTime(), range.end.getTime()],
  );
}

function finalRows(db: BunSQLiteDatabase, range: ResolvedUsageRange): RawFinalRow[] {
  return all<RawFinalRow>(
    db,
    `select requested_model_id as modelId,
      final_provider_id as providerId,
      cast(count(*) as text) as finalCount
    from trace_span
    where parent_span_id is null
      and requested_model_id is not null
      and final_provider_id is not null
      and ended_at >= ? and ended_at <= ?
    group by requested_model_id, final_provider_id`,
    [range.start.getTime(), range.end.getTime()],
  );
}

function bucketRows(db: BunSQLiteDatabase, range: ResolvedUsageRange, modelId: string): RawBucketRow[] {
  const bucket =
    range.bucketUnit === 'hour'
      ? `min(23, cast((ended_at - ${range.start.getTime()}) / 3600000 as integer))`
      : `strftime('%Y-%m-%d', ended_at / 1000, 'unixepoch', 'localtime')`;
  return all<RawBucketRow>(
    db,
    `select ${bucket} as bucket,
      final_provider_id as providerId,
      cast(count(*) as text) as finalCount
    from trace_span
    where parent_span_id is null
      and requested_model_id = ?
      and final_provider_id is not null
      and ended_at >= ? and ended_at <= ?
    group by bucket, final_provider_id`,
    [modelId, range.start.getTime(), range.end.getTime()],
  );
}

function all<T>(db: BunSQLiteDatabase, sql: string, params: readonly SQLQueryBindings[]): T[] {
  return (db as IterableDatabase).$client.query<T, SQLQueryBindings[]>(sql).all(...params);
}
```

`usageLocalDate` 不在本文件使用（分桶表达式直接写 SQL 的 `strftime`），所以不要导入它。

创建 `packages/core/src/db/trace-store/routing-traffic/index.ts`：

```ts
export * from './routing-traffic';
```

- [ ] **Step 4: 接线到 TraceStore**

在 `packages/core/src/db/trace-store/types.ts` 中，`ProviderWindowCostQuery` 之后加查询类型：

```ts
export type RoutingTrafficQuery = {
  readonly range: UsageOverviewRange;
  readonly now?: Date;
};

export type RoutingTrafficBucketsQuery = RoutingTrafficQuery & {
  readonly modelId: string;
};
```

并在 `TraceStore` 的 `providerWindowCost` 之后加两个方法：

```ts
  readonly routingTraffic: (query: RoutingTrafficQuery) => DashboardRoutingTrafficResponse;
  readonly routingTrafficBuckets: (query: RoutingTrafficBucketsQuery) => DashboardRoutingTrafficBucketsResponse;
```

`types.ts` 顶部的 `@aio-proxy/types` import 需要补 `DashboardRoutingTrafficBucketsResponse`、`DashboardRoutingTrafficResponse`、`UsageOverviewRange`（`UsageOverviewRange` 若已因 `UsageOverviewQuery` 导入则无需重复）。

在 `packages/core/src/db/trace-store/trace-store.ts` 中加导入并在返回对象里接线：

```ts
import { routingTraffic, routingTrafficBuckets } from './routing-traffic';
```

```ts
    routingTraffic: (query) => routingTraffic(db, query),
    routingTrafficBuckets: (query) => routingTrafficBuckets(db, query),
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun test packages/core/src/db/trace-store/routing-traffic/ packages/core/src/db/trace-store/trace-store.test.ts`
Expected: PASS。三个新 test 全绿，既有 `trace-store.test.ts` 不受影响。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/db/trace-store/routing-traffic packages/core/src/db/trace-store/types.ts packages/core/src/db/trace-store/trace-store.ts
git commit -m "feat(core): aggregate routing traffic by model and Provider"
```

---

### Task 6: 服务端派生 catalog 事实

**Files:**
- Create: `packages/server/src/model-routing/catalog-facts.ts`
- Create: `packages/server/src/model-routing/catalog-facts.test.ts`
- Modify: `packages/server/src/model-routing/inventory.ts`（`WritableModel` 加字段、`assembleRoutingInventory` 取值、`finalizeModel` 输出）

**Interfaces:**
- Consumes: Task 1 的 `DashboardRoutingCatalog`；`lookupCachedModel`（`@aio-proxy/core` 已导出，见 `packages/core/src/index.ts:225`）
- Produces: `routingCatalogFacts(modelId: string): Promise<DashboardRoutingCatalog | undefined>`。Task 1 的字段由此填充。

**为什么单独成文件：** `inventory.ts` 已 280 行，CLAUDE.md 要求 400 行即评估拆分。

`lookupCachedModel` 返回 `{ slug, metadata }`，`slug` 形如 `openai/gpt-5`——**前缀即 lab**；`metadata` 由 `catalogModelToMetadata()` 产出，已含 `releaseDate`。一次调用拿到两个字段。冷缓存时返回 `undefined`，这是正常状态。

- [ ] **Step 1: 写失败测试**

创建 `packages/server/src/model-routing/catalog-facts.test.ts`：

```ts
import { afterEach, expect, test } from 'bun:test';

import { clearModelsDevCatalog, modelsDevModel, seedModelsDevCatalog } from '../../../__tests__/server.test-support';
import { routingCatalogFacts } from './catalog-facts';

afterEach(() => {
  clearModelsDevCatalog();
});

test('derives the lab from the catalog slug prefix and carries the release date', async () => {
  await seedModelsDevCatalog({ 'gpt-5': modelsDevModel('gpt-5', 'GPT-5', { release_date: '2026-06-01' }) });

  // slug 是 `openai/gpt-5`；lab 取前缀。models.dev 内部称其为 providerId，
  // 但本仓库 Provider ID 专指上游 provider，两者不可混名。
  expect(await routingCatalogFacts('gpt-5')).toEqual({ lab: 'openai', releaseDate: '2026-06-01' });
});

test('returns undefined for an unknown model so a cold catalog is not an error', async () => {
  await seedModelsDevCatalog({ 'gpt-5': modelsDevModel('gpt-5', 'GPT-5') });

  expect(await routingCatalogFacts('not-in-catalog')).toBeUndefined();
});

test('omits releaseDate entirely when the catalog entry has none', async () => {
  // modelsDevModel 默认带 release_date: '2026-01-15'，必须显式清掉才能测到缺失分支。
  await seedModelsDevCatalog({ 'gpt-5': modelsDevModel('gpt-5', 'GPT-5', { release_date: undefined }) });

  expect(await routingCatalogFacts('gpt-5')).toEqual({ lab: 'openai' });
});
```

导入路径已核对：`server.test-support.ts` 在 `packages/server/__tests__/`（与 `src/` 同级），从 `src/model-routing/` 出发是 `../../../__tests__/server.test-support`。

`modelsDevModel` 的 `overrides` 是 `Partial<ModelsDevModel>`，`release_date` 直接透传，**helper 无需修改**。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/server/src/model-routing/catalog-facts.test.ts`
Expected: FAIL —— `Cannot find module './catalog-facts'`。

- [ ] **Step 3: 实现**

创建 `packages/server/src/model-routing/catalog-facts.ts`：

```ts
import { lookupCachedModel } from '@aio-proxy/core';
import type { DashboardRoutingCatalog } from '@aio-proxy/types';

/** models.dev 目录派生的客观事实。
 *
 * `lab` 是模型厂商（openai、anthropic），取自 catalog slug 的前缀。models.dev 内部
 * 把这个前缀称作 providerId，但本仓库 Provider ID 专指上游 provider，两者必须不同名。
 *
 * 仅读缓存，绝不发网络请求：冷缓存返回 undefined，调用方据此降级而非报错。 */
export async function routingCatalogFacts(modelId: string): Promise<DashboardRoutingCatalog | undefined> {
  const entry = await lookupCachedModel(modelId);
  if (entry === undefined) return undefined;
  const lab = entry.slug.split('/')[0];
  if (lab === undefined || lab === '') return undefined;
  const releaseDate = entry.metadata.releaseDate;
  return { lab, ...(releaseDate === undefined ? {} : { releaseDate }) };
}
```

在 `packages/server/src/model-routing/inventory.ts` 中：

1. 加导入：

```ts
import { routingCatalogFacts } from './catalog-facts';
```

2. `@aio-proxy/types` 的 type import 补 `DashboardRoutingCatalog`。

3. `WritableModel` 加字段（第 275 行起）：

```ts
type WritableModel = {
  modelId: string;
  revision: string;
  rawMetadata: unknown;
  catalog?: DashboardRoutingCatalog;
  providers: DashboardRoutingProvider[];
};
```

4. 在 `assembleRoutingInventory` 的 `return` 之前、两个填充循环之后，补一轮 catalog 解析：

```ts
  // catalog 事实只读 models.dev 缓存，冷缓存时留空而不是失败。
  for (const model of models.values()) {
    model.catalog = await routingCatalogFacts(model.modelId);
  }
```

5. 在 `finalizeModel` 的返回对象里，`metadata` 之后加：

```ts
    ...(model.catalog === undefined ? {} : { catalog: model.catalog }),
```

注意 `finalizeModel` 的签名保持同步，catalog 已在第 4 步预解析好。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/server/src/model-routing/`
Expected: PASS。新测试绿，既有 `inventory` 相关测试不受影响。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/model-routing/catalog-facts.ts packages/server/src/model-routing/catalog-facts.test.ts packages/server/src/model-routing/inventory.ts
git commit -m "feat(server): expose models.dev lab and release date on routing models"
```

---

### Task 7: 两个流量端点

**Files:**
- Modify: `packages/server/src/dashboard-routes/routing/routing.ts`
- Test: `packages/server/src/dashboard-routes/routing/routing.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `state.traceStore.routingTraffic` / `routingTrafficBuckets`；`UsageOverviewRangeSchema`
- Produces: `GET /routing/traffic?range=` 与 `GET /routing/traffic/buckets?range=&model=`。dashboard 的 service 层消费。

**model id 走查询参数。** `?model=` 而非路径段：model id 可含斜杠，路径段会被反向代理与路由器切开。`%2F` 编码同样不可用——代理层常把它还原成真斜杠。

验证器沿用 `packages/server/src/dashboard-routes/overview/overview.ts` 的写法（`validator('query', ...)` + Zod `safeParse` + 400）。

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/dashboard-routes/routing/routing.test.ts` 末尾追加：

```ts
test('GET /routing/traffic validates range and rejects ranges beyond span retention', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-routing-traffic-'));
  const state = await createServerState({ config: ConfigSchema.parse({ providers: {} }), dbHome: dir });

  try {
    const routes = createDashboardRoutes(state, disabledDashboardAuthentication);

    const ok = await routes.request('/routing/traffic?range=24h');
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ range: '24h', models: [] });

    // trace_span 保留 45 天，90d 不在支持范围内。
    expect((await routes.request('/routing/traffic?range=90d')).status).toBe(400);
    expect((await routes.request('/routing/traffic')).status).toBe(400);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET /routing/traffic/buckets takes the model id as a query parameter so slashes survive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-routing-buckets-'));
  const state = await createServerState({ config: ConfigSchema.parse({ providers: {} }), dbHome: dir });

  try {
    const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
    const modelId = 'anthropic/claude-sonnet-4.5';

    const response = await routes.request(
      `/routing/traffic/buckets?range=24h&model=${encodeURIComponent(modelId)}`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ modelId, bucketUnit: 'hour', providerIds: [] });
    expect((await routes.request('/routing/traffic/buckets?range=24h')).status).toBe(400);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

若文件顶部还没有 `mkdtempSync` / `rmSync` / `tmpdir` / `join` / `ConfigSchema` / `createServerState` / `createDashboardRoutes` / `disabledDashboardAuthentication` 的导入，按同目录既有测试（或 `packages/server/src/dashboard-routes/models-dev-lookup.test.ts`）的导入方式补齐。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun test packages/server/src/dashboard-routes/routing/routing.test.ts`
Expected: FAIL —— 两个新 test 拿到 404，因为路由还不存在。

- [ ] **Step 3: 实现**

在 `packages/server/src/dashboard-routes/routing/routing.ts` 顶部补导入：

```ts
import { UsageOverviewRangeSchema } from '@aio-proxy/types';
import { z } from 'zod';
```

在 `routingMutationValidator` 之后加两个验证器：

```ts
const RoutingTrafficQuerySchema = z.object({ range: UsageOverviewRangeSchema });

// model id 可含斜杠，所以它是查询参数而不是路径段。
const RoutingTrafficBucketsQuerySchema = RoutingTrafficQuerySchema.extend({ model: z.string().min(1) });

const trafficValidator = validator('query', (raw, context) => {
  const parsed = RoutingTrafficQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation_failed' } as const, 400);
});

const trafficBucketsValidator = validator('query', (raw, context) => {
  const parsed = RoutingTrafficBucketsQuerySchema.safeParse(raw);
  return parsed.success ? parsed.data : context.json({ error: 'validation_failed' } as const, 400);
});
```

在 `createDashboardRoutingRoutes` 的链上，`.put('/routing/models', ...)` 之后加两个 route（两者都是字面路径，顺序不影响匹配）：

```ts
    .get('/routing/traffic/buckets', trafficBucketsValidator, (context) => {
      const { range, model } = context.req.valid('query');
      return context.json(state.traceStore.routingTrafficBuckets({ range, modelId: model }));
    })
    .get('/routing/traffic', trafficValidator, (context) =>
      context.json(state.traceStore.routingTraffic(context.req.valid('query'))),
    )
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun test packages/server/src/dashboard-routes/routing/`
Expected: PASS，两个新 test 绿，既有 routing 路由测试不受影响。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/dashboard-routes/routing/routing.ts packages/server/src/dashboard-routes/routing/routing.test.ts
git commit -m "feat(server): serve routing traffic totals and buckets"
```

---

### Task 8: 全量验证

**Files:** 无新增改动，只跑门禁。

**Interfaces:**
- Consumes: Task 1–7 的全部产出
- Produces: 一棵通过 `preflight` 的树，dashboard 计划可以在此之上开工。

**没有 changeset。** 这份计划本身不产生用户可见变化——端点存在但无人调用。按 CLAUDE.md，release note 描述的是「已发布状态」，而本 PR 的已发布状态包含 dashboard 重做；现在写一份就必然在 dashboard 计划里重写它。changeset 在 dashboard 计划的最后一个任务里一次写成。

- [ ] **Step 1: 构建（`lint:types` 依赖各包 dist 解析跨包类型）**

Run: `bun run build`
Expected: 成功。`@aio-proxy/types`、`@aio-proxy/core`、`@aio-proxy/server` 全部产出 `dist`。

- [ ] **Step 2: 类型感知 lint**

Run: `bun run lint:types`
Expected: 无错误。若报 `routingCatalogFacts` 返回值可能为 `undefined` 之类的收窄问题，在调用处补显式判断而不是加断言。

- [ ] **Step 3: 格式检查**

Run: `bun run format:check`
Expected: 无差异。有差异就跑 `bun run format` 并把结果并入最近一次提交。

- [ ] **Step 4: 全量测试**

Run: `bun run test`
Expected: 全绿。特别确认这三处：
- `packages/core/src/db/migrations/migrations.test.ts` —— manifest 与 journal 一致。
- `packages/core/src/db/trace-store/usage-overview/` —— Task 4 重构的安全网。
- `packages/types/src/dashboard/routing/` —— 两个 DTO 文件。

- [ ] **Step 5: 若第 3 步产生了改动则提交**

```bash
git add -A
git commit -m "style: apply oxfmt to routing data layer"
```

---

## 后续

dashboard 侧是独立的第二份计划，与本计划落在**同一个 PR**：列表页重做（健康概览条、lab 分组标题行、双层份额条、URL 筛选）、splat 详情路由 `routes/routing/$.tsx`、四个 tab、未保存守卫，以及删除 `RoutingEditorDrawer`。它消费本计划产出的 `DashboardRoutingModel.catalog` 与两个 traffic 端点。









