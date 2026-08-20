# Antigravity live alias collapse

日期：2026-08-21  
状态：待用户规格审阅

修订 [2026-07-17 Google Antigravity OAuth](./2026-07-17-google-antigravity-oauth-design.md) 的 family collapse 与 default alias 写入规则。官方 `agy` CLI 1.1.13 与 2026-08-21 的 `fetchAvailableModels` 实抓 payload 是行为参照，不是要复制 CLI 源码。

## 修订

**2026-08-21 a.** 产品决定：新生成 alias / variant **不保留原始模型 ID**。`preserve` 一律 `false`。客户端只认 logical alias + effort 维度；被当成 target 的 wire slug 不再独立可路由。

**2026-08-21 b.** 第二轮 Codex 仍开的实现洞：

- OpenAI `reasoning` 必须在 Google codec **之前**收成插件 thinking，禁止从 codec 写出来的 `thinkingLevel` / `thinkingBudget` 反推 effort（`none → minimal`、非 `gemini-3*` 会变数字 budget）。
- `minimal` 只对当前 wire id 以 `-extra-low` 结尾成立；不得用「有正数 thinkingBudget」当门闩。
- catalog 写入改为 `compareAndSwapCatalog`；merge 必须核对仍是自己写下的 `refreshedAt`。
- TTL 回调带 plugin / capability / `defaultAliases`；re-login 的 catalog 提交与 alias insert 拆开，insert 失败不得拖垮 catalog。

## 背景

当前 Antigravity 的 client-facing family（`gemini-3.5-flash` 等）来自手写 `ANTIGRAVITY_FAMILIES`。发现接口返回的是零散 wire id。官方 CLI 选择器看起来是「一行 family × Effort」，但 **`agentModelSorts` 并不是 family 表**：它是一组名为 `Recommended` 的扁平 slug 名单。CLI 用 `displayName` 的 `(Low|Medium|High)` 收成两轴 UI；没有 displayName 的 `*-tiered`（如 `gemini-3.7-flash-tiered`）由客户端当成「同一 slug + thinkingLevel」。

手写 family 表在 Google 增加 3.6 / 3.7 时必须改插件代码。目标是：Gemini 新版本只要仍用现有 displayName / `-tiered` 约定，插件不必改表。

## 目标

- 用发现结果生成 default alias，不再为每个 Gemini 版本维护 effort→slug 表。
- **存储 catalog** 仍是 wire id（库存、alias target 校验、thinking / envelope 查表）。
- **客户端路由** 只暴露 logical alias。新生成的 base / variant target 一律 `preserve: false`；`Router.directModelIds` 会摘掉这些 slug，`/v1/models` 只列出 `modelRoutes`（alias 名）。客户端请求 `gemini-3.5-flash` 并带 effort，不请求 `gemini-3.5-flash-low` 当 model id。
- 新账号 first-login 写出与 CLI 选择器同一批 family。
- 已有账号在 catalog refresh 与 re-login 时 **只插入缺失的 alias key**，不改、不删用户已有项。
- Gemini thinking 数字来自发现结果；Claude 的 adaptive budget 阶梯仍手写（API 只给 `thinkingBudget: 1024`）。

## 非目标

- 不把存储 catalog 收成一行 family。未当 alias target 的其它 wire id 仍可走直连路由。
- 不把已折叠 family 的原始 slug（`-low` / `-medium` / `-high` / `-tiered` / `-extra-low` 等）留作独立 client model id。
- 不调用 `ListModelConfigs`（它返回另一套 chat-agentic config，不是 Agent 选择器）。
- 不把 `agentModelSorts` 当 catalog 过滤器（会藏掉 3.7-tiered 等）。
- 不持久化 `quotaInfo`、`modelExperiments`、`experimentIds`、`supportedMimeTypes`。
- 不自动改写或删除用户已编辑的 alias / variant。
- 不在本次改 Dashboard alias 编辑器 UI。
- 不把 3.5 的历史 `minimal` 推广到新 family。
- 不把 `tieredModelIds.pro` / `flashLite` 预置进 picker（除非该 id 已出现在 `agentModelSorts`）。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 折叠数据源 | `models[].displayName` 的 `(Low\|Medium\|High)` + 通用 `*-tiered` 规则 |
| 菜单范围 | `agentModelSorts` 的 modelIds，并 **前置** `tieredModelIds.flash` 中尚未出现的 id |
| 存储 catalog | 继续列出全部非 internal / 非 denylist / 非 deprecated-old 的 wire id |
| 客户端路由 | 新 alias / variant `preserve: false`；target wire id 不独立可路由 |
| 逻辑名 | 优先 wire stem；stem 不一致时 slugify displayName family 段（数字版本点保留） |
| Effort 轴 | 新 alias 只有 `low` / `medium` / `high`，对齐 CLI |
| 3.5 `minimal` | 生成器不再写出；runtime 仅当当前 wire id 以 `-extra-low` 结尾时接受 |
| collapse `kind` | 只描述 slug 怎么收（`split` / `tiered` / `same-wire`） |
| `thinking.mode` | 与 `kind` 无关：由 `apiProvider` / `modelProvider` 判定 `gemini` / `claude` / `none` |
| Gemini thinking | 用该 wire 的 catalog `thinkingBudget`；缺失或 `-1` 则把 `thinkingLevel` 传给上游 |
| Claude thinking | 常量阶梯 `low=4096, medium=8192, high=16384`；`max` 不再作为新 default |
| OpenAI reasoning | 在 Google codec 之前收成 `aioProxy.thinking`；codec 写出的 thinking 字段不作 effort 来源 |
| `maxOutputTokens` | 上游缺省则 descriptor 不写该字段；discover **不再**填 `64000` |
| 手写残留 | denylist、静态 snapshot、Claude budget 常量 |
| Deprecated | 以响应 `deprecatedModelIds` 为准，不再手写 retired 集合 |
| Alias 写入 | 新建账号：全量 suggestions。re-login 与 TTL refresh：**insert-only**，且在 catalog 提交之后 |
| Host 范围 | insert-only 对所有带 `defaultAliases` 的 OAuth 插件生效（含 Cursor） |
| Catalog 并发 | `compareAndSwapCatalog`：仅当已有 `refreshedAt < startedAt`（或无行）才写入 |

## 发现契约

继续 `POST /v1internal:fetchAvailableModels`，body `{ project }`。Zod schema 保持 `.loose()`，并显式读取：

- `models`（现有）
- `webSearchModelIds`（现有）
- `agentModelSorts`: `{ displayName?: string, groups: { displayName?: string, modelIds: string[] }[] }[]`
- `tieredModelIds`: `{ flash?: string[], flashLite?: string[], pro?: string[] }`
- `deprecatedModelIds`: `Record<string, { newModelId?: string }>`
- `defaultAgentModelId`: string（本设计不读取；折叠与默认 `model` 不依赖它）

`models` 条目额外保留（写入 **该 descriptor 的** metadata，供 envelope / thinking 使用）：

- `displayName`
- `thinkingBudget`（含 `-1`）
- `minThinkingBudget`
- `apiProvider` / `modelProvider`（不枚举死值；匹配见 Thinking）
- `model`（`MODEL_PLACEHOLDER_*` enum 字符串，写入 `modelEnum`）
- 现有 `supportsImages` / `supportsThinking` / `maxTokens` / `maxOutputTokens`
- `maxOutputTokens`：仅当上游给出正数时写入。**不要**再为缺失值填 `64000`（今天 `discoveredCapabilities` 会造这个数；envelope 会把它当成硬上限）。`contextWindow` 仍可用现有 `maxTokens` 缺省（显示用，不进 CCA clamp）。

过滤顺序不变：空 id、`isInternal === true`、硬编码 denylist（`chat_20706`、`chat_23310`、`tab_flash_lite_preview`、`tab_jump_flash_lite_preview`、`gemini-2.5-pro`）、以及本次发现 `deprecatedModelIds` 的 **old key**。

Picker 输入与折叠结果写在 `ModelCatalog.metadata`（不是公开 `/v1/models` 字段）：

- `antigravityPicker`: `{ agentModelSorts, tieredModelIds, deprecatedModelIds }`（snapshot 也必须带，否则静态 catalog 跑不了同一套 collapse）
- `antigravityFamilies`: 折叠结果数组

## Picker 名单

1. 将 `tieredModelIds.flash` 中、通过过滤后仍存在的 id 按原数组顺序放在最前（CLI 把最新 Flash 放在选择器顶部）。
2. 再追加所有 `agentModelSorts` 中 `groups[].modelIds`，跳过已出现的 id，跳过未通过过滤的 id。
3. 不要加入 `flashLite` / `pro` / `tab` / `imageGeneration` / `webSearch` 专用名单，除非它们已出现在步骤 1–2。

此名单只决定 **default alias 生成哪些 family、以及 key 的插入顺序**。catalog.language 仍是过滤后的全量 wire id。

## 折叠算法

对 picker 名单上每个 wire id，用其 catalog `displayName` 匹配：

```text
^(.+) \((Low|Medium|High)\)$
```

大小写敏感，必须是整个 displayName。`(Thinking)`、`(Extra Low)` 不匹配。

- 命中：family stem = 捕获组 1，effort = 捕获组 2 的小写（`low` / `medium` / `high`）。同一 stem 的多个 slug 合成一个 family。同一 effort 出现多个 slug 时：优先仍在 picker 名单中的 id，其次 `deprecatedModelIds` 的 `newModelId`，再其次字典序较小者。`kind = split`。
- 未命中且 id 以 `-tiered` 结尾：自成 family，三个 effort 都指向该 id，`kind = tiered`。
- 未命中且不是 `-tiered`：自成 family，`kind = same-wire`，写出 low/medium/high 三行且都指向该 id（Claude `(Thinking)` 走这条）。
- 命中正则但只有一档（如 `GPT-OSS 120B (Medium)`）仍走第一条，只发出实际存在的那一档，不补另外两档。

丢弃规则（先算完所有候选，再按 logicalId 去重）：

1. 若某个 `tiered` family 的 logicalId 已等于某个 `split` family，丢弃 tiered（3.6 同时有 low/medium/high 与 `gemini-3.6-flash-tiered` 时只保留 split）。
2. 若某个 `same-wire` family 的 logicalId 已等于某个 `split` 或 `tiered` family，丢弃 same-wire。
3. 同一 `kind` 且 logicalId 相同（如 picker 里的 `foo` 与 `foo-thinking` 都会变成 same-wire `foo`）：保留 **picker 名单中最先出现成员** 的那个 family；若并列，保留 variant 更多者；再并列保留 `base` 字典序较小者。丢弃另一个，不合并 variant。

### logicalId

对 family 成员按最长匹配去掉后缀 `-extra-low`、`-low`、`-medium`、`-high`、`-tiered`；`same-wire` 再去掉末尾 `-thinking`。

- 若所有剩余 stem 相同且非空：logicalId = 该 stem。
- 否则：把 displayName family stem（split）或单模型 displayName 去掉末尾 ` (Thinking)` 后 slugify：小写；空白变 `-`；夹在数字之间的 `.` 保留；其余非 `[a-z0-9.]` 变 `-`；压缩连续 `-`；去掉首尾 `-`。

由此得到现有 key 而不维护对照表：`gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.1-pro`、`claude-sonnet-4-6`、`claude-opus-4-6`、`gpt-oss-120b`、`gemini-3.7-flash`。

### 默认 `model`（无 effort 时）

在该 family 已有 variant 中：有 `medium` 用 medium；否则用 picker 名单里该 family **最先出现** 的成员。

`preserve` 一律 `false`（alias 顶层与每一行 variant）。variant 行形状为已落地的 `{ when: { effort }, model, preserve: false }[]`。只包含 picker 名单里实际存在的 effort。`tiered` / `same-wire` 若要对齐 CLI 三档滑条，写出 low/medium/high 三行，即使它们指向同一 slug。

跳过「只有一行、logicalId 等于该 slug、且 `when` 为空」的自指 alias（与 Cursor peel 相同）。本算法不会产生空 `when`，因此 Claude / GPT-OSS 仍会发出带 effort 的 variant。

## Catalog metadata

`discover` 在 `ModelCatalog.metadata.antigravityFamilies` 写入折叠结果，供 `defaultAliases`、thinking、envelope 共用，避免两套规则。形状：

```text
{
  logicalId: string,
  kind: 'split' | 'tiered' | 'same-wire',
  thinking: { mode: 'gemini' | 'claude' | 'none' },
  base: string,
  variants: { effort: 'low' | 'medium' | 'high', model: string }[]
}
```

`classifyProvider(descriptor)`（`apiProvider` 优先于 `modelProvider`）与 family `thinking.mode` 共用：

- 字符串（大小写不敏感）包含 `gemini` → `gemini`
- 包含 `anthropic` → `claude`
- 否则 `none`（GPT-OSS 即使 `kind=split` 也是 `none`）
- 同一 family 成员判定不一致时：`gemini` > `claude` > `none`
- 无 family 的直连 wire：直接用该 descriptor 的 `classifyProvider`（thinking 与 Claude tool-mode 都走这条）

`defaultAliases(catalog)` 只是把这些 family 转成 `DefaultAliasSuggestions`，并校验 target 都在 `catalog.language`。

删除作为公共配置源的 `ANTIGRAVITY_FAMILIES`（含其中的 `wireProfiles` / retired 集合）。snapshot、thinking、envelope 不得再 import 那张表。

## Envelope 与 transport

`modelEnum`、`maxOutputTokens`、Claude tool-mode 今天走手写 `modelCapabilities` / `ANTIGRAVITY_FAMILIES`。删表之后必须改读当前 `RuntimeContext.catalog`：

- `createGoogleAntigravityRuntime` 从 catalog 建 `descriptorById` 与 `familyByWireId`。
- `AntigravityTransport` / `createCcaEnvelope` **每次** inference 都用这两张表，而不是只在 `providerTools` 路径上传 `modelMetadata`。
- `applyWireProfile`：`maxOutputTokens` / `labels.model_enum` 来自该 wire descriptor metadata；缺失则不加这些字段（新模型没有手写 profile 也能发请求）。
- Claude tool-mode：`familyByWireId(modelId)?.thinking.mode === 'claude'` **或** 该 descriptor 的 `classifyProvider` 为 `claude`。不在 picker / `antigravityFamilies` 里的 Claude wire 仍可直连，必须带 `VALIDATED`，不能只认 family 表。

## Thinking

Runtime 已经持有 `RuntimeContext.catalog`。查 family 用 `metadata.antigravityFamilies`，查 budget 用该 wire descriptor；无 family 时用 `classifyProvider(descriptor)`。

**Gemini（family `thinking.mode === 'gemini'`，或无 family 且 `classifyProvider === 'gemini'`）**

- 入站 effort 规范化为小写。`xhigh` 按 core reasoning ladder 折成 `high`。其它不在 `{ off, none, minimal, low, medium, high }` 的值拒绝。
- `split`：该 effort 对应的 variant.model 必须等于当前 wire id，否则拒绝。`minimal` / `off` / `none` 不走这条 variant 表（见下方兼容）。
- `tiered`：`low` / `medium` / `high` 都允许指向同一 wire。
- budget：descriptor `thinkingBudget` 为正数则写成 CCA `thinkingBudget`；缺失或 `-1` 则把规范化后的 `thinkingLevel` 留给上游，不编 10000 这类手写数。`split` 与 `tiered` 同一条规则。
- 不在任何 family 中的 Gemini wire：不按 variant 表拒绝；`low`/`medium`/`high` 有正数 `thinkingBudget` 则用它，否则保持上游字段。

**Gemini 兼容 effort（生成器不再写出这些 variant key）**

- `off` / `none` → `thinkingBudget: 0`。显式关闭，即使 descriptor 有正数 `minThinkingBudget`。
- `minimal`：**仅当当前 wire id 以 `-extra-low` 结尾** 时接受，budget 用该 wire 的 catalog `thinkingBudget`（正数）或拒绝。不得用「任意 wire 有正数 budget」当门闩。因此 `gemini-3.8-flash`（base 为 medium）+ `minimal` 必须拒绝，即使 router 因对不上 variant 回落到 medium。旧 3.5 alias 的 `minimal` 行仍指向 `…-extra-low`，可以过。

**Claude（family `thinking.mode === 'claude'`，或无 family 且 `classifyProvider === 'claude'`）**

- `disabled` → budget 0。
- `fixed`：`budgetTokens` 必须为正整数、`< max_tokens`，且 `>= max(1024, minThinkingBudget ?? 1024)`。
- `adaptive`：常量 `{ low: 4096, medium: 8192, high: 16384 }`。未知 effort 拒绝。
- 不再为新 default 生成 `max`。已有用户 alias 的 `max` variant 若仍指向有效 slug，runtime 可用同一常量的 `max: 32768`；生成器不再建议它。

**`thinking.mode === 'none'`（含 GPT-OSS）**

- 不按 Gemini / Claude effort 表改写或拒绝。不要把 Google codec 的 thinking 字段再映射一遍。

**Anthropic `aioProxy.thinking` 打到 Gemini wire**

- `disabled` / `off` / `none` → Gemini `thinkingBudget: 0`。
- `fixed`：用 `budgetTokens`。若 descriptor 有 `minThinkingBudget` 且 budget > 0，则必须 `>= minThinkingBudget`；没有 1024 的 Claude 地板。
- `adaptive`：与 Gemini `thinkingLevel` 同一 mapper（含 `minimal` 的 `-extra-low` 限制）。

### 入站路径（必须同一 mapper）

Google codec（`@ai-sdk/google`）会改写 effort：`gemini-3*` 上 `none → thinkingLevel: minimal`；非 `gemini-3*`（`gemini-pro-agent`、Claude）写成数字 `thinkingBudget`。**禁止**从 codec 产物反推 effort。

AI SDK 模型路径（`createAntigravityLanguageModel`）：

1. 已有 `aioProxy.thinking`（Anthropic）→ 用它。
2. 否则若 `settings.reasoning` 是字符串且不是 `provider-default`：`none` → `{ mode: 'disabled' }`；其它 → `{ mode: 'adaptive', effort }`。
3. **清掉**传给 Google codec 的 `settings.reasoning`（或改成 `provider-default`），避免它再写 `thinkingConfig`。
4. `google-fetch` 若持有该 thinking option，用 mapper **整段替换** body 里的 `thinkingConfig`，丢掉 codec 可能残留的字段。

raw Gemini：继续在 `normalizeGeminiThinking` 里用 body 的 `thinkingLevel` 调同一 mapper（raw 没有经过 Google codec）。

`applyAntigravityThinking` 的 Gemini/Claude 分支改读 catalog，不再读 `ANTIGRAVITY_FAMILIES`。

## 宿主：insert-only alias

取代「只有新账号写 alias；re-login 与 refresh 完全不动」。

把 `validatedDefaultAliases` 与 insert-only 合并抽成 core 可复用 helper（login stage 与 server 回调共用）。不要让 `CatalogScheduler` 直接写 config 文件。

**alias 底图**

1. `base = providerPatch.alias ?? existing.alias ?? {}`
2. 新建账号且 `providerPatch.alias` 缺省：`base =` 完整 suggestions（与现在一致）。新建账号且调用方带了 `providerPatch.alias`：以 patch 为终态，**不再**往里 insert（调用方显式覆盖）。
3. re-login / TTL：对每个 suggestion key，若 `base` 已有该 key 则跳过；否则插入该 suggestion。
4. 不删除 key，不修改已有 key 的 `model` / `variants` / `preserve`。

**新建账号（`currentAccount === null`）**：按上面 1–2 **写进创建事务**。`defaultAliases` / 缺 target 仍使创建失败（与现在一致）。

**re-login**

1. 账号 + catalog 提交 **只用现有 alias**（加上 `providerPatch`）。这一步 **不得**调用 `defaultAliases`；suggestions 抛错不能挡住 catalog / credential 提交。
2. 提交成功后，再调用与 TTL 相同的 insert-only helper。
3. helper 抛错只记日志：catalog 已提交，不得补偿账号、不得标 `CATALOG_UNAVAILABLE`。

**TTL catalog refresh**

1. 用 CAS 写入的那份 catalog 调用该 job **捕获的** `defaultAliases`（与 discover 同一 adapter），不是事后按 Provider ID 再解析一遍可能已换掉的插件。
2. helper 仍拒绝指向 catalog 中不存在的 target。
3. 按「alias 底图」做 insert-only。
4. catalog CAS 成功优先：merge 失败只记日志，不得回滚 catalog、不得标 `CATALOG_UNAVAILABLE`。
5. `CatalogScheduler` 注入 `mergeDefaultAliases(providerId, catalog, identity)`。`identity` 至少含 `plugin`、`capability`、`writtenRefreshedAt`。回调走与 Dashboard 改 alias 相同的 config 事务；有插入则随后 `rebuild`。
6. 事务内：账号不存在、或 `plugin`/`capability` 与当前 provider / account 不一致 → **跳过 merge**。不要用 `runtimeRevision` 精确相等（credential refresh 会变）。
7. 事务内再 `readCatalog`：若 `refreshedAt !== writtenRefreshedAt`，跳过 merge（re-login 已写入更新 catalog）。
8. `CatalogScheduler` 可以早于 `ConfigStore` 构造。回调必须晚绑定：store 尚未 ready 时 **跳过 merge**（catalog 已写入），不得抛错、不得阻塞 refresh。

`CatalogJobDescriptor` 增补（materialize 时从当前 adapter / account 填入）：

- `plugin` / `capability`
- `defaultAliases`：`adapter.catalog.defaultAliases` 的绑定函数；没有则 TTL 只写 catalog

re-login 测试从「不调用 `defaultAliases`」改为「catalog 提交不依赖 suggestions；提交后 insert-only，且不得覆盖已有 key」。另测：`defaultAliases` 抛错时 catalog / credential 仍提交。

### Catalog generation fence

`PluginRepository` 增加原子方法，现有无条件 `writeCatalog` 留给 re-login 账号事务（用户发起的 discover 覆盖过期 TTL）：

```text
compareAndSwapCatalog(providerId, catalog, refreshedAt, startedAt): boolean
```

在同一 SQLite 事务里：无行或 `stored.refreshedAt < startedAt` 才 `replace`；否则返回 `false`。禁止 read-再-write。

TTL：

1. 开始 discover **之前** 记下 `startedAt`。
2. discover 成功后调用 `compareAndSwapCatalog(..., now(), startedAt)`。`false` → 跳过 merge。
3. `true` → `writtenRefreshedAt =` 刚才写入的 `now()`，再 merge。merge 前按上面第 7 条再核对 `refreshedAt`。
4. `replaceJobs` 仍用现有 generation 中止被替换的 in-flight job。CAS 补的是「re-login 已写更新 catalog，TTL 描述符还没被 replace」以及「read 与 write 之间插入更新写入」。

## 静态 snapshot

snapshot 仍只用于首次登录的可重试发现失败。必须能走 **同一套** `normalize` + collapse，因此除 language 条目外还要带 `metadata.antigravityPicker`（手写一份与当前 CLI Recommended + `tieredModelIds.flash` 对齐的结构）。

- 每个 language 模型带上与线上一致的 `displayName`（3.5 extra-low 必须是 `Gemini 3.5 Flash (Low)`，不能是 `Extra Low`，否则正则不收）。
- `gemini-3.7-flash-tiered` 可以没有 displayName，靠 `-tiered` 规则。
- snapshot 覆盖当前 CLI Recommended + `tieredModelIds.flash` 中已验证可工作的模型；不必收录 tab / internal / 已 denylist 的 id。
- `modelEnum` / `maxOutputTokens` / `thinkingBudget` / `apiProvider` 继续放在 **descriptor** metadata，按 id 写在 snapshot 里，不再经过 Gemini family 表。

## 测试

- 用去掉 quota / experiments / mime 的实抓 payload fixture：折叠出 `gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.1-pro`、两个 Claude、`gpt-oss-120b`，以及 `gemini-3.7-flash`（tiered）；3.6 不出现第二份 `*-tiered` alias；`gemini-3.1-pro` high 指向 `gemini-pro-agent` 而非 deprecated `gemini-3.1-pro-high`。
- 生成的 alias / variant `preserve === false`。router 与 `/v1/models` 不把这些 target wire id 列为独立 model；请求 `gemini-3.5-flash-low` 当 model id 得到 not found（用户手改 `preserve: true` 除外）。
- displayName 为 `Gemini 3.5 Flash (Extra Low)` 的 snapshot 旧值不得被收成 low（回归：snapshot 必须用 `(Low)`）。
- 未知 `gemini-3.8-flash-low/medium/high` 在不改折叠代码的情况下生成 `gemini-3.8-flash`。
- `gemini-3.8-flash-tiered` 单独出现时生成 `gemini-3.8-flash` 三档同一 slug。
- denylist / internal / deprecated old id 不进 catalog、不当 alias target。
- first-login 仍拒绝缺 target 的 suggestion。
- re-login：账号事务不调用 `defaultAliases`；提交后已有 key 不变，新 logical id 被插入。`providerPatch.alias` 作为底图后再 insert-only。`defaultAliases` 抛错时 catalog / credential 仍在。
- catalog refresh：insert-only；merge 抛错时 catalog 仍更新；config store 未 ready 时只写 catalog。plugin/capability 不匹配或 `refreshedAt` 已变则不 insert。
- `compareAndSwapCatalog`：已有 `refreshedAt >= startedAt` 时不覆盖；并发插入更新 `refreshedAt` 时旧 writer 失败。
- Gemini split：`thinkingLevel` 与当前 wire 的 effort 不一致则拒绝；一致且 catalog budget 为正数则使用该 budget。
- Gemini tiered + `thinkingBudget: -1`：请求带上 `thinkingLevel`，不编造正数 budget。
- 旧 3.5 alias 的 `minimal`（打到 `…-extra-low`）/ `off` 仍能出正确 CCA thinking。
- `gemini-3.8-flash`（无 extra-low）+ `minimal` 拒绝，即使 router 回落到 medium。
- OpenAI `reasoning=high`：在 codec 之前收成 adaptive，CCA 用 catalog mapper；`gemini-pro-agent` / Claude 不得留下 codec 数字 budget。
- OpenAI `reasoning=none` 打到 `gemini-3*`：CCA `thinkingBudget: 0`，不得变成 `thinkingLevel: minimal`。
- GPT-OSS：`thinking.mode === 'none'`，不按 Gemini budget 改写。
- 仅存在于 catalog、不在手写 `wireProfiles` 里的新模型：envelope 仍能带上 descriptor 里的 `modelEnum` / `maxOutputTokens`。
- 上游缺 `maxOutputTokens` 时 descriptor 无该字段，envelope 不注入上限。
- 不在 picker 里的 Claude wire：直连请求仍带 `VALIDATED`。
- picker 同时有 `foo` 与 `foo-thinking`：只留一个 same-wire `foo`，赢家是名单里更早的那个。
- Claude adaptive 三档常量。
- snapshot 带 picker 字段时，collapse 结果与同一批模型的 live fixture 一致。

## 发布

plugin 行为变更 + 宿主 alias 写入规则变更。Changeset：`@aio-proxy/plugin-google-antigravity`、`@aio-proxy/core`、以及产品包 `aio-proxy`（与 core 同级 bump）。若 SDK 类型因 catalog metadata 文档化而需导出，再列入 `@aio-proxy/plugin-sdk`，同样带上 `aio-proxy`。

## 实现顺序

1. 插件：parse 字段、collapse、aliases（`preserve: false`）、thinking mapper、**codec 之前**收 OpenAI reasoning、envelope 改读 catalog、snapshot / picker metadata、fixture 测试。此步即可让 **新登录** 跟上上游。
2. 宿主：`compareAndSwapCatalog`；抽出 alias helper；re-login 先提交 catalog 再 insert-only；TTL 回调带 plugin/capability/`defaultAliases`。此步让 **已有账号** 在 TTL 后得到新 logical id。
