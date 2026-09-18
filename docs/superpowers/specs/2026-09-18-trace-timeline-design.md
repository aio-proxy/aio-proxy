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

### 对抗式复核后的更正（同一版内）

这棵树经过一轮对抗式复核，改掉了下面这些。列在这里因为它们都是**曾经写进本文档的错误**：

| 原写法 | 事实 | 处置 |
|---|---|---|
| Langfuse 会重复计费且「无法 opt out」，本树被它强制 | 全仓无 exporter 无 Langfuse；Priority 1 读 `langfuse.observation.type` 就是逃生口；计费未复现 | 该节改为前瞻性理由，不再当硬约束 |
| root 删掉 setter 就是纯 HTTP | `span-projection.ts:225-231` 读回时从 summary 列重建 `gen_ai.*` | 新增事实 4；任务 5 一并改投影；断言移到读回之后 |
| `aio_proxy.response.egress` 测「向客户端写出的那段」 | 要挂的标量全产生于上游读取，下游写出无结算契约无观测点 | 删掉该 span，标量留在 attempt |
| `POST` span 到响应头结束，却挂 `first_byte_ms` 等 | 这些值在响应头之后产生，写已结束的 span 会被拒 | `POST` 只留 `headers_ms`，其余落 attempt |
| GenAI span 包在 `attemptResolvedRequest` 外层；候选耗尽才 ERROR | 路由在该函数内部；`raw.ts:115-130` 会在仍有候选时终止 | 起点移到路由之后，ERROR 判据改为逻辑失败 |
| 任务顺序 1→6 | 属性下沉排在目标 span 创建之前，注册表校验排在创建点之前 | 按依赖重排为 7 个任务 |
| 一次失败转移 10 行 / 干净 8 行 | 数错了 | 12 行 / 9 行，新增 7 种 span 类型 |

`model-prepare.ts:98-99` 自行发射+结算导致的重复 attempt，以及 `processor.take()` 抽干 buffer
导致的子 span 丢弃，是本轮新发现的实现陷阱，见「结算所有权」与任务 3。

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

## 第三方消费约束（Langfuse）—— 前瞻，不是硬约束

**先把现状说清楚：今天没有任何导出。** 全仓零 OTLP exporter、零 Langfuse 集成、
零 exporter 依赖（`packages/server/package.json` 只有 `@opentelemetry/api`、
`sdk-trace-node`、`semantic-conventions`）。`2026-07-24-trace-session-affinity-design.md:24`
明确写 "No Collector, OTLP export, external Trace backend"，OTLP 只在该文 268 行
「后续可选」里出现过一次。

OTLP 导出是计划中的方向，所以这棵树按标准语义搭，目的是**将来接 exporter 时不需要重映射**。
但它不是当下的强制约束 —— 下面的取舍都要按「为未来省事」而不是「不改就出事」来读。

Langfuse 的 observation 类型是闭集，按属性从 span 推断，
`packages/shared/src/server/otel/ObservationTypeMapper.ts` 的优先级链相关三档：

- **Priority 1**：直接读 `langfuse.observation.type`，取值表含 `span: "SPAN"`，
  经 `ObservationTypeDomain.safeParse()` 校验后返回。**这是显式逃生口，压过 Priority 10。**
- **Priority 3**：`gen_ai.operation.name` ∈ {`chat`,`completion`,`text_completion`,
  `generate_content`,`generate`} → `GENERATION`；`embeddings` → `EMBEDDING`。
- **Priority 10 兜底**：span 带下列任一 key 即判 `GENERATION` ——
  `langfuse.observation.model.name`、`gen_ai.request.model`、`gen_ai.response.model`、
  `llm.model_name`、裸 `model`。全部 mapper 都不认领时终态返回 `"SPAN"`。

**上一版这里写错了两处，更正：**

1. 写「无法 opt out」是错的。Priority 1 就是 opt out：任何 span 挂
   `langfuse.observation.type = "span"` 即可强制判 SPAN。所以命名禁区是**我们选的**干净做法
   （不引供应商专有属性），不是被迫的。
2. 写「三次转移 = 四倍成本」是未经证实的推断。Langfuse 的推算成本还要求有 usage 且能匹配到
   计价模型，本 spec 没有做计费复现。判成 GENERATION ≠ 必然计费。

仍然成立的部分：attempt span 今天确实带 `gen_ai.response.model`（`emit.ts:52`），
真接了 exporter 就会被 Priority 10 判成 GENERATION，一条 trace 里出现多个 GENERATION，
聚合语义含糊。GenAI span 这层则靠 Priority 3 的 `gen_ai.operation.name` 干净分类，
不依赖 model 兜底。这是下面命名禁区的理由 —— 语义正确，不是避免账单。

另外，把模型与 usage 属性留在 root SERVER span 上并不会让 Langfuse 分类失败（它的 mapper
不看 span kind）。GenAI span 这层要靠「单独测量一次逻辑操作耗时」立论，不能靠编造的计费限制。

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
所以「capture 已经看到首个 token → 出口流报错 → `Promise.all` reject」这条路上，
观测到的首 token 时间被终态整形丢掉了。这解释了为什么 ai_sdk 有 8,255 个 headers
却只有 5,813 个 ttft。

### 4. 读路径会把 `gen_ai.*` 重新塞回 root，不管 recorder 写不写

**这条推翻了「root 纯 HTTP」能靠删 setter 达成的想法。**

`trace-lifecycle.ts:111-132` 把终态的 `finalModelId` 与整套 usage 落进 **root 的 summary 列**，
这些列取自 `input.summary`，与 root span 的属性无关。读回来时
`span-projection.ts:225-231` 逐个还原：

```ts
set(ATTR.genAiRequestModel, isRoot ? columns.requestedModelId : columns.modelId);
set(ATTR.genAiResponseModel, columns.finalModelId);
set(ATTR.genAiUsageInputTokens, columns.inputTokens);
// … output / total / cacheRead / cacheWrite / reasoning
```

`mergeAttributes` 的唯一调用方是 `trace-queries.ts:163`，即 dashboard 读路径。所以
**删掉 recorder 里的 setter 不会得到一个不带 `gen_ai.*` 的 root** —— 落库再读一遍它又回来了。

两个后果：

- root 是「纯 HTTP」只在**发射时**成立，在**读回时**不成立。spec 下文的属性表要按这个事实写。
- 断言必须放在**落库并读回之后**，只断言发射出的 span 会漏掉这整条重建路径。

summary 列本身要留 —— 那是记账与列表页排序用的投影，不是 span 属性的副本。要改的是
「读回时自动把它们重建成 root 的 `gen_ai.*` 属性」这一步。

## 陷阱已消失：不回填 `startTime`

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
的成因是 `model.ts:24-41` 先跑 `prepareModelInvocation()` + `assertCandidateSupported()` +
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
│     └─ POST                                    CLIENT
└─ aio_proxy.usage.resolve                       INTERNAL
```

**新增 span 类型 7 种**（root 与 attempt 已存在）。一次失败转移 12 行，干净请求 9 行。
每种都要在下表指到一个确切的代码边界 —— 指不出来的不做。

## 逐个 span

| span 名 | kind | 创建位置 | 状态规则 |
|---|---|---|---|
| `{method} {http.route}` | SERVER | `request-trace-recorder.ts:88` | **4xx 不置 ERROR**，仅 5xx / internal |
| `aio_proxy.request.parse` | INTERNAL | `pipeline/index.ts:182` `adapter.parse`（**不是**外层 `parseProtocolRequest()`，见下） | |
| `aio_proxy.session.resolve` | INTERNAL | `pipeline/index.ts:97` `logicalSessionStore.begin()` | |
| `aio_proxy.route.resolve` | INTERNAL | `pipeline/index.ts:259-265` `router.resolve()` + `filterCandidatesByCapability()` | |
| `{operation} {request.model}` | CLIENT | `attemptResolvedRequest` 内、**路由解析之后**（新增） | 逻辑失败即 ERROR，**不是**候选耗尽 |
| `aio_proxy.provider.attempt` | INTERNAL | `attempt/emit.ts:47`（补 `kind`，改挂到 GenAI span 下） | 单次失败即 ERROR |
| `aio_proxy.request.prepare` | INTERNAL | `attempt/model.ts:24` `prepareModelInvocation()` | 这行宽度就是 δ |
| `POST` | CLIENT | `createObservedFetch` 包一层 | 只到响应头，见下 |
| `aio_proxy.usage.resolve` | INTERNAL | `usage-capture/usage-validation.ts:8-23` `finalizeUsage()` | |

### 三条被 pipeline 现状否决的画法，及更正

**（a）GenAI span 不能包在 `attemptResolvedRequest` 外层。** 路由解析发生在该函数**内部**
（`index.ts:259-265`），而树里 `route.resolve` 画成 GenAI span 的兄弟。两者只能同时成立于
「GenAI span 在函数内、路由之后开始」。另外流式路径会在其注册的 completion 结算之前就
`return` 掉 `Response`，所以它的终点必须取**终态结算**，不是函数返回。

**（b）ERROR 条件不是「全部候选耗尽」。** `attempt/raw.ts:115-130`：当 `fallback === false`
但状态是错误时，直接 `session.finish({...finalFailure})` 并 `return { kind: 'return' }` ——
此时 `hasNext` 完全可能还是 true。不可重试的状态会在**还有候选**的情况下终止整个逻辑操作。
所以 ERROR 的判据是「该逻辑操作以失败结算」，与候选是否用尽无关。

**（c）attempt 必须显式改挂到 GenAI span 下。** `emit.ts:47` 今天把 attempt 挂在
`session.rootContext`，也就是 root。加了 GenAI span 这层不会自动重挂 —— 这是任务 4 的活，
不能推后（否则树是平的，等于没做）。

**（d）parse 要插桩 `adapter.parse`，不是外层包装。** `parseProtocolRequest()` 的失败分支
在函数**内部**就把 root 结算掉了，见下面「结算所有权」。包在它外面的 span 会在 root 结算之后
才结束，直接被丢弃。

`route.resolve` 的边界：上一版说「包在 `attemptCandidates()` 里只覆盖亲和性重排，名不符实」，
那是因为当时找错了位置。正确边界在 `attemptResolvedRequest` 内的 `lease.snapshot.router.resolve()`
加 `filterCandidatesByCapability()`，这两步就是路由解析本身。

### POST span 的终点只到响应头

`POST` span 从发起 fetch 起，**到拿到响应头结束**，不覆盖 body 流。

理由：body 终点在两条通道上可观测性不同（raw 有受控流能看到 EOF，AI SDK 没有），
让同一个 span 名在两条通道上表达不同几何比少一段信息更糟。而且当前 trace 的结算**可能早于
body EOF** —— AI SDK capture 在 `finish` 分片就结算而传输仍活着，raw capture 在终止帧结算
并刻意不因后续取消改判，所以「attempt 终点 = body 终点」本身就是错的。

body 阶段**不做 span**，body 期观测到的标量留在 attempt span 上 —— 那本来就是
`emit.ts:62` `endAttempt` 取 `observation.snapshot()` 的通路，attempt 那时还没结束，零新机制。
首 token 位置由 TTFT 属性在 UI 上画成刻度。时间轴读起来是：prepare → POST（到响应头）→
attempt 条剩下的宽度就是 body 期，刻度标出首 token。

**上一版的 `aio_proxy.response.egress` span 删掉。** 它被定义成「我们向客户端写出的那段」，
但要挂上去的 `max_sse_frames_per_read` 产生于 `response-observation.ts:84-86` 的
`observeRead`，读的是**上游**响应；`content_gap_p95_ms` 同理。换个命名空间不会让上游读变成
下游写。而真正的下游写出，今天既没有结算契约、也没有观测点 —— raw 成功路径在
`attempt/raw.ts:169-180` 从 `captured.completion` 就结算了。一个测不到自己声称测的东西的
span，不如不要。

一个覆盖上游 body 消费全程的 span（`upstream.body.consume`：开始消费 → EOF / 读失败 / 取消）
是可能诚实的，但它会在 attempt / root 结算**之后**才结束，持久化与布局要另行设计。推后。

### 结算所有权：span 必须在 root 结算前关掉

`request-trace-recorder.ts:142-143` 是 `root.end()` 紧接 `processor.take(traceId)`，
`take` 把该 traceId 的 buffer 抽干删除。**此后任何子 span 的 `onEnd` 都被丢弃。**
同理 `Span.js:80-82` 会拒绝对已结束 span 写属性。

这条对本方案有两处硬约束：

1. **不能把 span 包在自己结算 root 的函数外面。** `parseProtocolRequest()` 的失败分支在内部
   就 finish 了，所以插桩点取 `adapter.parse`（表里已更正）。
2. **`model-prepare.ts:98-99` 这条路要改。** 它在 `adapter.modelInvocation` 抛错时自己调
   `ctx.emitter.emitAttempt(...)`（开+关一次性合成一个 attempt span）再
   `session.finish(...)`。任务 4 若「先建 attempt span 再跑 prepare 子 span」，这条路会
   ①留下一个永不关闭的 attempt span，②再合成第二个 attempt —— 一次失败出两行。
   改法：让准备阶段**返回拒绝信息**而不是自己发射 + 结算，复用已打开的那个 attempt span，
   并在 root 结算前关掉所有子 span。

## 属性

### root（SERVER）—— 发射时纯 HTTP

```
http.request.method   http.route   url.path
http.response.status_code          ← 改名，原 http.status_code
error.type
aio_proxy.request_id  aio_proxy.inbound_protocol
```

**注意：只删 recorder 里的 setter 不够。** `span-projection.ts:225-231` 会在读回时从 summary
列把 `gen_ai.request.model` / `gen_ai.response.model` / 整套 `gen_ai.usage.*` 重新挂到 root 上
（见事实 4）。要一起改这个投影，否则 dashboard 上 root 行照旧带着这些属性，
「唯一一个带 `gen_ai.*` 的 span」的断言在读回后不成立。summary 列本身保留。

### `{operation} {model}`（CLIENT）—— 唯一带 `gen_ai.*` 的 span

```
gen_ai.operation.name                      仅合法值时写，见下
gen_ai.provider.name                       取代已废弃的 gen_ai.system
gen_ai.request.model                       请求的模型
gen_ai.response.model                      实际应答的模型
gen_ai.request.stream
gen_ai.response.id
gen_ai.response.finish_reasons
gen_ai.response.time_to_first_chunk        double,秒;起点是本 span 起点
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
aio_proxy.attempt.ttft_ms                  毫秒,起点是本 attempt span 起点
error.type

body 期观测（由 endAttempt 从 observation.snapshot() 落下，attempt 此时仍未结束）：
aio_proxy.upstream.first_byte_ms
aio_proxy.upstream.first_sse_event_ms
aio_proxy.upstream.content_gap_p95_ms
aio_proxy.upstream.max_sse_frames_per_read
aio_proxy.upstream.transport               sse|body|unavailable|ambiguous
aio_proxy.upstream.content_encoding
```

后六项留在 attempt 而不是 POST 上，因为它们全部在响应头之后才产生，而 POST span 那时已经
结束了（写属性会被拒，且 buffering processor 在 `onEnd` 已经拷走记录）。命名空间用
`upstream` 是准确的 —— 它们测的确实是上游响应的读取过程。

两个 TTFT **不是同一个量**，不是同一个数存两份。

| | `gen_ai.response.time_to_first_chunk` | `aio_proxy.attempt.ttft_ms` |
|---|---|---|
| 挂在 | GenAI span | 每个 attempt span |
| 起点 | GenAI span 起点 | 该 attempt span 起点 |
| 终点 | 吐给客户端的第一个 chunk | 从该 provider 观测到的首个内容 |
| 含失败转移耗时 | **含** | 不含 |
| 失败时 | 不写 | **写**，这正是它存在的理由 |
| 单位 | 秒（`double`） | 毫秒 |

一次转移后前者可能 3.2s、后者 0.4s。规范原文是 "measured from request issuance"，
而 GenAI span 按约定要覆盖含全部重试的逻辑操作，所以它的 issuance 就是逻辑起点。
引入该属性的 issue（semantic-conventions#3598）写明意图是
"Client TTFT includes network latency and is the metric users actually experience" ——
调用方等的就是 3.2s，per-attempt 的 0.4s 没有任何客户体验过。作者的示例是单次
LangChain 调用，PR #3607 全程没提过 retry / failover，`gen-ai-spans.md` 的
「Streaming chunks」章节正文至今是 `TODO`。两者重合时他们没区分，分叉时按其写明的意图取逻辑值。

**因此同名不同起点是禁止的**，naming.md 原文：
"Avoid introducing names and namespaces that would mean different things when used by
different conventions or instrumentations."
`gen_ai.response.time_to_first_chunk` 在 `model/gen-ai/spans.yaml:238` 只被
`gen_ai.inference.client` 一个 group 引用，不在任何共享 `attribute_group` 里——
它的语义只相对那个 group 定义。attempt 上写这个 key 会让一个 trace 里出现两个起点，
且没有任何属性能区分，聚合时必然重复计入胜出路径。

attempt 侧也不能借 `gen_ai.` 前缀（`gen_ai.aio_proxy.attempt.*` 之类），同一份 naming.md：
"It is not recommended to use existing OpenTelemetry semantic convention namespace as a
prefix for a new company- or application-specific attribute name."

单位不对称是刻意的。秒是硬约束：registry 写明 `in seconds`，姊妹 metric
`gen_ai.client.operation.time_to_first_chunk` 的 bucket 也是秒，写毫秒等于给每个合规
消费者一个 1000× 错误。毫秒则是为了跟它加入的那一族对齐——`semantic.ts` 里
`aio_proxy.response.upstream_headers_ms` / `first_upstream_byte_ms` /
`first_sse_event_ms` / `content_gap_p95_ms` 全是 `_ms`。命名空间内部一致优先于跨命名空间一致，
`_ms` 后缀在每个读取点都自带单位。

**第三个起点：两层都不满足字面的「request issuance」。** `raw-retry.ts` 在单次 attempt
内部做隐藏重试，全程在 usage capture 之前、完全不进 trace。所以
`aio_proxy.attempt.ttft_ms` 的起点是 attempt span 起点，**不是** 实际发包时刻。这条独立地
否决了「两层共用标准 key」——树里没有任何一层能诚实地声称自己是 issuance。

代价记一笔：姊妹 metric `gen_ai.client.operation.time_to_first_chunk` 在这个定义下会把
模型延迟和转移延迟混进同一个分布，呈双峰。这是正确的代价——另一个选择是让网关看起来比
实际更快——但如果发这个 metric，必须用同一个逻辑值，并接受双峰。

OTel 自己的 reference report 在 13 个库上对这个属性全是 `(none)`。野外确有零星实现
（VS Code Copilot、Sentry、Microsoft.Extensions.AI、litellm 等），但**每一个多层 tracer 都只
把它挂在最内层那个 per-LLM-call span 上**——哪怕其中有些会把 token 数向上层重复累加。
两层都发这个 key 的实现一个也没有。

**实现注意：拿不到非废弃的类型常量。** `semantic-conventions-genai` 仓库只有
`model/` `docs/` `reference/` `templates/`，不发生成代码包；旧家
`@opentelemetry/semantic-conventions` 里的
`ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK`（`experimental_attributes.ts:7462`）标了
`@experimental` + `@deprecated Moved to…`。在 `semantic.ts` 里直接写字符串字面量，
不要 import 那个废弃常量——它的 deprecation 说的是「搬家了」，不是「要删了」，
但 lint 不认识这个区别。

### POST（CLIENT）—— 只放响应头之前就已确定的事实

```
http.request.method   server.address   url.full
http.response.status_code
aio_proxy.upstream.headers_ms
```

`headers_ms` 可以留在这里：`response-observation.ts:77` 的 `upstreamHeadersMs` 写在
`observeResponse` 里、早于 `controlledStream` 判断，正是本 span 的终点时刻。
其余上游标量全部在此之后产生，见上一节。

## 命名禁区

**attempt span 上禁止出现：`gen_ai.request.model`、`gen_ai.response.model`、
`llm.model_name`、裸 `model`。**

命中任一个，Langfuse Priority 10 兜底会把这个 span 判成 `GENERATION`，一条 trace 里就出现
多个 GENERATION，聚合语义含糊（是否真产生重复费用还取决于 usage 与计价模型匹配，本 spec
未做计费复现）。provider / model 走 `aio_proxy.attempt.*`。

用 `langfuse.observation.type = "span"` 强行压成 SPAN 也能达到同样效果（Priority 1），
但那是往通用 span 上钉供应商专有属性。**选干净命名，不选供应商属性。**

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

将来接 exporter 时 Langfuse 两条路都通：写了属性的走 Priority 3（`chat`→GENERATION，
`embeddings`→EMBEDDING）；没写的靠 `gen_ai.request.model` 走 Priority 10 兜底成 GENERATION。
无论哪条，全链路恰好一个。

代码上只多一处条件：属性写入时查白名单。**结构零分支。**

## 实现任务

按依赖排序。上一版的顺序是坏的：属性下沉排在创建目标 span 之前，注册表校验排在创建点存在
之前。每个任务要能独立跑绿。

### 任务 1（server）4xx 状态修正

`completion.ts:29-37` 今天 `failure` 与 `cancelled` 都置 `SpanStatusCode.ERROR`。
SERVER span 上的 4xx 要保持 UNSET。`rejectRequest()` 的 400/404/413 归到这一类。

`cancelled` 保持 ERROR 不变 —— 规范只约束 4xx。

与 span 树无关，独立可验。

### 任务 2（server）首内容观测归一到 observation

今天 TTFT 挂在 completion 的返回值上，被终态整形吃掉（见事实 3）。改成让 usage capture
观测到首个内容时写进 `AttemptResponseObservation`，由 `snapshot()` 带出，`endAttempt` 统一落属性。

这不是为了画图，是修一个真实的观测丢失：**保留时间不该依赖终态形状。**
副作用是失败路径也有 TTFT 了，而 `endAttempt` 真正变成单一汇聚点（上一版误以为它已经是）。

**不要**为了保住时间戳把失败的出口流改判成成功。时间与结论分开存。

同样与 span 树无关，独立可验。

### 任务 3（server）结算所有权归位

前置于任务 4，单独一个任务因为它改的是控制流不是遥测。

`model-prepare.ts:98-99` 现在在 `adapter.modelInvocation` 抛错时自己
`emitAttempt` + `session.finish`。改成**返回拒绝信息**，由候选循环统一发射与结算。
`parseProtocolRequest()` 的失败分支同理 —— 拒绝要沿返回值往上走，不在函数内部终结 root。

验收：这一步不新增任何 span，现有 trace 形状与属性保持不变，测试证明拒绝路径的终态、
状态码、日志与改之前逐字段一致。**这是纯重构。**

### 任务 4（server）接线七个 span

按「逐个 span」表接线，含下面这些不能推后的部分：

- attempt 与 prepare 的顺序重排：先建 attempt span，再在其中跑 prepare 子 span
  （理由见「陷阱已消失」）。`AttemptInfo`（`attempt-base.ts:85-107`）现在把 `startedAt`
  吞进 `durationMs` 就丢了，改成一并带出。
- **attempt 显式改挂到 GenAI span 下。** `emit.ts:47` 今天挂 `session.rootContext`。
  不改这里，树还是平的，等于没做。
- **GenAI span 在 `attemptResolvedRequest` 内、路由解析之后开始，终点取终态结算**
  （不是函数返回，流式路径会先 `return Response`），ERROR 取逻辑失败（不是候选耗尽）。
- **`POST` span 按实际发送插桩。** 包 `createObservedFetch` 会观测到同一 attempt 内的多次
  fetch（`raw-retry.ts` 的隐藏重试就是），所以从第一天起就要正确挂到 attempt 下、并能表达
  多次发送。现有的 `inAttempt()` 装的是观测与日志上下文，**不是** `OpenSpan.run()` 的
  span 上下文，要补。
- 所有子 span 必须在 root 结算之前关闭（见「结算所有权」）。

### 任务 5（server）属性改名与下沉，含读路径投影

现在 GenAI span 存在了，属性才有地方可去。

`http.status_code` → `http.response.status_code`；四个自造 `gen_ai.usage.*` 换成标准名并
从 root 下沉到 GenAI span。

TTFT 这项是**拆分不是改名**：现有 `aio_proxy.response.ttft_ms`（`semantic.ts:31`，挂 root）
删掉，换成 `gen_ai.response.time_to_first_chunk`（GenAI span，秒）与
`aio_proxy.attempt.ttft_ms`（attempt span，毫秒）两个新 key，语义见上文对照表。
`ALLOWED_ATTRIBUTES`（`span-record.ts:15`）同步。

**`span-projection.ts:225-231` 一并改**：今天它在读回时从 summary 列把 `gen_ai.request.model`
/ `gen_ai.response.model` / 整套 `gen_ai.usage.*` 重建到 root 上（事实 4）。不改这里，
下沉在读回后等于没发生。summary 列保留 —— 那是列表页与记账的投影。

dashboard 侧 `trace-attribute-names.ts:21` 与 `span-metrics.ts:62` 一并改：
`span-metrics` 现在只认 root 上那一个 key，拆分后 attempt 行读 `aio_proxy.attempt.ttft_ms`、
GenAI 行读标准 key 并 ×1000 换算成毫秒展示。

历史数据不迁移、不做兼容。

### 任务 6（server）span 注册表

放在最后，因为校验的前提是所有创建点都已存在。

`semantic.ts` 的 11 个裸字符串常量改成注册表：每个 span 声明 `{ name, kind, parent }`，
配一个校验测试。抄 LiteLLM v2 的 `SPAN_REGISTRY` + `validate_registry()` 思路。

「常量存在但没人创建」这种事结构上就不可能再发生 —— 这正是本次七个死常量的成因。

### 任务 7（dashboard）瀑布树渲染

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
- **不做 `aio_proxy.response.egress` span。** 上一版有，这一版删了：它声称测「我们向客户端
  写出的那段」，但要挂的两个标量都产生于上游读取，而真正的下游写出今天既无结算契约也无观测点。
  详见「POST span 的终点只到响应头」。
- **不做故障位置推断。** 「有 `first_token` 且失败 = 首 token 之后断的」不成立：失败可能出在
  出口流、序列化、取消或后续终态处理。「只有 `upstream_headers` = 没等到内容」更是把「没有
  记录」当成「没有发生」—— 观测可能不可用、被歧义抑制、被终态整形丢掉，或者根本不覆盖那类
  输出（AI SDK 的 `firstTokenAt` 只在 `text-delta` / `reasoning-delta` 上设，纯 tool-call
  不算）。**「首个 token」是一个特定的内容观测约定，不是「之前什么都没发生」的证据。**
- **不给旧数据合成 span。** δ 已永久丢失。
- **不做模态细分 usage。** `gen_ai.usage.text.*` / `.image.*` / `.audio.*` 那套等真有人要分
  模态计费再说。
- **不加采样、不改 retention。** 本 PR 每 trace 的 span 数从 2 涨到 9–12，是 4.5–6 倍。
  存储影响要在实施时实测，但采样是独立决策。

## 缺失的含义

一条规则：**缺失不代表旧版本。**新记录也会缺属性 —— 没走受控流（AI SDK 没有首字节）、
观测到多次响应（`ambiguous`）、`markTransportUnavailable()` 未被后续 fetch 清掉、
或者该阶段根本没发生。判断依据是「这个 span 上有没有这个属性」，不引版本号、不写迁移。

## 后续（不在本 PR）

`raw-retry.ts` 的同 attempt 内隐藏重试，**语义上**完全不进 trace。`resolveRawRetry()` 会消费
并分类第一个响应、改写请求、再次发起，全程在 usage capture 之前。「到底发了几次请求？哪次
失败？最终内容来自哪次？」今天无法回答 —— 这是真正缺信息的地方。

**但挂载不能推后。** 任务 4 的 `POST` span 包在 `createObservedFetch` 上，隐藏重试的第二次
fetch 现在就会被观测到，所以「正确挂到 attempt 下、能表达多次发送」属于本 PR。推后的是
**归因**：区分候选下标与候选内重发下标、标注每次发送的分类结果与请求改写、回答最终内容来自
哪一次。那需要读 `resolveRawRetry()` 的内部状态，是独立 server PR。

## 测试

端到端契约测试，不是给 React 喂手写 fixture：

```
真实 pipeline 场景 → span 记录 → sanitize → 落库与读取 → 瀑布投影
```

| 场景 | 断言 |
|---|---|
| 注册表校验 | 每个声明的 span 都有创建点；kind 与 parent 与声明一致 |
| 一次失败转移（**断言落在读回之后**） | 恰好一个 span 带 `gen_ai.request.model`；attempt 上零 `gen_ai.*`；**root 上零 `gen_ai.*`** —— 只断言发射出的 span 会漏掉 `span-projection` 的重建路径 |
| 一次失败转移的层级 | 两个 attempt 都挂在 GenAI span 下，不在 root 下 |
| 六种能力各一 | 树形状一致；非法 operation 不写 `gen_ai.operation.name` |
| 4xx 拒绝 | root 状态 UNSET；`http.response.status_code` 正确 |
| prepare 抛错（`modelInvocation` 失败） | 恰好一个 attempt 行，没有未关闭的 span 被丢弃；终态与重构前逐字段一致 |
| 不可重试状态但仍有候选 | GenAI span 置 ERROR —— ERROR 判据是逻辑失败，不是候选耗尽 |
| 流式成功 | GenAI span 终点取终态结算，不是 `Response` 返回时刻 |
| prepare 有延迟 / 能力拒绝 | prepare span 宽度反映真实耗时，不再是黑洞 |
| 请求前后墙钟前跳 / 后跳 | duration 不被污染、不被夹成 0 |
| AI SDK 有内容无首字节、纯 tool-call 输出 | 仍有可用属性；没有 TTFT 不等于没有输出 |
| 首内容之后出口流报错 | 观测活过终态替换；不把它标成上游 body 失败 |
| 同 attempt 内隐藏重试后成功 | 两个 `POST` span 都挂在同一 attempt 下；不跨响应造刻度；歧义可见 |
| 终止帧之后延迟 EOF 或取消 | 不把 trace 结算当成 body 完成或客户端送达成功 |

断言的是**时间边界、层级归属与错误归属正确**，不是「每条 trace 恰好有 N 行」。
