# OpenAI Responses opencode 入站兼容与可观测性设计

日期：2026-07-17  
状态：待书面评审

## 背景

opencode 1.18.3 通过 aio-proxy 的 OpenAI Responses 端点调用 `gpt-5.6-terra` 时，请求在本地入站校验阶段返回：

```text
400 Invalid OpenAI Responses request
```

根因是 AI SDK 将 `gpt-5*` 识别为 reasoning model，并把 system prompt 编码为 `developer` 消息；aio-proxy 当前只接受 `system`、`user` 和 `assistant`。同一限制还会在工具调用后的下一轮暴露：Responses API 使用 `function_call`、`function_call_output` 和 `reasoning` Item 表达代理历史，而当前入站 schema 只接受消息数组。

该失败没有出现在 Dashboard Request logs 或 dev 控制台。共享 pipeline 在 `adapter.parse()` 成功、Router 成功解析候选之后，才在 `attemptCandidates()` 中创建 request recording session。JSON、schema、body limit 和 model-not-found 等早期失败会直接返回，绕过记录器，也没有结构化日志调用。

## 目标

本轮完成两个相关目标：

1. OpenAI Responses 入站协议支持 opencode 的文本与函数工具完整请求循环。
2. Request logs 覆盖所有进入共享 pipeline 的终态请求，包括尚未进入 Provider attempt 的本地拒绝。

完成后，首轮 `developer` 请求和工具执行后的后续请求均可通过同协议 raw passthrough；跨协议路由保留可表示的消息与函数工具语义；本地解析失败可同时在 Dashboard Request logs 和 dev 控制台中定位。

## 非目标

- 不实现 Responses API 的所有内建工具和所有未来 Item 类型。
- 不记录请求体、响应体、prompt、工具参数、headers、API key 或凭据。
- 不改变 Provider fallback、权重、raw/model capability 选择或 usage capture 语义。
- 不让 route 或 adapter 直接访问数据库。
- 不为 opencode 增加客户端名称检测或专属分支。
- 不改变当前面向客户端的通用 OpenAI 错误体。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 兼容层 | 扩展正式 OpenAI Responses adapter，不识别 opencode 客户端 |
| 同协议请求 | 保持原始 Request；schema 只负责路由与能力判定 |
| 跨协议请求 | 将文本消息、function call 和 function output 转成 AI SDK `ModelMessage` |
| reasoning Item | raw 路径原样保留；model 路径不转发不透明 reasoning state |
| 无法跨协议表示的 Item | 在 model invocation 阶段返回明确的 `unsupported_feature` |
| Request session | 在 parse 前开始，parse 成功后补充 requested model ID |
| 未解析模型显示 | 使用稳定占位符 `<unparsed>`，不修改数据库 nullable 约束 |
| 控制台日志 | 输出脱敏的结构化 `request.rejected` 事件 |

## OpenAI Responses 入站模型

### 支持的消息

消息 Item 支持以下角色：

- `system`
- `developer`
- `user`
- `assistant`

本轮继续支持字符串 content 和现有文本 content part。`developer` 与 `system` 在跨协议 model path 中都转换为内部 system message；raw path 不重写角色。

### 支持的代理历史 Item

为覆盖 opencode 的普通函数工具循环，入站 `input` 数组新增：

```ts
type FunctionCallItem = {
  readonly type: "function_call";
  readonly call_id: string;
  readonly name: string;
  readonly arguments: string;
  readonly id?: string;
};

type FunctionCallOutputItem = {
  readonly type: "function_call_output";
  readonly call_id: string;
  readonly output: string | readonly FunctionOutputContentPart[];
};

type ReasoningItem = {
  readonly type: "reasoning";
  readonly id?: string;
  readonly encrypted_content?: string | null;
  readonly summary: readonly ReasoningSummaryPart[];
};
```

`function_call` 和 `function_call_output` 是跨协议可转换的正式支持项。`reasoning` 是 passthrough-safe 项：schema 接受并保留原始请求，但跨协议转换不会把隐藏 reasoning state 当作可见文本发送给其他 Provider。

Responses `item_reference` 可以由保存型会话产生。本轮允许它通过入站解析和同协议 raw passthrough，但由于 aio-proxy 无法在本地解析远端 Item 引用，跨协议 model path 返回 `unsupported_feature: item_reference`，不得静默丢弃。

其他 Responses 内建工具 Item，例如 `computer_call`、`shell_call`、`apply_patch_call`、`file_search_call` 和对应 output，不属于本轮 opencode 普通函数工具兼容范围。它们应被识别为不支持并返回 501，而不是落入通用 400 schema 错误。

### 模块边界

当前 `packages/core/src/ingress/openai-responses.ts` 同时包含 envelope、消息、工具和 unsupported probe。新增 Item 后会接近或超过文件限制，因此改为协议私有目录：

```text
packages/core/src/ingress/openai-responses/
  index.ts          # 公共类型、request envelope、parse orchestration
  input-items.ts    # message/function/reasoning/reference schemas
  tools.ts          # request tool schemas 与 unsupported tool 判定
```

高层 import 继续引用 `../ingress/openai-responses`，私有模块不从更高层 barrel 导出。

## 跨协议转换

### 消息转换

转换规则为：

| Responses Item | 内部 ModelMessage |
| --- | --- |
| `system` | `role: "system"` |
| `developer` | `role: "system"` |
| `user` | `role: "user"` |
| `assistant` 文本 | `role: "assistant"` |
| `reasoning` | 不产生消息 |

`developer` 合并到内部 system 语义，是因为 AI SDK 的统一 `ModelMessage` 没有 developer role；目标 Provider 的 adapter 再按其协议决定 system 表示。

### 函数工具转换

当前转换使用 `request.input.map(inputMessage)`，无法表达 call/output 配对。本轮改为一个局部、有序转换循环：

1. 遇到 `function_call` 时解析 JSON `arguments`，生成 assistant `tool-call` part。
2. 记录 `call_id -> tool name`，供后续 output 使用。
3. 连续的 `function_call` 聚合为一个 assistant message 中的多个 tool-call parts；assistant 文本 Item 保持独立 assistant message，整体输入顺序不变。
4. 遇到 `function_call_output` 时，通过 `call_id` 找到工具名，生成 tool `tool-result` part。
5. 连续的 `function_call_output` 聚合为一个 tool message；output 字符串映射为 text result，文本 content parts 映射为 content result。
6. 图片、文件等暂不能由跨协议工具结果稳定表示的 output content part 返回明确的 unsupported error，不静默过滤。
7. output 找不到对应 call 时抛出带安全字段路径的 `OpenAIResponsesTransformError`，不伪造工具名。
8. 无效 JSON arguments 同样返回本地 invalid request，不把字符串包装成猜测对象。

同协议 raw path 始终使用原始 Request，因此不会受到上述有损转换影响。只有协议不同或 Provider 仅有 model capability 时才执行转换。

## Request logs 生命周期

### 当前缺口

当前顺序为：

```text
size guard
  -> parse
  -> model extraction
  -> router.resolve
  -> requestRecorder.begin
  -> provider attempts
```

因此以下终态不会写入 Request logs：

- invalid/oversized `Content-Length`；
- 流式读取时超过 body limit；
- JSON syntax error；
- Zod/schema error；
- protocol transform error during parse；
- requested model 不存在；
- 在创建 Provider attempt 前发生的其他已映射本地错误。

### 新生命周期

共享 pipeline 改为：

```text
requestRecorder.begin({ inboundProtocol })
  -> size guard
  -> parse
  -> session.identify({ requestedModelId })
  -> router.resolve
  -> provider attempts using the same session
  -> exactly one finish
```

`RequestRecorder.begin()` 不再要求调用方已经知道模型。`RequestSession` 新增 `identify()` 操作；pipeline 正常只调用一次，同一值的重复调用幂等，冲突的第二个值属于编程错误并抛出。session 内部在落库前持有 requested model ID。若请求在 identify 前结束，使用 `<unparsed>`。这样保留 `request_log.requested_model_id NOT NULL` 和现有 Dashboard response schema，不引入数据库 migration。

`attemptCandidates()` 接收已创建的 session，不再自行创建第二个 session。所有 return 分支必须由 pipeline 或 candidate loop 恰好调用一次 `finish()`；记录器现有的 finished guard 继续作为防御，而不是生命周期编排手段。

model-not-found 在已 identify 后记录真实 requested model ID、404 status 和稳定 error code。parse/body-limit 失败记录 `<unparsed>`、对应 status 和本地 error code，attempts 数组为空。本轮内部 Request log error code 固定为 `invalid_request`、`request_too_large` 和 `model_not_found`；它们不依赖不同出站协议错误体中的字段名称。

## 结构化控制台日志

### 事件形状

已映射的本地入站拒绝输出一条 JSON 日志：

```ts
type RequestRejectedLog = {
  readonly event: "request.rejected";
  readonly requestId: string;
  readonly inboundProtocol: string;
  readonly requestedModelId?: string;
  readonly path: string;
  readonly statusCode: number;
  readonly errorCode: string;
  readonly errorType: string;
  readonly issues?: readonly {
    readonly code: string;
    readonly path: readonly (string | number)[];
  }[];
};
```

`path` 只记录 URL pathname。日志不包含 query string，以避免未来 query 参数携带敏感信息。Zod issues 只保留 code 与 path，不记录 received input、完整 message 或 union 分支中的原值。

### 日志接缝

Server state 已有 JSON stderr logger，但类型目前仅接受 config reload 事件。将其扩展为 server log union，并通过 `ProviderRouteSource` 提供给共享 pipeline。默认实现继续 `console.error(JSON.stringify(entry))`；测试注入内存 sink。

Request recorder 的存储失败 logger 也接入同一 server logger，避免 SQLite 写入失败继续被静默吞掉。存储失败使用独立事件，不冒充请求拒绝。

只有本地生成的、已映射拒绝写 `request.rejected`。raw upstream 4xx/5xx 已由 Request logs 的 final status 和 attempts 表达，不重复输出同名 ingress 日志。

## 错误分类

| 情况 | 客户端响应 | Request log | 控制台事件 |
| --- | --- | --- | --- |
| JSON/schema invalid | 协议形状 400 | failure，无 attempts | `request.rejected` |
| body too large | 协议形状 413 | failure，无 attempts | `request.rejected` |
| model not found | 协议形状 404 | failure，无 attempts | `request.rejected` |
| unsupported Responses Item on model path | 协议形状 501 | failure，包含当前 candidate attempt | 不新增 ingress 事件 |
| raw upstream 4xx | 原始 upstream response | failure，包含 attempt | 不新增 ingress 事件 |
| Provider/AI SDK failure | 现有映射响应 | failure/cancelled，包含 attempts | 保持现有行为 |

本轮不把详细 Zod path 返回客户端。客户端继续得到稳定、协议兼容的通用消息；详细诊断仅进入本地脱敏日志。

## 测试策略

严格按 TDD 分阶段完成。

### Core ingress tests

- `developer` 消息由当前失败变为成功。
- `function_call`、`function_call_output`、`reasoning` 和 `item_reference` 的合法最小形状可解析。
- 空 call ID、空工具名和缺少 output 被拒绝。
- 已知但不支持的内建 Item 返回 `OpenAIResponsesUnsupportedFeatureError`。
- 现有 unsupported request features（如 `previous_response_id`、`store: true`）行为保持不变。

### Core transform tests

- `developer` 转为 system message。
- function call arguments 转为 assistant tool-call part。
- function output 按 call ID 转为带正确工具名的 tool-result part。
- 多个并行 function calls 与 outputs 保持顺序和配对。
- reasoning 不产生跨协议可见文本。
- orphan output、无效 arguments 和 item reference 在 model path 返回明确错误。
- model messages 转回 Responses 的现有行为不回归。

### Pipeline tests

- parse 失败仍只调用一次 adapter parse，不调用 Router 或 Provider。
- parse 失败写入一条 failure Request log，requested model 为 `<unparsed>`，attempts 为空。
- parse 失败输出一条脱敏 `request.rejected` 日志，且不包含请求正文中的唯一敏感 marker。
- body too large 和 model-not-found 同样完成 session。
- 正常请求只创建一个 session，现有 attempt/fallback 顺序不变。
- request-log store 写入失败产生独立结构化日志，但不改变 HTTP 响应。

### OpenAI Responses integration tests

- opencode 风格的首轮 `developer + user + tools` 请求进入同协议 raw provider。
- opencode 风格的 `reasoning + function_call + function_call_output` 后续请求原样进入同协议 raw provider。
- 同一后续请求路由到不同协议 model provider 时，得到正确 AI SDK tool history。
- alias model rewrite 只改变 model，保留所有 input Item 与未知 passthrough 字段。

按照仓库规则，实质修改模块中仍位于 `_test/` 的 Responses 测试迁移到源码旁。若 package 的 `test:unit` script 未覆盖 colocated tests，同一变更中修正 script。

## 实施顺序

1. 以当前 opencode 首轮请求建立失败 ingress/integration 测试。
2. 支持 developer，并验证首轮红绿循环。
3. 为 function call/output/reasoning 建立失败测试，再扩展 Item schema。
4. 将 Responses transform 改为有序状态转换并完成工具历史测试。
5. 为 parse failure Request logs 建立 pipeline 失败测试。
6. 把 request session 移到 parse 前，增加 identify 生命周期。
7. 增加脱敏 server log sink 与 Request recorder 存储失败日志。
8. 运行相关 package tests、`bun run check`，最终运行 `bun run preflight`。

## 安全与隐私

- Request logs 继续只保存元数据，不保存 request/response body。
- 控制台不记录 prompt、tool arguments、tool output、headers、URL query 或凭据。
- 测试使用唯一敏感 marker 断言日志输出不包含正文。
- Zod error 序列化采用 allowlist 字段，禁止直接 `JSON.stringify(error)`。
- raw passthrough 保留原始请求只发生在内存/网络路径，不新增持久化副本。

## 验收标准

- opencode 1.18.3 使用 `gpt-5.6-terra` 的首轮 Responses 请求不再因 developer role 返回 400。
- 普通函数工具调用的后续 Responses 请求可在同协议 raw path 完整透传。
- 同一工具历史可转换为 AI SDK ModelMessage 并路由到 model capability。
- unsupported Item 不再伪装成 generic invalid request；raw-safe、model-unsupported 的边界有明确测试。
- JSON/schema/body-limit/model-not-found 等本地终态均出现在 Dashboard Request logs。
- 本地拒绝在 dev stderr 中有一条可定位、脱敏的结构化日志。
- 每个入站请求只有一个 request ID、一个 recording session 和一个 terminal outcome。
- 现有 Provider attempt、fallback、usage capture、raw fidelity 和 Dashboard logs 查询行为不回归。
- `bun run preflight` 通过。
