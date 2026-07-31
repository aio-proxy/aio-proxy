# 流式压缩策略与时延观测设计

日期：2026-07-30

状态：设计评审中

## 背景

对 issue #94 的代码审计与同 Provider、同模型轻量 A/B 表明，当前证据不足以把 aio-proxy 的体感差异归因于 `decompress: false` 本身：OpenAI Responses raw 路径的首内容时间与 CPA 基本持平；Anthropic Messages 经 aio-proxy 的额外延迟发生在跨协议 model path，不能直接外推到同协议 raw 转发。

但传输策略仍有一个值得独立修正的差异：CPA 对上游流式请求显式发送 `Accept-Encoding: identity` 并逐 chunk flush；aio-proxy 的 OpenAI stream wrapper 当前无条件覆盖为 `gzip, deflate, br, zstd`，再以 `decompress: false` 进行受控解码。即使本地解码开销不大，上游或中间层也可能因为压缩而改变 SSE flush/分块行为。

现有 trace 只有“attempt dispatch 到首个 text/reasoning content”的 TTFT。它无法区分时间消耗在响应 headers 前、首字节前、SSE 元数据阶段，还是内容事件之间，也无法判断一次底层读取是否批量交付了多个 SSE frame。

本设计因此只处理两件事：让流式压缩协商与 CPA 对齐，并为每个 provider attempt 保存足以定位流式延迟的聚合指标。模型目录策略已拆到 [#96](https://github.com/aio-proxy/aio-proxy/issues/96)，不在本轮实现。

## 目标

1. provider 未显式配置时，由 OpenAI stream wrapper 管理的上游流式请求使用 `Accept-Encoding: identity`；非流式请求保留 Bun 的正常压缩协商与自动解压行为。
2. provider 显式配置的 `Accept-Encoding` 始终优先，不新增单独的压缩配置项。
3. 在 provider attempt 上记录 headers、首字节、首个 SSE event、首内容、内容间隔和批量 frame 等聚合指标。
4. raw 和 model path 使用相同时间基线，同时明确不同传输的可观测边界，不用 `0` 伪造不可见或尚未发生的数据。
5. 保持流式 backpressure、取消、协议 terminal 截断和错误传播语义不变。

## 非目标

- 不改变 provider 配置决定的 raw/model capability，也不增加协议自动探测。
- 不让 Messages 绕过 provider 配置强行走 raw；跨协议请求继续使用现有 model capability。
- 不增加跨协议 session/cache 身份映射；同一 session 的请求不假设会切换入站协议。
- 不在本轮实现 [#96](https://github.com/aio-proxy/aio-proxy/issues/96) 的模型元数据覆盖。
- 不以 Bun 自动解压替换受控流式解码。显式要求压缩的流仍保留当前 demand、错误和 protocol-terminal 取消控制。
- 不把该 header 策略扩展到当前未使用 OpenAI stream wrapper 的 Anthropic、Gemini 或自管 fetch transport。
- 不合并 terminal parser 与 usage parser，不调整 SQLite 写入、preconnect、连接池或 provider fallback。
- 不保存逐 frame 时间戳、逐 frame trace event、响应正文或 header 全集。
- 不新增 Dashboard 表格列、筛选项、数据库列或 migration；本轮指标通过 trace detail 的 span attributes 暴露。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 策略对象 | 实际上游请求是否流式，而不是客户端最终收到 SSE 还是 JSON |
| provider 覆盖 | 复用现有 provider `headers.Accept-Encoding` 或插件 transport 的显式值 |
| 流式默认 | 未显式配置时发送 `Accept-Encoding: identity` |
| 非流式默认 | 不设置 `Accept-Encoding`，也不传 `decompress` override，交给 Bun |
| 显式压缩流 | 保留 `decompress: false`、受控解码与 protocol-terminal 取消 |
| 流式判定 | 由调用方传递内部 stream hint；不得为判定再次读取/解析 request body |
| 指标归属 | 每个 provider attempt 独立聚合并写入该 attempt span |
| 时间基线 | candidate 创建时的 `performance.now()`，与现有 TTFT 相同 |
| 持久化 | 只保存终态聚合值；缺失表示不可见或尚未发生，绝不补零 |
| 多 fetch | 一个 attempt 观察到多个无法归因的 HTTP response 时，transport observation 标为 ambiguous 并省略原始传输指标 |

## 上游压缩策略

### 优先级

OpenAI Responses 和 OpenAI-compatible transport 按以下优先级决定上游 `Accept-Encoding`：最终 provider request 中的显式 header、插件 transport 的显式 `acceptEncoding`、流式默认。对应行为为：

| 显式 provider/transport 值 | 上游流式 | 行为 |
| --- | --- | --- |
| 有 | 任意 | 使用显式值 |
| 无 | 是 | 设置 `Accept-Encoding: identity` |
| 无 | 否 | 不设置该 header，让 Bun 使用平台默认行为 |

对本轮 managed raw transports，“provider 显式值”不包括入站客户端的 `Accept-Encoding`。该 header 表达客户端接收 aio-proxy 响应的偏好，不应决定 aio-proxy 到 provider 的传输。generic API provider 在复制入站 headers 时先删除它，再应用 provider 配置中的 headers；内置 openai-chatgpt raw transport 同样在进入共享 OpenAI wrapper 前删除客户端值。这样 provider 配置或插件的显式 transport 值仍可明确选择 `identity`、`gzip` 或其他值。

该清理保证只覆盖本轮管理的 generic API 与内置 openai-chatgpt OpenAI wrapper。其他自管 fetch 的插件 raw transport 继续拥有自己的 header 语义，本轮不在调用插件前全局删除入站值，也不宣称对它强制执行该策略。

不增加 `streamCompression` 等新配置。现有 `headers` 已经提供必要的 escape hatch，额外配置只会产生两套优先级。

### 流式判定接缝

不得在 fetch wrapper 中通过 `request.clone().json()` 重新判断 `stream`。这会重复读取已由 adapter 解析过的请求体，对大 prompt 增加内存和发起上游请求前的延迟，也无法可靠处理保留原始压缩实体的 raw request。

流式信息从已经知道事实的位置向 transport 传递：

- raw path 使用 `adapter.wantsStream(request, context)` 的结果，并通过向后兼容的第三参数传递：`RawTransport.invoke(request, logicalContext?, { upstreamStream })`。第三参数在 plugin-sdk 与 server runtime 类型中均为可选；现有两参数插件函数会自然忽略它。generic API provider 的 materialization 明确把该值转交给 OpenAI fetch wrapper。
- AI SDK path 使用 `streamText`，其上游请求本身始终是流式。即使入站客户端请求非流式 JSON，aio-proxy 只是随后缓冲 typed stream，因此上游 transport 仍使用流式策略。
- AI SDK OpenAI wrapper 与内置 OpenAI 插件的 model fetch 在创建时声明 `upstreamStream: true`；插件自管且不使用 aio-proxy OpenAI wrapper 的 fetch 不被强行重写。

`createOpenAIStreamFetch` 同时接受 wrapper-level 默认值和仅在 aio-proxy 内部使用的 per-call stream hint，per-call 值优先。这样共享 fetch 也不需要复制认证/重写逻辑：

- AI SDK model 调用不传 per-call hint，使用 wrapper-level `true`。
- raw capability 把 `RawTransport.invoke` 的第三参数转成 per-call hint。
- openai-chatgpt 的 model 与 raw 继续共享一个 `dynamicFetch`；它的 model 默认是 `true`，raw 调用逐次覆盖。其现有 `acceptEncoding: identity` 是显式 plugin transport fallback；raw 客户端值被清除且当前没有更高优先级的 provider header，因此最终为 identity。stream hint 只决定使用受控流式 reader，还是非流式平台/意外 SSE 分支。

内部 hint 必须在调用底层 fetch 前被消费，不作为未知 `RequestInit` 字段继续透传。

该 hint 只影响 transport，不进入公开 provider 配置、请求 header 或协议 adapter 的业务模型。

### fetch 与解压行为

流式分支：

- 默认或显式 `identity` 都使用 `decompress: false`，继续由现有 wrapper 掌握 source reader、terminal 截断和取消。
- provider 显式请求 gzip/br/zstd/deflate 时，继续走现有受控 decoder。
- 上游返回 SSE 时继续执行 protocol terminal 检测；返回普通 JSON 错误体时继续按普通响应处理。

非流式分支：

- 不传 `decompress` 选项，不调用手动 decoder，普通非 SSE response 直接保留 Bun 默认压缩协商和自动解压行为。
- 若声明为非流式的请求意外收到 `text/event-stream`，仍对 Bun 已暴露的 body 按 identity decoded bytes 执行现有 protocol-terminal 包装；不得根据可能残留的 `Content-Encoding` 再解压一次。这样保留旧的 terminal 截断/取消语义，同时避免 double decode。

本设计优化的是“避免上游压缩可能造成的 flush/批量交付”，不是把手动解码替换成 Bun 解码。若 provider 明确选择压缩，aio-proxy 尊重该选择。

## 聚合时延指标

### 属性定义

所有时间均相对当前 candidate 的单调时钟 `startedAt`，终态取非负毫秒并四舍五入。raw/model 的 attempt span 目前不是在完全相同的代码位置开启，因此不得用 span start time 替代该共同基线。属性写在 `aio_proxy.provider.attempt` span 上。

| Span attribute | 定义 | 缺失条件 |
| --- | --- | --- |
| `aio_proxy.response.transport_observation` | `sse`：单一可观测 SSE response；`body`：单一可观测非 SSE response；`unavailable`：provider 已执行但未经过可注入 fetch；`ambiguous`：多个 response 无法归因 | provider 执行前失败，或可注入 fetch 已开始但在 response headers 前失败 |
| `aio_proxy.response.upstream_headers_ms` | 被观测的上游 fetch 返回 response headers 的时间 | provider 未使用可注入 fetch，或多 response 无法归因 |
| `aio_proxy.response.first_upstream_byte_ms` | 仅受控流式分支记录 fetch 暴露的 body 第一次读到非空字节的时间；发生在 aio-proxy 手动解压之前 | body 为空、首字节前失败/取消、不可观测、ambiguous，或非流式平台自动解压分支 |
| `aio_proxy.response.first_sse_event_ms` | 第一个语法完整 SSE event 可交给协议消费者的时间；metadata/start event 也计入 | 非 SSE、首 event 前终止，或压缩 model transport 无法在 typed stream 前观测 |
| `aio_proxy.response.ttft_ms` | 现有语义：第一个 text/reasoning content event 的时间 | 纯工具响应、首内容前终止 |
| `aio_proxy.response.content_gap_p95_ms` | 相邻 content events 时间间隔的在线 p95 估计 | 少于两个 content events |
| `aio_proxy.response.max_sse_frames_per_read` | 单次底层 source `reader.read()` 完成并由 SSE parser dispatch 的 events 最大值；comment/keep-alive、空块、`retry:` 或仅含 `event:` 的块不计入，跨 read 的 carry 计入补全它的 read | 非 SSE、不可见 read 边界、显式压缩且只在 encoded fetch 层可见 |
| `aio_proxy.response.content_encoding` | 受控流式 fetch 收到的 `identity`、已知单一 coding、`multiple` 或 `other`；无 header 记为 `identity` | response headers 不可观测、ambiguous，或非流式平台自动解压分支 |

`first_upstream_byte_ms` 不是客户端最终收到的 chunk，也不是一个 token。在本设计关注的受控流式分支中，它是 wrapper 手动解压前的 fetch body 字节；非流式平台分支不记录该属性，避免把平台自动解压后的字节冒充 wire bytes。`first_sse_event_ms` 与 TTFT 有意分开：前者能显示连接已经开始流动但模型尚未产生内容的阶段。

content event 继续只认生成的 text/reasoning delta。tool argument、usage、metadata、stream-start 和 terminal event 不计入 TTFT 或 content gap。SSE comment/keep-alive 也不计入 frames/read。一次 source read 批量产生多个 content event 时，它们之间会出现接近 0 的 gap，同时 `max_sse_frames_per_read` 会升高；两项组合用于识别批量交付。

### raw path

raw path 在两个现有接缝采集：

1. provider fetch 的透明 pull-through observer 记录 headers、原始 encoding、首非空字节和 identity SSE 的 source-read frame 批量。
2. passthrough usage observer 在解码后的 SSE 上记录首个 event、首内容和 content gaps。

observer 必须单路读取并原样 enqueue 同一个 chunk；不得 `tee()` 出观察支路，避免慢支路缓存响应体或改变 backpressure。SSE frame 扫描只保留未完成 carry 和聚合计数，不保留 frame body。

### model path

model path 的 typed stream 始终可以记录：

- 第一个 text/reasoning content；
- 相邻 content gaps。

当 provider 的网络请求经过 aio-proxy 注入的 fetch 时，在 AI SDK 消费 response 前安装同一个 pull-through observer，可补充 headers、原始字节、encoding，以及 identity SSE 的 event/read 指标。

opaque `ProviderV4` 或插件内部自管 fetch 将 `transport_observation` 标记为 `unavailable`，但仍可保存 typed semantic metrics。非 SSE fetch 标记为 `body`。pipeline 不得从 `TextStreamPart` 反推 headers、原始字节、content encoding 或底层 read 边界。OpenAI/Anthropic SDK 可能在把 typed stream 交给 pipeline 前预读上游事件，因此 typed part 的到达时间也不能冒充首个原始 SSE event。semantic 来源继续由现有 attempt attribute `aio_proxy.transport = raw | ai_sdk` 区分，不再把 transport 可见性与 semantic 层塞进一个枚举。

### 多 fetch 语义

AI SDK retry、OAuth refresh 或 provider 内部请求可能让一个 provider attempt 产生多个 HTTP response。v1 不尝试猜测哪一个 response 最终贡献了 content：

- 恰好观察到一个 response 时保存其传输指标。
- 观察到多个 response 且无法建立明确归属时，将 `transport_observation` 记为 `ambiguous`，省略所有 raw transport timing、encoding 和 frames/read。
- 每个新 response 清空 content-gap 的上一事件基线，不把不同 response 之间的空闲时间计作 gap；已经累计的 response-local gaps 仍然保留。
- typed content TTFT 与 content-gap 指标仍然保留，因为它们明确属于当前 attempt 的最终 typed stream。

这比把首个失败 response 的 headers 与最终成功 content 拼成一组指标更可靠。后续若确实需要展开 AI SDK 内部 retry，应新增 child HTTP spans，而不是改变本轮聚合字段语义。

### content-gap p95

content gaps 不进入数组或 trace events。collector 使用以下固定 bucket 上界（单位 ms）：

- `0..250`：每 1ms 一个 bucket；
- `260..1000`：每 10ms 一个 bucket；
- `1100..10000`：每 100ms 一个 bucket；
- `11000..60000`：每 1000ms 一个 bucket；
- `>60000`：一个 overflow bucket，并维护其中实际最大 gap。

每个 gap 进入第一个满足 `upperBound >= gap` 的 bucket；因此 `(250, 260]` 进入 `260` bucket，其他档位边界同理。

终态用 `ceil(count * 0.95)` 的 nearest-rank 找到 p95。普通 bucket 保存其上界；若 rank 落在 overflow，保存 overflow 中实际最大值。因此该值是保守的近似值，且测试可以对完整边界表给出确定预期。

直方图只保存计数、上一个 content 时间和 overflow 最大值，内存不随输出 token 数增长。实现不新增统计依赖。

## 数据流与存储

每次 candidate 创建一个 attempt-local collector。它随现有 attempt AsyncLocalStorage context 进入注入 fetch，并同时传给 raw/model usage capture：

```text
candidate startedAt
  -> attempt-local aggregate collector
     -> injected fetch pull-through observer (transport metrics)
     -> raw SSE observer or model typed stream (semantic metrics)
  -> terminal snapshot
  -> provider attempt span attributes
```

collector 由 `CandidateSlot`/attempt emitter 直接持有，raw/model usage capture 只更新它，不要求 `UsageCompletion` 覆盖所有出口。`AttemptEmitter` 的统一 span-end 接缝在结束 span 前一次性取 snapshot 并写 attributes；raw 非 2xx/fallback、model prepare/availability exception、stream success、failure 和 cancellation 都走该接缝。现有 `UsageCompletion.ttftMs` 仍负责把 TTFT 复制到 root summary，不承载 transport snapshot。

新增属性加入 server trace allowlist。trace store 继续把未投影属性保存在现有 `attributes_json` 中，因此不需要 schema migration。现有 TTFT 仍按当前行为复制到 root summary；其余新指标不复制到 root，也不扩展 `DashboardTraceSummary`，避免为尚未验证价值的字段扩大列表查询和 UI。

不产生每 frame OTel event、server log 或数据库写入。调试 body logging 仍只在 debug level 生效，指标采集不记录正文。

## 取消、错误与 fallback

- headers 前失败/取消：只保留 attempt outcome；所有 timing 缺失。
- headers 后、首字节前终止：保留 headers time 与 content encoding，首字节及之后指标缺失。
- 收到字节但没有完整 SSE event：保留首字节，首 event 与内容指标缺失。
- 少于两个 content events：保留 TTFT，省略 content-gap p95。
- stream 取消或错误：保存终止前已经观测到的聚合值，不补造 terminal gap。
- 非 2xx raw fallback 当前不会消费 body，通常只记录 headers，以及受控流式分支可见的 encoding；继续及时 cancel body。
- 每个 fallback candidate 使用独立 collector，后一个 attempt 不继承前一个的时间或计数。
- 指标 observer 自身的解析/统计错误不得改变代理响应；停止该维度观测并继续透传。

所有缺失字段都表示“未发生或当前层不可观测”，不写 `0`。`0ms` 只允许作为实际测得并四舍五入后的值。

## 测试策略

### 压缩策略行为测试

- raw 流式请求在未配置 header 时发送 `Accept-Encoding: identity`，并使用 `decompress: false`。
- AI SDK `streamText` 请求默认采用相同策略，包括入站最终需要 buffered JSON 的情况。
- provider 配置的 `Accept-Encoding` 覆盖流式默认，大小写不影响匹配。
- 入站客户端 `Accept-Encoding` 不会被误认为 provider 配置。
- 非流式 raw 请求不设置 header、不传 `decompress` override；普通 response 直接使用平台 body，意外 SSE 只增加 terminal 包装且不重复解压。
- 显式压缩的流继续通过现有 decoder，保留 split frame、terminal 截断、错误和取消回归测试。
- stream hint 的传递不读取或 clone request body。

### 指标行为测试

使用可注入单调时钟和受控 `ReadableStream`，不依赖真实 sleep：

- headers、首字节、首 SSE event、首内容按定义落到同一 attempt 基线。
- 一个 read 含多个 frames、frame 跨多个 reads、空 chunk 和 EOF carry 的计数正确。
- tool/metadata event 不触发 TTFT 或 content gap。
- 固定直方图对已知 gap 分布返回预期 p95 bucket 上界。
- success、failure、cancellation 和 fallback 都保存已发生字段并省略未发生字段。
- `transport_observation = unavailable` 的 model provider 只产生 typed semantic metrics；不可见 raw 字段不存在。
- 多 response attempt 标记 ambiguous，不拼接不同 response 的 raw 指标。
- observer 保持单路 backpressure，不新增 `tee()`，取消只向 source 传播一次。

### 集成与回归

- OpenAI Responses 同协议 raw provider 实际收到默认 `identity`。
- 配置显式压缩后，raw 与 model provider 都尊重配置。
- attempt trace detail 能读取聚合 attributes，数据库 schema 不变。
- 现有 provider capability 选择、fallback、usage、TTFT root projection 和协议响应字节不回归。
- 运行相关 plugin-sdk/core/server tests、`bun run check`，最终运行 `bun run preflight`。

## 发布验证

发布后用同一 provider、同一模型、全新 session 和相同请求体分别比较 CPA 与 aio-proxy，Responses 与 Messages 分开统计：

- `upstream_headers_ms`
- `first_upstream_byte_ms`
- `first_sse_event_ms`
- `ttft_ms`
- `content_gap_p95_ms`
- `max_sse_frames_per_read`
- `content_encoding`

Responses raw path 用于验证压缩策略本身；Messages cross-protocol 结果只能评估完整 model path，不作为 raw transport 因果证据。重点比较 p50/p95 和分阶段差值，不以单次主观体感判定。

若 identity 后 TTFT 不变但 frames/read 和 content-gap 明显改善，说明收益主要在流式节奏；若全部不变，则保留该策略作为与 CPA 对齐的低风险默认，同时用新增指标继续定位 provider/模型阶段。provider 可通过现有 headers 明确恢复压缩，无需回滚其他观测能力。

## 验收标准

- provider 未显式配置时，实际上游流式 OpenAI 请求发送 `Accept-Encoding: identity`。
- provider 显式 `Accept-Encoding` 始终优先；真正非流式请求保留 Bun 默认行为。
- 不通过重复解析 request body 判定 stream。
- raw/model capability 选择和 provider 配置语义不变。
- 每个 attempt 最多保存一组聚合指标，不保存逐 frame 数据。
- raw 与 model path 的可见/不可见字段有明确语义；取消、失败和 ambiguous 场景不写误导性的零值。
- trace detail 可用于区分 headers、首字节、首 event、首内容和后续内容节奏。
- 现有受控 decoder、backpressure、terminal 取消、usage 和 fallback 行为不回归。
- `bun run preflight` 通过。
