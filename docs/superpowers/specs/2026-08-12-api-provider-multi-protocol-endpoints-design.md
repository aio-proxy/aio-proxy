# API Provider 多协议端点设计

- 日期：2026-08-12
- 状态：待用户评审

## 背景

部分上游渠道原生同时提供多种 API 协议：z.ai / Moonshot / DeepSeek 在同一 origin 下用不同 path 前缀暴露 OpenAI 与 Anthropic 端点；new-api / LiteLLM / aio-proxy 级联这类聚合网关在同一个根上按标准路径服务多协议。

aio-proxy 的 API provider 目前只能声明一个 `protocol` + 一个 `baseURL`。inbound 协议与该协议不同时，即使渠道原生支持 inbound 协议，也会落入有损的 AI SDK 桥接。本设计让 API provider 声明多个协议端点：inbound 命中任一端点协议即走 raw 透传，最大化保真。

现状中的关键事实（决定了本设计的语义分层）：

- raw 透传的 URL 重写是 `upstreamUrl.pathname = incomingUrl.pathname`，即 **baseURL 自带的 path 前缀被丢弃，只用 origin**；而 AI SDK 桥接使用完整 baseURL。README 教的写法是 `https://api.openai.com/v1`（带版本段），origin-only 写法也因透传忽略 path 而同样工作。存量配置两种写法并存，任何全局语义统一都会破坏其中一类。
- pipeline 分发已经协议参数化：`provider.raw.resolve({ protocol, modelId })` 命中才透传，否则走 `model` capability，扩展点天然存在。
- 鉴权 header 风格（`x-api-key` / `x-goog-api-key` / `Bearer`）、流包装 `wrapOpenAIProtocolFetch`、probe 请求构造均已按协议分支。

## 目标

- API provider 可声明多个协议端点；inbound 协议命中任一端点即 raw 透传，透传时鉴权 header、流包装、URL 构造均按命中端点的协议。
- 支持两类真实渠道形态：per-protocol baseURL（一方渠道）与共享根 baseURL（聚合网关）。
- 存量配置零回归：旧写法长期合法、行为冻结；磁盘配置从不主动重写。
- 存量用户零成本渐进迁移：保留原 `protocol`+`baseURL` 不动，追加 `endpoints` 即可。

## 非目标

- 渠道内跨协议降级重试（raw 失败后同渠道换协议桥接）。渠道内仍单次尝试，失败进入现有跨渠道 fallback。
- per-endpoint 的 `apiKey` / `headers` / `proxy` / `transforms` / `models` 覆盖。现实渠道各协议端点共用同一凭据与模型集；出现真实需求再做非破坏扩展。
- 桥接目标协议偏好配置。桥接固定使用主协议端点。
- Dashboard 表单与 provider mutation API 对 `endpoints` 的支持（由进行中的 dashboard 重构需求承接）。`replaceProvider` 保留清单本轮不加 `endpoints`。
- 配置文件的启动时迁移重写或旧写法硬废弃。
- probe 探测全部端点或逐端点状态展示。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 新字段 | `endpoints`，仅 API provider，可选 |
| 形态 | 数组 `[{ protocol, baseURL }]` 或共享对象 `{ baseURL, protocol: Protocol[] }`，二选一不混合 |
| 与旧字段共存 | 合并：旧 `protocol`+`baseURL` 作为主端点排最前，`endpoints` 为附加端点 |
| 主端点 | 旧字段存在时即旧字段；否则数组第一个条目 / 共享形态 `protocol` 数组第一个 |
| 归一化 | zod transform 解析时把三种写法打平为统一端点数组，每条目带 baseURL 解释模式标签 |
| baseURL 解释模式 | 旧字段=`origin`（冻结现状）；数组条目=`sdk`；共享条目=`root` |
| raw 匹配 | inbound 协议 ∈ 端点协议集 → 用该端点透传；否则主协议端点桥接 |
| 桥接 | 每 provider 仍只建一个 bridge，固定主协议端点 |
| probe | 只探主端点，维持单状态 |
| 校验 | 协议重复（含旧字段与 endpoints 之间）、空数组、空协议列表、`endpoints` 与旧字段皆缺 → 配置无效 |
| 迁移 | 仅解析归一化；旧写法长期合法；磁盘不主动重写 |

## 配置契约

```jsonc
{
  "providers": {
    // 一方渠道：各协议不同端点（数组形态，SDK 语义）
    "zai": {
      "kind": "api",
      "apiKey": "{{env.ZAI_API_KEY}}",
      "models": ["glm-4.7"],
      "endpoints": [
        { "protocol": "openai-compatible", "baseURL": "https://api.z.ai/api/paas/v4" },
        { "protocol": "anthropic", "baseURL": "https://api.z.ai/api/anthropic" },
      ],
    },

    // 聚合网关：同根标准路径（共享形态，根语义）
    "gateway": {
      "kind": "api",
      "apiKey": "{{env.GATEWAY_KEY}}",
      "models": ["gpt-5"],
      "endpoints": { "baseURL": "https://gw.example.com", "protocol": ["openai-response", "anthropic", "gemini"] },
    },

    // 存量渐进迁移：旧字段一行不改，追加 endpoints；旧字段即主端点
    "moonshot": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "https://api.moonshot.cn/v1",
      "apiKey": "{{env.MOONSHOT_API_KEY}}",
      "models": ["kimi-k2"],
      "endpoints": [{ "protocol": "anthropic", "baseURL": "https://api.moonshot.cn/anthropic" }],
    },
  },
}
```

字段规则：

- `endpoints` 省略时行为与今天完全一致。
- 配了 `endpoints` 时，顶层 `protocol`+`baseURL` 可整对省略或整对保留；只出现其一 → 配置无效。
- 同一协议在合并后的端点集中最多出现一次；重复 → 配置无效（进入现有 `invalidProviders` 流程）。
- authoring 层 `endpoints` 内字符串值支持 `{{env.NAME}}` 模板，跟随现有 authoring/materialized 双 schema 模式。
- `apiKey` / `headers` / `proxy` / `transforms` / `models` / `alias` / `metadata` 保持 provider 级，作用于全部端点。

## baseURL 三种解释模式

归一化后每个端点条目携带解释模式标签（内部字段，建议名 `baseUrlMode: 'origin' | 'sdk' | 'root'`）：

| 模式 | 来源 | 透传 URL 构造 | 桥接 baseURL |
| --- | --- | --- | --- |
| `origin` | 旧 `protocol`+`baseURL` | 冻结现状：origin + inbound 完整路径（丢弃 baseURL path） | 完整 baseURL（现状不变） |
| `sdk` | 数组条目 | 按该协议官方 SDK 的 baseURL 语义拼接（见下） | 同一 baseURL，raw 与桥接一致 |
| `root` | 共享条目 | 根前缀 + inbound 标准路径（含 query 原样保留） | 按主协议从根派生（见下） |

`sdk` 模式的用户心智是"照抄渠道文档给该协议官方 SDK 的值"：

- `openai-compatible` / `openai-response`：baseURL 含版本段（如 `…/v1`、`…/api/paas/v4`）。透传把 inbound 路径的 `/v1` 前缀剥掉后拼接：`/v1/chat/completions` → `{base}/chat/completions`，`/v1/responses` → `{base}/responses`。
- `anthropic`：baseURL 为根（官方 SDK 的 `ANTHROPIC_BASE_URL` 语义，如 `https://api.z.ai/api/anthropic`）。透传拼接完整 inbound 路径：`/v1/messages` → `{base}/v1/messages`。
- `gemini`：baseURL 为根（官方 GenAI SDK 语义）。透传拼接完整 inbound 路径：`/v1beta/models/...` → `{base}/v1beta/models/...`。
- 即 `anthropic` / `gemini` 的 `sdk` 模式与 `root` 模式等价；仅 openai 系有版本段差异。

`root` 模式桥接派生规则：openai 系 = `{root}/v1`；`anthropic` / `gemini` = `{root}`。各 `@ai-sdk/*` 包自身的 baseURL 约定（是否内含 `/v1`、`/v1beta`）在实现时逐包核对，派生值以"该包收到后的实际请求 URL 与渠道端点一致"为准。

已知文档义务：单元素数组与旧写法同值不同义（`sdk` vs `origin`）。文档明确引导：单协议继续用旧写法；多协议用 `endpoints`；新写法 baseURL 照抄渠道 SDK 文档。

## 数据流

### 归一化（packages/types）

`ApiProviderSchema` 增加 `endpoints` 输入形态，transform 输出：

- `endpoints: readonly NormalizedProtocolEndpoint[]`（非空，含解释模式标签），主端点恒为 `endpoints[0]`；
- 顶层 `protocol` / `baseURL` 保留为主端点镜像，**仅供展示与身份读取**（dashboard summary、日志字段等）；所有 URL 构造必须读端点条目。

三种输入的归一化：

1. 仅旧字段 → `[origin(protocol, baseURL)]`（与今天的单协议行为逐字节一致）。
2. 旧字段 + endpoints → `[origin(protocol, baseURL), ...endpoints 条目]`。
3. 仅 endpoints → 数组条目逐个转 `sdk` 条目；共享对象按 `protocol` 顺序展开为多个 `root` 条目（共享同一 baseURL）。

### raw 透传（packages/core / packages/server）

- `materializeRuntimeProvider` 的 `raw.resolve({ protocol })` 从"等于单一 protocol"改为"在端点集中查找条目"；命中即返回绑定该条目的 invoke。
- `createApiProvider` 按条目构造透传：URL 按条目解释模式拼接；`upstreamHeaders` 的鉴权 header 风格按条目协议；`wrapOpenAIProtocolFetch` 按条目协议包装。inbound query、method、body、signal、SSE tee/trace 行为不变。
- token-count 等复用 `raw.resolve` 的路径自动获得多协议匹配，无需单独改动。

### 桥接（packages/core）

`bridgeApiProviderToAiSdk` 改读主端点：协议 → AI SDK 包映射不变；baseURL 按主端点解释模式取值（`origin`/`sdk` 直取，`root` 按派生规则）。每 provider 仍只建一个 bridge。

### probe（packages/server）

`providerProbeRequest` 改读主端点，URL 构造按主端点解释模式（不再对 `sdk`/`root` 条目做 origin-替换）。单状态语义不变；附加端点故障在真实请求失败时通过现有 attempt 日志暴露。

### 不受影响

候选排序（Provider weight）、session affinity、cooldown、usage 计量、attempt trace 字段语义（raw 的 `targetProtocol` = inbound 协议）、`modelRoutes` 模型目录、list-models。

## Dashboard 风险（已知并接受）

dashboard 的 `replaceProvider` 是"整体替换 + 手工保留清单"。本轮不把 `endpoints` 加入保留清单、不扩展 mutation schema：**通过 dashboard 编辑配了 `endpoints` 的 provider 会静默丢掉该字段**。处置：

- 文档（README / website）中明确警告；
- dashboard 重构需求承接 mutation schema 扩展与表单编辑。

只读展示不受影响：summary 的 `protocol` 显示主协议，`passthrough` 标志不变。

## 模块边界

- `packages/types`：`endpoints` authoring/materialized schema、归一化 transform、`NormalizedProtocolEndpoint` 类型与校验（重复协议、空数组、字段成对约束），colocated 测试。
- `packages/core`：`createApiProvider` 按条目透传（URL 拼接三模式、header 风格、流包装）、`bridgeApiProviderToAiSdk` 主端点取值与 `root` 派生。
- `packages/server`：`materializeRuntimeProvider` 端点集 `raw.resolve`、probe 主端点构造。pipeline 候选循环不动。
- `packages/dashboard`：无改动。
- 文档：README.md、READNE.zh-Hans.md、website getting-started（en/zh）补两种形态示例、语义差异说明、dashboard 编辑警告。
- changeset：minor，目标 `aio-proxy` 与实际改动的内部包（`@aio-proxy/core` 等）。

## 测试策略

### Schema 归一化（types）

- 三种写法各自归一化结果与解释模式标签正确；合并形态主端点为旧字段。
- 重复协议（含旧字段与 endpoints 之间）、空数组、空协议列表、旧字段只出现其一 → provider 无效且进入 `invalidProviders`。
- 仅旧字段时输出与现状逐字段一致（存量零回归的 schema 层证据）。
- `{{env.NAME}}` 模板在 endpoints 内字符串值上展开。

### 透传与桥接（core）

- 三种解释模式的 URL 拼接：`origin` 保持现状；`sdk` 对 openai 系剥 `/v1`、对 anthropic/gemini 拼完整路径；`root` 前缀拼接；query 原样保留。
- 命中非主协议端点时鉴权 header 风格与流包装按该端点协议。
- 桥接使用主端点；`root` 主端点的派生 baseURL 使该 AI SDK 包发出的请求命中渠道端点。

### 分发矩阵（server）

- inbound 协议命中任一端点 → raw 透传该端点；不命中 → 主协议桥接；沿用现有 dispatch-matrix 测试模式扩展。
- probe 使用主端点与其解释模式。
- 仅旧字段的 provider 全链路行为不变（回归护栏）。

## 拒绝的替代方案

### 全局统一为 SDK 语义

三种写法一个规则最简洁，但今天的透传忽略 baseURL path，存量 origin-only 的 openai 系配置（合法且工作中）在统一后透传会打到错误路径。README 惯例（带 `/v1`）不受影响不足以豁免其余存量。

### 全局统一为根语义

README 自己教的 `https://api.openai.com/v1` 会拼出 `/v1/v1/...` 直接破坏，被事实排除。

### 智能拼接启发式

"去掉 baseURL 尾部已知版本段再根拼接"可让常见配置零回归，但规则含魔法、边角（非标准版本段如 `/api/paas/v4`）无法判定，解释成本高于三模式标签。

### 旧字段与 endpoints 互斥报错

无歧义但堵死了"存量配置追加一行"的迁移路径，强迫用户重写已工作的配置。合并规则（旧字段=主端点）与"旧写法=首选单协议写法"的文档口径一致。

### per-endpoint 凭据/模型覆盖

现实多协议渠道各端点共用凭据与模型集。`raw.resolve` 已接收 `modelId`，未来加 per-endpoint 白名单是非破坏扩展；现在不做。

### 启动时迁移重写配置文件

配置支持 jsonc 注释；只有 dashboard 主动写操作才允许整文件重写。服务启动时改写会让从不使用 dashboard 的手写配置用户无辜丢注释。

### 渠道内跨协议降级重试

改变"每渠道单次尝试"的候选循环契约，放大故障传播面；本轮动机是保真而非可用性，且现有跨渠道 fallback 已覆盖失败转移。
