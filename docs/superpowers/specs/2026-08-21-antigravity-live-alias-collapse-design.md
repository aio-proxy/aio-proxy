# Antigravity live alias collapse

日期：2026-08-21  
状态：待用户规格审阅

修订 [2026-07-17 Google Antigravity OAuth](./2026-07-17-google-antigravity-oauth-design.md) 的 family collapse 与 default alias 写入规则。官方 `agy` CLI 1.1.13 与 2026-08-21 的 `fetchAvailableModels` 实抓 payload 是行为参照，不是要复制 CLI 源码。

## 背景

当前 Antigravity 的 client-facing family（`gemini-3.5-flash` 等）来自手写 `ANTIGRAVITY_FAMILIES`。发现接口返回的是零散 wire id。官方 CLI 选择器看起来是「一行 family × Effort」，但 **`agentModelSorts` 并不是 family 表**：它是一组名为 `Recommended` 的扁平 slug 名单。CLI 用 `displayName` 的 `(Low|Medium|High)` 收成两轴 UI；没有 displayName 的 `*-tiered`（如 `gemini-3.7-flash-tiered`）由客户端当成「同一 slug + thinkingLevel」。

手写 family 表在 Google 增加 3.6 / 3.7 时必须改插件代码。目标是：Gemini 新版本只要仍用现有 displayName / `-tiered` 约定，插件不必改表。

## 目标

- 用发现结果生成 default alias，不再为每个 Gemini 版本维护 effort→slug 表。
- 公开 catalog 仍是 wire id；逻辑名只存在 alias 层。
- 新账号 first-login 写出与 CLI 选择器同一批 family。
- 已有账号在 catalog refresh 与 re-login 时 **只插入缺失的 alias key**，不改、不删用户已有项。
- Gemini thinking 数字来自发现结果；Claude 的 adaptive budget 阶梯仍手写（API 只给 `thinkingBudget: 1024`）。

## 非目标

- 不把 `/v1/models` 收成一行 family；客户端仍可直接请求 `gemini-3.5-flash-low`。
- 不调用 `ListModelConfigs`（它返回另一套 chat-agentic config，不是 Agent 选择器）。
- 不把 `agentModelSorts` 当 catalog 过滤器（会藏掉 3.7-tiered 等）。
- 不持久化 `quotaInfo`、`modelExperiments`、`experimentIds`、`supportedMimeTypes`。
- 不自动改写或删除用户已编辑的 alias / variant。
- 不在本次改 Dashboard alias 编辑器 UI。
- 不把 3.5 的历史 `minimal` 推广到新 family。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 折叠数据源 | `models[].displayName` 的 `(Low\|Medium\|High)` + 通用 `*-tiered` 规则 |
| 菜单范围 | `agentModelSorts` 的 modelIds，并 **前置** `tieredModelIds.flash` 中尚未出现的 id |
| 公开 catalog | 继续列出全部非 internal / 非 denylist / 非 deprecated-old 的 wire id |
| 逻辑名 | 优先 wire stem；stem 不一致时 slugify displayName family 段（数字版本点保留） |
| Effort 轴 | 新 alias 只有 `low` / `medium` / `high`，对齐 CLI |
| 3.5 `minimal` | 生成器不再写出；已有 config 保留 |
| Gemini thinking | 用该 wire 在 catalog 上的 `thinkingBudget`；`-1` 表示把 `thinkingLevel` 传给上游 |
| Claude thinking | 常量阶梯 `low=4096, medium=8192, high=16384`；`max` 不再作为新 default |
| 手写残留 | denylist、静态 snapshot、Claude budget 常量 |
| Deprecated | 以响应 `deprecatedModelIds` 为准，不再手写 retired 集合 |
| Alias 写入 | 新建账号：全量 suggestions。re-login 与 TTL refresh：**insert-only** |
| Host 范围 | insert-only 对所有带 `defaultAliases` 的 OAuth 插件生效（含 Cursor） |

## 发现契约

继续 `POST /v1internal:fetchAvailableModels`，body `{ project }`。Zod schema 保持 `.loose()`，并显式读取：

- `models`（现有）
- `webSearchModelIds`（现有）
- `agentModelSorts`: `{ displayName?: string, groups: { displayName?: string, modelIds: string[] }[] }[]`
- `tieredModelIds`: `{ flash?: string[], flashLite?: string[], pro?: string[] }`
- `deprecatedModelIds`: `Record<string, { newModelId?: string }>`
- `defaultAgentModelId`: string（本设计不读取；折叠与默认 `model` 不依赖它）

`models` 条目额外保留（写入 descriptor metadata，不进公开无关字段）：

- `displayName`
- `thinkingBudget`（含 `-1`）
- `minThinkingBudget`
- `apiProvider` / `modelProvider`
- `model`（`MODEL_PLACEHOLDER_*` enum 字符串）
- 现有 `supportsImages` / `supportsThinking` / `maxTokens` / `maxOutputTokens`

过滤顺序不变：空 id、`isInternal === true`、硬编码 denylist（`chat_20706`、`chat_23310`、`tab_flash_lite_preview`、`tab_jump_flash_lite_preview`、`gemini-2.5-pro`）、以及本次发现 `deprecatedModelIds` 的 **old key**。

## Picker 名单

1. 将 `tieredModelIds.flash` 中、通过过滤后仍存在的 id 按原数组顺序放在最前（CLI 把最新 Flash 放在选择器顶部）。
2. 再追加所有 `agentModelSorts` 中 `groups[].modelIds`，跳过已出现的 id，跳过未通过过滤的 id。
3. 不要加入 `flashLite` / `tab` / `imageGeneration` / `webSearch` 专用名单，除非它们已出现在步骤 1–2。

此名单只决定 **default alias 生成哪些 family、以及 key 的插入顺序**。catalog.language 仍是过滤后的全量 wire id。

## 折叠算法

对 picker 名单上每个 wire id，用其 catalog `displayName` 匹配：

```text
^(.+) \((Low|Medium|High)\)$
```

大小写敏感，必须是整个 displayName。`(Thinking)`、`(Extra Low)` 不匹配。

- 命中：family stem = 捕获组 1，effort = 捕获组 2 的小写（`low` / `medium` / `high`）。同一 stem 的多个 slug 合成一个 family。同一 effort 出现多个 slug 时：优先仍在 picker 名单中的 id，其次 `deprecatedModelIds` 的 `newModelId`，再其次字典序较小者。
- 未命中且 id 以 `-tiered` 结尾：自成 family，三个 effort 都指向该 id，kind 为 `tiered`。
- 未命中且不是 `-tiered`：自成 family，kind 为 `same-wire`，写出 low/medium/high 三行且都指向该 id（Claude `(Thinking)` 走这条）。
- 命中正则但只有一档（如 `GPT-OSS 120B (Medium)`）仍走第一条，只发出实际存在的那一档，不补另外两档。

若某个 `-tiered` id 剥掉后缀后的 stem，已经等于某个 split family 的 logicalId，则 **丢弃这个 tiered family**（3.6 同时有 low/medium/high 与 `gemini-3.6-flash-tiered` 时只保留 split）。

### logicalId

对 family 成员按最长匹配去掉后缀 `-extra-low`、`-low`、`-medium`、`-high`、`-tiered`；`same-wire` 再去掉末尾 `-thinking`。

- 若所有剩余 stem 相同且非空：logicalId = 该 stem。
- 否则：把 displayName family stem（split）或单模型 displayName 去掉末尾 ` (Thinking)` 后 slugify：小写；空白变 `-`；夹在数字之间的 `.` 保留；其余非 `[a-z0-9.]` 变 `-`；压缩连续 `-`；去掉首尾 `-`。

由此得到现有 key 而不维护对照表：`gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.1-pro`、`claude-sonnet-4-6`、`claude-opus-4-6`、`gpt-oss-120b`、`gemini-3.7-flash`。

### 默认 `model`（无 effort 时）

在该 family 已有 variant 中：有 `medium` 用 medium；否则用 picker 名单里该 family **最先出现** 的成员。

`preserve` 一律 `false`。variant 行形状为已落地的 `{ when: { effort }, model, preserve: false }[]`。只包含 picker 名单里实际存在的 effort。`tiered` / `same-wire` 若要对齐 CLI 三档滑条，写出 low/medium/high 三行，即使它们指向同一 slug。

跳过「只有一行、logicalId 等于该 slug、且 `when` 为空」的自指 alias（与 Cursor peel 相同）。本算法不会产生空 `when`，因此 Claude / GPT-OSS 仍会发出带 effort 的 variant。

## Catalog metadata

`discover` 在 `ModelCatalog.metadata.antigravityFamilies` 写入折叠结果，供 `defaultAliases` 与 runtime thinking 共用，避免两套规则。形状：

```text
{
  logicalId: string,
  kind: 'split' | 'tiered' | 'same-wire',
  base: string,
  variants: { effort: 'low' | 'medium' | 'high', model: string }[]
}
```

`defaultAliases(catalog)` 只是把这些 family 转成 `DefaultAliasSuggestions`，并校验 target 都在 `catalog.language`。

删除作为公共配置源的 `ANTIGRAVITY_FAMILIES`。snapshot 与 thinking 不得再 import 那张 Gemini 版本表。

## Thinking

Runtime 已经持有 `RuntimeContext.catalog`。

**Gemini（`apiProvider` 为 Google Gemini，或 family kind 为 `split` / `tiered`）**

- 入站 `thinkingLevel` 规范化为小写 effort。
- `split`：该 effort 对应的 variant.model 必须等于当前 wire id，否则拒绝。budget 用该 wire descriptor 的 `thinkingBudget`。
- `tiered`：三档都允许指向同一 wire。`thinkingBudget === -1` 或缺失时，把 `thinkingLevel` 留给上游（不要再编 10000 这类手写数）；若 catalog 给出正数 budget 则仍写成 CCA `thinkingBudget`。
- 不在任何 family 中的 Gemini wire：不按 effort 表拒绝；有正数 `thinkingBudget` 则用它，否则保持上游字段。

**Claude（`apiProvider` 含 Anthropic，或 `modelProvider` 为 Anthropic）**

- `disabled` / `fixed` 行为不变。
- `adaptive`：使用常量 `{ low: 4096, medium: 8192, high: 16384 }`。未知 effort 拒绝。
- 不再为新 default 生成 `max`。已有用户 alias 的 `max` variant 若仍指向有效 slug，runtime 可用同一常量的 `max: 32768` 兼容已配置 key；生成器不再建议它。

## 宿主：insert-only alias

取代「只有新账号写 alias；re-login 与 refresh 完全不动」。

**新建账号（`currentAccount === null`）**：与现在一样，校验后写入完整 suggestions。

**re-login 与 TTL catalog refresh**：

1. 用刷新后的 catalog 调用 `defaultAliases`。
2. `validatedDefaultAliases` 仍拒绝指向 catalog 中不存在的 target。
3. 对每个 suggestion key：若 `providers[id].alias` 已有该 key（用户改过或旧 default），跳过；若没有，插入该 suggestion。
4. 不删除 key，不修改已有 key 的 `model` / `variants` / `preserve`。
5. catalog 写入成功优先：alias merge 失败只记日志，不得回滚 catalog、不得标 `CATALOG_UNAVAILABLE`。
6. TTL refresh 的 merge 由 server `CatalogScheduler` 在 `writeCatalog` 成功后调用宿主注入的 `mergeDefaultAliases(providerId, catalog)`。该回调走与 Dashboard 改 alias 相同的 config 事务；有插入则随后 `rebuild`。core 调度器不直接写 config 文件。

re-login 测试从「不调用 `defaultAliases`」改为「调用且不得覆盖已有 key；可插入新 key」。

## 静态 snapshot

snapshot 仍只用于首次登录的可重试发现失败。条目必须能走 **同一套** `normalize` + collapse：

- 每个 language 模型带上与线上一致的 `displayName`（3.5 extra-low 必须是 `Gemini 3.5 Flash (Low)`，不能是 `Extra Low`，否则正则不收）。
- `gemini-3.7-flash-tiered` 可以没有 displayName，靠 `-tiered` 规则。
- snapshot 覆盖当前 CLI Recommended + `tieredModelIds.flash` 中已验证可工作的模型；不必收录 tab / internal / 已 denylist 的 id。
- `modelEnum` / `maxOutputTokens` 继续放在 descriptor metadata，按 id 写在 snapshot 里，不再经过 Gemini family 表。

## 测试

- 用去掉 quota / experiments / mime 的实抓 payload fixture：折叠出 `gemini-3.6-flash`、`gemini-3.5-flash`、`gemini-3.1-pro`、两个 Claude、`gpt-oss-120b`，以及 `gemini-3.7-flash`（tiered）；3.6 不出现第二份 `*-tiered` alias；`gemini-3.1-pro` high 指向 `gemini-pro-agent` 而非 deprecated `gemini-3.1-pro-high`。
- displayName 为 `Gemini 3.5 Flash (Extra Low)` 的 snapshot 旧值不得被收成 low（回归：snapshot 必须用 `(Low)`）。
- 未知 `gemini-3.8-flash-low/medium/high` 在不改折叠代码的情况下生成 `gemini-3.8-flash`。
- `gemini-3.8-flash-tiered` 单独出现时生成 `gemini-3.8-flash` 三档同一 slug。
- denylist / internal / deprecated old id 不进 catalog、不当 alias target。
- first-login 仍拒绝缺 target 的 suggestion。
- re-login：已有 key 不变；catalog 多出的新 logical id 被插入。
- catalog refresh：insert-only；merge 抛错时 catalog 仍更新。
- Gemini split：`thinkingLevel` 与当前 wire 的 effort 不一致则拒绝；一致则使用 catalog budget。
- Gemini tiered + `thinkingBudget: -1`：请求带上 `thinkingLevel`，不编造正数 budget。
- Claude adaptive 三档常量。

## 发布

plugin 行为变更 + 宿主 alias 写入规则变更。Changeset：`@aio-proxy/plugin-google-antigravity`、`@aio-proxy/core`、以及产品包 `aio-proxy`（与 core 同级 bump）。若 SDK 类型因 catalog metadata 文档化而需导出，再列入 `@aio-proxy/plugin-sdk`，同样带上 `aio-proxy`。

## 实现顺序

1. 插件：parse 字段、collapse、aliases、thinking、snapshot、fixture 测试。此步即可让 **新登录** 跟上上游。
2. 宿主：re-login + catalog refresh 的 insert-only。此步让 **已有账号** 在 TTL 后得到新 logical id。
