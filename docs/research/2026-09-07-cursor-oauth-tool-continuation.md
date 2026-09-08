# Cursor OAuth 工具调用与续接排查

调查对象：Codex 任务 `01a07afc-4b65-70c0-8bd4-11f20f94a4af`，本地
aio-proxy 2026-09-07 日志，以及独立的 Composer 2.5 短会话。

## 结论与证据

### 1. 完整工具参数没有进入对客户端输出的参数流

原任务的多次 `codegraph_explore` 调用显示 `arguments: null`。
后续请求的入站日志进一步确认，客户端保存的参数实际为 `arguments: ""`，
工具因此返回 `query must be a non-empty string`。

Cursor 有两种参数来源：`partialToolCall` 的文本快照，以及 `mcpArgs` /
`toolCallCompleted` 的完整参数。插件只在收到可关联的文本快照时发送
`tool-input-delta`，完整参数只放进最终 `tool-call.input`。
OpenAI Responses 输出层从 `tool-input-start/delta/end` 组装参数，
所以完整的最终 `tool-call.input` 无法补回已经输出的空参数。

独立实测中，Cursor 先发 `partialToolCall`，随后才发 `toolCallStarted` 和
`mcpArgs`。前面的快照因尚无可关联的工具状态而被忽略；完整参数仍在
`mcpArgs` 中。这正好触发上述缺陷。

修复：先收集参数，在工具完成时将最终解析出的参数完整发送一次，再关闭参数流。
这样也避免提前发送的半截参数与完成事件中的最终参数不一致。
完成消息可能省略较大的字段，或把对象、数组降级为未能解析的字符串；
合并时保留已经收到的这些字段，其他字段采用完成消息中的值，与 OMP 的处理规则一致。

### 2. 续接请求丢掉了模型实际读取的工具结果

匹配到待处理工具结果时，插件更新了 `conversationState.turns` 中的结构化结果，
但仍复用旧的 `rootPromptMessagesJson`。Cursor 用后者构造模型提示词；
保留前者并不等于模型能看到新结果。工具调用前没有收到 checkpoint 时，
缓存甚至只含系统提示词，没有本轮用户问题。

独立实测使用一个固定结果的 `codegraph_explore`，要求收到结果后回答 `OK`：

| 版本               | 第一轮                   | 返回工具结果后的续接                                               |
| ------------------ | ------------------------ | ------------------------------------------------------------------ |
| 仅修复参数流       | 正常调用工具，约 3.65 秒 | 再次调用工具，且 query 变成 `diagnostic`                           |
| 同时修复提示词续接 | 正常调用工具，约 2.83 秒 | 约 4.42 秒回答 `OK`，收到 `turnEnded`、Connect 结束帧及 HTTP/2 EOF |

修复：完整历史续接使用当前请求构造的提示词；仅包含新增工具结果的续接，
保留缓存提示词并追加新结果。继续保留原有结构化 checkpoint 的结果回填。
空结果和执行被拒绝也写入明确标记，并保留拒绝理由，避免模型把它们当作尚未完成。

## 原任务的长等待

本地 trace 显示原任务使用 `composer-2.5`，有多次约 260–270 秒后取消的请求。
例如 `06e8d5fce12350e2dcc0f8cc490b8d38` 为 260430 ms，
`19b7007b271f2533cb4641de2a26ba7f` 为 267724 ms。

上述两个缺陷能够解释空参数、反复重试以及续接丢失上下文，并已分别复现。
原请求没有 Cursor 原始二进制响应日志，不能断言每一次长等待都由同一原因触发。

最初检查的“等待 HTTP/2 EOF”与 OMP 的成功判定一致；独立成功请求中
`turnEnded` 到 EOF 仅约 7 ms，本次没有把它作为已证实的根因修改。
另外，当前 driver 没有处理 `interactionQuery`；OMP 会回应这类需要客户端
确认的消息。这仍是独立的挂起风险，现有原请求日志无法确认是否触发。
先于 `toolCallStarted` 到达的参数快照仍会被忽略；本次实测由完成消息补齐了参数，
但如果完成消息也缺少字段，仍可能丢失这部分参数，需要另行捕获对应帧验证。

## 验证

- 参数流回归测试先失败：完整参数应为 `{"query":"docs"}`，实际为 `""`；修复后通过。
- 完整历史、增量工具结果的续接测试先失败，修复后通过。
- 部分完成参数、结构化参数降级，以及空结果、拒绝执行的 12 个补充回归先失败，修复后通过。
- 真实 Cursor 双轮请求如上，使用独立内存会话，不改线上服务和原任务。
- Cursor model → AI SDK → Responses SSE 回放确认参数为
  `{"query":"provider OAuth switch"}`，最终事件为 `response.completed`。
- Cursor 插件 215 个测试通过；`bun run check` 和插件范围的类型检查通过，补丁复审通过。
- 完整 preflight 在未修改的 dashboard 文件
  `use-oauth-editor-session.ts` 第 99 / 119 行遇到 TS2322 / TS2589，未执行后续阶段。

前序修复现已随交接 PR 提交为 ae32d4fef4ee910449e433943835aaec31b2ba2a；尚未部署，后续协议修复见配套 spec/plan。
