# Routing 重新设计 · 详情页实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `RoutingEditorDrawer` 挤在 36rem 滚动列里的三件事搬进一个全宽的独立路由页，并让权重决策与实际流量数据相邻；同时删掉抽屉。

**Architecture:** 新增 splat 路由 `routes/routing/$.tsx`（model id 含斜杠，普通路径参数匹配不了），模板 `templates/routing-model-page.tsx` 用四个 tab 承载拓扑 / 元数据 / 成本限额 / 流量。两个既有 form hook 的分离**必须保留**，但脏状态与保存按钮提升到页面级，并用 `useBlocker` 拦住带脏状态的导航。

**Tech Stack:** React · TanStack Router / Query / Form · shadcn（Base UI）· recharts · `@aio-proxy/i18n` · rstest

## Global Constraints

- **代码注释一律写英文。** 本计划代码块里的中文注释是意图说明，落地时用英文写出同样的理由。
- 所有命令从仓库根目录运行。dashboard 测试跑 `bun run --filter @aio-proxy/dashboard test`。
- **不要编字面值。** 下面「已核实的事实」一节里的每一条都实测过。其余引用若与源码不符，**停下来报告**，不要猜 —— 前两份计划合计有 11 处字面值出错的记录。
- 遵守 `packages/dashboard/AGENTS.md`：六个模块桶、每个 `.tsx` 一个组件、`React.FC<XProps>` + `interface XProps`、文件名 kebab-case 对应组件名。
- 用户可见文案全部走 i18n，新键加到 `packages/i18n/messages/*.json`（五个语言文件），改完跑 `bun run i18n:compile`。
- 每个 input/select/checkbox/textarea 必须走 TanStack Form（AGENTS.md）。本计划不新增表单字段，只搬运既有的。
- 手写非测试文件 500 行上限，400 行即评估拆分。抽屉原本 210 行，拆成页面 + 四个 tab 后每个文件都应远低于此。
- 完成前跑 `bun run preflight`。

## 已核实的事实（实测，不是推测）

| 事实 | 如何确认的 |
|---|---|
| `$.tsx` splat 路由被支持 | 建了 `routes/routing/$.tsx` 跑 `bun run build`，生成器产出 `RoutingSplatRoute`，`path: '/routing/$'`。已还原探针。 |
| `Route.useParams()._splat` 类型是 `string \| undefined` | 同一个探针里写 `const r: string = params._splat ?? ''`，`bun run lint:types` exit 0。 |
| `useBlocker` 可用 | `@tanstack/react-router@1.170.32` 的 `dist/esm/useBlocker.d.ts` 存在。 |
| shadcn `Tabs` 与 `Chart` 可用 | `packages/ui/src/components/tabs.tsx`、`chart.tsx` 都在。 |
| 图表用 recharts | `usage-trend-chart.tsx` 从 `@aio-proxy/ui/components/chart` 取容器，从 `recharts` 取 `Area`/`AreaChart`/`XAxis` 等。 |
| `useRoutingForm(model, onSubmit)` | `model: DashboardRoutingModel \| null`，`onSubmit: (value: RoutingFormValues) => void`。 |
| `useRoutingMetadataForm(model)` | 单参 `model: DashboardRoutingModel \| null`。 |
| `RoutingBoard` props | `{ form: ReturnType<typeof useRoutingForm>; model: DashboardRoutingModel; writable: boolean }` |
| `ModelMetadataEditor` props | `{ model: string; value; onChange; onValidityChange }` |
| `RoutingProviderOverrideFields` props | `{ providerId: string; value: { cost; limit }; onChange }` |
| 抽屉用到的 lib | `mergeRoutingMutationDrafts` · `reconcileRoutingMetadataValues` · `routingOverrideDraftsValid`（`../lib/routing-metadata-draft`）、`explicitRoutingOverrides`（`../lib/routing-summary`）、`reconcileRoutingFormRows` · `routingDraftRecord`（`../hooks/use-routing-form`）、`isStaleRoutingError`（`../services/routing-service`） |

**未能静态确认，必须靠测试钉住：** 含斜杠的 model id 在运行时真的能通过 splat 往返。`parsePathname` 不是公开导出，所以 Task 1 用一次真实渲染来验证，而不是假设。

## 前置依赖

本计划消费**列表页计划**的产出：`lib/routing-traffic/`（`tierActualShares` / `modelTrafficSummary`）、`lib/routing-risk/`、`services/routing-traffic-service.ts`（totals）。列表页计划必须先完成。

## File Structure

| 文件 | 职责 |
|---|---|
| `routes/routing/$.tsx`（新） | splat 路由，读 `_splat`，渲染模板 |
| `templates/routing-model-page.tsx`（新） | 页面装配：header、range、四个 tab、页面级保存 |
| `hooks/use-routing-model-editor.ts`（新） | 两个 form + mutation + 脏状态合并 + 未保存守卫 |
| `components/routing-model-topology-tab.tsx`（新） | `WeightedTierBoard` 全宽 + 每张卡的实际数字 |
| `components/routing-model-metadata-tab.tsx`（新） | 搬运 `ModelMetadataEditor` + catalog 对照 |
| `components/routing-model-cost-tab.tsx`（新） | provider × 字段的表格 |
| `components/routing-model-traffic-tab.tsx`（新） | 堆叠趋势 + 汇总表 + 跳 Traces |
| `services/routing-traffic-service.ts`（改） | 增加 buckets queryOptions |
| `components/routing-table-columns.tsx`（改） | 操作列改为跳详情页 |
| `components/routing-editor-drawer.tsx`（删） | 行为已迁移 |
| `components/routing-editor-drawer.test.tsx`（删） | 测试迁移到新页面 |

---

### Task 1: splat 路由与含斜杠的 model id

**Files:**
- Create: `packages/dashboard/src/routes/routing/$.tsx`
- Create: `packages/dashboard/src/modules/routing/templates/routing-model-page.tsx`（本任务只放最小骨架）
- Create: `packages/dashboard/src/modules/routing/templates/routing-model-page.test.tsx`
- Generated: `packages/dashboard/src/route-tree.gen.ts`（由 `tanstackRouter` 插件重写，**不要手改**）

**Interfaces:**
- Consumes: 无。
- Produces: 路由 `/routing/$`；`RoutingModelPage`，props `{ modelId: string }`。后续任务往这个模板里填内容。

**为什么必须是 splat：** `IdSchema = z.string().min(1)`，model id 是任意非空字符串，而 OpenRouter 风格的 id 字面就是 `anthropic/claude-sonnet-4.5`。普通路径参数 `$modelId` 只匹配单段，会匹配失败。`%2F` 方案也不行 —— 反向代理常把它还原成真斜杠。

**这个仓库此前没有任何 splat 路由**，所以本任务的第一个测试就是证明它真的工作，而不是假设。

- [ ] **Step 1: 写失败测试**

创建 `routing-model-page.test.tsx`。用真实 router 渲染，而不是 mock `useParams` —— 本任务要验证的恰恰是 router 的行为：

```tsx
import { expect, test } from '@rstest/core';
import { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';

import { RoutingModelPage } from './routing-model-page';

const renderAt = (pathname: string) => {
  const rootRoute = createRootRoute();
  const splatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/routing/$',
    component: () => <RoutingModelPage modelId={splatRoute.useParams()._splat ?? ''} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([splatRoute]),
    history: createMemoryHistory({ initialEntries: [pathname] }),
  });
  render(<RouterProvider router={router} />);
};

test('resolves a model id that contains slashes', async () => {
  // The whole reason this route is a splat: real model ids look like this.
  renderAt('/routing/anthropic/claude-sonnet-4.5');

  expect(await screen.findByText('anthropic/claude-sonnet-4.5')).toBeInTheDocument();
});

test('resolves a single-segment model id too', async () => {
  renderAt('/routing/gpt-5-codex');

  expect(await screen.findByText('gpt-5-codex')).toBeInTheDocument();
});

test('resolves an id with more than two segments', async () => {
  // models.dev routes an OpenRouter model as openrouter/<vendor>/<model>; a proxied id can
  // carry the same shape, so the splat must not stop at the second slash.
  renderAt('/routing/openrouter/mistralai/mistral-large');

  expect(await screen.findByText('openrouter/mistralai/mistral-large')).toBeInTheDocument();
});
```

若 `@tanstack/react-router` 的这几个测试用构造器名与实际不符（`createRootRoute` / `createRoute` / `createRouter` / `createMemoryHistory` / `RouterProvider`），**停下来报告**，不要换成 mock `useParams` —— 那样测试就不再验证 router 了，本任务也就失去意义。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/templates/routing-model-page`
Expected: FAIL —— `Cannot find module './routing-model-page'`。

- [ ] **Step 3: 实现最小骨架**

创建 `routing-model-page.tsx`：

```tsx
import { PageContainer } from '@/components/page-container';

interface RoutingModelPageProps {
  readonly modelId: string;
}

export const RoutingModelPage: React.FC<RoutingModelPageProps> = ({ modelId }) => (
  <PageContainer
    title={<span className="font-mono">{modelId}</span>}
    breadcrumbs={[
      { label: m['dashboard.menus.configuration']() },
      { label: m['dashboard.routing.title'](), to: '/routing' },
      { label: modelId },
    ]}
  >
    {null}
  </PageContainer>
);
```

`PageContainer` 的 props 已核实为 `{ title?, subtitle?, extra?, breadcrumbs, classNames? }`。**面包屑项是否支持 `to`** 未核实 —— 先看 `BreadcrumbItems` 的类型，若不支持链接就只放纯文本 label，并在报告里说明。

创建 `routes/routing/$.tsx`：

```tsx
import { createFileRoute } from '@tanstack/react-router';

import { RoutingModelPage } from '@/modules/routing/templates/routing-model-page';

const RoutingModelRoute: React.FC = () => {
  // A model id can contain slashes, so this is a splat route: `_splat` carries every
  // remaining segment joined, which is exactly the id.
  const { _splat } = Route.useParams();
  return <RoutingModelPage modelId={_splat ?? ''} />;
};

export const Route = createFileRoute('/routing/$')({ component: RoutingModelRoute });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/templates/routing-model-page`
Expected: PASS，3 个 test 全绿。

- [ ] **Step 5: 确认生成的路由树**

Run: `bun run --filter @aio-proxy/dashboard build`
Expected: 成功，且 `src/route-tree.gen.ts` 里出现 `RoutingSplatRoute` 与 `path: '/routing/$'`。把生成的文件一起提交。

- [ ] **Step 6: 提交**

```bash
git add packages/dashboard/src/routes/routing packages/dashboard/src/route-tree.gen.ts packages/dashboard/src/modules/routing/templates/routing-model-page.tsx packages/dashboard/src/modules/routing/templates/routing-model-page.test.tsx
git commit -m "feat(dashboard): route model detail through a splat so slashes survive"
```

---

### Task 2: 编辑器 hook —— 两个 form、合并脏状态、未保存守卫

**Files:**
- Create: `packages/dashboard/src/modules/routing/hooks/use-routing-model-editor.ts`
- Create: `packages/dashboard/src/modules/routing/hooks/use-routing-model-editor.test.tsx`

**Interfaces:**
- Consumes: `useRoutingForm(model, onSubmit)`、`useRoutingMetadataForm(model)`、`useRoutingMutation()`、`mergeRoutingMutationDrafts`、`reconcileRoutingMetadataValues`、`routingOverrideDraftsValid`、`explicitRoutingOverrides`、`reconcileRoutingFormRows`、`routingDraftRecord`、`isStaleRoutingError`（位置见「已核实的事实」表）。
- Produces: `useRoutingModelEditor({ model, writable, onReload })`，返回 `{ form, metadataForm, dirtyTabs, canSave, save, stale, reload, saveFailed, metadataValid, setMetadataValid }`。Task 3–6 的 tab 与 Task 7 的页面消费。

**必须保留的既有设计：** 拓扑用 `useRoutingForm`（只含 priority/weight），元数据与 cost/limit 用 `useRoutingMetadataForm`。源码注释写明这个分离是**故意的** —— 防止拖拽或份额变更误删抽屉里的数据。本计划**不合并这两个 form**，只在它们之上加一层脏状态汇总。

**两个抽屉时代不存在的新问题：**
1. **未保存守卫。** 关抽屉是明确动作，路由跳转不是。用 `useBlocker`（已确认可用）在有脏状态时拦住导航，否则点面包屑会静默丢草稿。
2. **脏标记要打在 tab 上。** 保存是**页面级**的（一次 PUT 提交整个模型，现有 mutation 即如此），所以用户必须能看见「切走的那个 tab 里有未保存改动」。

- [ ] **Step 1: 写失败测试**

创建 `use-routing-model-editor.test.tsx`。用 `@testing-library/react` 的 `renderHook`；mutation 与 router 按该模块既有测试的 mock 风格处理：

```tsx
test('reports which tab is dirty rather than one global flag', () => {
  // The save button is page-level, so the user must be able to see that a tab they
  // navigated away from still holds an unsaved change.
  const { result } = renderEditor();

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));

  expect(result.current.dirtyTabs).toEqual(['topology']);
});

test('tracks the metadata form separately from the topology form', () => {
  const { result } = renderEditor();

  act(() => result.current.metadataForm.setFieldValue('metadata', { touched: true, value: { name: 'x' } }));

  expect(result.current.dirtyTabs).toEqual(['metadata']);
});

test('blocks navigation while any tab is dirty and allows it when clean', () => {
  const { result } = renderEditor();
  expect(blockerEnabledFor(result)).toBe(false);

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));

  expect(blockerEnabledFor(result)).toBe(true);
});

test('refuses to save while the metadata draft is invalid', () => {
  // Saving over an invalid draft would silently persist the last valid value and discard
  // what the user can see.
  const { result } = renderEditor();

  act(() => result.current.setMetadataValid(false));

  expect(result.current.canSave).toBe(false);
});

test('refuses to save when the config is read-only', () => {
  const { result } = renderEditor({ writable: false });

  expect(result.current.canSave).toBe(false);
});

test('submits one mutation carrying both forms', () => {
  const { result, mutate } = renderEditor();

  act(() => result.current.form.setFieldValue('providers[0].weight', 3));
  act(() => void result.current.save());

  // One PUT for the whole model — there is no per-tab save.
  expect(mutate).toHaveBeenCalledTimes(1);
  expect(mutate.mock.calls[0]?.[0]).toMatchObject({ modelId: 'sonnet', revision: 'rev-1' });
});

test('surfaces a stale revision as a reloadable state rather than a generic failure', () => {
  const { result, rejectWithStale } = renderEditor();

  act(() => void result.current.save());
  act(() => rejectWithStale());

  expect(result.current.stale).toBe(true);
  expect(result.current.saveFailed).toBe(false);
});
```

`renderEditor` / `blockerEnabledFor` / `rejectWithStale` 是本文件的局部 helper，按该模块既有测试的 mock 方式实现。若 `useBlocker` 无法在 `renderHook` 下被观测，**改为断言传给它的 `shouldBlockFn`/`condition` 的入参**，并在报告里说明你观测的是什么 —— 不要把这个测试降级成「只测脏状态」。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/hooks/use-routing-model-editor`
Expected: FAIL —— `Cannot find module './use-routing-model-editor'`。

- [ ] **Step 3: 实现**

`use-routing-model-editor.ts` 的职责边界：

- 建两个 form，**签名照已核实的**：`useRoutingForm(model, (value) => { ... })`、`useRoutingMetadataForm(model)`。
- `onSubmit` 里复用抽屉原有的提交体构造，一字不改地搬过来：
  ```ts
  mutation.mutate({
    modelId: model.modelId,
    revision: model.revision,
    baselineProviderIds: model.baselineProviderIds,
    ...mergeRoutingMutationDrafts(explicitRoutingOverrides(routingDraftRecord(value.providers)), metadataForm.state.values),
  }, { onSuccess: ..., onError: (error) => { if (isStaleRoutingError(error)) setStale(true); } });
  ```
- `dirtyTabs`：`'topology'` 来自 `form.state.isDirty`，`'metadata'` 与 `'cost'` 来自 `metadataForm` 里对应字段的 `touched`。**`metadata` 与 `cost` 共用一个 form，所以要按字段区分**，不能整体标脏 —— 否则改了成本会把元数据 tab 也标成脏的。
- `canSave`：`writable && form.canSubmit && !mutation.isPending && metadataValid && routingOverrideDraftsValid(metadataForm.state.values.overrides)`。
- `useBlocker`：`condition`/`shouldBlockFn` 取 `dirtyTabs.length > 0`。**先看 `useBlocker` 在 1.170.32 的实际入参名**（`dist/esm/useBlocker.d.ts`），按它写，不要照别的版本的 API 猜。
- `reload`：搬抽屉的 `reloadEditor`，含它的 generation 防竞态逻辑（`reloadGeneration`）—— 那段防的是「重载返回时用户已切到别的模型」，在独立路由页依然可能发生。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/hooks/use-routing-model-editor`
Expected: PASS，7 个 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/hooks/use-routing-model-editor.ts packages/dashboard/src/modules/routing/hooks/use-routing-model-editor.test.tsx
git commit -m "feat(dashboard): merge routing editor dirty state and guard navigation"
```

---

### Task 3: buckets 查询

**Files:**
- Modify: `packages/dashboard/src/modules/routing/services/routing-traffic-service.ts`
- Modify: `packages/dashboard/src/modules/routing/services/routing-traffic-service.test.ts`
- Modify: `packages/dashboard/src/lib/query-keys.ts`

**Interfaces:**
- Consumes: 列表页计划已建的 `routing-traffic-service.ts`。
- Produces: `routingTrafficBucketsQueryOptions(range, modelId)`、`decodeRoutingTrafficBuckets(wire)`、`RoutingTrafficBucketsData`。Task 6 消费。

**已核实：** 客户端路径是 `dashboardClient.dashboard.api.routing.traffic.buckets.$get({ query: { range, model } })`。**查询参数叫 `model`，store 的参数叫 `modelId`** —— 在这里做映射。

**`key` 是完整 ISO 时刻**（day 分桶时为本地午夜），不是天粒度日期串。图表 X 轴按这个格式化，别当成 `YYYY-MM-DD`。

- [ ] **Step 1: 写失败测试**

在 `routing-traffic-service.test.ts` 追加：

```ts
const bucketsWire = {
  range: '7d' as const,
  modelId: 'anthropic/claude-sonnet-4.5',
  rangeStart: '2026-09-19T00:00:00.000Z',
  rangeEnd: '2026-09-26T08:00:00.000Z',
  bucketUnit: 'day' as const,
  providerIds: ['primary', 'fallback'],
  buckets: [
    { key: '2026-09-19T00:00:00.000Z', values: { primary: '10', fallback: '0' } },
    { key: '2026-09-20T00:00:00.000Z', values: { primary: '9007199254740993', fallback: '1' } },
  ],
};

test('decodes bucket counts to bigint and keeps the ISO key untouched', () => {
  const decoded = decodeRoutingTrafficBuckets(bucketsWire);

  expect(decoded.buckets[1]?.values['primary']).toBe(9_007_199_254_740_993n);
  // A day bucket's key is local midnight as a full instant, not a date-only string.
  expect(decoded.buckets[0]?.key).toBe('2026-09-19T00:00:00.000Z');
});

test('keeps an explicit zero bucket rather than dropping it', () => {
  // A dropped key would leave a gap in the stacked chart instead of a zero-height band.
  expect(decodeRoutingTrafficBuckets(bucketsWire).buckets[0]?.values['fallback']).toBe(0n);
});

test('carries the provider series order through for stable stacking', () => {
  expect(decodeRoutingTrafficBuckets(bucketsWire).providerIds).toEqual(['primary', 'fallback']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/services/routing-traffic-service`
Expected: FAIL —— `decodeRoutingTrafficBuckets` 不是导出。

- [ ] **Step 3: 实现**

`query-keys.ts` 在 `routingTraffic` 之后加：

```ts
  routingTrafficBuckets: (range: string, modelId: string) => ['routing', 'traffic', 'buckets', range, modelId],
```

`routing-traffic-service.ts` 追加：

```ts
type RoutingTrafficBucketsWire = InferResponseType<
  typeof dashboardClient.dashboard.api.routing.traffic.buckets.$get,
  200
>;

/** Bucket counts are decimal strings for the same reason the totals are. `key` is passed through
 * verbatim: it is a full ISO instant, local midnight for a day bucket, and the chart formats it. */
export const decodeRoutingTrafficBuckets = (wire: RoutingTrafficBucketsWire) => ({
  ...wire,
  buckets: wire.buckets.map((bucket) => ({
    key: bucket.key,
    values: Object.fromEntries(Object.entries(bucket.values).map(([id, count]) => [id, BigInt(count)])),
  })),
});

export type RoutingTrafficBucketsData = ReturnType<typeof decodeRoutingTrafficBuckets>;

export const routingTrafficBucketsQueryOptions = (range: UsageOverviewRange, modelId: string) =>
  queryOptions({
    queryKey: queryKeys.routingTrafficBuckets(range, modelId),
    queryFn: async (): Promise<RoutingTrafficBucketsData> => {
      // The HTTP parameter is `model`; a model id never travels in a path segment because it
      // can contain slashes.
      const response = await dashboardClient.dashboard.api.routing.traffic.buckets.$get({
        query: { range, model: modelId },
      });
      if (!response.ok) throw new Error(`routing traffic buckets failed: ${response.status}`);
      return decodeRoutingTrafficBuckets(await response.json());
    },
  });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/services/routing-traffic-service`
Expected: PASS，既有 3 个 + 新增 3 个全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/services/routing-traffic-service.ts packages/dashboard/src/modules/routing/services/routing-traffic-service.test.ts packages/dashboard/src/lib/query-keys.ts
git commit -m "feat(dashboard): add the per-model traffic buckets query"
```

---

### Task 4: 拓扑 tab

**Files:**
- Create: `packages/dashboard/src/modules/routing/components/routing-model-topology-tab.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-model-topology-tab.test.tsx`
- Modify: `packages/dashboard/src/modules/routing/components/routing-board-item.tsx`
- Modify: `packages/i18n/messages/*.json`（五个文件）

**Interfaces:**
- Consumes: `RoutingBoard`（props `{ form, model, writable }`，已核实）；列表页计划的 `tierActualShares`；Task 2 的 `form`。
- Produces: `RoutingModelTopologyTab`，props `{ form; model; writable; actual: readonly RoutingTierShare[] | undefined }`。Task 7 装配。

**这个 tab 是整次重新设计的核心价值所在：** 配置滑块与实际数字必须在同一张卡片上。`RoutingBoard` 已经渲染全宽拖拽板，本任务只往每张 provider 卡片上补三个数字。

**降级规则：** `actual === undefined`（traffic 未到或失败）时，卡片只显示配置份额，**不显示「实际 0%」** —— 缺失与零是两件事。

- [ ] **Step 1: 加 i18n 键**

在 `dashboard.routing` 下新增（五个语言文件同键）：

```
detail.actual_share          配 {configured} → 实际 {actual}
detail.success_rate          成功率 {value}
detail.p95                   p95 {value}
detail.no_traffic_yet        暂无流量数据
detail.tab_topology          拓扑
detail.tab_metadata          元数据
detail.tab_cost              成本与限额
detail.tab_traffic           流量
detail.unsaved_title         有未保存的改动
detail.unsaved_body          离开这个页面会丢弃未保存的改动。
detail.unsaved_stay          留在此页
detail.unsaved_leave         放弃改动
detail.dirty_marker          未保存
detail.catalog_vs_override   目录值 / 你的覆写
detail.open_in_traces        在 Traces 中查看
```

英文值按字面意思写。跑 `bun run i18n:compile`。

- [ ] **Step 2: 写失败测试**

创建 `routing-model-topology-tab.test.tsx`：

```tsx
test('shows configured and actual share side by side on a provider card', () => {
  // The page exists to answer "I configured 50/50, why is it 93/7?" — both numbers must be
  // on the same card, not in separate tabs.
  renderTopology({ actual: [share('primary', 0.93, 0.5, 60)] });

  expect(screen.getByText(/50%.*93%/u)).toBeInTheDocument();
});

test('shows the success rate that explains a collapsed share', () => {
  renderTopology({ actual: [share('primary', 0.07, 0.41, 20)] });

  expect(screen.getByText(/41%/u)).toBeInTheDocument();
});

test('omits actual numbers entirely when traffic is unavailable', () => {
  // Rendering "actual 0%" would claim the Provider served nothing, which is not known.
  renderTopology({ actual: undefined });

  expect(screen.queryByText(/实际|actual/iu)).not.toBeInTheDocument();
  expect(screen.getByText(/No traffic yet|暂无流量/u)).toBeInTheDocument();
});

test('shows no p95 when the sample was empty', () => {
  // null p95 means no sample; 0 would read as instant.
  renderTopology({ actual: [share('primary', 1, null, null)] });

  expect(screen.queryByText(/p95/u)).not.toBeInTheDocument();
});
```

`renderTopology` 与 `share(providerId, actualShare, successRate, p95)` 是局部 helper。渲染需要一个真实的 `useRoutingForm` —— 照 `routing-editor-drawer.test.tsx` 现有的方式构造（那个文件即将删除，但它的 fixture 构造方式是本任务最好的参考，**先读它**）。

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-model-topology-tab`
Expected: FAIL —— 模块不存在。

- [ ] **Step 4: 实现**

`routing-model-topology-tab.tsx`：一层薄封装，渲染 `<RoutingBoard form={form} model={model} writable={writable} />`，并在 `actual === undefined` 时于板子上方渲染一行 `m['dashboard.routing.detail.no_traffic_yet']()`。

实际数字要进到每张卡片，而卡片是 `RoutingBoardItem` 渲染的 —— 所以给它**加一个可选 prop** `actual?: RoutingTierShare`，在 `actual` 存在时追加三段文本：`detail.actual_share`（配置 → 实际）、`detail.success_rate`、以及 `p95LatencyMs !== null` 时的 `detail.p95`。`RoutingBoardCanvas` 负责把每个 providerId 对应的 `RoutingTierShare` 传下去，所以它也要接一个 `actual` prop 并透传。

**已核实改动范围是安全的：** `/providers` 页用的是自己的 `modules/providers/components/provider-routing-board`，它直接接共享的 `WeightedTierBoard`，**不导入** routing 的 `RoutingBoardCanvas` / `RoutingBoardItem`。所以给这两个组件加 prop 只影响 routing 模块。（唯一的外部引用是 `routing-editor-drawer.test.tsx` 里的一个 testId 断言，而那个文件在 Task 8 会被删掉。）

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/`
Expected: PASS，4 个新 test 全绿，既有 board 测试不受影响。

- [ ] **Step 6: 提交**

```bash
git add packages/i18n/messages packages/dashboard/src/modules/routing/components
git commit -m "feat(dashboard): put actual traffic on the routing topology cards"
```

---

### Task 5: 元数据 tab 与成本 tab

**Files:**
- Create: `packages/dashboard/src/modules/routing/components/routing-model-metadata-tab.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-model-metadata-tab.test.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-model-cost-tab.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-model-cost-tab.test.tsx`

**Interfaces:**
- Consumes: `ModelMetadataEditor`（props `{ model: string; value; onChange; onValidityChange }`，已核实）；`RoutingProviderOverrideFields`（props `{ providerId: string; value: { cost; limit }; onChange }`，已核实）；Task 2 的 `metadataForm` 与 `setMetadataValid`；`DashboardRoutingModel.catalog`。
- Produces: `RoutingModelMetadataTab`（props `{ metadataForm; modelId; catalog; setMetadataValid }`）、`RoutingModelCostTab`（props `{ metadataForm; providers; writable }`）。Task 7 装配。

**两个 tab 都是搬运，不是重写。** 抽屉里那两段 `metadataForm.Field` 的用法一字不改地搬过来 —— 它们已经和 `mergeRoutingMutationDrafts` 的 `touched` 语义对齐，重写会打破那个契约。

**元数据 tab 唯一的新增：** catalog 对照。服务端已经带回 `catalog`（`{ lab, releaseDate? }`），所以「目录值 vs 你的覆写」几乎免费，而它回答的是「我到底改了什么」。`catalog === undefined`（models.dev 冷缓存）时整块不渲染，不显示空表。

**成本 tab 的改动是布局：** 抽屉里每个 provider 一个竖排 block，改成 provider × 字段的表格。字段仍由 `RoutingProviderOverrideFields` 渲染，**不要**自己写 input —— AGENTS.md 要求每个可编辑字段走 TanStack Form，那个组件已经接好了。

- [ ] **Step 1: 写失败测试**

创建 `routing-model-metadata-tab.test.tsx`：

```tsx
test('renders the models.dev catalog facts next to the authored override', () => {
  renderMetadata({ catalog: { lab: 'anthropic', releaseDate: '2026-08' } });

  expect(screen.getByText('anthropic')).toBeInTheDocument();
  expect(screen.getByText('2026-08')).toBeInTheDocument();
});

test('omits the comparison entirely when models.dev has nothing cached', () => {
  // A cold catalog is normal, not an error: an empty comparison table would be noise.
  renderMetadata({ catalog: undefined });

  expect(screen.queryByText(/目录值|Catalog/u)).not.toBeInTheDocument();
});

test('reports an invalid JSON draft upward so the page can gate saving', () => {
  const setMetadataValid = rs.fn();
  renderMetadata({ catalog: undefined, setMetadataValid });

  // ModelMetadataEditor owns the JSON validity signal; the tab only forwards it.
  expect(setMetadataValid).toHaveBeenCalled();
});
```

创建 `routing-model-cost-tab.test.tsx`：

```tsx
test('lays providers out as rows rather than stacked blocks', () => {
  renderCost({ providers: [providerFixture('primary'), providerFixture('fallback')] });

  const rows = screen.getAllByRole('row');
  // One header row plus one row per Provider.
  expect(rows).toHaveLength(3);
});

test('keeps every provider editable through the shared override fields', () => {
  renderCost({ providers: [providerFixture('primary')], writable: true });

  expect(screen.getByText('primary')).toBeInTheDocument();
});

test('renders read-only when the config cannot be written', () => {
  renderCost({ providers: [providerFixture('primary')], writable: false });

  for (const input of screen.queryAllByRole('textbox')) expect(input).toBeDisabled();
});
```

`renderMetadata` / `renderCost` / `providerFixture` 是局部 helper。**先读 `routing-editor-drawer.test.tsx`**（Task 8 会删掉它）拿它现成的 fixture 与 form 构造方式 —— 那是本任务最好的参考。若 `RoutingProviderOverrideFields` 不接受 `writable` 这类禁用信号，第三个测试改为断言它实际支持的只读表现，并在报告里说明。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-model-metadata-tab src/modules/routing/components/routing-model-cost-tab`
Expected: FAIL —— 两个模块都不存在。

- [ ] **Step 3: 实现**

`routing-model-metadata-tab.tsx`：把抽屉里 `routing-metadata-section` 那一段搬过来（`metadataForm.Field name="metadata"` 包 `ModelMetadataEditor`，`onChange` 写 `{ touched: true, value: next }`，`onValidityChange` 接 `setMetadataValid`）。在它上方加 catalog 对照：`catalog !== undefined` 时渲染一个小表，两列是 `m['dashboard.routing.detail.catalog_vs_override']()` 的两侧 —— 目录侧显示 `catalog.lab` 与 `catalog.releaseDate`，覆写侧显示当前 `metadataForm` 里对应的值（没有覆写就留空或显示继承标记，沿用 `m['dashboard.routing.editor.inherit']()`）。

`routing-model-cost-tab.tsx`：把抽屉里 `routing-overrides-section` 那一段搬过来，但外层换成 shadcn `Table`：每行一个 provider，单元格里放 `RoutingProviderOverrideFields`。`metadataForm.Field name="overrides"` 的读写方式照抄，包括那个 `?? { cost: { touched: false, value: undefined }, limit: { touched: false, value: undefined } }` 兜底 —— 它保证未触碰的 provider 不会被当成「显式清空」。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/`
Expected: PASS，6 个新 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/components
git commit -m "feat(dashboard): split routing metadata and cost into tabs"
```

---

### Task 6: 流量 tab

**Files:**
- Create: `packages/dashboard/src/modules/routing/components/routing-model-traffic-tab.tsx`
- Create: `packages/dashboard/src/modules/routing/components/routing-model-traffic-tab.test.tsx`

**Interfaces:**
- Consumes: Task 3 的 `routingTrafficBucketsQueryOptions` / `RoutingTrafficBucketsData`；列表页计划的 `tierActualShares`（用于汇总表）。
- Produces: `RoutingModelTrafficTab`，props `{ modelId: string; range: UsageOverviewRange }`。Task 7 装配。

**这个 tab 回答「为什么偏了」，拓扑 tab 回答「偏了多少」。** 所以它有两块：按 provider 的堆叠趋势（什么时候开始掉的）+ 每 provider 的 attempt/success/p95 汇总表，再加一个跳 Traces 的链接。

**已核实的图表栈：** 从 `@aio-proxy/ui/components/chart` 取容器组件，从 `recharts` 取图元 —— `usage-trend-chart.tsx` 就是这么做的（`Area` / `AreaChart` / `CartesianGrid` / `XAxis` / `YAxis`）。堆叠柱用 recharts 的 `BarChart` + 每个 provider 一个 `Bar stackId`。**先读 `usage-trend-chart.tsx`** 拿它的 `ChartContainer` / `ChartConfig` 用法，不要自己发明配置形状。

**两个必须处理的数据事实：**
1. `key` 是完整 ISO 时刻（day 分桶时为本地午夜），X 轴按 `bucketUnit` 决定格式：`hour` 显示时刻，`day` 显示日期。**不要**把它当成 `YYYY-MM-DD` 直接截断。
2. 计数是 `bigint`。recharts 吃不了 bigint —— 在喂给图表前转 `Number()`，并在注释里写明这是显示层的有损转换（桶内计数远小于安全整数上限，所以安全）。

- [ ] **Step 1: 写失败测试**

```tsx
test('stacks one series per provider in the order the response gave', () => {
  renderTraffic({ buckets: bucketsFixture(['primary', 'fallback']) });

  expect(screen.getByText('primary')).toBeInTheDocument();
  expect(screen.getByText('fallback')).toBeInTheDocument();
});

test('summarises attempts, successes and p95 per provider', () => {
  renderTraffic({ buckets: bucketsFixture(['primary']) });

  expect(screen.getByRole('table')).toBeInTheDocument();
});

test('shows an empty state rather than an empty chart when nothing was served', () => {
  renderTraffic({ buckets: { ...bucketsFixture([]), providerIds: [], buckets: [] } });

  expect(screen.getByText(/No traffic|无流量/u)).toBeInTheDocument();
});

test('links out to Traces filtered to this model', () => {
  renderTraffic({ buckets: bucketsFixture(['primary']) });

  const link = screen.getByRole('link', { name: /Traces/u });
  // The traces list filters by requestedModelId, which is the same key space as the
  // traffic response's modelId.
  expect(link).toHaveAttribute('href', expect.stringContaining('requestedModelId'));
});
```

最后那个测试依赖 traces 页的 search 参数名。**先核对 `modules/traces/lib/trace-search/trace-search.ts` 里的字段名**（已知它有 `requestedModelId`），若拼写不同就用实际的那个，并在报告里说明。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-model-traffic-tab`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

组件自己发 buckets query（`useQuery(routingTrafficBucketsQueryOptions(range, modelId))`）—— 它是唯一的消费者，把查询放在这里让该 tab 未被打开时不请求。加载中渲染 `Skeleton`；失败渲染一行可重试的错误，**不要**让它冒泡成整页错误；`providerIds.length === 0` 渲染 `Empty` + `m['dashboard.routing.traffic.none']()`。

汇总表用 shadcn `Table`，每行一个 provider：请求数、成功率、p95。数据从 totals query 来还是从 buckets 来？**从 totals 来** —— buckets 只有 finalCount，没有 attempt/success/p95。所以这个 tab 还需要 `routingTrafficQueryOptions(range)` 并按 `modelId` 取出对应条目；两个 query 共用同一个 range。

跳 Traces 的链接用 `Link to="/traces" search={{ requestedModelId: modelId }}`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/components/routing-model-traffic-tab`
Expected: PASS，4 个 test 全绿。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/components/routing-model-traffic-tab.tsx packages/dashboard/src/modules/routing/components/routing-model-traffic-tab.test.tsx
git commit -m "feat(dashboard): add the routing model traffic tab"
```

---

### Task 7: 页面装配

**Files:**
- Modify: `packages/dashboard/src/modules/routing/templates/routing-model-page.tsx`
- Modify: `packages/dashboard/src/modules/routing/templates/routing-model-page.test.tsx`

**Interfaces:**
- Consumes: Task 1–6 的全部产出；`useRoutingQuery()`（已有，返回 `{ writable, models }`）。
- Produces: 完整的详情页。

**页面结构：** header（`modelId` mono + lab + `releaseDate` + 风险 chip）· 右上 range 选择器（**页面级**，统管拓扑 tab 内嵌的实际数字与流量 tab）· 四个 tab · footer 的页面级保存/取消。

**五条必须做对的行为：**
1. **保存是页面级的，不是 tab 级的。** 一次 PUT 提交整个模型。tab 只是视图，切换不丢草稿。
2. **脏标记打在 tab 上**（`m['dashboard.routing.detail.dirty_marker']()`），让用户看见切走的 tab 里有未保存改动。
3. **未保存守卫**用 Task 2 的 blocker；拦下时弹一个 shadcn `AlertDialog`（`detail.unsaved_*` 那组键）。
4. **range 是页面级 state，不进 URL** —— 它不是 triage 的一部分，也不需要在往返中保留（列表页的筛选才需要）。若审查认为它该进 URL，那是产品决定，停下来问。
5. **model 不存在时**（URL 里的 id 不在 inventory 里）渲染 `Empty` + 回列表的链接，**不要**白屏或报错 —— 用户可能从书签进来，或那个模型刚从 config 里删掉。

- [ ] **Step 1: 写失败测试**

在 `routing-model-page.test.tsx` 追加（Task 1 的三个 splat 测试保留）：

```tsx
test('marks the tab that holds an unsaved change', () => {
  renderPage({ models: [modelFixture('sonnet')] });

  dirtyTopology();

  expect(screen.getByRole('tab', { name: /拓扑|Topology/u })).toHaveTextContent(/未保存|Unsaved/u);
});

test('blocks leaving the page while a draft is unsaved', async () => {
  const { user } = renderPage({ models: [modelFixture('sonnet')] });
  dirtyTopology();

  await user.click(screen.getByRole('link', { name: /Routing|路由/u }));

  expect(screen.getByRole('alertdialog')).toBeInTheDocument();
});

test('offers a way back rather than blanking when the model is gone', () => {
  // A bookmarked id, or a model just removed from config.
  renderPage({ models: [], modelId: 'deleted-model' });

  expect(screen.getByRole('link', { name: /Routing|路由/u })).toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
});

test('keeps one save button for the whole page rather than one per tab', () => {
  renderPage({ models: [modelFixture('sonnet')] });

  expect(screen.getAllByRole('button', { name: /保存|Save/u })).toHaveLength(1);
});

test('disables saving when the config is read-only', () => {
  renderPage({ models: [modelFixture('sonnet')], writable: false });

  expect(screen.getByRole('button', { name: /保存|Save/u })).toBeDisabled();
});

test('switching range does not discard an unsaved draft', () => {
  // The range only drives read-only traffic numbers; it must not reset the forms.
  renderPage({ models: [modelFixture('sonnet')] });
  dirtyTopology();

  selectRange('7d');

  expect(screen.getByRole('tab', { name: /拓扑|Topology/u })).toHaveTextContent(/未保存|Unsaved/u);
});
```

`renderPage` / `dirtyTopology` / `selectRange` / `modelFixture` 是局部 helper。**先读 `routing-editor-drawer.test.tsx`**（Task 8 删它）拿它的 query/mutation mock 方式与 model fixture —— 那 724 行里的 setup 是本任务最好的参考，行为断言也大多可以搬。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/templates/routing-model-page`
Expected: FAIL —— 模板还是 Task 1 的骨架，没有 tab、没有保存、没有守卫。

- [ ] **Step 3: 实现**

`routing-model-page.tsx`：

1. `const query = useRoutingQuery()`，`const model = query.data?.models.find((entry) => entry.modelId === modelId)`。
2. `model === undefined && !query.isLoading` → 渲染 `Empty` + `Link to="/routing"`，提前返回。
3. `const [range, setRange] = useState<UsageOverviewRange>('24h')`。
4. `const editor = useRoutingModelEditor({ model: model ?? null, writable: query.data?.writable ?? false, onReload: query.refetch })`。
5. 顶部 traffic：`useQuery(routingTrafficQueryOptions(range))` 取出本模型的 totals，算出 `tierActualShares` 传给拓扑 tab（traffic 未到/失败就传 `undefined`，沿用列表页那条降级规则）。
6. shadcn `Tabs`：四个 `TabsTrigger` 的 label 用 `detail.tab_*`；`editor.dirtyTabs.includes(id)` 时在 label 后附脏标记。每个 `TabsContent` 装对应组件，props 照各任务的 Produces 逐一接上：

```tsx
<TabsContent value="topology">
  <RoutingModelTopologyTab form={editor.form} model={model} writable={writable} actual={actual} />
</TabsContent>
<TabsContent value="metadata">
  <RoutingModelMetadataTab
    metadataForm={editor.metadataForm}
    modelId={model.modelId}
    catalog={model.catalog}
    setMetadataValid={editor.setMetadataValid}
  />
</TabsContent>
<TabsContent value="cost">
  <RoutingModelCostTab metadataForm={editor.metadataForm} providers={model.providers} writable={writable} />
</TabsContent>
<TabsContent value="traffic">
  <RoutingModelTrafficTab modelId={model.modelId} range={range} />
</TabsContent>
```

`actual` 是第 5 步算出的 `tierActualShares` 结果（traffic 未到或失败时为 `undefined`）。注意**四个 tab 的 `value` 必须与 `editor.dirtyTabs` 里的 id 一致** —— Task 2 产出的是 `'topology'` / `'metadata'` / `'cost'`，流量 tab 只读所以永远不脏。
7. footer：一个保存按钮（`disabled={!editor.canSave}`）、一个取消、`editor.stale` 时多一个重载按钮 —— 沿用抽屉的三按钮语义。
8. `editor` 的 blocker 被触发时渲染 `AlertDialog`。

若加完这些超过 400 行，把 query 编排提到 `hooks/use-routing-model-page.ts`，模板只做渲染。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/`
Expected: PASS，模块内全部测试绿（此时抽屉测试仍存在且仍应通过）。

- [ ] **Step 5: 提交**

```bash
git add packages/dashboard/src/modules/routing/templates
git commit -m "feat(dashboard): assemble the routing model detail page"
```

---

### Task 8: 切换入口并删掉抽屉

**Files:**
- Modify: `packages/dashboard/src/modules/routing/components/routing-table-columns.tsx`
- Modify: `packages/dashboard/src/modules/routing/components/routing-table.tsx`
- Modify: `packages/dashboard/src/modules/routing/components/routing-table.test.tsx`
- Modify: `packages/dashboard/src/modules/routing/templates/routing-page.tsx`
- Modify: `packages/dashboard/src/modules/routing/templates/routing-page.test.tsx`
- Delete: `packages/dashboard/src/modules/routing/components/routing-editor-drawer.tsx`
- Delete: `packages/dashboard/src/modules/routing/components/routing-editor-drawer.test.tsx`

**Interfaces:**
- Consumes: Task 1 的路由。
- Produces: 列表页的编辑入口变成跳详情页；抽屉彻底消失。

**这一步是净删除，不是新增。** 抽屉 210 行 + 测试 724 行下线。**先确认 724 行测试里的每个行为断言都已在 Task 2/4/5/7 里有对应覆盖**，缺的补上再删 —— 删测试是本计划唯一不可逆的动作。

**列表页此时应该完全不引用抽屉了。** `routing-page.tsx` 里的 `selected` state、`editorGeneration` ref、`onReload` 闭包一并删除 —— 它们只为抽屉存在。

- [ ] **Step 1: 盘点抽屉测试的覆盖迁移**

Run: `grep -c "^test(\|^  test(" packages/dashboard/src/modules/routing/components/routing-editor-drawer.test.tsx`

逐条读那些 test 名，对照 Task 2/4/5/7 的测试。产出一份清单写进报告：每条抽屉测试 → 它现在被哪个文件的哪个测试覆盖，或「已补」。**任何一条无对应覆盖且你认为仍然重要的，先在对应任务的测试文件里补上，再继续。** 只有当某条断言的行为确实随抽屉一起消失（例如「关闭抽屉时重置 mutation」），才可以直接丢弃，并在报告里说明理由。

- [ ] **Step 2: 写失败测试**

在 `routing-table.test.tsx` 改/加：

```tsx
test('links each row to its detail page instead of opening a drawer', () => {
  render(<RoutingTable models={[modelFixture('anthropic/claude-sonnet-4.5')]} traffic={undefined} />);

  // A slash-containing id must land on the splat route unescaped.
  expect(screen.getByRole('link', { name: /编辑|Edit/u })).toHaveAttribute(
    'href',
    '/routing/anthropic/claude-sonnet-4.5',
  );
});
```

在 `routing-page.test.tsx` 加：

```tsx
test('no longer renders the editor drawer', () => {
  mockRoutingModels({ writable: true, models: [modelFixture('sonnet')] });

  render(<RoutingPage />);

  expect(screen.queryByTestId('routing-editor-drawer')).not.toBeInTheDocument();
});
```

`RoutingTable` 的 `onEdit` prop 此时应删除 —— 若还有测试传它，一并清理。

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/`
Expected: FAIL —— 操作列还是按钮而非链接，页面还挂着抽屉。

- [ ] **Step 4: 实现**

`routing-table-columns.tsx`：`actions` 列的 `Button onClick={() => onEdit(row.original)}` 换成 `Button render={<Link to="/routing/$" params={{ _splat: row.original.modelId }} />}`。**先确认 `Link` 对 splat 路由的 params 写法** —— 若 `params: { _splat }` 不被接受，用 `to={`/routing/${row.original.modelId}`}` 这种模板字符串形式，并在报告里说明你用的是哪种。`createRoutingColumns` 的 `onEdit` 参数删除。

`routing-table.tsx`：删 `onEdit` prop 及其在 `useMemo` 依赖里的引用。

`routing-page.tsx`：删 `selected` / `editorGeneration` / `selectModel` / `onReload` 与 `<RoutingEditorDrawer>`；`<RoutingTable>` 不再传 `onEdit`。

删两个抽屉文件。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run --filter @aio-proxy/dashboard test src/modules/routing/`
Expected: PASS。模块内全部测试绿，且不再有任何文件引用 `routing-editor-drawer`。

Run: `grep -rn "routing-editor-drawer\|RoutingEditorDrawer" packages/dashboard/src`
Expected: 无输出。

- [ ] **Step 6: 提交**

```bash
git add -A packages/dashboard/src/modules/routing
git commit -m "refactor(dashboard): replace the routing drawer with the detail page"
```

---

### Task 9: changeset 与全量门禁

**Files:**
- Create: `.changeset/<随机名>.md`

**Interfaces:**
- Consumes: 本计划与前两份计划的全部产出。
- Produces: 一份可发布的分支。

**这是整个重新设计唯一的 changeset。** 按 spec 的交付章节：一个 PR、一份 note。

- [ ] **Step 1: 写 changeset**

Run: `bun changeset`

**frontmatter 必须同时包含产品包与所有内部包**，否则按 CLAUDE.md 所述，只指向内部包会让 `aio-proxy` 的 CHANGELOG 为空、`scripts/release.ts` 跳过它的 GitHub Release、说明静默消失：

```
---
'aio-proxy': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
'@aio-proxy/types': minor
'@aio-proxy/dashboard': minor
---
```

正文**描述合并后的最终状态**（重新设计的 routing 页），不是三份计划的过程。一段，至多 5 行，面向用户，不写文件名和实现细节。要点：routing 页现在按模型厂商分组、能一键筛出无可用 provider / 单点无 failover / 实际偏离配置的模型，并把每个模型的实际流量份额与成功率和配置权重并排显示；编辑从抽屉改成全宽独立页面。

**先 `grep` 一遍 `.changeset/`**：若已有描述本功能某个中间状态的 note，改写它而不是追加一份新的。

- [ ] **Step 2: 全量门禁**

Run: `bun run build`
Expected: 全部包构建成功。

Run: `bun run lint:types`
Expected: exit 0。只应剩下 dashboard 里那几条既有的 `react-hooks(exhaustive-deps)` 警告。

Run: `bun run format:check`
Expected: 无差异。有差异跑 `bun run format` 并并入提交。

Run: `bun run test`
Expected: 全绿。

- [ ] **Step 3: 提交**

```bash
git add .changeset
git commit -m "chore: add a changeset for the routing page redesign"
```

---

## 不在本计划范围内

- **列表页**：健康概览条、lab 分组、双层份额条、URL 筛选 —— 上一份计划。本计划开始前它必须已完成。
- **`/providers` 页的 provider 级 routing board**：共用 `WeightedTierBoard`，但有自己的 `provider-routing-board`，本计划不碰（已核实不存在共享组件耦合）。
- **数据层**：已合并，见 `2026-09-25-routing-redesign-data-layer.md`。

## 已知风险

- **`Link` 对 splat 路由的 params 写法未核实**（Task 8）。`_splat` 作为 params 键在类型上可行（Task 1 已验证读取侧），但写入侧的 API 形状没验过。这是本计划最可能需要现场调整的一处。
- **`useBlocker` 在 1.170.32 的入参名未核实**（Task 2）。只确认了模块存在。照 `dist/esm/useBlocker.d.ts` 写，不要照别的版本的 API 猜。
- **删 724 行抽屉测试是唯一不可逆的动作**（Task 8）。Step 1 的覆盖盘点不是形式主义 —— 跳过它就等于用「测试还在绿」换掉了一批真实断言。
- **`PageContainer` 的面包屑项是否支持 `to`** 未核实（Task 1）。不支持就退化成纯文本 label。
- **`RoutingProviderOverrideFields` 是否接受只读信号** 未核实（Task 5）。不接受就改断言，不要为此重写那个组件。








