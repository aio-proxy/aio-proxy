# 调用链：对齐 OTel 语义约定的完整 span 树

日期：2026-09-18
所属 PR：`claude/traces-detail-page`

## 这一版改了什么

本文件上一版结论是「修时间戳契约，不新增 span 与事件」，落地形态是 2 行 + 分段柱，
并在末尾留了一个待拍板项：要不要凑够 demo 的 9 行。

**该项已拍板：建树。** 随后的规范核查又推翻了原方案的几处前提，所以整篇重写。

- 保留：全部实测数字、三个已验证事实、「不发里程碑事件」「不做故障位置推断」等结论。
- 反转：新增 span、GenAI 语义层、属性改名。
- 作废：`startTime` 回填方案（被重排顺序取代，见「陷阱已消失」）。

## 背景

改版 demo 画了一棵九行的瀑布树。真实数据不是这样。

生产库（41,024 span / ~18.5k trace）实测每 trace 的 span 数：1 个的 25 条，
2 个（root + 一次尝试）的 14,946 条，3 个的 3,208 条，4 个的 350 条，5 个的 21 条。
只有四个 span 名被写过。约 80% 的 trace 渲染成两根柱子。

`semantic.ts` 里有 11 个 `spanName` 常量，生成路径上只有 `request` 和 `attempt` 会被真正
创建。**另外七个不是垃圾，是这棵树没接线的设计。**

## 规范依据

GenAI 语义约定已迁到 `open-telemetry/semantic-conventions-genai`（`gen_ai.*` 在 1.43.0
主包里标 `@deprecated Moved to…`，是迁移不是删除）。以下为原文：

> GenAI spans represent logical operations as observed by the caller.
> They SHOULD cover the duration of the operation, starting when it is initiated,
> ending when the response is fully received or the operation is terminated due to
> an error or cancellation.
> **If a transient issue happened and the request was retried automatically, the
> corresponding span SHOULD cover the duration of the logical operation with all retries.**

> GenAI spans SHOULD be named `{gen_ai.operation.name} {gen_ai.request.model}`.
> Semantic conventions for individual GenAI systems and frameworks
> **MAY specify different span name format**.

两条推论：

1. `{operation} {model}` 是 `SHOULD` 且明确授权自定义格式 —— 保留
   `aio_proxy.provider.attempt` 不违规，这是规范留的口子。
2. GenAI span 的边界是**逻辑操作含全部重试**，不是单次 attempt。对一个失败转移路由器，
   这正是需要单独一层的理由：成功那次 attempt 的耗时不含转移开销，会低估延迟。

`gen_ai.operation.name` 合法值共 9 个：`chat`、`text_completion`、`embeddings`、
`generate_content`、`execute_tool`、`create_agent`、`invoke_agent`、`invoke_workflow`、
`retrieval`。

span 状态：成功保持 `UNSET`（`OK` 保留给应用显式使用）；**SERVER span 上的 4xx 不得置
ERROR**。今天 `rejectRequest()` 把 400/404/413 记成 `outcome: 'failure'` → `SpanStatusCode.ERROR`，
违反这条。

## 第三方消费约束（Langfuse）

Langfuse 的 observation 类型是闭集，按属性从 span 推断，优先级链关键两档：

- **Priority 3**：`gen_ai.operation.name` ∈ {`chat`,`completion`,`text_completion`,
  `generate_content`,`generate`} → `GENERATION`；`embeddings` → `EMBEDDING`。
- **Priority 10 兜底**：span 带下列任一 key 即判 `GENERATION` ——
  `langfuse.observation.model.name`、`gen_ai.request.model`、`gen_ai.response.model`、
  `llm.model_name`、裸 `model`。

唯一的豁免 guard 按 `invoke_agent`/`agent_step` 判，**没有给 retry/attempt wrapper 留口子**。
后果：失败的 attempt 只要带了模型属性就会被当成一次真实生成计费，三次转移 = 四倍成本，
且无法 opt out。

这直接决定了下面的命名禁区。

已核查：`experimental_telemetry` 全仓零引用，AI SDK 遥测是 opt-in 默认关，所以 Langfuse
认 Vercel AI SDK 的 Priority 5/6（`operation.name` 前缀 + `ai.model.id`）打不着，
失败转移不会自己变成 GENERATION。

## 横向对照

调研 LiteLLM / OpenLLMetry / Portkey / Helicone / Langfuse 后的事实：

| 主题 | 行业现状 |
|---|---|
| 多级树 | 只有 LiteLLM 自建；其余单 span，层级靠调用方传入或框架装饰器 |
| 失败转移 | **无人建分组 span**。LiteLLM 同名 sibling 重复靠状态区分；Portkey 不单独记、把响应时间加总进一条日志；Helicone 记成独立请求 |
| `{operation} {model}` | 只有 2 家，且都藏在 flag 后（LiteLLM 要 `OTEL_SEMCONV_STABILITY_OPT_IN`，Portkey 要 `EXPERIMENTAL_GEN_AI_OTEL_TRACES_ENABLED`，其自家 UI 显示 `POST /v1/chat/completions`） |
| 计时子阶段 | **从不做 span**。LiteLLM 用 metric + `gen_ai.response.time_to_first_chunk`，Langfuse 用 `completionStartTime` |

两条据此定下的取舍：

- **TTFT 不做 span**，用标准属性 + UI 在 attempt 条上画刻度。全行业一致。
- **分组 span 保留，但承认是产品自创、零先例。** 理由：规范那句 retry 原文要这个数；
  Portkey 需要同一个数、用加总日志实现，我们在 span 层做是 OTel 原生解法；
  Langfuse 成本模型要求全链路恰好一个 GENERATION，有这层归属无歧义。

代价诚实记下：多一行，且没有先例可循。

## 已验证的事实（推翻了三个想当然）

### 1. `raw &&` 不是「raw 通道」，是「只观测到一个响应」

`response-observation.ts:108` 是 `const raw = responseCount === 1;`。它抑制的是
**多次响应导致的歧义**（`observeResponse` 在第二个响应时把 `transportObservation` 置为
`'ambiguous'`），跟传输方式无关。变量名有误导性。

`upstreamHeadersMs` 在 `observeResponse` 第 77 行写入，**早于** `controlledStream` 判断；
只有 `firstUpstreamByteMs` / `firstSseEventMs` / `contentEncoding` / `maxSseFramesPerRead`
需要 `controlledStream`，也就是 Bun 的 `decompress: false`，只有 raw 通道会设。

AI SDK 通道的 fetch 同样被 `createObservedFetch` 包过（`materialize.ts:193,219`），
所以 `model.ts:58` 的 `markTransportUnavailable()` 会被随后的 `observeFetchStart()` 清掉。

实测证实（按 attempt span 的 transport 列分组）：

| transport | attempt 数 | 有 headers | 有 first_byte | 有 ttft |
|---|---|---|---|---|
| ai_sdk | 11,529 | 8,255 | 12 | 5,813 |
| raw | 6,518 | 4,488 | 4,448 | 3,611 |
| （无） | 2,418 | 0 | 0 | 0 |

**结论：AI SDK 通道有响应头，只是没有首字节。**之前写的「AI SDK 路径永远没有响应头」是错的。

### 2. `endAttempt` 不是所有标量的汇聚点

`emit.ts:62` 的 `endAttempt` 只拿 `observation.snapshot()`，**不包含 TTFT**。
TTFT 走另一条路：`settleSuccess`（`emit.ts:93-104`）从 completion 里取 `ttftMs` 再 setAttribute。
失败路径 `emitAttempt` 根本没有 TTFT。

### 3. 首内容观测会在失败路径上丢失

`route-observation.ts:30-31` 的 rejection handler 直接造
`{ outcome: 'failure', errorCode: 'internal_error' }`，**不带 ttftMs**。
所以「capture 已经看到首个 token → egress 报错 → `Promise.all` reject」这条路上，
观测到的首 token 时间被终态整形丢掉了。这解释了为什么 ai_sdk 有 8,255 个 headers
却只有 5,813 个 ttft。

## 陷阱已消失：重排顺序取代 startTime 回填

上一版方案的核心风险是给 span 传 `startTime` 回填起点。`@opentelemetry/sdk-trace` 2.10.0
（本仓 pin 的版本）`Span.js` 的 `_getTime(inp)`：

```js
if (typeof inp === 'number' && inp <= otperformance.now()) {
  return hrTime(inp + this._performanceOffset);   // 分支 1：当成 performance 时间戳
}
if (typeof inp === 'number') return millisToHrTime(inp);  // 分支 2：当成 epoch 毫秒
...
if (this._startTimeProvided) return millisToHrTime(Date.now());  // 分支 3
```

一旦传了 `startTime`，`span.end()` 不带时间戳就走分支 3 用 `Date.now()`：起点是单调时钟
映射、终点是墙钟采样，请求过程中任何一次时钟校正都直接算进 duration —— 往后跳会让
`hrTimeDuration` 为负，被夹成 `[0,0]` 的零宽行。

**新方案不需要回填。** δ（候选循环 `startedAt` 与 attempt span 创建之间那段未记录的偏移）
的成因是 `model.ts:40-41` 先跑 `prepareModelInvocation()` + `assertCandidateSupported()` +
诊断日志，最后才 `startAttempt()`。改成**先建 attempt span，再在其中跑 prepare 子 span**，
δ 就变成一段真实测量的 span 宽度。

顺序问题用顺序解决，不用时间戳补偿。整片 `_getTime` 雷区随之消失。

prepare 产出的属性（provider / model）改为 span 创建后 `setAttribute`，不阻塞建 span。

## span 树

六种能力形状完全一致。以 language + 一次失败转移为例：

```
POST /v1/messages                                SERVER
├─ aio_proxy.request.parse                       INTERNAL
├─ aio_proxy.session.resolve                     INTERNAL
├─ aio_proxy.route.resolve                       INTERNAL
├─ chat claude-sonnet-4-5                        CLIENT    ← 唯一 GENERATION
│  ├─ aio_proxy.provider.attempt                 INTERNAL  ERROR
│  │  ├─ aio_proxy.request.prepare               INTERNAL
│  │  └─ POST                                    CLIENT
│  └─ aio_proxy.provider.attempt                 INTERNAL
│     ├─ aio_proxy.request.prepare               INTERNAL
│     ├─ POST                                    CLIENT
│     └─ aio_proxy.response.egress               INTERNAL
└─ aio_proxy.usage.resolve                       INTERNAL
```

失败转移 10 行，干净请求 8 行。**全部是真实代码边界，零合成 span。**

## 逐个 span

| span 名 | kind | 创建位置 | 状态规则 |
|---|---|---|---|
| `{method} {http.route}` | SERVER | `request-trace-recorder.ts:88` | **4xx 不置 ERROR**，仅 5xx / internal |
| `aio_proxy.request.parse` | INTERNAL | `pipeline/index.ts` `parseProtocolRequest()` | |
| `aio_proxy.session.resolve` | INTERNAL | `logicalSessionStore.begin()` | |
| `aio_proxy.route.resolve` | INTERNAL | `router.resolve()` + `filterCandidatesByCapability()` | |
| `{operation} {request.model}` | CLIENT | `attemptResolvedRequest` 外层（新增） | 全部候选耗尽才 ERROR |
| `aio_proxy.provider.attempt` | INTERNAL | `attempt/emit.ts:47`（补 `kind`） | 单次失败即 ERROR |
| `aio_proxy.request.prepare` | INTERNAL | `attempt/model.ts:40` `prepareModelInvocation()` | 这行宽度就是 δ |
| `POST` | CLIENT | `createObservedFetch` 包一层 | |
| `aio_proxy.response.egress` | INTERNAL | 出口流 | |
| `aio_proxy.usage.resolve` | INTERNAL | 用量归集 | |

`route.resolve` 的边界：上一版说「包在 `attemptCandidates()` 里只覆盖亲和性重排，名不符实」，
那是因为当时找错了位置。正确边界在 `attemptResolvedRequest` 内的 `lease.snapshot.router.resolve()`
加 `filterCandidatesByCapability()`，这两步就是路由解析本身。

### POST span 的终点只到响应头

`POST` span 从发起 fetch 起，**到拿到响应头结束**，不覆盖 body 流。

理由：body 终点在两条通道上可观测性不同（raw 有受控流能看到 EOF，AI SDK 没有），
让同一个 span 名在两条通道上表达不同几何比少一段信息更糟。而且当前 trace 的结算**可能早于
body EOF** —— AI SDK capture 在 `finish` 分片就结算而传输仍活着，raw capture 在终止帧结算
并刻意不因后续取消改判，所以「attempt 终点 = body 终点」本身就是错的。

body 阶段由 `aio_proxy.response.egress` 表达（我们向客户端写出的那段），首 token 位置由
TTFT 属性在 UI 上画成刻度。时间轴读起来是：prepare → POST（到响应头）→ egress（流式写出），
每段边界都诚实。

一个覆盖上游 body 消费全程的 span（`upstream.body.consume`：开始消费 → EOF / 读失败 / 取消）
是可能诚实的，但它会在 attempt / root 结算**之后**才结束，持久化与布局要另行设计。推后。

## 属性

### root（SERVER）—— 纯 HTTP，不带任何 `gen_ai.*`

```
http.request.method   http.route   url.path
http.response.status_code          ← 改名，原 http.status_code
error.type
aio_proxy.request_id  aio_proxy.inbound_protocol
```

### `{operation} {model}`（CLIENT）—— 唯一带 `gen_ai.*` 的 span

```
gen_ai.operation.name                      仅合法值时写，见下
gen_ai.provider.name                       取代已废弃的 gen_ai.system
gen_ai.request.model                       请求的模型
gen_ai.response.model                      实际应答的模型
gen_ai.request.stream
gen_ai.response.id
gen_ai.response.finish_reasons
gen_ai.response.time_to_first_chunk        double,秒
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
gen_ai.usage.cache_read.input_tokens
gen_ai.usage.cache_write.input_tokens
gen_ai.usage.reasoning.output_tokens
aio_proxy.capability                       六值,始终写
```

现有四个自造 `gen_ai.usage.*` 一一对上，还多出 cache / reasoning 两档。
这些属性今天挂在 root 上，**不只是名字不对，是挂错层了**，要下沉到这一层。

### attempt（INTERNAL）

```
aio_proxy.attempt.index
aio_proxy.attempt.provider_id
aio_proxy.attempt.model_id
aio_proxy.attempt.ttft_ms                  毫秒,UI 画刻度用
error.type
```

TTFT 存两份，职责不同：attempt 上是**观测原值**（毫秒，每次尝试都有，含失败的），
GenAI span 上的 `gen_ai.response.time_to_first_chunk` 是**标准属性**（秒），取胜出那次
attempt 的值。前者给 UI 画刻度，后者给第三方消费。不是冗余，是两个受众。

### POST（CLIENT）—— 观测标量落这层

```
http.request.method   server.address   url.full
http.response.status_code
aio_proxy.upstream.headers_ms
aio_proxy.upstream.first_byte_ms
aio_proxy.upstream.first_sse_event_ms
aio_proxy.upstream.transport            sse|body|unavailable|ambiguous
aio_proxy.upstream.content_encoding
```

### egress（INTERNAL）

```
aio_proxy.egress.content_gap_p95_ms
aio_proxy.egress.max_sse_frames_per_read
```

## 命名禁区

**attempt span 上禁止出现：`gen_ai.request.model`、`gen_ai.response.model`、
`llm.model_name`、裸 `model`。**

命中任一个，Langfuse Priority 10 兜底会把这个 span 判成 `GENERATION`，每次失败转移都变成
一次真实生成计费。provider / model 走 `aio_proxy.attempt.*`。

语义上也自洽：attempt 不是 GenAI span，它是 aio-proxy 的转移机制，本来就不该带 `gen_ai.*`。

## 六种能力统一命名

span 名与 `gen_ai.operation.name` 属性是两回事：规范只说名字 `SHOULD` 长成
`{operation} {model}`、且 `MAY` 自定义格式，没说属性必须存在。所以拆开处理。

- **span 名**：六种能力一律 `{operation} {model}`，词表固定六个，低基数。
- **`gen_ai.operation.name`**：只在合法时写。非法的四个不写，不往标准属性里塞非法枚举值。

| capability | span 名 | `gen_ai.operation.name` |
|---|---|---|
| language | `chat claude-sonnet-4-5` | `chat` |
| embedding | `embeddings text-embedding-3` | `embeddings` |
| image | `image dall-e-3` | 不写 |
| speech | `speech tts-1` | 不写 |
| transcription | `transcription whisper-1` | 不写 |
| video | `video veo-3` | 不写 |

`aio_proxy.capability` 始终写（六值），查询按它 group by，不用去匹配 span 名字符串。

Langfuse 两条路都通：写了属性的走 Priority 3（`chat`→GENERATION，`embeddings`→EMBEDDING）；
没写的靠 `gen_ai.request.model` 走 Priority 10 兜底成 GENERATION。都是恰好一个，不重复计费。

代码上只多一处条件：属性写入时查白名单。**结构零分支。**

## 实现任务

### 任务 1（server）span 注册表

`semantic.ts` 的 11 个裸字符串常量改成注册表：每个 span 声明 `{ name, kind, parent }`，
配一个校验测试。抄 LiteLLM v2 的 `SPAN_REGISTRY` + `validate_registry()` 思路。

「常量存在但没人创建」这种事结构上就不可能再发生 —— 这正是本次七个死常量的成因。

### 任务 2（server）属性改名与下沉

`http.status_code` → `http.response.status_code`；四个自造 `gen_ai.usage.*` 换成标准名并
从 root 下沉到 GenAI span；TTFT 标准属性按秒（内部 ms 保留给 UI 画刻度）。
`ALLOWED_ATTRIBUTES`（`span-record.ts:15`）同步。

历史数据不迁移、不做兼容。

### 任务 3（server）4xx 状态修正

`completion.ts:29-37` 今天 `failure` 与 `cancelled` 都置 `SpanStatusCode.ERROR`。
SERVER span 上的 4xx 要保持 UNSET。`rejectRequest()` 的 400/404/413 归到这一类。

`cancelled` 保持 ERROR 不变 —— 规范只约束 4xx。

### 任务 4（server）接线七个 span

按「逐个 span」表接线。含 attempt 与 prepare 的顺序重排：先建 attempt span，再在其中跑
prepare 子 span（理由见「陷阱已消失」）。
`AttemptInfo`（`attempt-base.ts:85-107`）现在把 `startedAt` 吞进 `durationMs` 就丢了，
改成一并带出。

### 任务 5（server）首内容观测归一到 observation

今天 TTFT 挂在 completion 的返回值上，被终态整形吃掉（见事实 3）。改成让 usage capture
观测到首个内容时写进 `AttemptResponseObservation`，由 `snapshot()` 带出，`endAttempt` 统一落属性。

这不是为了画图，是修一个真实的观测丢失：**保留时间不该依赖终态形状。**
副作用是失败路径也有 TTFT 了，而 `endAttempt` 真正变成单一汇聚点（上一版误以为它已经是）。

**不要**为了保住时间戳把失败的 egress 改判成成功。时间与结论分开存。

### 任务 6（dashboard）瀑布树渲染

`trace-layout.ts` 现在只管深度与柱宽，要支持真实多级嵌套。TTFT 在 attempt 条上画刻度，
不画成子行。

`transportObservation === 'ambiguous'` 时不画刻度，并在 UI 上说明「同一 attempt 内观测到
多次响应」，而不是显示成普通的缺数据。

旧数据（2 行，无新 span）照今天的单色柱渲染，`trace-waterfall-row.tsx:43-48` 保留为退路。

## 明确不做

- **不发里程碑事件。** 锚点问题已由重排顺序解决，`attempt 起点 + 标量` 就够画。事件是合法的
  OTel 表达方式，但要额外背上「标量与事件必须一致、都要活过持久化、所有终态路径都要发」的
  义务。真要发事件，该发的是**独立观测到的失败阶段**，不是复制已有标量。
- **不做 TTFT / stream.body 子 span。** 计时子阶段全行业从不做 span（见横向对照）。
  `stream.body = 首 token → attempt 终点` 是不诚实的。
- **不做故障位置推断。** 「有 `first_token` 且失败 = 首 token 之后断的」不成立：失败可能出在
  egress、序列化、取消或后续终态处理。「只有 `upstream_headers` = 没等到内容」更是把「没有
  记录」当成「没有发生」—— 观测可能不可用、被歧义抑制、被终态整形丢掉，或者根本不覆盖那类
  输出（AI SDK 的 `firstTokenAt` 只在 `text-delta` / `reasoning-delta` 上设，纯 tool-call
  不算）。**「首个 token」是一个特定的内容观测约定，不是「之前什么都没发生」的证据。**
- **不给旧数据合成 span。** δ 已永久丢失。
- **不做模态细分 usage。** `gen_ai.usage.text.*` / `.image.*` / `.audio.*` 那套等真有人要分
  模态计费再说。
- **不加采样、不改 retention。** 本 PR 每 trace 的 span 数从 2 涨到 8–10，是 4–5 倍。
  存储影响要在实施时实测，但采样是独立决策。

## 缺失的含义

一条规则：**缺失不代表旧版本。**新记录也会缺属性 —— 没走受控流（AI SDK 没有首字节）、
观测到多次响应（`ambiguous`）、`markTransportUnavailable()` 未被后续 fetch 清掉、
或者该阶段根本没发生。判断依据是「这个 span 上有没有这个属性」，不引版本号、不写迁移。

## 后续（不在本 PR）

`raw-retry.ts` 的同 attempt 内隐藏重试**完全不进 trace**。`resolveRawRetry()` 会消费并分类
第一个响应、改写请求、再次发起，全程在 usage capture 之前。「到底发了几次请求？哪次失败？
最终内容来自哪次？」今天无法回答 —— 这是真正缺信息的地方。

独立 server PR。做的时候：插桩**实际发送**而不是 `raw.invoke()` 调用（一次调用可能是多次
发送），区分候选下标与候选内重发下标，显式把发送 span 挂到 attempt 下 ——
现有的 `inAttempt()` 装的是观测与日志上下文，**不是** `OpenSpan.run()` 的 span 上下文。

## 测试

端到端契约测试，不是给 React 喂手写 fixture：

```
真实 pipeline 场景 → span 记录 → sanitize → 落库与读取 → 瀑布投影
```

| 场景 | 断言 |
|---|---|
| 注册表校验 | 每个声明的 span 都有创建点；kind 与 parent 与声明一致 |
| 一次失败转移 | 恰好一个 span 带 `gen_ai.request.model`；attempt 上零 `gen_ai.*` |
| 六种能力各一 | 树形状一致；非法 operation 不写 `gen_ai.operation.name` |
| 4xx 拒绝 | root 状态 UNSET；`http.response.status_code` 正确 |
| prepare 有延迟 / prepare 抛错 / 能力拒绝 | prepare span 宽度反映真实耗时，不再是黑洞 |
| 请求前后墙钟前跳 / 后跳 | duration 不被污染、不被夹成 0 |
| AI SDK 有内容无首字节、纯 tool-call 输出 | 仍有可用属性；没有 TTFT 不等于没有输出 |
| 首内容之后 egress 报错 | 观测活过终态替换；不把它标成上游 body 失败 |
| 同 attempt 内隐藏重试后成功 | 不跨响应造刻度；歧义可见 |
| 终止帧之后延迟 EOF 或取消 | 不把 trace 结算当成 body 完成或客户端送达成功 |

断言的是**时间边界、层级归属与错误归属正确**，不是「每条 trace 恰好有 N 行」。
