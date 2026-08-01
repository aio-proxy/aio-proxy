# SSE 流完成检测与 trace 计时修正

日期:2026-08-01
状态:设计已批准,待写实现计划

## 问题

流式请求的 trace `ended_at` 只在上游 SSE socket 到达 EOF(`reader.read()` 返回 `done`)时写入。某些上游(如 `super-relay`)在发出终止帧(`response.completed` / `[DONE]` / `message_stop` / `finish_reason`)后仍长时间挂住连接才关闭。后果:

1. **时间放大**:trace 记录的时长包含"内容发完之后的空转窗口"。实测 trace `108e6571...`:14 个 output token 的响应,内容约 7s 发完,但 span 记了 64s(≈56s 是终止帧之后的纯空转)。
2. **"永远运行中"**:dashboard 用 `ended_at IS NULL` 判 running(`trace-status.tsx:36`),连接不关则一直显示运行中。

现有唯一兜底是进程重启时的 `recover()`(把残留 running 标 `interrupted`),正常运行期不生效。

## 根因

- 完成信号(`terminal.resolve`)只在 `passthrough-capture.ts` 的 `pull()` 读到 EOF(`:82`)时触发。
- observer 在 `:119` 逐帧解析时**已经实时识别** `response.completed`,但只用它取 `responseId`(`:104`),丢弃了"内容已完成"的时间信息。
- `ended_at` 由 `root.end()` 时刻决定(`trace-lifecycle.ts:98` `endedAt = rootSpan.endedAt`)。`root.end()` 由 `finishFrom` promise resolve 驱动,而该 promise 链根在 `terminal.resolve`。所以提前 resolve = 提前 `ended_at`,无需改写 `ended_at` 逻辑。
- 同一病根也在 model / AI SDK 路径:`stream-capture.ts:40-44` 同样只在 `next.done`(EOF)才 resolve,尽管 `finish` part(`:64`)早已到达。本设计两条路径一并修。观测样本 `108e6571`(`transport: raw`)走 passthrough,故以它为主要复现场景。

## 参考项目调研结论

| 项目 | 内容级 idle 超时 | 主完成机制 |
|---|---|---|
| new-api | 300s(每帧 `ticker.Reset`) | 终止帧 `[DONE]`,`stream_scanner.go:265-280` |
| sub2api | 180s(每帧 `lastReadAt`) | 终止帧 + idle 双保险 |
| CLIProxyAPI | 无(仅 WS 5min) | 纯终止帧 `response.completed` |
| claude-code-hub | 无 | 纯终止帧 `TERMINAL_EVENT_TYPES` |
| opencode | 无(AI SDK) | SDK 终止 chunk |

**5 个项目全部不以 socket EOF 判完成。** 3 个纯靠终止帧;2 个另加 idle 兜底,阈值均取 180–300s 的宽松值。aio-proxy 当前用 EOF 判完成是唯一异类。

## 设计:两层,独立生效

- **第 1 层(idle-timeout 兜底,协议无关)**:保证"绝不永远运行中"。
- **第 2 层(终止帧即完成,逐协议)**:保证"时间精确到终止帧那一刻"。

两层解耦:即使某协议的终止帧判定漏了,第 1 层仍兜底;即使 idle 阈值很宽松,第 2 层仍保证精度。

### 第 1 层:idle-timeout

**位置**:两条流消费路径的 `pull()` 各加一个 idle 计时器:
- `packages/server/src/usage-capture/passthrough-capture.ts`(raw passthrough,`returnedBody` ReadableStream)。
- `packages/server/src/usage-capture/stream-capture.ts`(AI SDK / model 能力,`value` ReadableStream)。

**机制**(照抄 new-api `ticker.Reset` / sub2api `lastReadAt` 模式):

- 每次 `pull()` 成功读到 chunk/part 时重置一个 idle 计时器。
- 超过阈值未读到新数据 → `terminal.resolve({ outcome: 'failure', errorCode: 'stream_idle_timeout', ... })`,并 `reader.cancel()` 释放上游连接。
- 覆盖面:passthrough 侧 4 个 SSE 协议 + 非 SSE JSON passthrough(`captureJson` 分支);AI SDK 侧所有 model 能力流。这层不看帧内容,只看数据到达时刻。

**阈值**:文字端点 **300s**(对齐 new-api)。

> **待办记录(未来工作)**:新增图片/图像生成端点时,idle 阈值需放大(参考 sub2api 图片流 900s、范围 60–1800s)。图片流首字节延迟与帧间隔远大于文字流,300s 会误杀。在引入图片 passthrough 时把该阈值做成按端点类型区分。

**终止状态**:idle 超时 resolve 为 `failure`(而非新增 `timeout` reason)。理由:`TraceTerminationReason` 现有枚举为 `failure | cancelled | interrupted`(`trace.ts:38`),idle 超时是"上游未能在合理时间内完成",归入 `failure` 语义正确且不扩 schema。`errorCode: 'stream_idle_timeout'` 用于区分具体原因。

### 第 2 层:终止帧即完成

两条路径终止信号不同,但都在 `pull()` 内提前 `terminal.resolve`,不等 EOF。

#### 2a. raw passthrough(`passthrough-capture.ts` + `passthrough-usage.ts`)

**位置**:
- `passthrough-usage.ts`:observer 增加终止帧检测,`onEvent`(`:106`)命中即回调(新增 `onTerminal`)。
- `passthrough-capture.ts`:接到回调即提前 `terminal.resolve`。

**终止帧判定**(4 协议全实现,复用现有 switch 模式如 `content.ts:8` / `protocolFailure:177`):

| 协议 | 完成终止帧(→ success) | 现状 |
|---|---|---|
| OpenAIResponse | `response.completed` / `response.done` | `completedResponseId` 已有,复用 |
| Anthropic | `message_stop` | 新增 |
| OpenAICompatible | `choices[].finish_reason != null`(随后通常跟 `[DONE]`) | 新增 |
| Gemini | `candidates[].finishReason` 存在 | 新增 |

失败/截断终止帧(`response.failed` / `response.incomplete` / `response.cancelled` / `error`)已由现有 `protocolFailure:177` 识别,归 `failure`。第 2 层在命中它们时同样提前 resolve(outcome=failure),不再等 EOF——即"任何终止帧都提前收尾":成功帧 → success,失败帧 → failure。

#### 2b. AI SDK / model 能力(`stream-capture.ts`)

比 passthrough 更简单:AI SDK 已把终止信号归一化为 `finish` part(`stream-capture.ts:64`),现有代码已在 `finished`/`finishUsage` 记录它,只是仍等 `next.done` 才 resolve(`:40-44`)。

**改法**:`pull()` 读到 `type === 'finish'` part 时,记录后**立即** `terminal.resolve(success + usage)`(usage 由该 part 的 `normalizeAiSdkUsage` 得到),不等后续 part 或 EOF;`abort` part 仍走 cancelled。无需协议判定——SDK 已归一。剩余 part 继续 enqueue 给客户端直到真 EOF。

#### 提前 resolve 后的流处理(用户已定:resolve 但不断流)

- 命中终止帧 / finish part → resolve completion(此刻写 `ended_at` + usage;`finalizeUsage` 照常跑)。
- ReadableStream **继续 pull** 把剩余数据(passthrough:keepalive / 空行 / `[DONE]`;AI SDK:终止后的尾部 part)透传给客户端,直到真 EOF 才关连接。
- 客户端行为不变(仍收到完整流),但 trace 时间精确到终止帧时刻。
- resolve 幂等:`terminal` 是 `deferred`,内部已有 `settled` 卫兵(`shared.ts:69-81`),第二次 resolve(EOF 分支)天然无副作用。

**usage 完整性**:不断流,故终止帧之后若还有尾部 usage 帧(罕见),observer/SDK 仍会累积——但 completion 已 resolve,以终止帧时刻的 usage 为准。终止帧按协议约定携带最终 usage,可接受。

## 数据流

```
上游 SSE ──> passthroughCapture.pull()
              │  每帧: sseObserver.feed(chunk) ──> onEvent(:106)
              │                                      ├─ 命中终止帧? ──> onTerminal 回调 ──> terminal.resolve(success + usage)  [第2层]
              │                                      └─ 累积 usage / responseId
              │  reset idleTimer                                                                                             [第1层]
              │  idleTimer 超时 ──> terminal.resolve(failure: stream_idle_timeout) + reader.cancel()                          [第1层]
              └─ EOF(next.done) ──> terminal.resolve(success + usage)  [原路径,幂等兜底]
                          │
terminal.resolve ─> settleSuccess.then ─> finishFrom promise ─> recorder.complete() ─> root.end() ─> ended_at 写入(=真实完成时刻)
```

## 错误处理

- **终止帧是失败态**(`response.failed` / `error` 帧):复用现有 `protocolFailure`,resolve 为 `failure`,保持现状。
- **idle 超时**:resolve `failure` + `errorCode: 'stream_idle_timeout'`,cancel 上游。
- **客户端断开**:走现有 `cancel(reason)` 分支(`:123`),resolve `cancelled`,不受本改动影响。
- **resolve 竞态**:idle timer、终止帧、EOF 三者可能竞争 resolve。`deferred` promise 天然取第一个 resolve;需确保后续 resolve 与 `reader.cancel` 幂等,不重复释放 reader(现有 `releaseReader` 已有 `released` 卫兵)。

## 测试

- **第 2 层 passthrough**:每协议一个单测——喂入 `content delta + 终止帧 + (长延迟)剩余字节`,断言 completion 在终止帧后立即 resolve、usage 正确、剩余字节仍透传到客户端。至少 OpenAIResponse(复现 `108e6571` 场景)+ Anthropic `message_stop` + OpenAICompatible `finish_reason` + Gemini `finishReason`。
- **第 2 层 AI SDK**:`stream-capture` 单测——`finish` part 后紧跟额外 part,断言 completion 在 `finish` 时即 resolve success(带 usage),额外 part 仍 enqueue 给消费者。
- **第 1 层**(两路径各一):喂入若干帧/part 后停止供给(不发终止帧、不 EOF),断言 idle 阈值后 resolve `failure: stream_idle_timeout` 且 reader 被 cancel。用小阈值注入测试。
- **幂等**:终止帧 resolve 后再触发 EOF,断言 completion 只 resolve 一次、无重复副作用。
- 现有 `passthrough-capture` / `passthrough-usage` / `stream-capture` 测试须保持绿。

## 对模型请求的影响(口径 vs 行为)

本改动对模型请求本身透明,只改计时口径 + 一处连接释放行为:

- **透明**:客户端收到的字节流内容/顺序/结束时机不变(不断流);usage/token 统计不变(同一份终止帧数据);路由/转换/egress 不变。
- **口径变化**:`ended_at` 从"上游 socket 关闭时刻"变为"终止帧到达时刻",dashboard running 状态与 span 时长因此变准。这是纯观测口径。
- **行为变化(仅第 1 层)**:idle 超时会主动 `reader.cancel()` 切断挂死的上游连接。对正常请求零影响(正常请求早在终止帧/EOF 结束,碰不到 300s)。仅在上游异常挂死 > 阈值时触发,切断本就泄漏的连接是止损。此默认对齐 new-api/sub2api;若审阅时希望 idle 只 resolve 计时、不切上游(连接等自然 EOF),可在实现前推翻。

## 影响面

- 改动落在 `passthrough-capture.ts`、`passthrough-usage.ts`、`stream-capture.ts`(均 < 300 行约束,注意拆分)。
- observer 接口新增一个 `onTerminal` 回调(`PassthroughSseCallbacks`),向后兼容。
- 不改 `ended_at` 写入、`complete()`、trace schema、dashboard。
- idle 阈值作为常量引入(文字 300s),预留按端点类型区分的扩展点。

## 非目标

- 不改客户端可见的流内容(不断流)。
- 不新增 `timeout` 终止 reason(复用 `failure`)。
- 不实现图片端点的差异化阈值(仅记录为未来工作)。
