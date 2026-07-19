# Shared Protocol Routing Pipeline 设计

日期：2026-07-12  
状态：待用户评审

## 背景

aio-proxy 的首要产品契约是“协议兼容代理”：客户端使用 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 或 Gemini generateContent 协议时，同协议 API provider 应尽量保留原始请求、响应、流事件、错误体和 provider 扩展；只有跨协议调用才接受统一模型语义带来的有损转换。

当前策略本身符合这个契约：

- 入站协议与 API provider 协议一致时，走原始 HTTP passthrough。
- 协议不一致，或 provider 只有 AI SDK/OAuth 调用能力时，转换成 AI SDK model messages 后调用。

问题不在两种执行语义同时存在，而在候选循环、fallback、观测、错误处理和流式 preflight 被复制到四个 route 文件中。复制已经造成行为漂移，例如 Anthropic 缺少流式 preflight，Gemini 缺少统一 body limit。

## 目标

建立一个共享、深的 routing pipeline，使 route 只描述入站协议差异，provider 只提供可执行能力，pipeline 独占以下策略：

- model-first 候选解析；
- raw/model 执行路径选择；
- provider fallback；
- 请求和 attempt 观测；
- usage capture；
- 流式响应提交前的 preflight；
- 入站协议形状的本地错误映射。

保留同协议 raw passthrough，不把所有请求强制转换成 AI SDK 调用。

## 核心决策

| 决策点                  | 结论                                                       |
| ----------------------- | ---------------------------------------------------------- |
| 产品契约                | 协议兼容代理优先，不承诺所有跨协议特性无损                 |
| 同协议 API provider     | 使用 raw transport                                         |
| 跨协议 API provider     | 使用 materialize 时创建的 model transport（AI SDK bridge） |
| AI SDK / OAuth provider | 使用 model transport                                       |
| 编排位置                | server 中唯一的 shared routing pipeline                    |
| 协议知识位置            | 每个 inbound protocol adapter                              |
| Adapter 实现形状        | 通过小型 `defineProtocolAdapter()` 工厂创建无状态对象      |
| provider 选择           | model-first，保持 Router 返回的候选顺序                    |
| 旧重构分支              | 只参考设计和测试，不直接 merge                             |

## 为什么不全部走 AI SDK

AI SDK 的统一模型适合跨协议转换，但不是各家 wire protocol 的无损中间表示。provider adapter 只会转发和返回其明确支持的字段、provider options、metadata 和 stream parts。未知字段、新发布的 beta 功能、原始 SSE 事件边界、错误体、状态文本和响应头不保证能够往返。

删除 raw passthrough 不会删除这些复杂度，而会迫使每个协议 adapter 实现完整的双向转换和兼容矩阵。对于协议兼容代理，这会把一个简单的 `Request -> fetch -> Response` 路径替换成更大、更脆弱的语义重建路径。

## 模块与接缝

### 1. Protocol adapter

每个入站协议提供一个 adapter。它只负责协议表示，不负责候选循环或 provider 策略：

```ts
type ProtocolAdapter<TRequest, TContext> = {
  protocol: ProviderProtocol;
  parse(raw: Request, context: TContext): Promise<TRequest>;
  model(request: TRequest, context: TContext): string;
  variant(request: TRequest, context: TContext): string | undefined;
  wantsStream(request: TRequest, context: TContext): boolean;

  rawRequest(raw: Request, request: TRequest, resolvedModel: string, context: TContext): Promise<Request>;

  modelInvocation(request: TRequest, context: TContext): ModelInvocation;
  modelJson(stream: ModelEventStream): Promise<unknown>;
  modelSse(stream: ModelEventStream): ReadableStream<Uint8Array>;
  errors: ProtocolErrorMapper;
};
```

每个 adapter 是由小型工厂创建的无状态对象，而不是继承 `BaseProtocolAdapter` 的 class：

```ts
export const anthropicMessagesAdapter = defineProtocolAdapter<AnthropicMessagesRequest, AnthropicRouteContext>({
  protocol: ProviderProtocol.Anthropic,
  parse: parseAnthropicRequest,
  model: (request) => request.model,
  // 其余协议函数
});
```

工厂的职责被限定为：

- 为对象字面量提供统一的 construction point 和 `ProtocolAdapter<TRequest, TContext>` contextual typing；允许显式传入泛型，不为追求自动推断增加 builder 层次。
- 未提供 `variant` 时补充 `() => undefined`。
- 对返回的 adapter 做浅冻结，防止运行时替换协议或方法。

概念形状如下：

```ts
type ProtocolAdapterDefinition<TRequest, TContext> = Omit<ProtocolAdapter<TRequest, TContext>, "variant"> & {
  variant?: ProtocolAdapter<TRequest, TContext>["variant"];
};

function defineProtocolAdapter<TRequest, TContext>(
  definition: ProtocolAdapterDefinition<TRequest, TContext>,
): ProtocolAdapter<TRequest, TContext> {
  return Object.freeze({
    ...definition,
    variant: definition.variant ?? (() => undefined),
  });
}
```

公共行为按职责放置：

- 候选循环、fallback、preflight、记录和 usage 属于 shared pipeline。
- JSON 读取、JSON Schema 映射、model 字段改写等局部复用使用普通纯函数。
- parse、transform、egress 和协议错误形状留在各 adapter。

`defineProtocolAdapter()` 不执行 JSON 读取、parse、transform、fallback、preflight、记录、usage capture 或 provider 选择，也不接受 pipeline 生命周期 hooks。协议间复用的小型纯函数由 adapter 显式引用，避免工厂逐渐变成函数形式的基类。

adapter 不得在对象或闭包中保存单次请求的可变状态；并发请求所需状态全部通过方法参数传递。

不采用抽象基类的原因是 adapter 没有共享生命周期或实例状态。把 pipeline 策略放进 base class 会形成第二个公共算法中心；只把小 helper 放进 base class 又会得到一个删除后几乎不增加调用方复杂度的浅模块。项目中的 `BaseOAuthProvider` 有 vendor、store 和登录生命周期，因此 class 合理，但这个条件不适用于 protocol adapter。

四个 adapter 分别封装现有 ingress、transform 和 egress 模块。Gemini 的 path model/stream、Anthropic `count_tokens`、Responses 的未实现辅助端点仍由薄 route registration 处理。

adapter 不定义 provider kind，不执行 fallback，不写 request log，也不直接读取 provider snapshot。

### 2. Provider runtime capabilities

pipeline 不再根据 `api`、`ai-sdk`、`oauth` kind 推断如何执行。provider materialization 把配置和登录态转换成实际能力：

```ts
type RawTransport = {
  protocol: ProviderProtocol;
  invoke(request: Request): Promise<Response>;
};

type ModelTransport = {
  ensureAvailable?(): Promise<void>;
  invoke(request: ModelInvocation): ModelEventStream;
};

type RoutableProvider = {
  id: string;
  enabled: boolean;
  models?: readonly ModelId[];
  alias?: Readonly<Record<string, AliasConfig>>;
  raw?: RawTransport;
  model?: ModelTransport;
};
```

具体配置的 materialization 结果为：

| Provider 配置 | raw capability                 | model capability               |
| ------------- | ------------------------------ | ------------------------------ |
| API           | 原协议 HTTP transport          | 对应 AI SDK bridge             |
| AI SDK        | 无                             | 已加载的 AI SDK provider       |
| OAuth         | 无，除非 vendor 将来有真实需要 | vendor runtime model transport |

API provider 的 AI SDK bridge 在 snapshot materialization 时创建一次，并随 config reload 一起替换。请求路径不得重新加载 package 或重新创建 bridge。

现有 provider kind 可以作为 materialization 内部实现细节保留；它不再出现在 route 或 pipeline 的分支条件中。

### 3. Shared routing pipeline

pipeline 对外只有一个请求处理接口：

```ts
handleProtocolRequest({ adapter, context, rawRequest, source }): Promise<Response>
```

处理顺序固定为：

1. 执行共享请求大小检查。本轮统一现有的 `Content-Length > 8 MiB` guard，不引入流式 body limiter。
2. 通过 adapter parse 入站请求。
3. 提取 requested model 和 variant，调用 Router 获取有序候选。
4. 开始一次 request recording session。
5. 按顺序尝试候选 provider。
6. 如果 `provider.raw?.protocol === adapter.protocol`，走 raw path。
7. 否则如果存在 `provider.model`，走 model path。
8. 记录每次 attempt；满足 fallback 条件时继续。
9. 成功或最终失败时只结束一次 request session。

执行路径选择是一个封闭规则，不提供用户配置开关：

```text
same protocol + raw capability -> raw
otherwise + model capability   -> model
otherwise                      -> unsupported attempt
```

本轮不增加 `forceAiSdk`、`normalizedMode` 或每模型 transport override。真实需求出现后再扩展。

## Raw path

raw path 的不变量是尽量保持 wire compatibility：

- 使用原始 Request body；只有 alias 路由到不同 upstream model 时才由 protocol adapter 改写 model。
- 未知 JSON 字段和 provider-specific beta 字段不因 aio-proxy 不认识而被删除。
- 非 fallback 响应保留上游 status、headers 和 body；只允许 transport 层执行必要的 hop-by-hop header 与 content-encoding 处理。
- SSE body 不解析再生成；usage capture 可以旁路观察，但失败不得影响响应。
- 同协议上游返回普通 `4xx` 时直接返回，不转换成 aio-proxy 自己的错误体。

raw transport 当前存在的 credential header 和 base URL 语义问题不通过“全部改走 AI SDK”绕开。它们是相邻的 transport correctness 工作；本设计要求 pipeline 不复制或加深这些问题，但不在本轮重新定义 `baseUrl` 与 credential 配置契约。

## Model path

model path 接受有意的语义归一化：

1. protocol adapter 把入站请求转换为 `ModelInvocation`。
2. materialized model transport 调用 AI SDK 或 OAuth runtime。
3. protocol adapter 把统一 model events 写回原入站协议的 JSON 或 SSE。

跨协议无法表示的字段可以被丢弃，但必须满足以下纪律：

- 已支持的 tool call、tool result、reasoning、usage 和 finish reason 不得静默退化成空文本。
- provider-specific 选项只在有确定映射时传递。
- 新增有损映射时必须有 fixture 或测试明确记录行为。
- 不声称 model path 与 raw path byte-equivalent。

## Fallback 与流式提交

候选顺序继续由 Router 决定，config 顺序继续代表当前权重。

触发下一个候选：

- raw transport 网络异常；
- raw response 为 `429` 或 `5xx`；
- model transport 在响应提交前抛错；
- model stream 在首个 event 到达前失败；
- candidate 没有可用执行 capability。

不触发下一个候选：

- raw response 为普通 `4xx`；
- 入站请求被客户端取消；
- streaming response 已向客户端提交；
- 本地 parse/validation 失败。

model stream 在交给 egress writer 前统一执行首 event preflight。raw response 在收到 HTTP status 后视为已选定，不为 body 中途错误增加重放或 fallback，以免改变透明代理的时序和流语义。

所有候选失败时保留最终候选的失败结果，并以入站协议的错误形状返回无法直接透传的本地错误。

## 观测与 usage

request recording、attempt recording 和 usage capture 都由 pipeline 调用：

- 一个入站请求只有一个 request session。
- 每个候选最多生成一个 attempt。
- raw path 使用 passthrough usage capture，观察失败不改变响应。
- model path 从统一 finish event 捕获 usage。
- fallback 后只把最终成功 provider 记为 final provider，前序失败留在 ordered attempts。
- inbound abort 记为 cancelled，不尝试下一个 provider。

protocol adapter 不感知数据库、request log 或 pricing。

## 错误处理

错误分为三类：

1. **入站错误**：JSON、schema、body limit、URL context 等错误，由 protocol error mapper 转成入站协议形状，不进入候选循环。
2. **raw upstream response**：除 `429`/`5xx` fallback 外保持原始响应；最终候选的响应原样返回。
3. **本地/provider 异常**：availability、AI SDK、network 和 unsupported capability 等异常，由 pipeline 判断 fallback；最终通过 protocol error mapper 输出。

错误 mapper 返回 `undefined` 表示不认识该错误，pipeline 必须重新抛出，不能把编程错误伪装成 provider 失败。

## 包职责

- `packages/core`：协议 ingress/transform/egress、protocol adapter、model event 类型、provider transport 实现。
- `packages/server`：shared routing pipeline、Hono route registration、snapshot/source、request observation。
- `packages/types`：用户配置和稳定公共配置类型，不暴露 pipeline 内部类型。

route 文件应保持薄，只包含 URL 注册、path context 提取和少量协议专属辅助端点。

## 迁移策略

不 merge 旧 `protocol-adapter-refactor` 分支。实施以当前 `main` 为基础，并按以下顺序迁移：

1. 为当前已知漂移补失败测试：Anthropic 首 event fallback、Anthropic tool history、Gemini body limit。
2. 引入 runtime capabilities，并把 API bridge 移到 materialization 生命周期。
3. 建立 protocol adapters，优先复用现有 ingress/transform/egress 函数。
4. 建立 shared pipeline，先迁移一个协议验证接口深度。
5. 逐个迁移其余协议，每迁移一个就删除对应 route 编排。
6. 删除无调用的 route-dispatch helper 和 route-local 转换函数。

迁移期间不保留两套长期 pipeline。某个 route 切换到 shared pipeline 后，其旧编排和旧实现级测试应同步删除或改为通过新接口验证。

## 测试策略

shared pipeline 的接口是主要测试表面。

### Pipeline contract tests

- 同协议且有 raw capability 时只调用 raw。
- 协议不匹配时只调用 model。
- AI SDK/OAuth provider 即使“语义同协议”也因没有 raw capability 而调用 model。
- raw `429`/`5xx`、网络异常和 model 首 event 失败按顺序 fallback。
- raw 普通 `4xx`、inbound abort 和流已提交后不 fallback。
- 最终失败、attempt 顺序和 request outcome 正确。

### Protocol adapter tests

- `defineProtocolAdapter()` 提供默认 `variant`，并返回冻结对象。
- 四个协议各自的 parse、model、variant、stream 默认值。
- alias model rewrite 保留未知字段。
- model invocation 保留已支持的 tools、tool results、reasoning 和 provider options。
- JSON/SSE egress 和协议错误形状。

### Integration tests

- 四个入站协议各有一个同协议 raw fidelity 用例。
- dispatch matrix 覆盖四种入站协议与四种 API provider protocol 的 raw/model 路径选择。
- 至少一个混合候选链覆盖 `model failure -> raw success -> later candidate not called`。
- config reload 后使用新 materialized bridge，旧 bridge 不再接收请求。

测试断言可观察行为，不通过读取源文件或统计 route 行数来验证架构。

## 非目标

- 不把所有调用强制改成 AI SDK。
- 不增加新的入站协议。
- 不增加 weighted random、健康评分、circuit breaker 或可配置 retry policy。
- 不增加 transport 选择配置。
- 不增加 `BaseProtocolAdapter` 继承层次；`defineProtocolAdapter()` 不演变成 template-method pipeline。
- 不重做 Router 的 alias/variant 语义。
- 不重新定义 raw transport 的 `baseUrl` 与 credential 配置契约；另行设计和修复。
- 不把 AI SDK 类型加入公共配置 ABI。
- 不借此重构 dashboard、OAuth 登录流程或数据库。

## 验收标准

- 四个代理端点使用同一个 routing pipeline。
- route 文件不再实现候选循环、provider kind 分支、fallback、usage capture 或 request recording。
- protocol adapters 由职责受限的 `defineProtocolAdapter()` 创建，不保存请求级可变状态。
- 同协议 API provider 仍走 raw transport，未知请求字段与原始响应流得到保留。
- 跨协议 API provider 使用 materialize 时创建的 model transport，不按请求重新 bridge。
- AI SDK 和 OAuth provider 只通过 model transport 调用。
- Anthropic、OpenAI Completions、OpenAI Responses 和 Gemini 的流式 model path 都执行统一首 event preflight。
- Gemini 与其他 JSON 端点使用同一请求大小策略。
- Anthropic 跨协议 tool call/tool result 不再被转为空字符串。
- fallback、最终错误、request attempts 和 usage 的现有外部语义有自动化覆盖。
