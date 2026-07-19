# OpenAI Responses 参考实现调研

调研日期：2026-07-17

本调研对照 `.reference` 中四个固定源码快照，关注 OpenAI Responses 的入站兼容、跨协议转换、状态字段、fallback 与早期失败可观测性：

- [router-for-me/CLIProxyAPI@6fc4f0c](https://github.com/router-for-me/CLIProxyAPI/tree/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe)
- [QuantumNous/new-api@7c28993](https://github.com/QuantumNous/new-api/tree/7c28993f6bd9e92616f3f578212577f8b7c40b45)
- [ding113/claude-code-hub@595a7d9](https://github.com/ding113/claude-code-hub/tree/595a7d988a91c730ed63a791b4a92acb5a0e9c41)
- [can1357/oh-my-pi@20c0a2e](https://github.com/can1357/oh-my-pi/tree/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73)

## 结论

1. `developer`、`function_call`、`function_call_output` 和 reasoning 历史可以做结构化跨协议转换，但每个项目都有不同程度的语义降级。
2. `store`、`previous_response_id` 和 `background` 不是普通可选字段，而是 Responses 对象存储、Response ID、检索、续链、取消和异步恢复共同组成的状态协议。
3. 同协议 raw passthrough 可以保留这些字段；跨协议 model path 只能在 aio-proxy 自己实现一套等价状态层后才可能兑现其语义。仅把同名字段复制给 Chat Completions、Anthropic、Gemini 或 AI SDK model 不构成支持。
4. 四个项目都没有同时解决“早期失败进入持久化 Request logs”和“日志不记录请求正文”这两个要求。可借鉴其生命周期位置或错误日志接缝，但不应照搬请求/响应 body 捕获。

## 官方协议基线：为什么跨协议 model candidate 无法保证 `store` 语义

OpenAI 将 `store` 定义为保存生成的 Response，以便稍后通过 API 检索；Response 默认保存 30 天，`store: false` 可关闭保存。`previous_response_id` 使用已保存的 Response ID 续接多轮状态。[Conversation state](https://developers.openai.com/api/docs/guides/conversation-state#passing-context-from-the-previous-response) 和 [Create response](https://developers.openai.com/api/reference/resources/responses/methods/create) 都把这三者连在同一契约中。

`background: true` 又增加一层异步生命周期：客户端通过 `GET /v1/responses/{id}` 轮询终态，可以通过 `POST /v1/responses/{id}/cancel` 取消；`background + stream` 还要保存事件的 `sequence_number`，支持从 cursor 恢复流。[Background mode](https://developers.openai.com/api/docs/guides/background)、[Retrieve response](https://developers.openai.com/api/reference/resources/responses/methods/retrieve) 和 [Cancel response](https://developers.openai.com/api/reference/resources/responses/methods/cancel) 明确描述了这些操作。

aio-proxy 的跨协议 model path 会把 Responses 请求降为 Provider-neutral `ModelMessage[]`，然后调用可能由 Chat Completions、Anthropic、Gemini 或其他 AI SDK provider 实现的 model capability。这个抽象没有统一的 Responses object store，也没有统一的 Response ID、retrieve、cancel、`previous_response_id`、30 天保留期或 background stream cursor。即使目标协议恰好也有一个名为 `store` 的字段，也不能保证：

- 返回的是之后可通过 Responses API 检索的 Response ID；
- 后续 ID 请求回到创建该对象的同一 Provider 和同一账户；
- 目标 Provider 支持相同保留期、续链、取消和异步状态机；
- fallback 后的 ID 所有权仍可确定；
- 客户端能通过 aio-proxy 的 Responses retrieval endpoint 访问该对象。

因此，“跨协议 model candidate 因无法保证该语义而跳过”的准确含义是：不是消息内容无法转换，而是 aio-proxy 当前没有能力兑现状态协议。`store: true` 应视为 raw-only capability；不能静默丢弃，也不能用字段同名伪装成完整支持。

## 横向比较

| 项目                     | 入站与代理历史                                                                                                        | raw / 跨协议                                                                           | 状态字段                                                                                                              | background 闭环                                                                                           | fallback / affinity                                                                                             | 早期失败可观测性                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| CLIProxyAPI              | 入口只读取 raw JSON 并按 `stream` 分流；translator 支持 reasoning、function call/output，但把 `developer` 降为 `user` | 所有请求进入内部 translator/executor，不采用“同协议 raw 优先”模型                      | Codex translator 强制 `store=false`，executor 删除 `previous_response_id`，另用 session-scoped reasoning replay cache | 只注册 POST Responses/compact；GET `/responses` 是 WebSocket upgrade，不是 retrieve                       | 内部执行器可切换认证/上游，但原生 Responses 状态字段已被改写或删除                                              | handler 外层 middleware 可对所有 HTTP ≥400 做 error-only request log；会捕获 body，隐私边界不适合 aio-proxy                               |
| new-api                  | DTO 大量使用 `json.RawMessage`，只校验 model/input/max tokens；Responses→Chat 支持 function call/output               | 可配置 raw body passthrough；默认走 channel adapter 转换                               | Chat 转换明确拒绝 `previous_response_id` 等 stateful 字段；`store` 仅复制到 Chat request，不能证明 Responses 存储语义 | typed DTO 刻意不声明 `background`，注释说明依赖接口尚未支持；转换路径会丢弃该字段                         | 转换错误标记 `SkipRetry`，会阻断后续 channel；Responses 默认 affinity 使用 `prompt_cache_key`，不是 Response ID | parse 错误进入 console error；数据库 error log 只在 channel 已选后的 `processChannelError` 写入                                           |
| claude-code-hub          | 很早建立 `ProxySession`；非法 JSON 保存为 `{raw}`；Responses input 只做 string/object→array 整流                      | Responses 只选择 Codex provider，公开字段基本原样转发；没有真正的跨协议 Responses 转换 | POST 字段可 raw 保留，但没有可靠的 Response ID→Provider affinity 证据                                                 | catch-all 能接收资源路径，但格式检测只明确识别精确 `/v1/responses`；不能据此认定 retrieve/cancel 闭环可靠 | Provider selector 把 response format 限定到 Codex；支持 raw endpoint fallback，但状态对象归属没有单独建模       | outer catch 会 console log；guard early Response 直接返回，DB error log 又要求最后一步才创建的 `messageContext`，所以早期拒绝仍缺 DB 记录 |
| oh-my-pi gateway         | schema 支持 `developer`、reasoning、function call/output，并转成内部消息                                              | gateway 总是走 provider-neutral 模型层                                                 | gateway 明确接受后丢弃 `store`；`previous_response_id` 解析后也因没有 typed stream option 被丢弃                      | `background` 是 accepted-but-ignored，且 gateway 只注册 POST `/v1/responses`                              | 用 `prompt_cache_key` 派生 session/credential affinity，不是 Response ID affinity                               | JSON/schema/model-not-found 直接 400/404，不打 console log；Provider 阶段和未捕获 500 才有日志；无 DB Request logs                        |
| oh-my-pi client provider | 将内部历史编码成原生 Responses Items                                                                                  | 直接调用原生 Responses endpoint                                                        | 真正实现 `store=true`、`lastResponseId`、`previous_response_id`、按 baseURL/model/session 隔离的 chain state          | 不负责对外 gateway 的 retrieve/cancel                                                                     | 官方 OpenAI endpoint 默认启用；第三方默认关闭；stale ID 时完整重放，连续失败后 circuit-break                    | 客户端内存状态与 debug 日志，不是网关 Request logs                                                                                        |

## CLIProxyAPI

### 请求和转换

Responses handler 读取原始 body，只在 handler 层检查 `stream`，model 也只是从 raw JSON 中提取后交给统一执行器，没有完整的严格入站 schema。[handler](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/sdk/api/handlers/openai/openai_responses_handlers.go#L366-L390) [execution](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/sdk/api/handlers/openai/openai_responses_handlers.go#L439-L488)

Responses→Chat translator 会聚合连续 function calls、保持 assistant tool-call 与 tool result 邻接关系，并处理 reasoning history；但 `developer` 被改写成 `user`，不是无损语义映射。[translator](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/translator/openai/openai/responses/openai_openai-responses_request.go#L58-L125) [item conversion](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/translator/openai/openai/responses/openai_openai-responses_request.go#L136-L260)

### 状态字段

Codex translator 主动强制 `stream=true`、`store=false`、`parallel_tool_calls=true` 并请求 encrypted reasoning；executor 随后删除 `previous_response_id`。[Codex request translator](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/translator/codex/openai/responses/codex_openai-responses_request.go#L15-L29) [executor normalization](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/runtime/executor/codex_executor.go#L770-L790)

它没有完全放弃多轮 reasoning，而是按 model + session key 建立自有 replay scope，把缓存的 reasoning/function-call Items 插回后续输入。这是“自建状态替代上游 `previous_response_id`”，不是保留 OpenAI Responses 的原始对象存储契约。[replay scope](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/runtime/executor/codex_executor.go#L246-L286) [replay cache key](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/cache/codex_reasoning_replay_cache.go#L203-L215)

路由只提供 POST `/v1/responses` 和 `/v1/responses/compact`；GET `/v1/responses` 注册为 WebSocket upgrade，没有按 Response ID 的 retrieve/cancel 路由。[routes](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/api/server.go#L517-L551)

### 日志

request logging middleware 位于 handler 外层。完整 request logging 未启用时，它仍设置 error-only 模式；response wrapper 对状态码 ≥400 强制落 request log。因此 parse 400 仍可观察。[middleware](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/api/middleware/request_logging.go#L26-L70) [error-only finalization](https://github.com/router-for-me/CLIProxyAPI/blob/6fc4f0c4ef5675a2b04d84c1158a0140523d53fe/internal/api/middleware/response_writer.go#L260-L290)

不应照搬其实现：middleware 会捕获请求和响应 body，虽然适合本地调试，但与 aio-proxy 只持久化脱敏元数据的目标冲突。

## new-api

### 宽松入站与转换

Responses DTO 使用 `json.RawMessage` 保存 input、tools、store、prompt 等复杂字段，入口只校验 model、input 和 max output tokens，所以新 Item 通常不会在 ingress 被严格 schema 拒绝。[DTO](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/dto/openai_request.go#L839-L881) [validation](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/relay/helper/valid_request.go#L131-L146)

channel 可以显式启用 raw body passthrough；否则请求经过 adapter 转换。所有转换错误都包装为 `SkipRetry`。[relay path](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/relay/responses_handler.go#L68-L123)

Responses→Chat 支持 function call 和 function output，但先拒绝 conversation、`previous_response_id`、prompt 和 context management。`store` 会被复制到通用 Chat request；这只是字段映射，目标协议并没有因此获得 Responses retrieve/续链语义。[tool items](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/service/relayconvert/internal/oai_responses/to_oai_chat_req.go#L166-L184) [stateful rejection and store copy](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/service/relayconvert/internal/oai_responses/to_oai_chat_req.go#L56-L117)

### background、fallback 与 affinity

`background` 字段在 typed DTO 中被注释掉，旁边明确注明“暂时还不支持依赖的接口”。这不是完整的显式 501：普通 Go JSON unmarshal 会忽略未知字段，而 raw body passthrough 配置仍可能原样转发；但默认转换路径没有宣称或实现 background 闭环。[DTO comment](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/dto/openai_request.go#L839-L861) [registered routes](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/router/relay-router.go#L100-L106)

`SkipRetry` 会让转换失败直接停止 fallback。因此一个高优先级的 Chat-only channel 无法转换 passthrough-only Item 时，后面的原生 Responses channel 也可能没有机会执行。[retry policy](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/controller/relay.go#L325-L355)

Responses 的默认 channel affinity key 是 `prompt_cache_key`，并配置为 affinity failure 后不重试；它解决的是会话/缓存粘性，不是 Response ID 所有权映射。[affinity rule](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/setting/operation_setting/channel_affinity_setting.go#L112-L133)

### 日志

Relay 外层 defer 会把 parse 等本地错误写 console。数据库 error log 只在已选 channel 的 `processChannelError` 中写入，因此请求在 channel 选择前失败时仍没有数据库记录。[console error](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/controller/relay.go#L89-L117) [DB error log](https://github.com/QuantumNous/new-api/blob/7c28993f6bd9e92616f3f578212577f8b7c40b45/controller/relay.go#L357-L400)

## claude-code-hub

### 早期 session 与 raw fidelity

`ProxySession.fromContext()` 在 guard pipeline 之前读取请求体并建立内存 session。JSON parse 失败时不返回 400，而是把正文保存为 `{ raw: requestBodyText }`；这提升了容错性，但也扩大了内存/日志中的敏感数据面。[session creation](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/session.ts#L239-L318) [body parsing](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/session.ts#L1170-L1249)

Responses input rectifier 只把 string/object 规范化成数组，不严格验证 Item。出站过滤器递归移除下划线前缀的私有字段，其余公开字段继续进入转发路径，所以 `store`、`previous_response_id`、`background` 在 POST raw 请求中通常能保持。[input rectifier](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/response-input-rectifier.ts#L30-L72) [private-field filter](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/forwarder.ts#L493-L533)

Provider selector 明确规定 response format 只兼容 Codex provider，因此它是原生协议转发参考，不是 Responses→其他协议转换参考。[compatibility matrix](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/provider-selector.ts#L98-L124)

### 状态闭环与日志缺口

路由有 catch-all，endpoint family 也把 `/v1/responses/*` 分类为 response resources；但 endpoint format detection 只明确识别精确 `/v1/responses`。因此源码不足以证明 `GET /v1/responses/{id}` 和 cancel 能稳定选择创建该 Response 的 Codex Provider。[catch-all routes](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/%5B...route%5D/route.ts#L38-L67) [resource classification](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/endpoint-family-catalog.ts#L96-L120) [format detection scope](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/format-mapper.ts#L30-L52)

outer catch 会把抛出的错误写 console 并交给 `ProxyErrorHandler`。但是 guard pipeline 可以直接 early return；`messageContext` 又是 pipeline 的最后一步，而数据库 error writer 在没有 `messageContext` 时直接 return。因此 auth、model、provider 等早期拒绝仍可能不进数据库 Request log。[handler lifecycle](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy-handler.ts#L18-L86) [outer catch](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy-handler.ts#L131-L152) [guard ordering](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/guard-pipeline.ts#L136-L155) [DB guard](https://github.com/ding113/claude-code-hub/blob/595a7d988a91c730ed63a791b4a92acb5a0e9c41/src/app/v1/_lib/proxy/error-handler.ts#L615-L647)

## oh-my-pi

oh-my-pi 最有价值的地方是同一仓库同时展示了一个反例和一个完整实现：gateway 把状态字段当作可忽略 option，而原生 Responses client provider 把状态字段作为完整会话协议。

### Gateway：宽兼容，但状态字段语义不诚实

gateway schema 支持 `developer`、reasoning、function call/output；parser 会保留 developer role、解析 reasoning、校验 function arguments JSON 并构造 tool call/result 历史。[schema](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses-server-schema.ts#L78-L122) [conversion](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses-server.ts#L310-L425)

schema 顶部明确写着 opaque controls 会 accepted-but-ignored；`background` 也显式声明为 unknown。`store` 虽然被 schema 接受，parser 注释却明确说明 gateway 不兑现它并直接丢弃。[accepted-but-ignored policy](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses-server-schema.ts#L1-L8) [request options](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses-server-schema.ts#L240-L269) [store drop](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses-server.ts#L485-L500)

`previous_response_id` 虽先被 parser 放入 typed options，`buildStreamOptions` 又明确把它列入“没有 matching slot”的 dropped options。gateway 因此不能兑现客户端传入的 Responses 续链。[typed option](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses-server.ts#L485-L496) [drop point](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/auth-gateway/server.ts#L120-L192)

gateway 只注册 POST `/v1/responses`。JSON、schema 和 model-not-found 在 logger 建立 request event 之前直接返回 400/404，只有 Provider 阶段异常和 outer 500 有 console log。[early returns](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/auth-gateway/server.ts#L330-L439) [route table and outer 500](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/auth-gateway/server.ts#L730-L785)

### Client provider：真正的 stateful Responses

原生 Responses client provider 默认只在官方 OpenAI endpoint 启用 stateful chaining，因为第三方 Responses proxy 经常忽略 `store` 或拒绝 `previous_response_id`。chain state 按 base URL、model 和 session 隔离，保存 `lastResponseId` 和上次可重放 Items。[configuration and state](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses.ts#L100-L180) [default policy](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses.ts#L214-L224)

启用 chaining 时它强制 `store=true`，下一轮只在历史前缀仍匹配时发送 delta input + `previous_response_id`。若 ID stale、expired、unsupported 或遇到 ZDR，它会清理 baseline、完整重放上下文，并在连续失败三次后关闭 chaining。[chain construction](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses.ts#L254-L303) [store enforcement](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses.ts#L429-L439) [stale recovery](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses.ts#L590-L629) [response ID commit](https://github.com/can1357/oh-my-pi/blob/20c0a2e4101d8507e7cbbaf547baa4f9f2340b73/packages/ai/src/providers/openai-responses.ts#L690-L716)

这组实现是本次调研最强的源码证据：`store` 不是一个孤立布尔值；它必须和 Response ID、Provider/session affinity、完整上下文 fallback、stale recovery 和 disable policy 一起设计。

## 对 aio-proxy 的建议

### 可以借鉴

- 学习 new-api 和 oh-my-pi 的宽 ingress：用宽松结构接受已知 Responses Item，再由显式 capability probe 区分支持级别，不让新增 raw-safe Item 先死在通用 schema 400。
- 学习 CLIProxyAPI 的有序 function call/output 转换和 tool adjacency，但 `developer` 应映射为内部 system/developer 语义，不能降为 user。
- 学习 oh-my-pi client provider：把 stateful Responses 视为 ID + Provider/session state + recovery policy，而不是字段 passthrough。
- 学习 CLIProxyAPI 的 handler 外层终态观察位置和 new-api 的 outer console error seam，但只记录 allowlist 元数据。

### 不应照搬

- 不采用 oh-my-pi gateway 的 accepted-but-ignored `store/background`；这会向客户端伪装支持。
- 不采用 new-api 的转换错误 `SkipRetry`：passthrough-only Item 遇到 model-only candidate 时，应跳过该 candidate，继续寻找后续同协议 raw candidate。
- 不采用 CLIProxyAPI 的 request/response body 日志捕获。
- 不采用 claude-code-hub 的“messageContext 创建后才允许写 DB error”条件。

### 建议写入当前设计

1. 将 Responses feature 分成三类：
   - model-safe：文本消息、developer、function call/output；
   - raw-safe / model-unsupported：reasoning opaque state、item reference 和无法稳定转换的未来 Item；
   - stateful protocol：`store: true`、`previous_response_id`、`background: true`。
2. raw-safe Item：
   - 同协议 raw candidate 原样透传；
   - model candidate 记录 unsupported attempt 后跳过；
   - model conversion error 缓存，避免对后续 model-only candidates 重复转换；
   - 找不到 raw candidate 才返回 501。
3. `store: true`：
   - 本轮只允许同协议 raw candidate；
   - 跨协议 model candidate 跳过；
   - 不把 Chat/AI SDK 的同名字段当作 Responses 存储语义。
4. `previous_response_id`：
   - 在实现 Response ID→Provider/account affinity、GET retrieve 和失败策略前，继续全局 501；
   - 仅 raw passthrough 仍不足够，因为后续 ID 请求必须回到对象所有者。
5. `background: true`：
   - 用户已选择 accepted-and-dropped：入站接受，转发前删除，按同步请求执行；
   - 该选择接近 oh-my-pi gateway 的处理，明确放弃本轮 background 异步语义；
   - 不生成本地 background Response ID，GET retrieve/cancel 继续不支持；
   - 与参考项目不同，aio-proxy 会输出一次脱敏 `request.feature_downgraded`，但不扩展 DB Request logs；
   - 长任务仍可能受同步连接超时影响，后续若实现完整闭环再移除该降级。
6. 可观测性：
   - request recording session 在 size guard 前开始；
   - parse/body-limit/model-not-found/parse-time unsupported 都必须落一个无 attempts 的 terminal Request log；
   - Provider attempt 仍只由 shared candidate loop 记录；
   - pipeline 为未映射异常提供 terminal 兜底，但流式 `finishFrom()` 已取得终态所有权后不得被同步 finally 提前 finish；
   - console `request.rejected` 只输出 request ID、协议、pathname、状态、稳定 error code 和脱敏 issue path，不记录 body、headers、query、arguments 或 output。

这些建议对应设计文档：[OpenAI Responses opencode 入站兼容与可观测性设计](../superpowers/specs/2026-07-17-openai-responses-opencode-ingress-observability-design.md)。
