# Cursor OAuth 协议可靠性修复 Spec

日期：2026-09-07

状态：供实施使用；本文件与[配套 plan](../plans/2026-09-07-cursor-oauth-protocol-reliability.md)一起评审。

实施基线：ae32d4fef4ee910449e433943835aaec31b2ba2a，已包含前序参数流、root 提示词续接补丁；从本 PR 分支继续实施。

依据：[跨项目调研](../../research/2026-09-07-cursor-proxy-comparison.md)、[前序故障排查](../../research/2026-09-07-cursor-oauth-tool-continuation.md)。

## 目标与范围

让 Cursor OAuth 在工具参数乱序、多个工具交错、需要客户端回包、结果续接及上游 HTTP 流不及时关闭时，仍输出完整、可关联、可终止的客户端响应。覆盖调研的 R1–R7，并保留前序补丁解决的参数 SSE 丢失与 root 提示词未更新问题。

这是一个 Cursor 协议修复项目。交互、工具状态、历史和终止共享同一 Run 生命周期，放在一份 spec/plan；任务各自有可验证的结果，按依赖顺序实施。

采用现有路径：每个客户端生成请求创建一个上游 Run；工具交接完成后关闭它；下一请求用保存的状态及真实历史重建。暂不引入驻留 H2 会话池、会话互斥队列、恢复结果重放账本、自动重试策略或新的路由循环。

本次不迁移 OAuth 登录/模型发现、不修改模型列表、不新增客户端协议、不调整账单用量算法、不修改 dashboard。不得把参考实现的原生 shell/文件执行能力带入反代。

## 全局约束

以下各行须原样出现在 plan 的 Global Constraints：

- 保持 Bun >=1.4.2（packageManager bun@1.4.2）、TypeScript ^7.0.2、AI SDK 7.0.8 / @ai-sdk/provider 4.0.1（V4）及 @bufbuild/protobuf ^2.14.1；不新增运行时依赖，不修改已有版本下限。
- 所有 shell 命令以 rtk 开头；命令均在当前 checkout 的仓库根目录运行（rtk proxy git rev-parse --show-toplevel）。
- 保留 server pipeline 唯一生成候选循环、统一协议 egress、Provider affinity/revision 校验和账户隔离；本次不修改 Plugin SDK 公共接口。
- 每个客户端请求最多启动一次 Cursor Run；插件内部不新增透明重试、故障转移或工具执行。
- 公共工具调用 ID 优先使用交接前已观察到的 outer call ID，缺失时使用 nested ID；两种身份分开索引，不得按工具名称配对。
- 保留前序参数合并与续接修复；已缓存的结构化参数不得被完成帧中降级的字符串覆盖。
- 手写非测试实现文件不得超过 500 行，达到 400 行先按职责拆分；新增测试与所属模块同目录，不增加 legacy _test/ 测试。
- JSON 形状检查使用 es-toolkit/predicate 的 isPlainObject；不添加通用工具依赖；控制流、流处理和状态机使用清晰的原生循环。
- 使用真实 protobuf 编解码做边界测试；时间测试使用 bun:test 的假时钟，不使用真实分钟级等待。
- 发布说明沿用 .changeset/loose-cars-hunt.md，保持 aio-proxy 和 @aio-proxy/plugin-cursor 均为 patch；正文一段且不超过 5 行。
- 实施完成运行 bun run preflight；若被未修改的既有错误阻断，至少通过 bun run check 和受影响包测试，并明确记录阻断与未执行项。
- 每个实施提交追加 Co-authored-by: Codex <noreply@openai.com>；只提交已核对属于本任务的文件。

## 已确认行为与需求编号

| 需求        | 当前可复现行为                         | 修复后的外部可见行为                                                 |
| ----------- | -------------------------------------- | -------------------------------------------------------------------- |
| C1 / R1     | interactionQuery 被忽略                | 已支持请求有匹配 ID 的协议回包；无法表示的交互明确失败，不能静默悬挂 |
| C2 / R5     | approval-only MCP 帧变为可执行工具事件 | 回复明确拒绝；既不执行，也不向外部客户端发可执行调用                 |
| C3 / R3、R6 | 早到快照丢失；空 completion 抢先结束   | 保留早到参数；等待能确定输入的事件，不推测缺失参数                   |
| C4 / R2     | 第一个调用完成就关闭 Run               | 收集已宣布的同批调用，并在可撤销收尾窗口后原子交接                   |
| C5 / R4     | 成功 END_STREAM 后仍等待 HTTP EOF      | 协议结束可独立完成响应；所有终止路径只结算一次                       |
| C6 / R7     | root 历史丢失调用/结果关联             | 完整历史及增量续接保留调用 ID、名称、输入、结果及错误语义            |
| C7          | 只有通用 300 秒 SDK 输出空闲检测       | Cursor 内部区分首帧、断联、无进展、工具参数等待与收尾阶段            |
| C8          | 原任务无法从 trace 判断等待位置        | 用现有日志设施记录安全的阶段、耗时和原因，可通过 requestId 关联      |
| C9          | 参数正确只在最终对象中，SSE 可能遗漏   | 实际 Cursor → AI SDK → Responses 路径参数事件与最终调用一致          |
| C10         | 取消/失败与缓存、连接清理可能竞争      | 单次结算，清理所有计时器/连接；失败不写入新缓存，取消原因保留        |

R1–R7 是合成帧回放证明的代码行为。原案例没有原始协议帧；不得在验收或发布说明中宣称全部长等待都已追溯到这些路径。

## 方案取舍

| 方案                        | 收益                                         | 代价                                         | 决定         |
| --------------------------- | -------------------------------------------- | -------------------------------------------- | ------------ |
| 完善现有取消/重建 Run       | 对应全部已复现缺口；复用当前隔离、缓存和路由 | 必须准确维护模型实际读取的 root 历史         | 本次采用     |
| 保留 Run 等待客户端工具结果 | 减少建连与上下文重建                         | 增加连接驻留、并发归属、断线恢复和跨实例约束 | 后续独立评估 |
| 切换 Cursor SDK bridge      | 上游协议细节由 SDK 承担一部分                | 认证不同；外部工具交接和并行调用问题仍存在   | 本次不采用   |

## C1–C2：交互回包与协议字段

保留现有完整 agent.proto，只追加本次必需、已核对的字段/消息，再使用 protoc-gen-es 2.10.2 重新生成 agent_pb.ts。不得手改生成的二进制 descriptor。

字段来源固定为 OMP 提交 3e181fe0cb73f8fbc8b5654335dee08177e2417b：
packages/ai/src/providers/cursor/proto/agent.proto，McpArgs 第 7 字段以及 WebFetch query/response 第 9 字段和相关消息。其余未使用的新字段保持 unknown-field 兼容；不整包引入无关新 exec 功能。更新 gen/README.md 的本地差异、来源和再生成说明，保留许可证与 turns_old 注释修正。

### Query 策略

| query case                  | 回包/行为                                      | 依据                                                       |
| --------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| webSearchRequestQuery       | webSearchRequestResponse.approved              | 允许 Cursor 托管搜索，不在代理本机执行搜索                 |
| exaSearchRequestQuery       | exaSearchRequestResponse.approved              | 同上，执行方是上游                                         |
| exaFetchRequestQuery        | exaFetchRequestResponse.approved               | 同上                                                       |
| webFetchRequestQuery        | webFetchRequestResponse.approved               | 新增已核对消息；仅上游托管 fetch                           |
| askQuestionInteractionQuery | askQuestionInteractionResponse.result.rejected | 当前协议适配没有交互式追问通道；不编造用户答案             |
| switchModeRequestQuery      | switchModeRequestResponse.rejected             | 模式由请求/工具列表决定                                    |
| createPlanRequestQuery      | createPlanRequestResponse.result.error         | 它请求创建计划文件，代理没有文件执行能力；不伪报文件已创建 |
| setupVmEnvironmentArgs      | 以 cursor_interaction_unsupported 结束 Run     | 当前结果 schema 只有 success；不存在真实可返回的成功       |
| 未识别或没有 query case     | 以 cursor_interaction_unsupported 结束 Run     | 不猜测 unknown oneof 的成功/拒绝结构，不依靠空 ack 解锁    |

每个已支持回复使用原 query.id。拒绝和 error 用固定简短理由，说明代理不支持该操作；不包含输入问题、URL、路径或 token。回包写入失败走原始传输错误路径。

approval-only 判定覆盖 execServerMessage.mcpArgs，以及 interactionUpdate 中嵌入的同一 McpArgs。收到 smartModeApprovalOnly=true：

- exec 路径回复原 id + execId 的 mcpResult.rejected，理由为“Tool approval is owned by the external client.”；
- interaction 展示事件不建立可交接工具状态、不输出 tool-input/tool-call；
- 不把该探测放入已执行/已交接去重集合；后续同 ID 的真实调用仍可正常交接；
- 不自动批准，即使工具已列在客户端 tools 中；工具可用不等于代理拥有审批权限。

## C3–C4：工具参数与交接状态

### 明确的状态与身份

为一个逻辑 MCP 调用保存：稳定的内部索引键、outerCallId、nestedToolCallId、客户端 toolName、累积 buffer、completion 参数、exec 参数、状态和首次宣布顺序。exec 先于 interaction 时暂以 nested ID 建立记录；后到 outer ID 建立别名，并在交接前更新公开 ID，内部索引键不变。交接时仍无 outer ID 才以 nested ID 输出；输出后不再改变。已绑定的 outer ID 指向另一 nested ID、或同一调用名称发生冲突时明确失败，不串接两次调用。

私有状态分为 collecting、awaiting-args、ready。所有 ready 调用在批次交接前仍可接收本调用的补充字段；尚未向外输出可执行事件。交接完成后 Run 终止，晚到事件不再改变结果。

- partial 早于 started：若已携带 MCP 工具信息立即建立状态；只有 callId/argsTextDelta 时暂存快照，待工具身份确定再关联。
- started 重复出现不得清空已有 buffer。
- 累积快照与现有 buffer 有前缀关系时只添加新增后缀；原样重复和较旧前缀不重复添加；无前缀关系沿用已验证的增量片段兼容规则。
- 内外 call ID 不相等时，通过已记录的映射关联，不能取“最近一个工具”。
- native 非 MCP 的展示事件不变成外部工具；未能确认身份的孤立快照在 Run 结束时丢弃，不形成调用。

### 参数权威性

合并次序为 buffer → completion map → exec mcpArgs map。每一层：缺失字段保留前一层；原有对象/数组不能被后层的降级字符串覆盖；其余后层字段覆盖前层。

参数就绪要求能确定一个 JSON 对象。只有未结束的 JSON、非法 JSON、数组/标量根值，均不能被静默替换为 {}。无法确定输入的 completion 进入 awaiting-args。

空参数的确定规则：

1. exec mcpArgs 是执行请求本身；其空 map 是显式空输入，可以形成 {}。
2. completion 带有效的 {} 快照，属于显式空输入。
3. 仅有空 completion、没有快照/exec 时，只允许请求声明为无参数的工具：input schema 为 object、properties 为空、required 为空，且无 $ref/allOf/anyOf/oneOf 等组合约束。
4. 其他空 completion 等待后续 mcpArgs。不得因为工具“可能允许缺省参数”就猜测 {}。遇到终止边界仍未就绪则报 cursor_tool_input_incomplete。

不在本任务实现完整 JSON Schema 验证器；通常的参数语义验证继续由 AI SDK/客户端承担。这里的 schema 检查仅用于区分确定的无参数调用和信息缺失。

### 原子交接

一个调用的输出必须是连续的一组：
tool-input-start → tool-input-delta（恰好一次完整 JSON）→ tool-input-end → tool-call。
同组 ID 一致；delta 拼接值与 tool-call.input 完全相同；finish 只出现一次。

工具专属输出延迟到批次交接；普通文本和 reasoning 继续正常流式输出。这样完成消息后、交接前抵达的权威参数还可以修正缓冲内容。已有 buffer 合并补丁保留。

首次满足“至少一个 ready 调用且没有 collecting/awaiting-args MCP 调用”后，启动 100 ms 工具收尾窗口。新调用、身份补齐或参数更新等有效 MCP 变化撤销旧窗口；集合再次满足条件时重开窗口。完全相同的重复帧不撤销窗口，也不刷新进展时钟。窗口触发必须重新检查集合。不要根据提示词里的“调用 N 次”推测批次数量。

窗口是有界兼容机制，并不证明服务器以后绝不会再发新调用。它解决已排队及窗口内的迟到兄弟调用；超出窗口的未知调用属于当前取消/重建架构的明确限制，不宣称无限等待式完整性。

交接时从 ready 状态生成同一批输出与续接记录，并关闭 Run。不得向 Cursor 写“工具已成功”的占位结果。已实际交接的调用与模型后续主动发起的同名同参调用不能全局去重。

## C5、C7、C10：终止与时间边界

Run 有且只有一个终止拥有者。它负责 controller、result、连接、内部 AbortController、心跳和全部定时器。所有路径先锁定终态，再释放资源；重复/迟到回调无效果。

| 信号                                                 | 处理                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 成功 Connect END_STREAM                              | 不等待 HTTP EOF 或未完成 trailers；存在不完整 MCP 则失败，否则交接 ready 工具或正常 finish      |
| Connect error END_STREAM                             | 立即失败，保留该错误；不能被工具收尾覆盖                                                        |
| turnEnded                                            | 启动一次 500 ms 收尾；允许尾随 usage/checkpoint 和工具补充帧；停止首帧/健康检查，收尾期限不续长 |
| turnEnded 收尾到期                                   | 不完整 MCP 失败；否则输出最终工具批次或正常 finish 并关闭连接                                   |
| HTTP EOF + 非零 grpc-status / 传输错误               | 终态尚未确定时失败                                                                              |
| HTTP EOF + 已看到 turnEnded                          | 检查不完整 MCP，正常收尾                                                                        |
| HTTP EOF + ready 工具且无不完整 MCP                  | 可以完成工具交接，终止原因为 tool-handoff                                                       |
| HTTP EOF + 无 turnEnded/成功 END_STREAM/完整工具批次 | cursor_stream_incomplete                                                                        |
| 客户端取消                                           | 保留取消 reason；取消连接、拒绝 result，不写新的会话缓存                                        |
| 成功结算后的网络关闭/错误                            | 仅清理，不推翻已确定成功或产生第二个终止事件                                                    |

未收到协议终止时，裸网络关闭仍不能伪装成功。完整工具批次与上游错误在窗口内竞争时，已观察到的错误优先；成功已提交之后不回滚客户端结果。

### 默认计时

| 计时项                | 值             | 起止/重置                                                                         |
| --------------------- | -------------- | --------------------------------------------------------------------------------- |
| clientHeartbeatMs     | 5000 ms        | Run 写入后发送；终态清除；它不证明上游存活                                        |
| firstFrameTimeoutMs   | 120000 ms      | 调用 openRun 前启动；首个解码成功的 Agent/Connect 终止帧清除                      |
| frameSilenceTimeoutMs | 120000 ms      | 首帧后启动；每个解码成功上游帧更新                                                |
| noProgressTimeoutMs   | 240000 ms      | 首帧后启动；有效文本/思考/参数变化、正数 tokenDelta、KV 处理、exec/query 处理更新 |
| toolHandoffGraceMs    | 100 ms         | 按前述可撤销工具批次规则                                                          |
| turnEndGraceMs        | 500 ms         | 第一次 turnEnded 起固定期限                                                       |
| 通用 SDK 流空闲期限   | 保持 300000 ms | 继续由 server usage capture 管理                                                  |

上游 heartbeat、纯 checkpoint、无变化的重复工具帧只刷新存活时钟，不刷新进展时钟。KV/exec/query 进展定义为已完成解码及本地处理，单纯收到未知帧不算进展。checkpoint 仍可保存尾随状态。

120/240 秒是保守的初始工程默认值，低于当前外层期限，不是测得的模型能力上限。内部 timing 可由测试注入，暂不提供用户配置或新增环境变量。首次发布后依据阶段日志评估误杀与长思考情况；不承诺所有静默阶段都能精确判断是否健康。

通用 300 秒计时仍看不到隐藏的 KV 进展，是有效限制的一部分。本次不伪造 text/reasoning/token 心跳来重置它，也不扩展 AI SDK 协议。实际下游背压继续遵守通用 capture 的既有行为。

首帧前取消或超时必须立即结算客户端请求；若 openRun 稍后才返回句柄，应立即关闭，禁止再写请求。定时器回调中的写入/close 异常也进入同一终止路径，不形成未处理异常。

## C6：模型历史与增量续接

rootPromptMessagesJson 是本任务必须校验的模型输入；turns 保留其已有 protobuf 配对用途。仅修改 turns 不算验收通过。

共享只读契约 CursorCompletedToolCall：

```ts
type CursorCompletedToolCall = {
  readonly outerCallId: string;
  readonly nestedToolCallId: string;
  readonly toolName: string;
  readonly input: string; // 已验证的 JSON 对象文本
};
```

CursorTurnResult 增加 assistantText: string 和 toolCalls: readonly CursorCompletedToolCall[]；现有 pendingToolCalls: Map<string, string> 保持对外类型。driver 在交接时从同一批 resolved 调用派生两个结果，避免重复维护映射。

### Root 消息格式

```json
[
  {
    "role": "assistant",
    "content": [
      { "type": "tool-call", "toolCallId": "aio_b3V0ZXItYQ", "toolName": "search", "args": { "query": "alpha" } },
      { "type": "tool-call", "toolCallId": "aio_b3V0ZXItYg", "toolName": "search", "args": { "query": "beta" } }
    ]
  },
  {
    "role": "tool",
    "content": [
      { "type": "tool-result", "toolCallId": "aio_b3V0ZXItYQ", "toolName": "search", "result": "RESULT_A" },
      { "type": "tool-result", "toolCallId": "aio_b3V0ZXItYg", "toolName": "search", "result": "RESULT_B" }
    ]
  }
]
```

这是 Cursor 内部历史消息格式：调用输入键为 args，结果键为 result；不能直接把 AI SDK V4 的 input/output 原样序列化后假设上游认识。参考固定 OMP 的 buildCursorAssistantContent 与 root builder。根消息工具名称用 toWireName 一致转换。来自客户端的公开调用 ID 只在内部 root 中编码一次：'aio_' + Buffer.from(id, 'utf8').toString('base64url')；调用与结果使用相同编码，读取已存 root ID 时不得再次编码。这样含竖线、斜杠或 Unicode 的 ID 仍能满足 Cursor 的安全字符限制。公开输出 ID 保持不变，pending 的 nested 映射保持协议语义。上例的原公开 ID 分别为 outer-a、outer-b。

输出要求：

- 保留 assistant 文本与 tool-call；结果按 ID 配对，不能按名称、位置或参数猜测。
- text、json、error-text、error-json、execution-denied、空内容均形成明确结果；错误/拒绝加 isError=true，拒绝保留理由，空文本/空内容使用现有“无输出”标记。
- 未找到调用的孤立结果保留已有可读文本退化，不伪造调用参数。按 ID 已能关联的结果不再降为 user 消息。
- 保留已有 inline 图片在 MCP protobuf 结果中的数据和 MIME 语义。Root 中非文本工具输出保持已有可读占位，不在本次发明新多模态历史格式。
- active user 仍只发送一次：发 Run 时通过 action；形成后续续接缓存时再纳入 root。

### 交接时保存实际调用

交接成功后，在本轮请求使用的 root 基础上追加 active user（若本轮是 user action）、assistantText 和 toolCalls，形成缓存中的 root。不要使用旧 checkpoint 的 root 覆盖这份模型历史。这样即使上游还没发 checkpoint，下一请求只带工具结果也能找到调用 ID 和输入。

完整历史续接由当前入站历史构造 root；增量续接在缓存 root 上追加新结果，读取缓存调用索引配对。保留现有 root 更新补丁与 pending nested ID 回填。

本次不增加新的“必须一次返回全部工具结果”入站限制，也不增加客户端部分结果积攒队列。部分结果沿用现有续接范围，但已返回的每个结果必须准确关联；未返回调用不能被伪造成功或从 pending 集合移除。

仅在 driver 成功结算后更新会话，继续使用既有比较写入保护。Provider affinity/account 不匹配按现有逻辑放弃旧状态；没有逻辑会话键时不保存跨请求缓存。

## C8：诊断与错误

通过 PluginApi.logger 注入，不改 RuntimeContext/Plugin SDK 公共接口。注册 adapter 时闭包传入 logger，沿 runtime → provider → model → driver 传递。禁止创建全局可变 logger 或在各请求之间共享阶段状态。

每个 Run 的 debug 日志记录：run-start、first-frame、first-text、tool-ready、tool-handoff、query-reply、turn-ended、connect-end、http-eof、settled。失败/超时使用 warn；客户端取消可用 debug。

允许字段：requestId、Provider ID、modelId、resumeMode、phase、elapsedMs、frameCount、openToolCount、readyToolCount、queryCase、queryId、termination、lastInboundAgeMs、lastProgressAgeMs。requestId 从现有 logicalRequest 读取，缺失时生成本轮 UUID；Provider ID 从 routingContinuity 读取。终态日志应带时间摘要，足以与已有请求 trace 关联，不新增 trace 表或 dashboard 面板。

禁止记录访问/刷新 token、邮箱、完整 session key、工具输入/结果、提示词、URL/路径及原始 protobuf 内容。日志异常不得改变生成结果。未知字段/查询只记录类型和数字 ID。

插件内部错误使用 CursorProtocolError（Error 子类）及稳定 code：

- cursor_interaction_unsupported
- cursor_tool_input_incomplete
- cursor_tool_input_invalid
- cursor_tool_identity_conflict
- cursor_stream_incomplete
- cursor_first_frame_timeout
- cursor_frame_silence_timeout
- cursor_no_progress_timeout

Connect/gRPC/网络错误保留原错误信息和 cause，归入统一失败路径；本地 code 不是新客户端错误协议，不修改通用 egress 的错误结构。

## 文件边界

| 文件 / 目录（均在仓库根下）                                                           | 职责                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| packages/plugins/cursor/src/gen/agent.proto、agent_pb.ts、README.md                   | 必需字段扩展、生成和来源                                           |
| runtime/interaction-query/interaction-query.ts + index.ts + 测试                      | 纯 query → 已编码回复；不支持时抛明确错误                          |
| runtime/protocol-error.ts                                                             | 本次协议错误 code 与 Error 子类                                    |
| runtime/mcp-call.ts                                                                   | CursorCompletedToolCall 共享只读类型                               |
| runtime/client-messages/client-messages.ts                                            | 包装 approval-only 的 exec 拒绝回复                                |
| runtime/stream/interaction/interaction.ts                                             | 保留文本/思考映射，调用私有 MCP 状态处理                           |
| runtime/stream/interaction/mcp-state.ts、mcp-input.ts                                 | 私有调用身份、参数生命周期与解码/合并                              |
| runtime/driver/driver.ts、lifecycle.ts、diagnostics.ts                                | Run 协调；私有终止/计时协作者；私有安全日志协作者                  |
| runtime/history/history.ts、root-messages.ts、tool-result.ts                          | 公共入口/turns 配对；私有结构化 root 构造与追加                    |
| runtime/run-request/run-request.ts                                                    | 完整/增量历史选择，不重复发送 active user                          |
| runtime/cursor-model/cursor-model.ts                                                  | 缓存写入与历史交接、传递 requestId/Provider ID                     |
| runtime/runtime.ts、runtime/provider/provider.ts、plugin/plugin.ts                    | 使用现有 logger 注入链                                             |
| runtime/cursor-model/test-support.ts                                                  | 仅供测试使用的真实 Run/KV 回放夹具，不导出为产品 API               |
| packages/core/src/egress/openai-responses/cursor-regression/cursor-regression.test.ts | 真实 Cursor mapper → AI SDK → 现有 Responses egress 的离线契约测试 |

表中 runtime、plugin 路径前缀均为 packages/plugins/cursor/src/。私有协作者不从高层 barrel 导出，也不被外部模块引用；测试可在所属目录验证它们。新的测试辅助文件不作为产品 API 导出。

## 验收

1. R1–R7 各有正式行为回归，断言修复后的结果；不能把确认错误行为的临时探针直接作为“通过”测试。
2. 参数交错、重复 started/completed、inner/outer ID 不同、无参数工具、早到快照、空 completion 后 exec 参数全部覆盖。
3. 检查同一调用的 delta/done/final JSON 一致；两个调用都进入 Responses 输出；没有空参数伪成功、重复 executable call 或重复 response.completed。
4. success END_STREAM + held-open HTTP、turnEnded grace、半截 JSON、未完整工具、非零 trailers、取消/成功竞争、首帧前挂起分别覆盖。
5. 完整历史、仅结果的增量历史、无 checkpoint 的交接缓存、部分结果、空/错误/拒绝结果按 ID 检查实际 root JSON；含特殊字符的公开 ID 编码后仍唯一配对，增量读取不得二次编码。
6. 假时钟验证心跳只刷新存活、进展刷新两条时钟、终止清除所有计时器；不得等待真实 120/240 秒。
7. 日志测试验证关联字段及禁止数据不出现；日志 sink 抛错不会破坏成功响应。
8. 运行插件全部测试、core 新增回归及全仓检查，记录既有阻断。此前的 215 个通过结果不能代替新实现的验证。
9. 如执行环境有现成可用凭证，使用独立内存会话做一次只读工具双轮 smoke；凭证不落日志/命令行。失败要明确标为尚未通过实时验证，不宣称覆盖全部模型。
10. 更新现有 changeset 为最终用户行为，一段、不超过 5 行，不记录中间修补历史。实施不包含服务重启或部署。

## 自审覆盖

C1/C2 → plan Task 1；C3 → Task 2；C4 → Task 3；C5/C7/C10 → Task 4；C6 → Task 5；C8 → Task 6；C9 及集成验收 → Task 7。前序补丁分别并入 Task 2、5 的最终实现和 Task 7 的发布说明。

未决的产品选择：无。长连接、分布式会话、完整 JSON Schema 验证和所有模型的性能基准明确属于范围外，不阻塞本 spec 的实施。
