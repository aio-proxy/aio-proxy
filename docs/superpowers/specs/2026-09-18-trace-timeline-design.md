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
| HTTP client span 到响应头结束，却挂 `first_byte_ms` 等 | 这些值在响应头之后产生，写已结束的 span 会被拒 | HTTP client span 只留 `headers_ms`，其余落 attempt |
| GenAI span 包在 `attemptResolvedRequest` 外层；候选耗尽才 ERROR | 路由在该函数内部；`raw.ts:115-130` 会在仍有候选时终止 | 起点移到路由之后，ERROR 判据改为逻辑失败 |
| 任务顺序 1→6 | 属性下沉排在目标 span 创建之前，注册表校验排在创建点之前 | 按依赖重排为 7 个任务 |
| 一次失败转移 10 行 / 干净 8 行 | 数错了 | 12 行 / 9 行，新增 7 种 span 类型 |

### 第二轮：核一手 OTel 原文后的反转

前一轮只读了 spec 自己的引文，这一轮把 `semantic-conventions-genai` 与 `semantic-conventions`
的原文拉下来逐条核过，结果推翻了上表最后第三行：

| 原写法 | 事实 | 处置 |
|---|---|---|
| GenAI span 起点在**路由解析之后** | 规范要求 span 覆盖「含全部重试的逻辑操作」，而选出第一次 attempt 靠的就是路由解析。上一版是从树的画法反推起点 —— 让图赢了规则 | 起点移到路由解析**之前**，`route.resolve` 降为子 span |
| 路由失败的 trace 没有 GenAI span，需要给 root 补属性 | 起点前移后它自然存在，带 ERROR 与 `gen_ai.request.model` | 评审那条「筛选不可达」自动消失，不新增属性名、不给不变式开例外 |
| `gen_ai.operation.name` 合法值**共 9 个** | 9 个是锁定的 1.43.0 导出的常量数（spec 抄得对），但规范明写 otherwise a custom value MAY be used —— 是**开集**；上游 main 已 18 个且未发布 | 保留 9 个列表，改掉「合法值共」的闭集措辞；任务 6 禁止白名单校验 |
| `gen_ai.provider.name` 没定规则 | 它是 `Required`，而一次逻辑操作有 0 个或多个 upstream | 按注 [2] 定为「入站协议口味」，全程不覆写 |
| `cancelled` 保持 ERROR，「规范只约束 4xx」 | `http-spans.md` 另有一条：调用方主动取消 SHOULD NOT 置 ERROR | 改成 UNSET 且不写 `error.type`，任务 1 带断言 |

### 第三轮：查完 OTel 的 gateway 现状后，改成三层

第二轮把属性挂在「一条横跨全部 attempt 的 GenAI span」上，并给 `gen_ai.provider.name` 填入站
协议口味。查完 issue #299 / PR #475 与 AI SDK 的重试实现后，这个形状被推翻：

| 第二轮写法 | 事实 | 处置 |
|---|---|---|
| 一条 GenAI span 横跨全部 attempt，`provider.name` 填入站口味 | issue #299 的评论原话反对这种做法："without **overloading** `gen_ai.provider.name` or pretending the gateway and upstream provider are the same thing" | 改三层：每个 provider 一条 inference span；runtime 明确知道身份时才带真实 `provider.name` |
| attempt 是 INTERNAL，命名禁区禁它带 `gen_ai.*` | 每次 attempt 就是一次真实上游推理调用，判 GENERATION 是准确分类；且标准 metric `gen_ai.client.operation.duration` 带 `provider.name` + `error.type`，按 attempt 发射才有 provider SLO | attempt 改造成 CLIENT inference span，命名禁区整节作废 |
| 「唯一一个带 `gen_ai.*` 的 span」 | `gen_ai.*` 现在分布在两层 | 断言改成「root 上没有任何 `gen_ai.*`」 |
| 同 provider 重试只有 `raw-retry` 一种，至多 +1 | **AI SDK `maxRetries` 默认 2**，我们从不赋值，一次 attempt 最多 3 次 HTTP；`onLanguageModelCallStart` 在 `retry()` 外面看不到 | 多条 `{method} {url.template}` HTTP client span（无模板时退化为 `{method}`）+ `aio_proxy.attempt.http_sends`；本 PR 只观测不改行为 |
| image/speech/transcription/video 不写 `gen_ai.operation.name` | 它是 `Required`，而枚举是开集 | 四种能力各写一个自定义值 |
| 一次失败转移 12 行 | 没算退避重试 | 带重试 14 行，干净 9 行，路由失败 5 行，新增 8 种 span 类型 |

`model-prepare.ts:98-99` 自行发射+结算导致的重复 attempt，以及 `processor.take()` 抽干 buffer
导致的子 span 丢弃，是本轮新发现的实现陷阱，见「结算所有权」与任务 3。

### 第四轮：实测瀑布顺序与 root 属性后的更正

| 现象 | 根因 | 处置 |
|---|---|---|
| `session.resolve` 排到 `inference` 后，`route.resolve` 排到 attempt 后 | 持久化的 `started_at` 只有毫秒精度；同毫秒 sibling 在 DB 与 dashboard 都用随机 `spanId` 打破平局 | 持久化每条 trace 内单调递增的 `startSequence`；树仍按父子关系 DFS，sibling 按 `startSequence` 排。禁止按 span 名、结束时间或 `spanId` 猜真实顺序 |
| root 出现整套 `aio_proxy.diagnostics.*` | 这些字段大多重复 OTel 已定义的 HTTP / URL / User-Agent 语义 | 新 trace 改写标准属性；只保留真正属于 aio-proxy 领域的 key。读取端对旧 `diagnostics.*` 做保留期内 fallback，不迁移历史数据 |

### 第五轮：provider inference 属性按语义去重

实测的 provider inference span 暴露了两类问题：已经有标准 `gen_ai.*` 的事实仍重复写成
`aio_proxy.*`，以及把 wire protocol 错当成 provider identity。

| 当前写法 | 事实 | 处置 |
|---|---|---|
| `aio_proxy.attempt.model_id` + `gen_ai.request.model` 同值双写 | 这条 span 就是 GenAI inference CLIENT span | 删除前者，只写 `gen_ai.request.model` |
| `aio_proxy.request.stream` 写在 provider span | 标准已有 `gen_ai.request.stream`，且它描述实际发给上游的请求 | provider span 改写标准 key；root 上的自定义 key 只描述入站请求意图 |
| provider TTFT 写 `aio_proxy.attempt.ttft_ms`，标准 TTFT 写在非 GenAI 的逻辑父层 | `gen_ai.response.time_to_first_chunk` 属于 `gen_ai.inference.client` 属性组 | 标准 TTFT 移到每条 provider inference span；逻辑层如需端到端首字延迟，改用 `aio_proxy.inference.ttft_ms` |
| `gen_ai.provider.name` 从 `ProviderProtocol` 映射，`openai-response` / `openai-compatible` 都写 `openai` | 协议兼容性不等于服务提供方；自定义 endpoint、OpenRouter、Azure、各类 gateway 都能说 OpenAI 协议 | 禁止从 source/target protocol 推导；只接受 provider/runtime 显式声明的语义身份，未知则不写 |
| `gen_ai.usage.cache_write.input_tokens` / `gen_ai.usage.total_tokens` | 当前 GenAI 约定使用 `cache_creation.input_tokens`，且没有 `total_tokens` span 属性 | 前者改标准名；后者不写 span，dashboard/summary 需要总数时由已有 usage 数据计算 |

### 第六轮：本地正式环境实测后的条件式树形

前几轮写的“干净请求 9 行”不是契约。它把 model conversion 路径的 `request.prepare` 和实际执行
usage validation/pricing 时才存在的 `usage.resolve` 当成了无条件节点。最终契约按执行边界记录：

- raw passthrough 不做 model conversion/materialization，因此没有 `aio_proxy.request.prepare`；
- 只有 model conversion/materialization 路径才有 `aio_proxy.request.prepare`；
- 只有 usage validation/pricing 实际运行才有 `aio_proxy.usage.resolve`；成功返回 `undefined` 仍为
  UNSET，异常为 ERROR；
- 验收断言时间边界、父子关系和属性归属，不断言每条 trace 固定有多少行。

## 背景

改版 demo 画了一棵九行的瀑布树。真实数据不是这样。

生产库（41,024 span / ~18.5k trace）实测每 trace 的 span 数：1 个的 25 条，
2 个（root + 一次尝试）的 14,946 条，3 个的 3,208 条，4 个的 350 条，5 个的 21 条。
只有四个 span 名被写过。约 80% 的 trace 渲染成两根柱子。

`semantic.ts` 里有 11 个 `spanName` 常量，生成路径上只有 `request` 和 `attempt` 会被真正
创建。**另外七个不是垃圾，是这棵树没接线的设计。**

## 规范依据

GenAI 语义约定已迁到 `open-telemetry/semantic-conventions-genai`（`gen_ai.*` 在 1.43.0
主包里标 `@deprecated Moved to…`，是迁移不是删除）。

**该仓库的成色要先说清**：0 个 tag、0 个 release，`model/manifest.yaml` 写 `stability: development`、
`schema_url: …/schemas/gen-ai-dev/1.42.0-dev`。main 上的内容是未发布开发态，会改名
（`get_response` → `fetch_response` 就是现成案例）。代码实际拿得到的是锁定的
`@opentelemetry/semantic-conventions@1.43.0`。下引原文取自该仓库 main 的
`docs/gen-ai/gen-ai-spans.md`：

> GenAI spans represent logical operations as observed by the caller.
> They SHOULD cover the duration of the operation, starting when it is initiated
> and ending when the response is fully received or the operation is terminated
> due to an error or cancellation.
> **If a transient issue happened and the request was retried automatically, the
> corresponding span SHOULD cover the duration of the logical operation with all retries.**

> GenAI spans SHOULD be named `{gen_ai.operation.name} {gen_ai.request.model}`.
> Semantic conventions for individual GenAI systems and frameworks
> **MAY specify different span name format**.

三条推论：

1. `{operation} {model}` 是 `SHOULD` 且明确授权自定义格式 —— 这是规范留的口子。
2. **那句 retry SHOULD 管的是「同一次调用的自动重试」，不是「换 provider」。** inference span
   的定义是 "a client call to Generative AI model or service"；换 provider 是**对另一个服务的
   另一次调用**，不是同一次调用的重试。所以退避重试收在一条 inference span 内，换 provider
   另起一条。见下面的三层模型。
3. **起点必须早于路由解析。** 逻辑操作层要覆盖第一次 attempt，而选出第一次 attempt 靠的正是
   路由解析。所以 `route.resolve` 是逻辑操作层的**子 span**，不是兄弟。上一版反过来从树的画法
   倒推起点，见「三条被否决的画法」(a)。

### 三层模型：规范未立法，但生态方向明确

穷尽检索四份 GenAI 规范正文：**failover / fallback / load balanc 零命中**，retry 只出现在上面
那一句。OTel **没有**多 provider 失败转移的约定。

但 `semantic-conventions-genai` **issue #299 open（2026-01-27，6 条评论）**：
"Add `gen_ai.gateway.*` attributes for AI routing/gateway layers"，开篇点名 OpenRouter / Portkey /
LiteLLM / Martian，明写 "The current GenAI semantic conventions **don't have a standardized way to
represent this gateway layer**"。提案 14 类属性，**至今一行未合并**（`gen_ai.gateway` 在 registry
的 md 与 yaml 里都是 0 命中）。

该 issue 最新评论（2026-08-24）主张把 span 拓扑当成设计的一部分：

> For a gateway/router, that suggests a useful **two-level model**:
>
> ```
> gateway logical operation
>   ├─ upstream attempt 1 -> provider/model A -> error/429/timeout
>   └─ upstream attempt 2 -> provider/model B -> success
> ```
>
> Each actual upstream attempt can then use the existing GenAI/HTTP conventions for the facts
> that belong to that attempt: `gen_ai.provider.name`, `gen_ai.request.model`,
> `gen_ai.response.model`, `server.address`, `error.type`, duration, response id.
>
> [Arrays such as `providers.attempted`] **lose the timing and error boundary** … Child attempt
> spans answer that naturally.

另一条（2026-06-09）直接反对上一版的做法：

> users need to explain model/provider divergence **without overloading `gen_ai.provider.name`**
> or pretending the gateway and upstream provider are the same thing.

**PR #475 open（"Add guidance on how to avoid duplicate inference spans"）** 守的是「一次逻辑
模型调用 = 一条 inference span」，防的是多层 instrumentation 重复记**同一次调用**，并明写：

> **Non-inference spans (such as `invoke_agent` or `invoke_workflow`) MUST NOT be stored under
> the inference span context key.**

父层是显式的另一类东西。所以本设计取三层，**父层用 `aio_proxy.inference`（INTERNAL），不冒充
GenAI span** —— `invoke_workflow` 的定义是 agent 编排（"coordinating multiple **agents** or GenAI
calls"，例子全是 agent 框架，且有一句 SHOULD NOT 排除内部实现细节），套失败转移是硬拉；
`gen_ai.gateway.*` 未落地。等它发布再对齐。

| 层 | span | kind | 回答 | ERROR 判据 |
|---|---|---|---|---|
| 逻辑操作 | `aio_proxy.inference` | INTERNAL | 这次请求总耗时、转移几次 | 全部候选失败 |
| 单个 provider | `{operation} {model}` | CLIENT | 这个 provider 行不行 | 该 provider 最终失败 |
| 单次发送 | `{method} {url.template}`；无低基数模板时 `{method}` | CLIENT | 这一次 HTTP 的结果 | 单次非 2xx |

### 同 provider 重试有两套机制

1. **raw 通道**：`attempt/raw-retry/raw-retry.ts:250-252`，至多一次重放，由 adapter hook 按
   400 响应体或 SSE rejection frame 决定。代码注释写着 "a hidden retry never reaches the client
   or the trace" —— 刻意不可见。
2. **AI SDK 通道**：`ai-sdk-bridge/index.ts:87` 调 `streamText()`，AI SDK 7.0.8 的 `maxRetries`
   **默认 2**（`dist/index.d.ts:3472`），即一次 attempt 最多 3 次 HTTP、指数退避。
   全仓 `maxRetries` 只出现在两处类型声明，**没有任何调用点赋值**。

这两套都不可从 AI SDK 的回调看到：`onLanguageModelCallStart` 在 `retry()` **外面**
（`dist/index.js:5334` notify、`:5342` `await retry(...)`），只 notify 一次。**唯一可观测层是
我们自己包的 `createObservedFetch`，也就是 HTTP client span。**

上一版要求 HTTP client span 能表达同 attempt 多次发送，但把原因只归给 `raw-retry`，漏了 AI SDK 的
默认值 —— 后者覆盖所有 ai-sdk provider，量级大得多。

本 PR **只观测不改行为**：落 `aio_proxy.attempt.http_sends` 计数 + 多条 HTTP client span。
`maxRetries` 可配留到单独 PR（它是产品行为：转移前会先静默重试 2 次，配置层没有旋钮）。

`gen_ai.operation.name` 是**开集，不是白名单**。registry 原文："If one of them applies, then
the respective value MUST be used; otherwise, **a custom value MAY be used**"。锁定的 1.43.0
导出 9 个常量（`experimental_attributes.d.ts:6225-6289`）：`chat`、`text_completion`、
`embeddings`、`generate_content`、`execute_tool`、`create_agent`、`invoke_agent`、
`invoke_workflow`、`retrieval`。上游 main 已扩到 18 个（多出 `fetch_response`、`plan`
与 7 个 memory 操作），未发布。**任务 6 的注册表校验不得把这 9 个写成白名单** —— 那是把开集
硬编码成闭集，上游一发布就自己判错。

因为是开集，**六种能力全都写 `gen_ai.operation.name`**：`language` → `chat`、`embedding` →
`embeddings` 用预定义值；`image` / `speech` / `transcription` / `video` 写自定义值
（`image_generation` / `speech` / `transcription` / `video_generation`）。该属性在 GenAI span 上是
`Required`，不写等于这四种能力的 span 不是合规 GenAI span。上一版「没有合法值可用所以不写」
的前提不成立。

span 状态按 `semantic-conventions/docs/general/recording-errors.md`：

> Span Status Code MUST be left unset if the instrumented operation has ended without any errors.
>
> **Errors that were retried or handled (allowing an operation to complete gracefully) SHOULD NOT
> be recorded on spans or metrics that describe this operation.**

第二条给出的是**每一层**的 ERROR 判据：某次失败若被更下游的机制吸收（退避重试成功、或转移到
下一个 provider 成功），就不该记在描述「那个更大操作」的 span 上。所以：单次 HTTP 非 2xx →
只有那条 HTTP client span 红；某 provider 重试耗尽 → 那条 inference span 红；全部候选失败 → 逻辑操作层红。
成功一律 `UNSET`（`OK` 保留给应用显式使用）。

4xx 按 `http-spans.md` 原文："For HTTP status codes in the 4xx range span status **MUST** be left
unset in case of `SpanKind.SERVER`"。今天 `rejectRequest()` 把 400/404/413 记成
`outcome: 'failure'` → `SpanStatusCode.ERROR`，违反这条。

取消：`http-spans.md` 原文 "the cancellation SHOULD NOT be treated as an error: the span status
SHOULD be left unset and `error.type` SHOULD NOT be set"。**已拍板按规范改**：`cancelled` 从
`SpanStatusCode.ERROR` 改成 UNSET 且不写 `error.type`。规范那条限定于「客户端可检测到的调用方
主动取消」，客户端断连正是这种。GenAI 侧只规定取消时 span 结束，没给状态规则，所以落到这条。

⚠ 这条与 dashboard 的取消渲染（`adaf2e63`「取消的 span 不再画成绿色」）交互：那次改动靠
`TraceStatus` 区分取消与正常完成，不靠 span status，所以状态改 UNSET 不会让取消又变回绿色 ——
但任务 1 必须带一个断言锁住这一点。

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

**第三轮更正：本节原本的结论（多个 GENERATION 是坏事）也不成立。**

三层模型下每条 inference span 对应一次真实的上游推理调用，被 Priority 3 的
`gen_ai.operation.name` 判成 GENERATION 是**准确分类**，不是误判。一次转移打了两个上游，
就是两次 generation 尝试；把它们压成一个才是丢信息。

所以取舍反过来了：**接受一条 trace 多个 GENERATION**，换回标准 `gen_ai.*` 属性放在语义正确的
层上。真要压，Priority 1 的 `langfuse.observation.type` 仍然是逃生口，但那是接了 exporter
之后再按需做的事，不该反过来约束 span 设计。

逻辑操作层（`aio_proxy.inference`）不带 `gen_ai.operation.name`、不带 `gen_ai.provider.name`、
不带 `gen_ai.response.model`，所以它会落到 Priority 10 之外、终态判 `"SPAN"` —— 正是想要的：
一个非 GenAI 的编排层。唯一需要注意的是它带 `gen_ai.request.model`，**这个 key 在 Priority 10
的兜底清单里**，会让它也被判成 GENERATION。要么接受（它确实是这次请求的推理入口），要么在
接 exporter 时给它挂 `langfuse.observation.type = "span"`。**记为待办，不在本 PR**。

另外，把模型与 usage 属性留在 root SERVER span 上并不会让 Langfuse 分类失败（它的 mapper
不看 span kind）。分层要靠「每层各自测量一件事」立论，不能靠编造的计费限制。

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

**这条推翻了「root 不承载 GenAI 语义」能靠删 setter 达成的想法。**

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

- root 在**发射时**不带 `gen_ai.*`，但读回时又被补上。spec 下文的属性表要按这个事实写。
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

### 同毫秒 sibling：保存开始顺序，不从展示层猜

当前 `trace_span.started_at` 是 SQLite `timestamp_ms`，详情查询按 `(startedAt, spanId)` 排；
dashboard 建树后也用同一组字段排 sibling。真实开始时间落到同一毫秒时，随机 `spanId` 因而被误当成
时序。截图里的 `session.resolve` 与 `route.resolve` 倒置只是展示错误，不表示执行顺序真的反了。

修复契约：

- `startSequence` 是 trace 内从 0 开始、按 span **开始**动作单调递增的持久化元数据，不是 OTel
  attribute。root 固定为 0；`BufferingSpanProcessor.onStart()` 给后续 span 分配序号，`onEnd()`
  只负责带着该序号落记录。
- `startedAt` 继续负责横轴位置与 duration；`startSequence` 只负责同一棵树里的确定顺序。
- dashboard 先按 parent/child 做 DFS，siblings 按 `startSequence` 排。`spanId` 只能作为损坏数据或
  历史数据缺少 sequence 时的稳定 fallback，**不得承载时间含义**。
- 不按 span 名写 `parse < session < inference < route` 之类的优先级，也不看 `endedAt`；前者把实现细节
  写死在 UI，后者会把长短不同误当成先后。
- 旧记录不迁移：真实的同毫秒顺序已经丢失，无法可靠补算。它们继续用 `(startedAt, spanId)` 稳定
  展示，但不声称这是原始开始顺序。

## span 树

六种能力形状完全一致。以 language + provider A 退避重试耗尽后转移到 B 为例：

```
POST /v1/messages                              SERVER    0–4890  UNSET
├─ aio_proxy.request.parse                     INTERNAL     2–5
├─ aio_proxy.session.resolve                   INTERNAL     5–9
├─ aio_proxy.inference                         INTERNAL  9–4876  UNSET   ← 逻辑操作层
│  ├─ aio_proxy.route.resolve                  INTERNAL    9–15
│  ├─ chat claude-sonnet-4-5                   CLIENT   18–2680  ERROR   ← provider A
│  │  ├─ aio_proxy.request.prepare             INTERNAL   19–23
│  │  ├─ POST /v1/messages                     CLIENT     24–812  ERROR  503
│  │  ├─ POST /v1/messages                     CLIENT   1020–1704 ERROR  503  ← AI SDK 退避
│  │  └─ POST /v1/messages                     CLIENT   2100–2680 ERROR  503  ← maxRetries 耗尽
│  └─ chat claude-sonnet-4-5                   CLIENT  2686–4876          ← provider B
│     ├─ aio_proxy.request.prepare             INTERNAL 2687–2688
│     └─ POST /v1/messages                     CLIENT   2692–3282
└─ aio_proxy.usage.resolve                     INTERNAL 4876–4888
```

父层 4867ms − provider B 那条 2190ms = **2677ms 转移开销**，其中绝大部分是 A 的三次退避。
今天这条 trace 渲染成 **2 行**（root + 一个 attempt）。

model conversion 成功示例（执行了 usage validation/pricing）：

```
POST /v1/messages                              SERVER    0–2210  UNSET
├─ aio_proxy.request.parse                     INTERNAL     2–5
├─ aio_proxy.session.resolve                   INTERNAL     5–9
├─ aio_proxy.inference                         INTERNAL  9–2198  UNSET
│  ├─ aio_proxy.route.resolve                  INTERNAL    9–15
│  └─ chat claude-sonnet-4-5                   CLIENT   18–2198
│     ├─ aio_proxy.request.prepare             INTERNAL   19–23
│     └─ POST /v1/messages                     CLIENT     24–614
└─ aio_proxy.usage.resolve                     INTERNAL 2198–2210
```

raw passthrough 成功示例（没有 model conversion，且本次没有 usage validation/pricing）：

```
POST /v1/responses                             SERVER    0–2210  UNSET
├─ aio_proxy.request.parse                     INTERNAL     2–5
├─ aio_proxy.session.resolve                   INTERNAL     5–9
└─ aio_proxy.inference                         INTERNAL  9–2198  UNSET
   ├─ aio_proxy.route.resolve                  INTERNAL    9–15
   └─ chat upstream-model                      CLIENT   18–2198
      └─ POST /v1/responses                    CLIENT     24–614
```

路由解析失败（模型未配置 / 候选被能力过滤到空）5 行 —— **逻辑操作层存在**，这是「起点早于
路由解析」的直接结果。注意这条路径上**没有** inference span，因为一次上游调用都没发生：

```
POST /v1/messages                              SERVER     0–14  UNSET  ← 404，4xx 不置 ERROR
├─ aio_proxy.request.parse                     INTERNAL     2–5
├─ aio_proxy.session.resolve                   INTERNAL     5–9
└─ aio_proxy.inference                         INTERNAL    9–13  ERROR  error.type
   └─ aio_proxy.route.resolve                  INTERNAL    9–13  ERROR
```

`gen_ai.request.model` 挂在 `aio_proxy.inference` 上（见「属性」），所以按模型筛选依然能捞到
这条 trace —— 评审提的「路由失败不可达」在三层模型里同样解决，而且不需要 overload
`gen_ai.provider.name`。

**新增 span 类型 8 种**（root 与 attempt 已存在，attempt 改造成 inference span）。具体行数由实际
执行的 parse/session/route、conversion、HTTP retry 与 usage resolution 边界决定；不得把某个示例的
行数提升为契约。每种 span 都要在下表指到一个确切的代码边界 —— 指不出来的不做。

## 逐个 span

| span 名 | kind | 创建位置 | 状态规则 |
|---|---|---|---|
| `{method} {http.route}` | SERVER | `request-trace-recorder.ts:88` | **4xx 不置 ERROR**，仅 5xx / internal |
| `aio_proxy.request.parse` | INTERNAL | `pipeline/index.ts:182` `adapter.parse`（**不是**外层 `parseProtocolRequest()`，见下） | |
| `aio_proxy.session.resolve` | INTERNAL | `pipeline/index.ts:97` `logicalSessionStore.begin()` | |
| `aio_proxy.route.resolve` | INTERNAL | `pipeline/index.ts:279-315` `router.resolve()` + `filterCandidatesByCapability()`（**改挂到 `aio_proxy.inference` 下**，今天挂 `session.rootContext`） | 解析失败即 ERROR |
| `aio_proxy.inference` | INTERNAL | `attemptResolvedRequest` 内、**路由解析之前**（`index.ts:273` 附近，`requestedModel` 是入参已在手）。今天 `startInferenceSpan` 在 `index.ts:316`、`routeSpan.end()` 之后 —— 要上移 | 全部候选失败才 ERROR（**不是**单次失败，也不是候选耗尽——见 (b)） |
| `{operation} {request.model}` | **CLIENT** | `attempt/emit.ts:47`，由今天的 `aio_proxy.provider.attempt` **改造而来**：改名、kind 从 INTERNAL 改 CLIENT、挂到 `aio_proxy.inference` 下 | 该 provider 最终失败即 ERROR |
| `aio_proxy.request.prepare` | INTERNAL | `attempt/model.ts:24` `prepareModelInvocation()` | 这行宽度就是 δ |
| `{method} {url.template}`；无低基数模板时 `{method}` | CLIENT | `createObservedFetch` 包一层。**一条 inference span 下可能有多条**：raw 的 `resolveRawRetry` 至多 +1，AI SDK 的 `maxRetries` 默认再 +2 | 单次非 2xx 即 ERROR；只到响应头，见下 |
| `aio_proxy.usage.resolve` | INTERNAL | `usage-capture/usage-validation.ts:8-23` `finalizeUsage()` | |

### 三条被 pipeline 现状否决的画法，及更正

**（a）~~GenAI span 不能包在 `attemptResolvedRequest` 外层~~ —— 这条整个反了，见下。**

原文是：「路由解析发生在该函数内部，而树里 `route.resolve` 画成 GenAI span 的兄弟，两者只能
同时成立于『GenAI span 在函数内、路由之后开始』。」

**它从树的画法反推起点，方向错了。** 规范里起点由「操作何时被发起」决定，加上「span SHOULD
覆盖含全部重试的逻辑操作」——要覆盖第一次 attempt，就必须覆盖选出它的那一步。树形要跟着规则走，
不是反过来。上一版引了这两条规则，却在同一份文档里画了一棵与之矛盾的树：**让图赢了规则。**

更正：`aio_proxy.inference` 在 `attemptResolvedRequest` 内**路由解析之前**开始（`requestedModel`
是入参，`gen_ai.request.model` 当场就有），`route.resolve` 降为它的子 span。两条失败出口都要在
root 结算前把它关掉并置 ERROR：`index.ts:298` 的 `throw`（`RouterModelNotFoundError` → 404）
与 `index.ts:301-313` 的 `eligible.length === 0` → `rejectRequest`。

收益：路由失败的 trace 自然带一条 ERROR 的逻辑操作层和 `gen_ai.request.model`，评审提的
「按 `gen_ai.request.model` 筛选时这类 trace 不可达」自动消失，且不需要 overload
`gen_ai.provider.name`。

代价：`route.resolve` 比原图深一层。仅此。

流式那半句仍然成立：流式路径会在其注册的 completion 结算之前就 `return` 掉 `Response`，
所以 `aio_proxy.inference` 的终点必须取**终态结算**，不是函数返回。

**（b）ERROR 条件不是「全部候选耗尽」。** `attempt/raw.ts:115-130`：当 `fallback === false`
但状态是错误时，直接 `session.finish({...finalFailure})` 并 `return { kind: 'return' }` ——
此时 `hasNext` 完全可能还是 true。不可重试的状态会在**还有候选**的情况下终止整个逻辑操作。
所以 `aio_proxy.inference` 的 ERROR 判据是「该逻辑操作以失败结算」，与候选是否用尽无关。

三层各自的判据不同，不要混：**父层**看逻辑操作是否以失败结算；**inference span** 看这个
provider 最终是否失败；**HTTP client span** 看单次 HTTP 是否非 2xx。所以「A 重试三次失败、B 成功」这条
trace 里，三条 HTTP client span 红、A 的 inference span 红、父层绿 —— 依据是 `recording-errors.md` 的
"Errors that were retried or handled … SHOULD NOT be recorded on spans that describe this
operation"。

**（c）inference span 必须显式改挂到 `aio_proxy.inference` 下。** `emit.ts:47` 今天把 attempt 挂在
`session.rootContext`，也就是 root。加了父层不会自动重挂 —— 这是任务 4 的活，
不能推后（否则树是平的，等于没做）。同一处还要把 kind 从 INTERNAL 改成 CLIENT、名字从
`aio_proxy.provider.attempt` 改成 `{operation} {model}`。

**（d）parse 要插桩 `adapter.parse`，不是外层包装。** `parseProtocolRequest()` 的失败分支
在函数**内部**就把 root 结算掉了，见下面「结算所有权」。包在它外面的 span 会在 root 结算之后
才结束，直接被丢弃。

`route.resolve` 的边界：上一版说「包在 `attemptCandidates()` 里只覆盖亲和性重排，名不符实」，
那是因为当时找错了位置。正确边界在 `attemptResolvedRequest` 内的 `lease.snapshot.router.resolve()`
加 `filterCandidatesByCapability()`，这两步就是路由解析本身。

### HTTP client span 的名字与终点

名字按 HTTP 语义约定取 `{method} {target}`：`method` 来自 `http.request.method`，client 侧
`target` 只能取显式提供的低基数 `url.template`。例如 `POST /v1/responses`、
`POST /v1/messages`、`POST /v1beta/models/{model}:streamGenerateContent`。不得从实际 `url.path`
自动生成名字；动态模型 ID、资源 ID 或自定义路径会把 span 名变成高基数。没有可靠模板时退化为
`{method}`，例如 `POST`。

模板必须来自实际发起请求的 transport 权威元数据；`createObservedFetch` 只消费，不猜模板。
入站 Hono route 只能作为 transport 计算改写后模板的输入，不能直接当作上游模板；wire protocol
也不能单独决定实际 path。raw transport 改写路径时必须声明改写后的模板，converted model transport
没有权威模板时退化为 `{method}`。

HTTP client span 从发起 fetch 起，**到拿到响应头结束**，不覆盖 body 流。

理由：body 终点在两条通道上可观测性不同（raw 有受控流能看到 EOF，AI SDK 没有），
让同一个 span 名在两条通道上表达不同几何比少一段信息更糟。而且当前 trace 的结算**可能早于
body EOF** —— AI SDK capture 在 `finish` 分片就结算而传输仍活着，raw capture 在终止帧结算
并刻意不因后续取消改判，所以「attempt 终点 = body 终点」本身就是错的。

body 阶段**不做 span**，body 期观测到的标量留在 attempt span 上 —— 那本来就是
`emit.ts:62` `endAttempt` 取 `observation.snapshot()` 的通路，attempt 那时还没结束，零新机制。
首 token 位置由 TTFT 属性在 UI 上画成刻度。时间轴读起来是：prepare → HTTP client（到响应头）→
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

### root（SERVER）—— HTTP 语义 + 最小领域关联

```
http.request.method   http.route   url.path
http.response.status_code          user_agent.original
http.request.header.content-type   http.response.header.content-type   ← 可选 header capture
http.request.body.size             http.response.body.size             ← 仅实际测得 body bytes 时写
error.type
aio_proxy.request.id               aio_proxy.protocol.inbound
aio_proxy.operation                ← 仅 token_count 写；缺失即默认 model
```

root 不再新写 `aio_proxy.diagnostics.*`。对应关系如下：

| 旧 key | 新写法 |
|---|---|
| `aio_proxy.diagnostics.request.protocol` | 删除；与 `aio_proxy.protocol.inbound` 重复 |
| `aio_proxy.diagnostics.request.method` | `http.request.method` |
| `aio_proxy.diagnostics.response.status_code` | `http.response.status_code` |
| `aio_proxy.diagnostics.request.user_agent` | `user_agent.original` |
| request / response `content_type` | 需要展示时用 `http.request.header.content-type` / `http.response.header.content-type` |
| request / response `content_length_bytes` | 只有实际观测到 body bytes 才写 `http.request.body.size` / `http.response.body.size`；只读到 `Content-Length` 头时不得冒充 body size，可按标准 header capture 记录或省略 |

Header capture 按 OTel 约定使用字符串数组。`aio_proxy.request.id` 保留用于关联 wire log；
`aio_proxy.protocol.inbound` 是 aio-proxy 的入站协议领域值，也保留。`aio_proxy.operation=model`
是默认值且 percentile 查询已对缺失值 `coalesce` 为 `model`，所以只在 `token_count` 路径显式写，
避免每条生成 trace 都重复一个无信息量属性。

dashboard diagnostics 读取端先读上述标准属性，再回退旧 `aio_proxy.diagnostics.*`，覆盖现有 retention
窗口；只做读兼容，不双写新旧字段，也不做数据库迁移。

**注意：只删 recorder 里的 setter 不够。** `span-projection.ts:225-231` 会在读回时从 summary
列把 `gen_ai.request.model` / `gen_ai.response.model` / 整套 `gen_ai.usage.*` 重新挂到 root 上
（见事实 4）。要一起改这个投影，否则 dashboard 上 root 行照旧带着这些属性。summary 列本身保留。

断言从「唯一一个带 `gen_ai.*` 的 span」改成 **「root 上没有任何 `gen_ai.*`」**。三层模型下
`gen_ai.*` 分布在两层（逻辑操作层只有调用方模型，provider inference span 有标准全套），
原来那条唯一性断言不再成立，但 root 必须不承载 GenAI / provider 尝试明细这一条不变。

### `aio_proxy.inference`（INTERNAL）—— 逻辑操作层，不是 GenAI span

```
gen_ai.request.model                       客户端点名的模型;路由失败时也写
error.type                                 逻辑操作以失败结算时写,低基数
aio_proxy.capability                       六值,始终写
aio_proxy.inference.attempt_count          int;这次逻辑操作试了几个 provider
aio_proxy.inference.failover_ms            转移开销 = 本层耗时 − 成功那条 inference span 耗时
aio_proxy.inference.ttft_ms                 毫秒;逻辑起点到首个客户端 chunk,含失败转移
```

**不写 `gen_ai.operation.name`，不写 `gen_ai.provider.name`。** 这一层不是 inference span：
PR #475 明写 "Non-inference spans … MUST NOT be stored under the inference span context key"，
而 `gen_ai.provider.name` 在这一层根本没有诚实的值（0 个或多个 upstream）。
`gen_ai.request.model` 例外 —— 它是「客户端要什么」，与打到谁无关，而且路由失败时全靠它可检索。

`gen_ai.gateway.*` 落地后，`attempt_count` / `failover_ms` 这两个自造属性应换成标准名。

### `{operation} {model}`（CLIENT）—— inference span，每个 provider 一条

```
gen_ai.operation.name                      Required;chat/embeddings/自定义值,见「规范依据」
gen_ai.provider.name                       runtime 已知时写;不得从 wire protocol 推导
gen_ai.request.model                       送给这个 provider 的模型
gen_ai.request.stream                      实际上游请求为 streaming 时写 true
gen_ai.response.model                      实际应答的模型
error.type                                 该 provider 最终失败时写
server.address  server.port                这次尝试打的上游地址
gen_ai.response.id
gen_ai.response.time_to_first_chunk        double,秒;本次 provider 调用到首个 chunk
gen_ai.usage.input_tokens
gen_ai.usage.output_tokens
gen_ai.usage.cache_read.input_tokens
gen_ai.usage.cache_creation.input_tokens
gen_ai.usage.reasoning.output_tokens
aio_proxy.attempt.index
aio_proxy.provider.id                      我们的 Provider ID(用户配置 key)
aio_proxy.attempt.http_sends               int;本次尝试实际发了几次 HTTP(含退避重试)
aio_proxy.provider.kind                    api / ai-sdk 等实现种类
aio_proxy.provider.weight                  本次路由使用的有效权重
aio_proxy.protocol.source                  入站协议
aio_proxy.protocol.target                  实际上游协议

body 期观测（由 endAttempt 从 observation.snapshot() 落下，本 span 此时仍未结束）：
aio_proxy.upstream.first_byte_ms           first_sse_event_ms
aio_proxy.upstream.content_gap_p95_ms      max_sse_frames_per_read
aio_proxy.upstream.transport               content_encoding
```

`gen_ai.provider.name` 的源头必须与 wire protocol、Provider ID 分开。内置 runtime 明确知道实际
服务时声明规范值（例如真正的 OpenAI 才写 `openai`）；通用 API / AI SDK 自定义 endpoint 没有
声明时省略。不能因为 `targetProtocol=openai-response` 或 `openai-compatible` 就写 `openai`，也不能
把用户配置的 Provider ID（如 `carpool`、`openai-main`）自动复制过去。错误值比缺失值更会污染聚合。

实现上给 materialized provider/runtime 增加一个可选、非用户显示名的语义字段
`genAiProviderName`；已知的内置 provider 填，通用 endpoint 默认空。`server.address` 与
`aio_proxy.provider.id` 仍分别回答「打到哪个地址」和「用了哪份 aio-proxy 配置」。

`gen_ai.request.stream` 说的是**实际发给上游的请求**，不是入站请求有没有 `stream=true`；跨协议转换
后两者可能不同。拿不到实际上游模式时省略，不能直接复制 root 的 `aio_proxy.request.stream`。

本 PR 不做 `gen_ai.response.finish_reasons`：全链路无采集点，属新采集。

### ~~attempt（INTERNAL）~~ —— 已并入上一节

这一层不再是独立 span 类型：`aio_proxy.provider.attempt` 改造成了 `{operation} {model}`
（CLIENT，inference span），属性表见上。只有 OTel 没有等价语义的 attempt / routing 数据保留
`aio_proxy.*`；`attempt.model_id`、`attempt.ttft_ms` 这类重复字段删除。

body 期六项（`aio_proxy.upstream.*`）留在 inference span 而不是 HTTP client span 上，因为它们全部在响应头
之后才产生，而 HTTP client span 那时已经结束（写属性会被拒，且 buffering processor 在 `onEnd` 已经
拷走记录）。命名空间用 `upstream` 是准确的 —— 它们测的确实是上游响应的读取过程。

⚠ 有退避重试时，这六项描述的是**最后一次发送**的读取过程（`observation` 只保留一份快照）。
本 PR 不为每次发送各留一份，`aio_proxy.attempt.http_sends` 让这件事至少可见。

两个 TTFT 都保留，但标准 key 只放在它所属的 inference CLIENT span 上：

| | `aio_proxy.inference.ttft_ms` | `gen_ai.response.time_to_first_chunk` |
|---|---|---|
| 挂在 | `aio_proxy.inference` 逻辑操作层 | 每条 provider inference span |
| 起点 | 逻辑操作层起点 | 该 provider inference 调用起点 |
| 终点 | 吐给客户端的第一个 chunk | 从该 provider 收到的第一个 chunk |
| 含 provider failover | **含** | 不含其他 provider；含本 provider 内自动重试 |
| 单位 | 毫秒 | 秒（规范硬约束） |

标准属性所在的 `gen_ai.inference.client` 组已经决定了它的作用域；非 GenAI 的逻辑父层不能为了
表达端到端体验而借用同一个 key。一次 failover 后两者可能分别是 3200ms 与 0.4s，这是两个不同量。
dashboard 分别展示，不互相回填。

attempt 侧也不能借 `gen_ai.` 前缀创造不存在的路由属性（例如
`gen_ai.aio_proxy.attempt.index`）。没有标准等价物的字段继续放 `aio_proxy.*`。

**实现注意：拿不到非废弃的类型常量。** `semantic-conventions-genai` 仓库只有
`model/` `docs/` `reference/` `templates/`，不发生成代码包；旧家
`@opentelemetry/semantic-conventions` 里的
`ATTR_GEN_AI_RESPONSE_TIME_TO_FIRST_CHUNK`（`experimental_attributes.ts:7462`）标了
`@experimental` + `@deprecated Moved to…`。在 `semantic.ts` 里直接写字符串字面量，
不要 import 那个废弃常量——它的 deprecation 说的是「搬家了」，不是「要删了」，
但 lint 不认识这个区别。

### HTTP client（CLIENT）—— 只放响应头之前就已确定的事实

```
http.request.method   server.address   url.full   url.template
http.response.status_code
aio_proxy.upstream.headers_ms
```

`url.template` 只有在实际 transport 能提供权威的低基数模板时才写，同时参与 span 命名；
`url.full` 记录实际请求地址但不参与命名。不得拿入站 route、wire protocol 或实际 `url.path`
直接代替 `url.template`。

`headers_ms` 可以留在这里：`response-observation.ts:77` 的 `upstreamHeadersMs` 写在
`observeResponse` 里、早于 `controlledStream` 判断，正是本 span 的终点时刻。
其余上游标量全部在此之后产生，见上一节。

## ~~命名禁区~~ —— 整节作废，理由如下

上一版规定：**attempt span 上禁止出现 `gen_ai.request.model` / `gen_ai.response.model` /
`llm.model_name` / 裸 `model`**，因为 Langfuse Priority 10 兜底会把这种 span 判成
`GENERATION`，一条 trace 出现多个 GENERATION，聚合语义含糊。

三层模型下这条**反了**：每个 provider 的尝试**本来就是**一次真实的上游推理调用，判成
GENERATION 是准确的，不是误判。一次转移打了两个上游，就是两次 generation 尝试。

支撑这次反转的三点，都在本文档别处已经成立：

1. 本节原本的理由已被本文档「第三方消费约束」一节自己降级 —— 全仓零 exporter、零 Langfuse
   集成，重复计费**未做复现**，且 Priority 1 的 `langfuse.observation.type` 是显式逃生口。
2. issue #299 的评论明确主张 per-attempt 子 span 带完整 `gen_ai.*`，并反对 overload
   `gen_ai.provider.name`。为了迁就一个未接入的下游而放弃标准属性，代价方向错了。
3. `gen_ai.client.operation.duration` 这个标准 metric 的属性里带 `gen_ai.provider.name` 与
   `error.type`。按 inference span 发射，直接得到**每个 provider 的延迟分布与错误率**；
   按上一版（属性挂在逻辑操作层、provider.name 填入站口味）发射，这个 metric 对 provider
   SLO 完全无用。这是本次反转收益最大的一条。

仍然保留的一条：**`aio_proxy.inference`（逻辑操作层）上不写 `gen_ai.operation.name` 与
`gen_ai.provider.name`**，它不是 inference span。依据是 PR #475 的
"Non-inference spans … MUST NOT be stored under the inference span context key"。

## 六种能力统一命名

span 名与 `gen_ai.operation.name` 属性是两回事：规范只说名字 `SHOULD` 长成
`{operation} {model}`、且 `MAY` 自定义格式。但属性本身在 inference span 上是 `Required`，
而枚举是开集（"otherwise, a custom value MAY be used"），所以**六种能力全写**。

| capability | span 名 | `gen_ai.operation.name` |
|---|---|---|
| language | `chat claude-sonnet-4-5` | `chat`（预定义） |
| embedding | `embeddings text-embedding-3` | `embeddings`（预定义） |
| image | `image_generation dall-e-3` | `image_generation`（自定义） |
| speech | `speech tts-1` | `speech`（自定义） |
| transcription | `transcription whisper-1` | `transcription`（自定义） |
| video | `video_generation veo-3` | `video_generation`（自定义） |

自定义值一旦上游补齐预定义值，要按新值改名 —— 这是开集的代价，记在「后续」。

`aio_proxy.capability` 始终写（六值），查询按它 group by，不用去匹配 span 名字符串。

将来接 exporter 时 Langfuse 两条路都通：写了属性的走 Priority 3（`chat`→GENERATION，
`embeddings`→EMBEDDING）；没写的靠 `gen_ai.request.model` 走 Priority 10 兜底成 GENERATION。
无论哪条，全链路恰好一个。

代码上只多一处条件：属性写入时查白名单。**结构零分支。**

## 实现任务

按依赖排序。上一版的顺序是坏的：属性下沉排在创建目标 span 之前，注册表校验排在创建点存在
之前。每个任务要能独立跑绿。

### 任务 1（server）4xx 与取消的状态修正

`completion.ts:29-37` 今天 `failure` 与 `cancelled` 都置 `SpanStatusCode.ERROR`。两处都要改：

1. **SERVER span 上的 4xx 保持 UNSET**（`http-spans.md` 的 MUST）。`rejectRequest()` 的
   400/404/413 归到这一类。
2. **`cancelled` 改成 UNSET 且不写 `error.type`**（`http-spans.md`："the cancellation SHOULD NOT
   be treated as an error"）。客户端断连就是规范说的调用方主动取消。

⚠ 第 2 条与 `adaf2e63`「取消的 span 不再画成绿色」交互：那次改动靠 `TraceStatus` 而不是 span
status 区分取消，所以状态改 UNSET 不会让取消又变绿 —— 但**必须带一个断言锁住这一点**，
否则下次有人把渲染改回读 span status 就会静默回归。

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

- attempt 与 prepare 的顺序重排：先建 inference span，再在其中跑 prepare 子 span
  （理由见「陷阱已消失」）。`AttemptInfo`（`attempt-base.ts:85-107`）现在把 `startedAt`
  吞进 `durationMs` 就丢了，改成一并带出。
- **`aio_proxy.provider.attempt` 就地改造成 inference span。** `emit.ts:47` 一处三改：
  名字改 `{operation} {model}`、kind 从 INTERNAL 改 **CLIENT**、父节点从 `session.rootContext`
  改成 `aio_proxy.inference`。不改父节点，树还是平的，等于没做。
- **`aio_proxy.inference` 在 `attemptResolvedRequest` 内、路由解析之前开始**（`index.ts:273`
  附近；今天 `startInferenceSpan` 在 `:316`、`routeSpan.end()` 之后，要上移），`route.resolve`
  改在它的 context 里创建。终点取终态结算（不是函数返回，流式路径会先 `return Response`），
  ERROR 取逻辑失败（不是候选耗尽）。两条路由失败出口 —— `:298` 的 `throw` 与 `:301-313` 的
  `eligible.length === 0` —— 都要在 root 结算前把它置 ERROR 并关闭。
- **HTTP client span 按实际发送插桩，且必须能表达一条 inference span 下的多条。** 名字优先
  `{method} {url.template}`，无模板时退化为 `{method}`；模板由实际 transport 显式声明，
  不能拿入站 route 或 target protocol 冒充，`createObservedFetch` 也不从实际 path 推断。多次发送有两个来源：
  `raw-retry.ts` 的隐藏重放（至多 +1），以及 **AI SDK `maxRetries` 默认 2**（再 +2，覆盖所有
  ai-sdk provider，量级远大于前者）。同时落 `aio_proxy.attempt.http_sends` 计数。
  现有的 `inAttempt()` 装的是观测与日志上下文，**不是** `OpenSpan.run()` 的 span 上下文，要补。
- 所有子 span 必须在 root 结算之前关闭（见「结算所有权」）。

### 任务 5（server）属性改名与下沉，含读路径投影

现在两层都存在了，属性才有地方可去。调用方请求的模型可留在 `aio_proxy.inference` 供路由失败
检索；实际上游调用的完整 `gen_ai.*`（`operation.name`、`request.model`、实际 stream、TTFT、
provider、response、usage）只落每条 provider inference span。分配表见「属性」。

`http.status_code` → `http.response.status_code`；四个自造 `gen_ai.usage.*` 换成标准名并
从 root 下沉到 inference span。

TTFT 这项是**拆分不是改名**：现有 `aio_proxy.response.ttft_ms`（挂 root）删除，逻辑层写
`aio_proxy.inference.ttft_ms`（毫秒），每条 provider inference span 写
`gen_ai.response.time_to_first_chunk`（秒）。删除 `aio_proxy.attempt.ttft_ms`。
`ALLOWED_ATTRIBUTES`（`span-record.ts:15`）同步，并补 `aio_proxy.inference.attempt_count`、
`aio_proxy.inference.failover_ms`、`aio_proxy.attempt.http_sends`、`gen_ai.provider.name`、
`server.address`、`server.port`。

同一任务删除 `aio_proxy.attempt.model_id`，provider span 的实际 stream 改
`gen_ai.request.stream`；`gen_ai.usage.cache_write.input_tokens` 改
`gen_ai.usage.cache_creation.input_tokens`，停止发射非标准 `gen_ai.usage.total_tokens`。
`gen_ai.provider.name` 改从 runtime 的可选 `genAiProviderName` 读取，删除按 `ProviderProtocol`
映射的 `PROVIDER_NAME` / `genAiProviderNameFor()`。

**`span-projection.ts:225-231` 一并改**：今天它在读回时从 summary 列把 `gen_ai.request.model`
/ `gen_ai.response.model` / 整套 `gen_ai.usage.*` 重建到 root 上（事实 4）。不改这里，
下沉在读回后等于没发生。summary 列保留 —— 那是列表页与记账的投影。

dashboard 侧 `trace-attribute-names.ts:21` 与 `span-metrics.ts:62` 一并改：逻辑操作行读
`aio_proxy.inference.ttft_ms`，provider inference 行读标准 key 并 ×1000 换算成毫秒展示。

历史 GenAI 属性不迁移。root diagnostics 例外：按本节属性表做只读 fallback，避免 retention 窗口内
的旧 trace 详情突然消失；新 trace 不再双写 `aio_proxy.diagnostics.*`。

### 任务 6（server）span 注册表

放在最后，因为校验的前提是所有创建点都已存在。

`semantic.ts` 的 11 个裸字符串常量改成注册表：每个 span 声明 `{ name, kind, parent }`，
配一个校验测试。抄 LiteLLM v2 的 `SPAN_REGISTRY` + `validate_registry()` 思路。

「常量存在但没人创建」这种事结构上就不可能再发生 —— 这正是本次七个死常量的成因。

**校验的边界**：查 span 名、kind、父子关系。**不查 `gen_ai.operation.name` 的取值** ——
那是开集（见「规范依据」），把 1.43.0 的 9 个常量写成白名单会在上游发布时自己判错。
需要校验的话，只校验「非空 + 低基数」。

### 任务 7（core / server / dashboard）瀑布树渲染与稳定顺序

`trace-layout.ts` 现在只管深度与柱宽，要支持真实多级嵌套。TTFT 在 attempt 条上画刻度，
不画成子行。

给 span 记录、`trace_span` 与 dashboard DTO 增加 nullable `startSequence`：root 在 `startRoot()`
写 0，`BufferingSpanProcessor.onStart()` 给同 trace 后续 span 分配 1、2、3……，`onEnd()` 带出；
详情查询优先按 sequence 返回，布局按 parent/child DFS 后用 sequence 排 sibling。nullable 只用于兼容
旧记录，缺失时才回退 `(startedAt, spanId)`。该字段是存储元数据，不加入 span attributes 表。

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
  详见「HTTP client span 的名字与终点」。
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

**但挂载不能推后。** 任务 4 的 HTTP client span 包在 `createObservedFetch` 上，隐藏重试的第二次
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
| 一次失败转移（**断言落在读回之后**） | root 上零 `gen_ai.*`；逻辑操作层带调用方的 `gen_ai.request.model`；每条 provider inference span 带各自的 `gen_ai.operation.name` / `request.model`，runtime 已声明时才带 `provider.name` |
| 一次失败转移的层级 | 两个 provider inference span 都挂在 `aio_proxy.inference` 逻辑操作层下，不在 root 下 |
| 六种能力各一 | 树形状一致；每条 provider inference span 都写非空、低基数的 `gen_ai.operation.name`，其中四种非标准能力使用本文定义的自定义值 |
| 4xx 拒绝 | root 状态 UNSET；`http.response.status_code` 正确 |
| root 属性（新 trace） | 使用标准 HTTP / URL / User-Agent 属性；零 `aio_proxy.diagnostics.*`；截图所列字段里只保留 `aio_proxy.request.id`、`aio_proxy.protocol.inbound`，并仅在 token-count 路径写 `aio_proxy.operation` |
| root 属性（历史 trace） | diagnostics API 优先读标准属性，缺失时能从旧 `aio_proxy.diagnostics.*` 还原；新 trace 不双写 |
| 已知内置 provider | `gen_ai.provider.name` 取 runtime 显式声明的规范值，与 provider 使用什么 wire protocol 无关 |
| 自定义 OpenAI-compatible endpoint | 不因 source/target protocol 写 `gen_ai.provider.name=openai`；未声明真实身份时省略，仍保留 `server.address`、`aio_proxy.provider.id` 与 `aio_proxy.protocol.target` |
| provider inference 属性去重 | 有 `gen_ai.request.model`，无 `aio_proxy.attempt.model_id`；有标准 TTFT 时无 `aio_proxy.attempt.ttft_ms` |
| provider streaming | `gen_ai.request.stream` 反映实际向上游发送的模式，不直接复制入站 `aio_proxy.request.stream` |
| provider usage | 使用 `cache_creation.input_tokens`；不出现 `cache_write.input_tokens` 或非标准 `gen_ai.usage.total_tokens` |
| 两层 TTFT | 逻辑操作层用 `aio_proxy.inference.ttft_ms`；provider inference 用秒单位的 `gen_ai.response.time_to_first_chunk` |
| prepare 抛错（`modelInvocation` 失败） | 恰好一个 attempt 行，没有未关闭的 span 被丢弃；终态与重构前逐字段一致 |
| 不可重试状态但仍有候选 | GenAI span 置 ERROR —— ERROR 判据是逻辑失败，不是候选耗尽 |
| 流式成功 | GenAI span 终点取终态结算，不是 `Response` 返回时刻 |
| prepare 有延迟 / 能力拒绝 | prepare span 宽度反映真实耗时，不再是黑洞 |
| 请求前后墙钟前跳 / 后跳 | duration 不被污染、不被夹成 0 |
| AI SDK 有内容无首字节、纯 tool-call 输出 | 仍有可用属性；没有 TTFT 不等于没有输出 |
| 首内容之后出口流报错 | 观测活过终态替换；不把它标成上游 body 失败 |
| 上游 HTTP 命名 | 有低基数模板时为 `{method} {url.template}`；无模板时为 `{method}`；实际 `url.path` 永不进入 span 名 |
| 同毫秒 sibling | 构造相反字典序的 `spanId`，仍按 `startSequence` 显示真实开始顺序；无 sequence 的旧数据只保证稳定 fallback，不声称可恢复真实顺序 |
| 同 attempt 内隐藏重试后成功 | 两个 HTTP client span 都挂在同一 attempt 下；不跨响应造刻度；歧义可见 |
| 终止帧之后延迟 EOF 或取消 | 不把 trace 结算当成 body 完成或客户端送达成功 |

断言的是**时间边界、层级归属与错误归属正确**，不是「每条 trace 恰好有 N 行」。
