# Antigravity session 标识规范化调研

调研日期：2026-07-18

## 结论

`aio-proxy` 不应把 `x-session-id`、`session_id` 或任何 request-id header 定义为跨协议标准。在 IANA 注册表、OpenAI/Anthropic 公共契约以及所检查的 gateway/reference 实现中，未发现一个通用的 AI 对话 session header；`x-session-id` 是常见但非标准的代理扩展，`session_id`/`Session_id` 是部分 Codex/ChatGPT OAuth 客户端与代理使用的私有兼容面。

Antigravity runtime 应建立一个独立的、协议无关的 **normalized session key**，再由它维护 Antigravity 私有的 `request.sessionId`、`requestId`、trajectory/step 与 reasoning replay 状态。建议：

1. 优先提取真正表示“对话/连续上下文”的协议原生字段；
2. 其次接受明确的 cache/continuity key；
3. 再接受已知客户端格式或代理扩展；
4. request-id 只能用于追踪，不能默认参与会话粘性；
5. 无显式会话标识时，才使用 transcript fingerprint，最后生成新 session。

`session_id` 与 `x-session-id` 可以作为 **只读入站兼容别名**，但不应成为 aio-proxy 的 canonical API，也不应原样透传成 Antigravity wire session。canonical 边界应是内部/SDK 的 `sessionId` 值；Antigravity 出站只写其 body 私有字段 `request.sessionId`。

## 推荐的规范化优先级

以下顺序按“语义强度”排序。每个来源先 trim、限制长度，再加来源 namespace，例如 `openai:conversation:...`、`openai:prompt-cache:...`、`claude-code:session:...`、`extension:x-session-id:...`，避免不同协议中相同裸字符串意外合并。

| 优先级 | 来源                                                                                                   | 使用规则                                                                                 | 理由                                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1      | aio-proxy 内部显式 `sessionId`                                                                         | 如果 protocol adapter/runtime 已提供可信 normalized session，直接使用                    | 最清楚的跨协议契约；避免插件重复猜测                                                                               |
| 2      | OpenAI Responses `conversation`；其他 ingress 明确定义的官方 conversation ID                           | 读取 string ID 或对象中的 ID                                                             | OpenAI 明确规定该 response 属于该 conversation，且请求/响应 items 会自动加入它；这是最强的官方连续对话语义         |
| 3      | OpenAI `prompt_cache_key`                                                                              | 作为稳定 continuity/cache identity 使用                                                  | 官方定义为相似请求的 cache bucketing key；虽不是 conversation object，但比非标准 header 更有明确语义               |
| 4      | Anthropic `metadata.user_id` 中可验证的 Claude Code session 格式                                       | 只接受 legacy `user_..._account__session_<id>`，或 JSON 字符串中的 `session_id`          | Anthropic 官方字段本身是“外部用户 ID”，不是会话 ID；只有已知 Claude Code 编码明确携带 session 时才可提升为会话标识 |
| 5      | body extension：`metadata.session_id`、`metadata.conversation_id`、顶层 `session_id`/`conversation_id` | 仅作为兼容扩展；按 ingress schema 能力读取                                               | 比 header 更接近请求语义，但不是 OpenAI/Anthropic 跨协议标准                                                       |
| 6      | header extension：`session_id`/`session-id`，然后 `x-session-id`；对应的 conversation aliases          | 接受但不宣传为标准；不自动向第三方原样透传                                               | `session_id` 是部分 Codex/ChatGPT OAuth 私有 surface；`x-session-id` 是 informal extension。无官方跨厂商契约       |
| 7      | OpenAI `previous_response_id`                                                                          | 只有在维护 `response_id -> normalized session` 映射时使用；映射缺失时不能把它当稳定根 ID | 它是上一条 response 的链指针，每轮都会变化；直接用值会破坏跨轮粘性。官方还规定它不能与 `conversation` 同用         |
| 8      | 稳定 transcript fingerprint                                                                            | 对规范化后的最早若干用户/助手 turns 做带 namespace 的 hash                               | 适合完整历史每轮重发的 stateless API，但压缩、改写开头、相似首轮和并发短任务会导致断链或误合并                     |
| 9      | 新生成 session                                                                                         | 生成进程内 session state                                                                 | 没有可靠连续性信号时 fail closed，避免把不同用户/对话粘在一起                                                      |

### 明确排除的默认来源

- `X-Client-Request-Id`：OpenAI 官方要求它“unique per request”，用于在拿不到 `x-request-id` 时排障。把它当 session 会让每轮都变成新会话。CLIProxyAPI 将它用于特定 PI 客户端兼容，但这不能提升为通用规则。
- OpenAI `x-request-id`、Anthropic `request-id`：服务端生成的单次请求追踪 ID，不是 conversation ID。
- 任意 Anthropic `metadata.user_id`：官方定义是与请求关联的外部用户 opaque ID，用于 abuse detection；若同一用户开多个对话，直接采用会把它们错误合并。
- OpenAI `metadata.user_id`：OpenAI Responses 的 `metadata` 是通用 key/value bag，没有标准化的 `metadata.user_id` 会话语义。
- idempotency key：它解决重复提交，不表达多轮对话；很多客户端每次请求都会生成新值。

## Antigravity wire state 的建议

normalized session key 不应直接等于上游 `request.sessionId`。参考实现表明 Antigravity 的字段是私有 envelope 协议：

- oh-my-pi 为每个 conversation state 保存 `agentId`、`trajectoryId`、signed-decimal `sessionId`、递增 `stepIndex` 和上一响应的 `lastExecutionId`；`requestId` 是 `agent/<agentId>/<timestamp>/<trajectoryId>/<step>`，并把 session 写入 `request.sessionId`。[源码](../../.reference/oh-my-pi/packages/ai/src/providers/google-gemini-cli.ts#L279-L295) [envelope 构造](../../.reference/oh-my-pi/packages/ai/src/providers/google-gemini-cli.ts#L1178-L1216) [写入请求](../../.reference/oh-my-pi/packages/ai/src/providers/google-gemini-cli.ts#L1343-L1361)
- CLIProxyAPI 每次生成新的 `requestId`，但从第一条用户文本 hash 出稳定的负十进制 `request.sessionId`；reasoning replay 会读取顶层或嵌套的 camel/snake-case session 字段。[请求 envelope](../../.reference/CLIProxyAPI/internal/runtime/executor/antigravity_executor.go#L2754-L2804) [stable session](../../.reference/CLIProxyAPI/internal/runtime/executor/antigravity_executor.go#L2806-L2821) [replay 提取](../../.reference/CLIProxyAPI/internal/runtime/executor/antigravity_reasoning_replay.go#L63-L73)

因此 aio-proxy 应：

1. 用 `model + normalized session key` 获取进程内 Antigravity conversation state，不包含 Provider ID，从而与已确定的跨 Antigravity Provider replay 共享策略一致。
2. state 首次创建时生成 Antigravity 格式的 signed-decimal wire `sessionId`、agent/trajectory IDs；后续轮次递增 step，并在可用时回填 `last_execution_id`。
3. 同一个 aio-proxy logical request 的 endpoint retry、401 refresh retry 和 Provider fallback 必须复用同一 normalized session/envelope identity，不能每次 attempt 重新生成 session。
4. `requestId` 始终是一次 Antigravity request/step 的标识，不从入站 `x-request-id`、`request-id` 或 `X-Client-Request-Id` 派生。
5. normalized key 可先 hash 后作为缓存 key，避免在日志、Redis key 或 debug state 中复制用户提供的裸 ID。上游 signed-decimal session 在首次 state 创建时随机生成即可；state 过期后开启新上游 session 是可接受的 best-effort 行为。
6. 与已确定的 replay 策略对齐：1 小时滑动 TTL、进程内 best effort；Provider failover 不切断 state，签名相关 400 则清理 replay/signature state。

## `.reference/claude-code-hub` 的完整链路

### 来源与生成

Claude Code Hub 分协议处理 session：

- Codex/Responses 提取顺序是 `session_id` header、`x-session-id`、body `prompt_cache_key`、`metadata.session_id`、`previous_response_id`。源码把 `x-session-id` 明确当兼容 header，而非主字段。[session extractor](../../.reference/claude-code-hub/src/app/v1/_lib/codex/session-extractor.ts#L3-L97)
- 若 Codex 缺字段，会把已有值补到 header `session_id`、兼容 header `x-session-id` 和 body `prompt_cache_key`；若完全没有，则按 key ID、IP、User-Agent、初始消息 hash 做 fingerprint，在 Redis 中复用 UUIDv7，默认 TTL 300 秒。[session completer](../../.reference/claude-code-hub/src/app/v1/_lib/codex/session-completer.ts#L28-L204) [补全规则](../../.reference/claude-code-hub/src/app/v1/_lib/codex/session-completer.ts#L207-L297)
- Anthropic 路径只从已知 Claude Code `metadata.user_id` 格式中解析 session，再回退到 `metadata.session_id`；缺失时再做 message content hash。[metadata parser](../../.reference/claude-code-hub/src/lib/claude-code/metadata-user-id.ts#L44-L132) [session extraction](../../.reference/claude-code-hub/src/lib/session-manager.ts#L210-L261) [hash fallback](../../.reference/claude-code-hub/src/lib/session-manager.ts#L428-L525)
- 对缺少 `metadata.user_id` 的 Claude 请求，它会注入由 key-derived device ID 和内部 session 组成的 legacy/JSON Claude Code 格式，但保留客户端已有值。[metadata injection](../../.reference/claude-code-hub/src/lib/claude-code/metadata-user-id.ts#L100-L153)

### 传播与用途

- session 写入请求日志/usage ledger，并分配 session 内 request sequence，用于 Dashboard、调试快照、并发 session 统计和消息查询。[session guard](../../.reference/claude-code-hub/src/app/v1/_lib/proxy/session-guard.ts#L89-L177) [message log](../../.reference/claude-code-hub/src/app/v1/_lib/proxy/message-service.ts#L52-L67)
- Redis 保存 `session:<id>:provider` 粘性绑定和 `session:<id>:key` 归属，TTL 为滑动窗口；读取时对 API key fail closed，避免另一 key 复用旧绑定。[session binding](../../.reference/claude-code-hub/src/lib/session-manager.ts#L603-L686)
- 后续请求优先复用绑定 Provider，但仍检查 enabled、reuse opt-out、时间窗口、熔断、协议格式、模型与客户端限制；不满足时清除或跳过绑定。[provider reuse](../../.reference/claude-code-hub/src/app/v1/_lib/proxy/provider-selector.ts#L460-L620)
- 首次成功用 `SET NX` 绑定；真实 failover 成功或 hedge winner 会改绑到成功 Provider。[smart binding](../../.reference/claude-code-hub/src/lib/session-manager.ts#L741-L900)
- 普通对话只有 messages 数量大于 1 才尝试 Provider reuse；raw cross-provider fallback 路径可以首轮复用。[reuse gate](../../.reference/claude-code-hub/src/app/v1/_lib/proxy/session.ts#L574-L583)

这些机制证明 session 对代理内部粘性、观测和 debug 很有价值，但它们不证明任何 header 是跨厂商标准。尤其 CCH 的 Codex completion 是代理主动创造的兼容层。

## 其他参考项目的提取策略

### oh-my-pi

oh-my-pi 的 auth gateway 优先读取 body `prompt_cache_key`，再读取 `metadata.{prompt_cache_key,session_id,conversation_id}`，随后读取 `x-prompt-cache-key`、`session_id`、`conversation_id`、`x-session-id`、`x-conversation-id`。源码把最后两个明确称为 “common informal”。[header allowlist 与优先级](../../.reference/oh-my-pi/packages/ai/src/auth-gateway/http.ts#L65-L160)

这支持“body/protocol semantics 优先，header extension 靠后”的设计。它把这些来源统一成 prompt cache identity，但 aio-proxy 还应进一步区分 cache key、conversation key 和 request trace ID。

### CLIProxyAPI

CLIProxyAPI 的 session-affinity selector 使用：已知 Claude Code `metadata.user_id`、`X-Session-ID`、Codex `Session_id`、`X-Client-Request-Id`、任意 `metadata.user_id`、`conversation_id`、message hash；缓存 key 包含 provider、session 和 model，并在 auth 不可用时自动重选。[selector 文档与 binding](../../.reference/CLIProxyAPI/sdk/cliproxy/auth/selector.go#L404-L470) [提取实现](../../.reference/CLIProxyAPI/sdk/cliproxy/auth/selector.go#L505-L580)

其中两个做法不应直接复制：

- 任意 `metadata.user_id` 会把同一用户的独立对话合并；
- `X-Client-Request-Id` 在当前 OpenAI 官方契约中应每请求唯一，只有确认特定 PI 客户端把它稳定复用时才能作为 opt-in compatibility rule。

## 官方规范与字段分类

| 字段                               | 分类                                        | 官方/一手语义                                                                                                           | 对 normalized session 的判断                                                           |
| ---------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `x-session-id`                     | 非标准代理扩展                              | 不在 IANA HTTP Field Name Registry；`X-` 前缀也不产生标准语义，RFC 6648 已弃用以 `X-` 区分非标准参数的惯例              | 只做低优先级入站兼容                                                                   |
| `session_id` / `session-id` header | 厂商/客户端私有扩展                         | OpenAI 与 Anthropic 公共 API 文档均未定义为通用 session header；部分 Codex/ChatGPT OAuth surface 使用                   | 可在 `x-session-id` 前接受，但不作为 canonical contract                                |
| OpenAI Responses `conversation`    | OpenAI 官方 body field                      | 指定 response 所属 conversation；conversation items 自动加入请求上下文，完成后 input/output items 自动加入 conversation | 强 session 来源                                                                        |
| OpenAI `previous_response_id`      | OpenAI 官方 body field                      | 上一条 response 的唯一 ID，用于多轮；不能与 `conversation` 同用                                                         | 需要 chain map，不能直接当稳定 session root                                            |
| OpenAI `prompt_cache_key`          | OpenAI 官方 body field                      | 用于相似请求 cache bucketing、优化 cache hit，替代旧 `user` 字段                                                        | 中强 continuity fallback，不等于服务端 conversation                                    |
| OpenAI `metadata`                  | OpenAI 官方通用 metadata                    | 最多 16 个 key/value，用于附加和查询对象信息                                                                            | 只有 aio-proxy 明确定义的扩展 key 才能读取；不存在通用 `metadata.user_id` session 语义 |
| `X-Client-Request-Id`              | OpenAI 官方 request header                  | 调用方提供的单次请求 ID，官方明确要求每请求唯一，用于排障                                                               | 禁止默认作为 session                                                                   |
| OpenAI `x-request-id`              | OpenAI 官方 response header                 | 服务端生成的单次请求追踪 ID                                                                                             | 禁止作为 session                                                                       |
| Anthropic `metadata.user_id`       | Anthropic 官方 body field                   | 与请求关联的外部用户 opaque ID，可用于 abuse detection；不得放姓名/邮箱/电话                                            | 仅解析已知 Claude Code embedded session；任意值禁止作为 conversation                   |
| Anthropic `request-id`             | Anthropic 官方 response header/SDK exposure | SDK 从错误响应 header 读取单次 request ID                                                                               | 禁止作为 session                                                                       |
| Anthropic cache control            | Anthropic 官方 content/body cache markers   | 通过 `cache_control` breakpoint 和 TTL 控制 prompt caching，而不是 `prompt_cache_key`                                   | 不提供通用 conversation ID                                                             |
| `conversation_id`                  | 协议/产品特定 body field                    | OpenAI Realtime 等特定 surface 定义；OpenAI Responses create 使用的是 `conversation`，并非统一顶层 `conversation_id`    | 只有 ingress 明确识别该协议时才算原生，否则是扩展                                      |
| Antigravity `request.sessionId`    | Google Antigravity 私有 body field          | 参考真实客户端行为维护 signed-decimal conversation identity                                                             | 由 runtime 生成，不作为公共 ingress header                                             |
| Antigravity `requestId`            | Google Antigravity 私有 body field          | 每次 agent step 的 request identity                                                                                     | 必须每 step 新建，不能替代 session                                                     |

官方来源：

- [OpenAI Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create)：`conversation`、`previous_response_id`、`prompt_cache_key`、`metadata` 和 `safety_identifier` 的当前定义。
- [OpenAI API overview — request IDs](https://developers.openai.com/api/reference/overview#supplying-your-own-request-id-with-x-client-request-id)：`x-request-id` 与每请求唯一的 `X-Client-Request-Id`。
- [Anthropic official TypeScript SDK — `Metadata.user_id`](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts#L1220-L1229)：opaque external user identifier，不得包含身份信息。
- [Anthropic official TypeScript SDK — request ID](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/core/error.ts#L20-L36)：错误对象从 `request-id` response header 读取 `requestID`。
- [Anthropic official TypeScript SDK — Messages request](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)：Messages 是 stateless multi-turn API，历史 turns 由调用方重发；cache 使用 `cache_control`。
- [IANA HTTP Field Name Registry](https://www.iana.org/assignments/http-fields/http-fields.xhtml)：没有注册 `x-session-id`、`session-id` 或 `session_id`。
- [RFC 6648](https://www.rfc-editor.org/rfc/rfc6648)：弃用以 `X-` 前缀区分非标准参数的惯例；因此 `X-Session-ID` 的名字本身不赋予互操作性。
- [W3C Trace Context — `traceparent`](https://www.w3.org/TR/trace-context/#traceparent-header)：这是跨系统请求追踪标准，但其 scope 是 trace/span，不是 AI conversation。

## 最终建议

Antigravity 插件应提供一个小而明确的 session normalization 模块，而不是在 runtime 各处读取 headers：

```text
trusted internal session
  > protocol-native conversation
  > prompt/cache continuity key
  > recognized embedded client session
  > body extensions
  > session header extensions
  > previous-response chain map
  > transcript fingerprint
  > generated session
```

模块输出至少包括 `key`、`source`、`confidence`，供 Antigravity envelope、reasoning replay、signature cache、日志审计共同使用。日志只记录 source 和截断/hash 后的 key，不记录原始 `metadata.user_id` 或完整用户 header。

关于 header 的直接答案：

- **接收**：兼容 `session_id`/`session-id` 与 `x-session-id`，其中非 `X-` 形式优先；还可兼容 conversation aliases。
- **不定义为标准**：文档中标记为 proxy/client extension。
- **不生成给所有上游**：Antigravity 使用 body `request.sessionId`；其他 Provider 只有其官方协议明确要求时才写对应字段。
- **不使用 request-id 替代**：`X-Client-Request-Id`、`x-request-id`、`request-id` 始终保持 request tracing 语义。
