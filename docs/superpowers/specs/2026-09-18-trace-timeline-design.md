# 调用链时间线：统一时间戳契约 + 标量锚定 + 分段柱

日期：2026-09-18
所属 PR：`claude/traces-detail-page`

## 背景

改版 demo 画了一棵九行的瀑布树（`POST /v1/messages` → `route.resolve` → `provider.*` →
`http.request` / `stream.ttft` / `stream.body` → `usage.record`）。真实数据不是这样。

生产库（41,024 span / ~18.5k trace）实测每 trace 的 span 数：1 个的 25 条，
2 个（root + 一次尝试）的 14,946 条，3 个的 3,208 条，4 个的 350 条，5 个的 21 条。
只有四个 span 名被写过。约 80% 的 trace 渲染成两根柱子。

## 核心问题：标量的原点不是 span 的起点

demo 想要的分段耗时确实已经被记下来了，但**不是记在 span 时间轴上**：

- `attempt.ts` 候选循环先取 `startedAt = performance.now()`，用它建 observation。
- `response-observation.ts:59`：所有标量都是 `elapsed(at) = at - options.startedAt`。
- `usage-capture` 的 `ttftMs = firstTokenAt - startedAt`，同一个原点。
- 但 attempt span 是**之后**才建的：`model.ts:24-41` 先 `await prepareModelInvocation()`、
  再 `assertCandidateSupported()`、再打诊断日志，最后才 `startAttempt()`。
  `emit.ts:46` 的 `startAttempt` 不传 `startTime`，OTel 取「建 span 那一刻」。

设 observation 原点为 `t0`，span 起点为 `s = t0 + δ`。响应头的真实位置是 `t0 + H`，
即 `s + (H − δ)`，而不是 `span.startedAt + H`。**δ 从未被记录，旧数据里已永久丢失。**

但这些标量**彼此之间**是一致的（同一个 `startedAt`），所以「响应头 → 首 token」这种
**区间长度**今天就是准的；错的只有**相对 span 的锚定位置**。

**修好锚点，标量就能直接画。**不需要新 span，也不需要把标量复制成事件。

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

**结论：AI SDK 通道有响应头，只是没有首字节。**它能画「起点 → 响应头 → 首 token → 收尾」
三段，只是无法在第一段里再切出首字节。之前写的「AI SDK 路径永远没有响应头」是错的。

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

## 陷阱：传了 `startTime` 会换掉 OTel 计算终点的方式

这是本方案最容易埋雷的地方，实现前必须看懂。`@opentelemetry/sdk-trace` 2.10.0
（本仓 pin 的版本）`Span.js` 的 `_getTime(inp)`：

```js
if (typeof inp === 'number' && inp <= otperformance.now()) {
  return hrTime(inp + this._performanceOffset);   // 分支 1：当成 performance 时间戳
}
if (typeof inp === 'number') return millisToHrTime(inp);  // 分支 2：当成 epoch 毫秒
...
if (this._startTimeProvided) return millisToHrTime(Date.now());  // 分支 3
return addHrTimes(this.startTime, millisToHrTime(otperformance.now() - this._performanceStartTime));
```

`_startTimeProvided = opts.startTime != null`（第 55 行）。`_performanceOffset` 是建 span 时
一次性算的 `Date.now() - (performance.now() + performance.timeOrigin)`（第 52-54 行）。

两个后果：

1. **一旦传了 `startTime`，`span.end()` 不带时间戳就走分支 3，用 `Date.now()`。**
   起点是单调时钟映射、终点是墙钟采样，请求过程中任何一次时钟校正都会直接算进 duration。
   往前跳 30 秒 → 100ms 的 attempt 变成 30.1 秒；往后跳 → `hrTimeDuration` 为负，
   第 254-257 行把 duration 夹成 `[0, 0]`。**这比 δ 更糟。**
2. **不要自己加 `timeOrigin`。**`performance.timeOrigin + startedAt` 是个远大于
   `performance.now()` 的数，会掉进分支 2，绕过 SDK 自己的 `_performanceOffset` 校正，
   跟其他 span 的映射方式不一致。直接传裸的 `performance.now()` 值，走分支 1 才对。

所以任务 1 的契约不是「传个 startTime」，而是：**同一个 span 的起点、终点、以及任何
事件时间戳，都传裸 `performance.now()` 数值，全部走分支 1 用同一个 `_performanceOffset`。**

## 方案：四个任务

### 任务 1（server）统一时间戳契约

`OpenSpan` 的起点与终点成对出现，由 `startPipelineSpan`（`tracing.ts:22`）强制：

- `startPipelineSpan` 的 options 多接一个 `startedAt?: number`（裸 `performance.now()`）。
- 传了 `startedAt` 的 span，`end()` 内部改成 `span.end(performance.now())`；没传的保持
  `span.end()` 不变（走分支 4，跟今天行为一致）。

把「传起点必须传终点」做进这一个 helper，调用方就不可能忘。`OpenSpan.end` 的签名不变。

`AttemptInfo`（`attempt-base.ts:85-91`）加 `readonly startedAt: number` —— `attemptBase()`
现在把它吞进 `durationMs` 就丢了，改成一并带出。`startAttempt`（`emit.ts:46`）把
`base.startedAt` 传给 `startPipelineSpan`。

这同时修两件事：δ 归零；model 路径的 prepare 耗时不再掉进 root 与 attempt 之间的黑洞。
语义上也更正确 —— attempt 开始于循环挑中这个候选那一刻，raw 路径（`raw.ts:51`）本来就是这样。

**注意 backdating 只改记录的几何，不改历史上下文。**prepare 期间的工作不会追溯性地变成
这个 span 的活跃上下文；等 prepare 自己有了插桩，这个区别会显出来。

**测试**：在 `prepareModelInvocation` 里插入可观测延迟，断言 attempt span 的 `startedAt`
等于循环的 `startedAt`；以及请求过程中把墙钟前后跳，断言 duration 不被污染、不被夹成 0。

### 任务 2（server）标记时间基准

部署之后新旧 attempt 会共存，dashboard 不能假设每个标量都相对它自己的 span 起点。
加一个属性 `aio_proxy.response.timing_basis = "attempt_start_v1"`，写进 `ALLOWED_ATTRIBUTES`
（`span-record.ts:15`）。无需迁移、无需新列。

规则是「有标记 = 基准已知；无标记 = 基准未知」，不需要推断为什么未知。

### 任务 3（server）首内容观测归一到 observation

今天 TTFT 挂在 completion 的返回值上，被终态整形吃掉（见上文事实 3）。改成让
usage capture 观测到首个内容时写进 `AttemptResponseObservation`，由 `snapshot()` 带出，
`endAttempt` 统一落属性。

这不是为了画图，是修一个真实的观测丢失：**保留时间不该依赖终态形状。**
副作用是失败路径也有 TTFT 了，而 `endAttempt` 真正变成单一汇聚点（之前的 spec 误以为它已经是）。

**不要**为了保住时间戳把失败的 egress 改判成成功。时间与结论分开存。

### 任务 4（dashboard）分段柱

一个纯函数（`modules/traces/lib/` 下，不 import React），输入一个 attempt span，
输出分段与刻度。坐标系明确写成 **attempt 相对毫秒**，由展示层再换算成 trace 全局位置。

有 `timing_basis` 标记时：

| 段 | 端点 | 可用通道 |
|---|---|---|
| 到上游响应头 | `0 → upstreamHeadersMs` | raw + ai_sdk |
| （细分）到首字节 | `upstreamHeadersMs → firstUpstreamByteMs` | 仅 raw |
| 等待首个 token | `→ ttftMs` | 两者，视观测是否存活 |
| 首 token 至尝试收尾 | `ttftMs → durationMs` | 两者 |

区间命名必须对得起观测点，不沿用 demo 的错误标签（`connect+send` / `stream.ttft` /
`stream.body` 全是错的：响应头之前包含本地准备、连接、发送、上游排队与计算，
只有一个时间点无法拆开；attempt 终点也不是上游 body 终点）。

**画段的前提不只是「同一基准」，还要端点有效、顺序合理、观测身份相同。**
第一次发送的响应头配第二次发送的内容，不会因为共用一个时钟就变成一个有意义的阶段 ——
这正是 `ambiguous` 抑制存在的理由。`transportObservation === 'ambiguous'` 时不画段，
并且要在 UI 上说明「同一 attempt 内观测到多次响应」，而不是显示成普通的缺数据。

不引入 `exact: boolean`。既然不精确的段一律不生成，这个字段永远是 `true`，是死分支。
需要的是一个明确的「基准未知」诊断项，而不是一个没人取 `false` 的布尔。

标量本身是 `Math.round` 过的，span 时间戳走 `Date` 转换，所以边界点可能差 1ms。
容差策略写死在这个纯函数里：负长度归零、超出 span 边界的刻度夹到边界，不抛错。

没有标记的行（旧数据）：柱子照今天画，指标区照今天显示数字，不画段。
`trace-waterfall-row.tsx:43-48` 的单色柱保留为这条退路。
`trace-layout.ts` 保持只管 span 的深度与柱宽，不合并。

## 明确不做

- **不发里程碑事件。** 三个事件是现有标量加一个正确锚点的确定性再编码，不带来任何新观测。
  锚点修好之后 `attempt 起点 + 标量` 就够画。事件是合法的 OTel 表达方式，但不是这个功能的
  前提，还要额外背上「标量与事件必须一致、都要活过持久化、所有终态路径都要发」的义务。
  真要发事件，该发的是**独立观测到的失败阶段**，不是复制已有标量。
- **不建 `route.resolve` span。** `attemptCandidates()`（`attempt.ts:214-228`）拿到的
  `candidates` 与 `resolution` 已经是解析好的，包在这里的 span 只覆盖亲和性重排与冷却过滤，
  叫 `route.resolve` 名不符实。真要做得先定错误契约（入参为空 / 全在冷却 / 后续能力拒绝
  是三件事），优先级低于隐藏重试。顺带一句：两行的 trace 加第三行是 50% 行数增长，
  「不改 schema」不等于「没有存储成本」。
- **不建 `http.request` / `stream.ttft` / `stream.body` / `usage.resolve` 子 span。**
  `stream.body = 首 token → attempt 终点` 是不诚实的。但换个边界是有可能诚实的
  （`upstream.body.consume`：开始消费响应体 → 观测到 EOF / 读失败 / 取消），
  代价是它需要独立的生命周期插桩，而且**当前 trace 的结算可能早于 body EOF**：
  AI SDK capture 在 `finish` 分片就结算而传输仍活着，raw capture 在终止帧结算并刻意不因
  后续取消改判。所以「attempt 终点 = body 终点 + 收尾」也是错的，它可能**早于** body 结束。
  一个诚实的 body span 会在 attempt/root 结算之后才结束，持久化与布局怎么处理要另行设计。
  推后是合理的，但理由是「需要独立插桩与布局设计」，不是「概念上不成立」。
- **不做故障位置推断。** 「有 `first_token` 且失败 = 首 token 之后断的」不成立：
  失败可能出在 egress、序列化、取消或后续终态处理。「只有 `upstream_headers` = 没等到内容」
  更是把「没有记录」当成「没有发生」—— 观测可能不可用、被歧义抑制、被终态整形丢掉，
  或者根本不覆盖那类输出（AI SDK 的 `firstTokenAt` 只在 `text-delta` / `reasoning-delta`
  上设，纯 tool-call 不算）。**「首个 token」是一个特定的内容观测约定，不是「之前什么都没发生」的证据。**
- **不改 retention、不加采样。** 本 PR 不新增 span 行。
- **不给旧数据合成分段。** δ 已永久丢失，虚线段照样在传达一个位置。

## 缺失的含义

一条规则：**缺失不代表旧版本。**新记录也会缺段 —— 没走受控流（AI SDK 没有首字节）、
观测到多次响应（`ambiguous`）、`markTransportUnavailable()` 未被后续 fetch 清掉、
或者该阶段根本没发生。所以判断依据是「这个 span 上有没有这个标量 + 有没有 `timing_basis`」，
不引版本号、不写迁移。

已知时长在没有全局位置时仍然有用：`ttftMs − upstreamHeadersMs` 是一个准确的时长，
可以放进 tooltip 或不与时间轴对齐的明细区，只是不画成柱子上的一段。

## 与 demo 的偏差（需要拍板）

本方案做完是 **2 行 + 分段柱**（root / attempt 分段），不是 demo 的 9 行树。

要凑够 9 行只能靠上面「明确不做」里那几个 span，而它们今天表达的是错误的时间语义。
如果视觉上必须要行数，可以让展示层把段渲染成缩进行（视觉像子行，但标注为派生区间、
不冒充 span、不进 span 计数）—— 这是展示层决定，不改记录层。**需要确认走哪个。**

## 后续（不在本 PR）

`raw-retry.ts` 的同 attempt 内隐藏重试**完全不进 trace**，注释里写明了。
`resolveRawRetry()` 会消费并分类第一个响应、改写请求、再次发起，全程在 usage capture 之前。
「到底发了几次请求？哪次失败？最终内容来自哪次？」今天无法回答 —— 这是真正缺信息的地方，
价值高于 `route.resolve`，也高于把三个标量复制成事件。

独立 server PR。做的时候：插桩**实际发送**而不是 `raw.invoke()` 调用（一次调用可能是多次发送），
区分候选下标与候选内重发下标，显式把发送 span 挂到 attempt 下 ——
现有的 `inAttempt()` 装的是观测与日志上下文，**不是** `OpenSpan.run()` 的 span 上下文。

## 测试

端到端契约测试，不是给 React 喂手写 fixture：

```
真实 pipeline 场景 → span 记录 → sanitize → 落库与读取 → 分段投影
```

| 场景 | 断言 |
|---|---|
| 请求前后墙钟前跳 / 后跳 | 起点、终点留在同一映射上；duration 不被污染、不被夹成 0 |
| prepare 有延迟 / prepare 抛错 / 能力拒绝 | 候选的逻辑起点一致，含追溯发出的失败 span |
| AI SDK 有内容无首字节、纯 tool-call 输出 | 仍画出可用的段；没有 TTFT 不等于没有输出 |
| 首内容之后 egress 报错 | 观测活过终态替换；不把它标成上游 body 失败 |
| 同 attempt 内隐藏重试后成功 | 不跨响应造段；歧义可见 |
| 终止帧之后延迟 EOF 或取消 | 不把 trace 结算当成 body 完成或客户端送达成功 |
| 零值标量、小数时间戳 | 零里程碑不被丢掉；取整不产生负长度或越界刻度 |

断言的是**时间边界与错误归属正确**，不是「每条 trace 恰好有 N 行」。
