# Dashboard Routing 页重新设计

`/routing` 从「一张表 + 一个抽屉」改为「可 triage 的列表 + 独立详情路由」，并首次把实际流量与配置意图并置。

## 问题

**信息呈现太薄。** 整条路由拓扑被 `formatRoutingTiers` 压成一行文字（`Tier 1: a 50% / b 50% → Tier 2: c`）。provider 归属只有 `2 / 3` 这种计数，覆写只有一个 yes/no badge。页面无法回答运维最常问的两个问题：哪个模型现在是坏的，以及我配的权重有没有真的生效。

**编辑体验差。** `RoutingEditorDrawer` 把三件互不相干的事挤进一个 36rem 滚动列：`WeightedTierBoard` 拖拽板、models.dev 元数据编辑器、每个 provider 的 cost/limit 覆写。

## 目标

1. 列表行用可视化份额条同时表达**配置意图**与**实际结果**。
2. 异常（无可用 provider、单点无 failover、实际偏离配置）可被扫到并一键收窄。
3. 按 lab 组织几百个模型，使列表可导航。
4. 编辑获得全宽空间，并让权重决策与实际流量数据相邻。

## 非目标

- 不新增「创建模型策略」能力。模型仍由 provider catalog 与已授权的 `models.<slug>` 派生。
- 不做批量操作。
- 不改 `/providers` 页的 provider 级 routing board，尽管它共用 `WeightedTierBoard`。

## 数据层

### catalog 事实注入现有 inventory

`DashboardRoutingModel` 增加：

```ts
readonly catalog?: { readonly lab: string; readonly releaseDate?: string };
```

来源是 `lookupCachedModel(modelId)`：其 `slug` 前缀即 lab，其 `metadata` 由 `catalogModelToMetadata()` 产出、已含 `releaseDate`（`YYYY-MM` 或 `YYYY-MM-DD`）。一次调用同时拿到两个字段，无新端点、无新请求。

`catalog` 与既有 `metadata` 必须保持分离：`catalog` 是 models.dev 派生的客观事实，`metadata` 是用户在 config 里授权的覆写（未授权时为 `undefined`，因此不能用于排序）。

models.dev 冷缓存时 `catalog` 为 `undefined`。这是正常状态而非错误：lab 筛选把这些模型归入「未知」组，排序把该组置于末尾。

命名约束：models.dev 内部把 lab 前缀称为 `providerId`，但在 aio-proxy 域语言中 **Provider ID 指上游 provider**。此字段必须叫 `lab`，不得沿用 models.dev 的叫法。

派生逻辑放 `packages/server/src/model-routing/catalog-facts.ts`。`inventory.ts` 已 280 行，接近 CLAUDE.md 要求「评估拆分」的 400 行线。

### 流量聚合

三条经调查确认的硬约束：

- **`usage_daily` 不可用。** 主键 `(localDay, modelDimension)` 为单维度，且 `modelDimension = session?.requestedModelId ?? summary.finalModelId ?? 'unknown'`，无 provider 维度，给不出交叉。
- **`trace_span` 可用。** root span（`parent_span_id IS NULL`）带 `requested_model_id` 与 `final_provider_id`；attempt span（`attempt_index IS NOT NULL`）带 `provider_id` 与 `termination_reason`（`NULL` 即成功）。两者以 `trace_id` join。
- **保留窗口 45 天**（`RETENTION_MS`，见 `request-trace-recorder.ts`）。直接复用既有 `UsageOverviewRangeSchema`（`24h` / `7d` / `14d` / `30d`），四个值全部落在保留窗口内，无需新造枚举。不提供 `90d`——这与现有 `providerHealth` 对 `90d` 返回 `null` 是同一个原因。

需要 attempt 级数据，因为「某 provider 失败后被 failover 掉」只存在于 attempt 层；仅读 root span 能得出实际份额，但得不出单个 provider 的失败率，流量 tab 就只能回答「偏了」而回答不了「为什么偏了」。

**索引迁移。** 现有索引全部以 `parent_span_id` 为前缀（为 root span 优化），attempt span 按 `ended_at` 做范围扫描无索引可用，等于 45 天 span 全表扫。新增 partial index：

```ts
index('trace_span_attempt_ended_idx').on(table.attemptIndex, table.endedAt)
  .where(sql.raw('attempt_index IS NOT NULL'))
```

走 `packages/core/src/db/migrations`（drizzle-kit 已在用，下一个序号 `0009`），并更新旁边的 `migrations.test.ts`。

### 两个端点

**model id 含斜杠，因此 model id 一律走查询参数，绝不进路径段。** 这与详情页必须用 splat 路由是同一个约束，服务端同样适用。

```
GET /dashboard/api/routing/traffic?range=24h
→ { range, rangeStart, rangeEnd, models: [{
      modelId,
      providers: [{ providerId, finalCount, attemptCount, successCount, p95LatencyMs }]
    }] }
```

字段名与校验沿用同一套 dashboard DTO 的既有约定：窗口边界叫 `rangeStart` / `rangeEnd` 且是 `z.iso.datetime()`（见 `dashboard.ts:94-95`），计数复用导出的 `NonNegativeIntegerStringSchema`（`dashboard.ts:59`）。不为同一个概念造第二套名字或第二条正则。

列表页一次取全，**仅总量，不含分桶**。**实际份额 = `finalCount / Σ finalCount`（同 tier 内）**，与配置份额同分母，才可比。

```
GET /dashboard/api/routing/traffic/buckets?range=24h&model=<encoded>
→ { buckets: [{ key, values: { [providerId]: count } }] }
```

详情页流量 tab 的趋势图，一次只查一个模型。

聚合查询放 `packages/core/src/db/trace-store/` 下，与 `overview/diagnostics.ts` 同构（后者已在做「按 provider 分组 + `termination_reason IS NULL` 计成功 + `json_group_array` 收集时长算 p95」，是可直接参照的先例）。

## 列表页 `/routing`

### 健康概览条

4 个 stat tile，后 3 个可点即筛（toggle）：

| Tile | 判定 |
|---|---|
| 模型总数 | 只读，不可点 |
| 无可用 provider | `eligibleProviderCount === 0` |
| 单点无 failover | `eligibleProviderCount === 1` |
| 实际偏离配置 | 见下方阈值 |

前三个 tile 只依赖 routing inventory，随列表一同出现。**「实际偏离配置」依赖 traffic query**，因此它在 traffic 到达前显示为加载态且不可作为筛选条件，traffic 失败时整个 tile 隐藏——不显示 `0`，那会谎报「没有偏离」。lab 分组标题行的异常计数遵循同一规则：配置派生的两类风险始终可用，偏离项在 traffic 到达后补入。

### 筛选状态放 URL

`/routing?risk=no-eligible&lab=anthropic`，走 TanStack Router search params。

这是方案选择的必然结果：详情页是独立路由，每修一个模型都要离开列表再回来。若筛选是组件内 state，每次往返都会清空筛选结果，triage 流程断裂。按 AGENTS.md 的原则，此处 URL 确实是 source of truth，因此**不引入 `stores/` 桶**。

返回列表由 router history 恢复，筛选自动保留。

### 排序

lab 升序 → `releaseDate` 降序（新模型在前）→ `modelId` 升序兜底。

- 缺 `catalog` 的模型归「未知」组，该组排最后。
- 组内缺 `releaseDate` 的排该组最后。
- `releaseDate` **按字符串比较，不 parse Date**：`YYYY-MM` 与 `YYYY-MM-DD` 混排时字典序结果本就合理，且避开时区问题。

排序不依赖 provider 健康状态，因此行的位置稳定可预测。

### 分组标题行

lab 分组在表格中可见（`anthropic · 14 个模型`）。排序规则已宣告 lab 是一级结构，视觉上不画出来等于让用户在脑中重建分组。分组标题行同时承载该 lab 的模型数与异常数，与顶部概览条形成「全局 → lab」两级。

分页跨组时，标题行在新页顶部重复渲染。

### 列

| 列 | 内容 |
|---|---|
| Model | `modelId`（mono）+ lab 图标 + `releaseDate` + 风险 chip + 覆写 chip |
| 路由 | 双层份额条：粗条 = 配置份额，细条 = 实际份额；hover tooltip 给每段 providerId 与百分比 |
| Providers | `ProviderAvatar` 叠放 + 计数 |
| 流量 | 请求数 + 成功率 |

**流量列不放 sparkline。** 趋势需要分桶数据，而列表端点只返回总量；为 217 个模型下发分桶会让载荷膨胀一个数量级，而在行高密度下 sparkline 的可读性本就很低。趋势留给详情页流量 tab，那里一次只查一个模型。

排序、筛选、列可见性沿用 `useDataTable`。AGENTS.md 中 server-paginated 表格的例外条款**不适用**——数据是客户端全量的，完整表格能力是正确的。

### 偏离阈值

同 tier 内 `|实际份额 − 配置份额| ≥ 15pp`，**且**该模型在当前 range 内 `finalCount ≥ 50`。样本不足一律不报，否则阈值本身成为噪音源。

实现放 `lib/routing-risk/`，纯函数、可测。

### 两个 query 不互相阻塞

routing models 先到即渲染粗条，traffic 到达后补细条。traffic 请求失败时列表**完全可用**，只是没有细条。这是显式的降级行为，不是 loading 兜底。

### 新增模块文件

- `lib/routing-risk/` — 风险判定与偏离阈值
- `lib/routing-traffic/` — 实际份额计算、与配置份额对齐同分母
- `services/routing-traffic-service.ts` — 两个新端点的 queryOptions
- `components/routing-health-strip.tsx`
- `components/routing-share-bar.tsx`
- `components/routing-lab-filter.tsx`
- `components/routing-lab-group-header.tsx`

## 详情页

### 必须用 splat 路由

`IdSchema = z.string().min(1)`——任意非空字符串。model id 来自 `provider.models`、`upstreamMetadata` 键与 alias，全由用户自由书写，而 OpenRouter 风格的 id 字面就是 `anthropic/claude-sonnet-4.5`。**model id 含斜杠是必然，不是假设**，普通路径参数 `$modelId` 会匹配失败。

路由为 `routes/routing/$.tsx`，读 `params._splat`。`/routing/anthropic/claude-sonnet-4.5` 天然工作，URL 保持可读。

不采用 `%2F` 编码方案：反向代理层常把它还原成真斜杠。

模板为 `templates/routing-model-page.tsx`。

### 结构

Header：`modelId` + lab + `releaseDate` + 风险 chip；右上一个 **页面级** range 选择器（`24h` / `7d` / `30d`），统管内嵌实际数字与流量 tab。

四个 tab：

- **拓扑** — `WeightedTierBoard` 全宽。每张 provider 卡片：配置份额滑块 + `配 50% → 实际 93%` + 成功率 + p95。零权重、不可用、被阻塞的状态沿用现有 badge。
- **元数据** — 现有 `ModelMetadataEditor`（JSON / 可视化双 tab + models.dev 查询）原样搬入。新增「catalog 值 vs 你的覆写」对照——服务端已带回 catalog 事实，此对照几乎免费，且它回答的是「我到底改了什么」。
- **成本与限额** — 现为每个 provider 一个竖排 block，改为 provider × 字段的表格。
- **流量** — 按 provider 的请求量堆叠趋势 + 每 provider 的 attempt/success/p95 汇总表 + 跳转 Traces（带 model 筛选）的链接。

### 保存语义

两个 drawer 时代不存在的新问题：

**未保存守卫。** 关抽屉是明确动作，路由跳转不是。需要 TanStack Router 导航 blocker 拦住脏状态，否则点面包屑会静默丢弃草稿。

**两个 form 的脏状态合并呈现。** 现有代码刻意分成 `useRoutingForm`（拓扑，仅 priority/weight）与 `useRoutingMetadataForm`（元数据与 cost/limit），源码注释写明是为防止拖拽或份额变更误删 drawer 数据。**这个分离必须保留。**

保存按钮是**页面级**的：一次 PUT 提交整个模型（现有 mutation 即如此），不存在 tab 级保存。tab 仅是视图，切换不丢草稿——脏标记打在 tab 上，让用户看见切走的 tab 里有未保存改动。

`revision` 乐观并发与 `stale` 重载沿用现有机制。

### 被移除的代码

`RoutingEditorDrawer`（210 行）及其测试（724 行）删除，行为迁移至新页面。`routing-page.tsx` 与 `routing-table-columns.tsx` 重写。这不是纯新增。

## 交付

**一个 PR。** 数据层与 UI 一起合并。

PR 内部仍按数据层先行的顺序推进，因为 UI 消费的契约必须先存在：

1. `types` — 新 DTO 与 schema（沿用 `matchesDto` 模式），`DashboardRoutingModel.catalog`。
2. `core` — 索引迁移（`0009_*.sql` + 更新 `migrations.test.ts`）与 attempt 级聚合查询。
3. `server` — 两个 traffic 端点与 `catalog-facts.ts`。
4. `dashboard` — 列表页重做、splat 详情路由、删除 `RoutingEditorDrawer`。
5. i18n 键与 changeset。

一个 changeset，同时列出 `aio-proxy` 与所有涉及的内部包。

代价要认：这个 PR 会同时包含一条 SQLite 迁移、两个新端点和一次页面重写，review 面较大。缓解办法是让提交历史按上面五步分段，使 diff 可以逐段读，而不是把所有改动压成一个提交。

## 测试

按价值排序，不为覆盖率写测试：

- `lib/routing-risk/` 与 `lib/routing-traffic/` 纯函数：阈值判定、实际份额与配置份额同分母对齐、缺失数据降级。
- core 聚合查询：seed span 后断言 (model × provider) 的计数与 p95；range 边界；**没有 attempt span 的 root-only trace 仍计入 `finalCount`**——它确实被那个 Provider 承接了，排除它会少算实际份额，而实际份额是这页的头号数字。此时 `attemptCount` 为 `0`、`p95LatencyMs` 为 `null`。由此 `successCount` 与 `finalCount` 在这一种情况下不一致，所以**消费端的成功率必须算 `successCount / attemptCount`，绝不能除以 `finalCount`**。
- splat 路由解析含斜杠的 model id。
- 未保存守卫与 tab 脏标记。
- traffic 请求失败时列表仍完全可用。
- `catalog` 在 models.dev 冷缓存时缺失且不报错。

## 硬性要求

- changeset 必须**同时**指向产品包 `aio-proxy` 与各内部包（`@aio-proxy/core`、`server`、`types`、`dashboard`）。仅指向内部包会让 Release 说明静默消失。
- 新增 i18n 键写入 `packages/i18n/messages/*.json` 后运行 `bun run i18n:compile`。
- `bun run preflight`。
- CI 的 `lint:types` 需先 build（跨包类型经各包 `dist` 解析）。

## 未决问题

无。



