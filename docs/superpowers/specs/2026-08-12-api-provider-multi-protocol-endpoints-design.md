# API Provider 多协议端点设计

- 日期：2026-08-12
- 状态：待用户评审（已按评审意见修订：统一 ai-sdk 入参语义、单次归一化、anthropic auth 覆盖、probe 路径职责、dashboard 交接）

## 背景

部分上游渠道原生同时提供多种 API 协议：z.ai / Moonshot / DeepSeek 在同一 origin 下用不同 path 前缀暴露 OpenAI 与 Anthropic 端点；new-api / LiteLLM / aio-proxy 级联这类聚合网关在同一个根上按标准路径服务多协议。

aio-proxy 的 API provider 目前只能声明一个 `protocol` + 一个 `baseURL`。inbound 协议与该协议不同时，即使渠道原生支持 inbound 协议，也会落入有损的 AI SDK 桥接。本设计让 API provider 声明多个协议端点：inbound 命中任一端点协议即走 raw 透传，最大化保真。

现状中的关键事实（决定了本设计的语义分层）：

- raw 透传的 URL 重写是 `upstreamUrl.pathname = incomingUrl.pathname`，即 **baseURL 自带的 path 前缀被丢弃，只用 origin**；而 AI SDK 桥接使用完整 baseURL。README 教的写法是 `https://api.openai.com/v1`（带版本段），origin-only 写法也因透传忽略 path 而同样工作。存量配置两种写法并存，任何对旧写法的语义统一都会破坏其中一类。
- `@ai-sdk/*` 各包的 baseURL 约定（已在 node_modules 实证）：`@ai-sdk/openai` 默认 `https://api.openai.com/v1`（追加 `/responses` 等）；`@ai-sdk/openai-compatible` 同为版本段风格（追加 `/chat/completions`）；`@ai-sdk/anthropic` 默认 `https://api.anthropic.com/v1`（追加 `/messages`）；`@ai-sdk/google` 默认 `https://generativelanguage.googleapis.com/v1beta`（追加 `/models/...`）。前三者对同根网关是同一个值（`{root}/v1`），仅 gemini 例外（`/v1beta`）。
- `@ai-sdk/anthropic` 区分 `apiKey`（发 `x-api-key`）与 `authToken`（发 `Authorization: Bearer`），二者互斥。z.ai / Moonshot / DeepSeek 的 anthropic 端点官方配置均为 `ANTHROPIC_AUTH_TOKEN`（Bearer），仅按协议推导鉴权 header 不够。
- 配置解析是两段式：`ProviderInputValueSchema.safeParse` 先校验单个 provider，`ProviderSchema.parse` 再解析一次（见 `packages/types/src/config/config.ts`）。在 `ApiProviderSchema` 上挂 transform 会被执行两次并破坏现有 `.omit()` 组合（ZodEffects 无 `.omit`），归一化必须放在这条链之外。
- pipeline 分发已经协议参数化：`provider.raw.resolve({ protocol, modelId })` 命中才透传，否则走 `model` capability；token-count 等旁路复用同一接口。

## 目标

- API provider 可声明多个协议端点；inbound 协议命中任一端点即 raw 透传，透传时 URL 构造、鉴权 header、流包装均按命中端点。
- 端点 `baseURL` 语义唯一且所见即所得：**等同于传给对应 `@ai-sdk/*` 包的 `baseURL` 入参**，raw 与桥接从同一个值出发，无隐式派生。
- 支持真实渠道的鉴权差异：anthropic 协议端点可选择 Bearer。
- 存量配置零回归：旧写法长期合法、行为冻结；磁盘配置从不主动重写。
- 存量用户零成本渐进迁移：保留原 `protocol`+`baseURL` 不动，追加 `endpoints` 即可。

## 非目标

- 渠道内跨协议降级重试（raw 失败后同渠道换协议桥接）。渠道内仍单次尝试，失败进入现有跨渠道 fallback。
- per-endpoint 的 `apiKey` / `headers` / `proxy` / `transforms` / `models` 覆盖。现实渠道各协议端点共用同一凭据与模型集；出现真实需求再做非破坏扩展。
- anthropic 之外协议的 `auth` 覆盖。当前无真实渠道证据；枚举扩展是非破坏变更。
- 桥接目标协议偏好配置。桥接固定使用主协议端点。
- Dashboard 表单与 provider mutation API 对 `endpoints` 的支持，以及 `replaceProvider` 保留清单的修改。已知编辑抹除风险（见 Dashboard 交接一节），在本需求 PR 描述中明确交接给进行中的 dashboard 重构需求。
- 配置文件的启动时迁移重写或旧写法硬废弃。
- probe 探测全部端点或逐端点状态展示。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 新字段 | `endpoints`，仅 API provider，可选 |
| 形态 | 数组 `[{ protocol, baseURL, auth? }]` 或共享对象 `{ baseURL, protocol: Protocol[] }`，二选一不混合 |
| 共享对象 | 纯语法糖：按 `protocol` 顺序展开为同 `baseURL` 的多个条目，无独立语义、不支持 `auth`（需要 `auth` 用数组形态） |
| 与旧字段共存 | 合并：旧 `protocol`+`baseURL` 作为主端点排最前，`endpoints` 为附加端点 |
| 主端点 | 旧字段存在时即旧字段；否则第一个条目（共享形态展开后的第一个） |
| baseURL 解释模式 | 仅两种：旧字段=`origin`（冻结现状）；endpoints 条目=`sdk`（ai-sdk 入参语义） |
| 鉴权 | 条目级可选 `auth: 'bearer' \| 'x-api-key'`，仅 anthropic 协议条目接受；缺省按协议推导（现状规则） |
| raw 匹配 | inbound 协议 ∈ 端点协议集 → 用该端点透传；否则主协议端点桥接 |
| 桥接 | 每 provider 仍只建一个 bridge，固定主协议端点，baseURL 原样传包 |
| probe | 只探主端点；probe 仅构造标准 inbound path/body，URL 改写完全由端点 transport 负责 |
| 归一化 | types 导出纯函数，仅在运行时物化点调用一次；schema 不做 transform，解析输出无镜像、无模式标签字段 |
| 校验 | union 级 `superRefine`：协议重复（含旧字段与 endpoints 之间）、空数组/空协议列表、旧字段只出现其一、`endpoints` 与旧字段皆缺、`auth` 用于非 anthropic 条目 → 配置无效 |
| 迁移 | 仅解析校验；旧写法长期合法；磁盘不主动重写 |

## 配置契约

```jsonc
{
  "providers": {
    // 一方渠道：各协议不同端点（z.ai 的 anthropic 端点要求 Bearer）
    "zai": {
      "kind": "api",
      "apiKey": "{{env.ZAI_API_KEY}}",
      "models": ["glm-4.7"],
      "endpoints": [
        { "protocol": "openai-compatible", "baseURL": "https://api.z.ai/api/paas/v4" },
        { "protocol": "anthropic", "baseURL": "https://api.z.ai/api/anthropic/v1", "auth": "bearer" },
      ],
    },

    // 聚合网关：openai 系与 anthropic 的 ai-sdk 入参同值，共享对象一行搞定
    "gateway": {
      "kind": "api",
      "apiKey": "{{env.GATEWAY_KEY}}",
      "models": ["gpt-5"],
      "endpoints": { "baseURL": "https://gw.example.com/v1", "protocol": ["openai-response", "anthropic"] },
    },

    // 存量渐进迁移：旧字段一行不改，追加 endpoints；旧字段即主端点
    "moonshot": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "https://api.moonshot.cn/v1",
      "apiKey": "{{env.MOONSHOT_API_KEY}}",
      "models": ["kimi-k2"],
      "endpoints": [{ "protocol": "anthropic", "baseURL": "https://api.moonshot.cn/anthropic/v1", "auth": "bearer" }],
    },
  },
}
```

字段规则：

- `endpoints` 省略时行为与今天完全一致。
- 配了 `endpoints` 时，顶层 `protocol`+`baseURL` 可整对省略或整对保留；只出现其一 → 配置无效。
- 同一协议在合并后的端点集中最多出现一次；重复 → 配置无效（进入现有 `invalidProviders` 流程）。
- `auth` 仅 anthropic 协议条目接受：`'bearer'`（`Authorization: Bearer`）或 `'x-api-key'`（缺省，同现状）。共享对象形态不承载 `auth`。
- authoring 层 `endpoints` 内字符串值支持 `{{env.NAME}}` 模板，跟随现有 authoring/materialized 双 schema 模式。
- `apiKey` / `headers` / `proxy` / `transforms` / `models` / `alias` / `metadata` 保持 provider 级，作用于全部端点。

## baseURL 两种解释模式

| 模式 | 来源 | 透传 URL 构造 | 桥接 baseURL |
| --- | --- | --- | --- |
| `origin` | 旧 `protocol`+`baseURL` | 冻结现状：origin + inbound 完整路径（丢弃 baseURL path） | 完整 baseURL 原样传包（现状不变） |
| `sdk` | endpoints 条目（数组或共享展开） | baseURL + 协议操作路径（inbound 路径剥去版本前缀的剩余部分），query 原样保留 | 同一 baseURL 原样传包 |

`sdk` 模式的用户心智：**baseURL 写你会传给对应 `@ai-sdk/*` 包的那个值**；raw 透传的拼接行为与该包一致。

各协议的版本前缀与操作路径：

| 协议 | inbound 路径 → 追加到 baseURL 的操作路径 |
| --- | --- |
| `openai-compatible` | `/v1/chat/completions` → `/chat/completions` |
| `openai-response` | `/v1/responses` → `/responses` |
| `anthropic` | `/v1/messages` → `/messages`；`/v1/messages/count_tokens` → `/messages/count_tokens` |
| `gemini` | `/v1beta/models/...` → `/models/...` |

推论与文档义务：

- 同根网关上 openai 系与 anthropic 的 ai-sdk 入参是同一个值（`{root}/v1`），共享对象因此成立且无任何派生；**gemini 的入参是 `{root}/v1beta`，不能与 `/v1` 系共用一个共享对象**，需单独数组条目。
- 渠道文档给 vendor SDK 的 anthropic 根地址（`ANTHROPIC_BASE_URL`，如 `https://api.z.ai/api/anthropic`）写进 endpoints 时需补 `/v1`。文档列出主流渠道（z.ai / Moonshot / DeepSeek / 聚合网关）的确切值。
- 单元素数组与旧写法同值不同义（`sdk` vs `origin`）。文档明确引导：单协议继续用旧写法；多协议用 `endpoints`。

## 鉴权

- 有效鉴权风格按命中条目决定：anthropic 缺省 `x-api-key`、可覆盖为 `bearer`；gemini 固定 `x-goog-api-key`；openai 系固定 `Bearer`。`origin` 条目冻结现状（协议推导，无覆盖）。
- raw 透传：`upstreamHeaders` 按有效风格写入 `Authorization: Bearer` / `x-api-key` / `x-goog-api-key`，其余 header 处理（剥离客户端凭据、provider `headers` 最后写入且最终获胜）不变。
- 桥接：主端点为 anthropic 且 `auth: 'bearer'` 时，`@ai-sdk/anthropic` 用 `authToken` 选项替代 `apiKey`（二者互斥已实证）；其余组合沿用现状 `apiKey` 注入。

## 数据流

### Schema 与归一化（packages/types）

- `ApiProviderSchema` / `ApiProviderAuthoringSchema` 增加 `endpoints` 输入形态；`protocol`/`baseURL` 变为可选（成对约束在 refine 中保证）。对象 schema 保持纯 `z.object`，`.omit()` 组合不受影响。
- 端点相关校验实现为 union 级 `superRefine`（与 `validateAliasTargets` 同位，纯校验、幂等，两段解析下安全）。
- 归一化是 types 导出的**纯函数**（如 `apiProviderEndpoints(provider)`）：输入解析后的 provider，输出非空端点数组 `{ protocol, baseURL, auth?, mode: 'origin' | 'sdk' }[]`，主端点恒为下标 0。三种写法的展开：仅旧字段 → `[origin]`；旧字段+endpoints → `[origin, ...sdk 条目]`；仅 endpoints → sdk 条目（共享对象按 `protocol` 顺序展开）。
- 解析输出（`Provider` 类型、Dashboard API、mutation 流）**不包含**归一化结果或模式标签；归一化只在运行时物化点调用，每个 provider 一次。

### raw 透传（packages/core / packages/server）

- `materializeRuntimeProvider` 在物化时调用归一化函数，`raw.resolve({ protocol })` 从"等于单一 protocol"改为"在端点集中查找条目"；命中即返回绑定该条目的 invoke。
- `createApiProvider` 按条目构造透传：URL 按条目模式拼接（`origin` 现状 / `sdk` 操作路径），鉴权按条目有效风格，`wrapOpenAIProtocolFetch` 按条目协议包装。inbound query、method、body、signal、SSE tee/trace 行为不变。
- token-count 等复用 `raw.resolve` 的路径自动获得多协议匹配，无需单独改动。

### 桥接（packages/core）

`bridgeApiProviderToAiSdk` 改读主端点：协议 → AI SDK 包映射不变；baseURL 原样传包（两种模式一致，桥接代码无需感知模式）；anthropic + `bearer` 时改用 `authToken`。每 provider 仍只建一个 bridge。

### probe（packages/server）

probe 只构造**标准 inbound path/body**（协议形状的探测请求），经主端点的同一条 raw invoke 路径发出，URL 改写完全由端点 transport 负责——probe 自身不做任何 baseURL 拼接，杜绝双重前缀。单状态语义不变；附加端点故障在真实请求失败时通过现有 attempt 日志暴露。

### 展示（packages/server）

`providerDisplayFields` / summary 的 `protocol` 显示主端点协议（经归一化函数取得），`passthrough` 标志不变。Dashboard read model 形状零变化。

### 不受影响

候选排序（Provider weight）、session affinity、cooldown、usage 计量、attempt trace 字段语义（raw 的 `targetProtocol` = inbound 协议）、`modelRoutes` 模型目录、list-models。

## Dashboard 交接（已知风险，本轮不修）

dashboard 的 `replaceProvider` 是"整体替换 + 手工保留清单"，`endpoints` 不在清单中：**通过 dashboard 编辑配了 `endpoints` 的 provider 会静默丢掉该字段**。经确认本轮不改 `replaceProvider`、不扩展 mutation schema；处置方式：

- 本需求的 PR 描述中明确列出该风险与复现路径，点名由进行中的 dashboard 重构需求补齐 `endpoints` 的 mutation schema、保留/编辑能力；
- 用户文档在 `endpoints` 章节附带警告。

只读展示不受影响。

## 模块边界

- `packages/types`：`endpoints`/`auth` authoring 与 materialized 输入 schema、union 级校验 refine、归一化纯函数与类型，colocated 测试。
- `packages/core`：`createApiProvider` 按条目透传（两模式 URL 拼接、鉴权风格、流包装）、`bridgeApiProviderToAiSdk` 主端点取值与 `authToken` 映射。
- `packages/server`：`materializeRuntimeProvider` 端点集 `raw.resolve`、probe 标准路径化、summary 主协议取值。pipeline 候选循环不动。
- `packages/dashboard`：无改动。
- 文档：`npm/aio-proxy/README.md`（仓库根 `README.md` 是其符号链接）；将根目录 typo 文件 `READNE.zh-Hans.md` 重命名为 `README.zh-Hans.md` 并校正仓内引用，同步补充中英文 `endpoints` 章节；website getting-started（en/zh）补两种形态示例、主流渠道 baseURL 对照、gemini 例外、dashboard 编辑警告。
- changeset：minor，目标 `aio-proxy` 与实际改动的内部包（`@aio-proxy/core` 等）。

## 测试策略

### Schema 与归一化（types）

- 三种写法的归一化展开、模式标签、主端点次序正确；共享对象按协议顺序展开。
- 重复协议（含旧字段与 endpoints 之间）、空数组、空协议列表、旧字段只出现其一、`auth` 用于非 anthropic 条目 → provider 无效且进入 `invalidProviders`。
- 仅旧字段时归一化输出与现状行为等价（存量零回归的 schema 层证据）。
- `{{env.NAME}}` 模板在 endpoints 内字符串值上展开。
- 两段解析（`ProviderInputValueSchema` → `ProviderSchema`)下结果稳定，无重复合并。

### 透传与桥接（core）

- 两种模式的 URL 拼接：`origin` 保持现状；`sdk` 按操作路径表拼接（含 anthropic count_tokens、gemini `/models/...`）；query 原样保留。
- 命中非主协议端点时鉴权风格与流包装按该端点；anthropic `auth: 'bearer'` 在 raw 发 `Authorization: Bearer` 且不发 `x-api-key`。
- 桥接使用主端点 baseURL 原样传包；anthropic + `bearer` 走 `authToken`；对照各包实际请求 URL 与鉴权 header 断言。

### 分发矩阵与 probe（server）

- inbound 协议命中任一端点 → raw 透传该端点；不命中 → 主协议桥接；沿用现有 dispatch-matrix 测试模式扩展。
- probe 请求只含标准 inbound 路径，最终上游 URL 由端点 transport 生成（断言无双重前缀）。
- 仅旧字段的 provider 全链路行为不变（回归护栏）。

## 拒绝的替代方案

### 在 `ApiProviderSchema` 上做 transform 归一化并输出顶层镜像

配置解析是两段式，transform 会执行两次：第一次产出的镜像与归一化数组在第二次解析时被再次合并，触发重复协议误报；且 ZodEffects 无 `.omit()`，破坏现有 schema 组合。归一化改为运行时单次调用的纯函数，校验留在 union 级 refine。

### 共享对象用"网关根"语义 + 按协议派生桥接地址

初版设计。`@ai-sdk/anthropic`/`@ai-sdk/google` 实测要求版本段前缀，"根"必须经一张隐式派生表（openai 系补 `/v1`、anthropic 补 `/v1`、gemini 补 `/v1beta`）才能用，配置里写的 URL 与实际请求不一致，排查成本高。统一为"ai-sdk 入参"语义后派生表消失，共享对象退化为纯语法糖。

### 删掉共享对象形态

评审建议的收敛方案。在"网关根"语义下成立（少一套语法、一个模式、一批分支）；但统一为"ai-sdk 入参"语义后共享对象无独立语义、归一化只是一次展开，保留它的成本接近零，而网关场景的配置紧凑度收益真实。经确认保留。

### 全局统一旧写法为 `sdk` 语义

今天的透传忽略 baseURL path，存量 origin-only 的 openai 系配置（合法且工作中）统一后透传会打到错误路径。README 惯例（带 `/v1`）不受影响不足以豁免其余存量。旧写法冻结为 `origin` 模式。

### 任意 per-endpoint headers 覆盖

鉴权差异的真实需求只有 anthropic 的 Bearer/x-api-key 之分。开放任意 headers 会与 provider 级 `headers`（最后写入且最终获胜）形成两层合并规则；用最小 `auth` 枚举覆盖已证实的需求，枚举扩展是非破坏变更。

### 旧字段与 endpoints 互斥报错

无歧义但堵死了"存量配置追加一行"的迁移路径，强迫用户重写已工作的配置。合并规则（旧字段=主端点）与"旧写法=首选单协议写法"的文档口径一致。

### 启动时迁移重写配置文件

配置支持 jsonc 注释；只有 dashboard 主动写操作才允许整文件重写。服务启动时改写会让从不使用 dashboard 的手写配置用户无辜丢注释。

### 渠道内跨协议降级重试

改变"每渠道单次尝试"的候选循环契约，放大故障传播面；本轮动机是保真而非可用性，且现有跨渠道 fallback 已覆盖失败转移。
