# Raw passthrough 的 SSE parser 选型

调研日期：2026-07-12

## 结论

`aio-proxy` 的 raw passthrough usage 旁路观测应使用 **`eventsource-parser@3.1.0` 的 `createParser()`**，不应继续维护手写的 frame/line split，也不应引入一个完整的 EventSource client。

原因是这个场景只需要一个“可逐 chunk feed、事件完成时回调”的协议解析原语。`eventsource-parser` 正好覆盖这个边界，并且：

- 任意 chunk 边界都可增量 feed，能保留跨 chunk 的未完整行；
- 正确处理 `LF`、`CR`、`CRLF`，包括 `CR` 与 `LF` 被拆到两个 chunk 的情况；
- 按规范拼接多行 `data:`，接受 `data:value` 与 `data: value`；
- 处理 `event`、`id`、`retry` 和注释；
- 3.1.0 新增 `maxBufferSize`，可限制恶意或异常 SSE event 的未完成缓冲；
- 零 runtime dependency，Node 18+；仓库有 Bun test script；
- 本仓库的 `bun.lock` 已经通过 AI SDK 间接锁定 `eventsource-parser@3.1.0`，把它声明为 server 的直接依赖不会再增加一个新的第三方包。

不过，parser 只能解决 **SSE 帧解析和单个未完成 event 的内存上限**。非 SSE 的普通 JSON 响应仍要单独设置采集上限；不能继续无界保存完整响应。

## 本仓库的实际需求

当前实现把所有 raw response chunks 存入数组，流结束后再拼成一个完整 `Uint8Array`，随后把整个 body 当成 SSE 或 JSON 解析。它有两个独立问题：

1. SSE grammar 被简化成 `split(/\r?\n\r?\n/)` 和 `startsWith("data: ")`，不能覆盖合法的 `data:{...}`、裸 `CR`、跨 chunk 语义等规范细节。
2. 无论 SSE 还是 JSON，都保留完整响应并在结尾再复制一次，内存随 response size 线性增长，峰值还会包含原 chunk 集合和拼接后的副本。

旁路观测不应改变转发字节。合适的结构是：读取一个 chunk，原样 `enqueue` 给客户端，同时把同一 chunk 经一个持久 `TextDecoder` 增量解码后 feed 给 parser。解析失败、超限或 usage 缺失都只应关闭观测，不应中断 passthrough。

## SSE 规范要求

WHATWG 的 event stream 解释算法要求：

- stream 必须按 UTF-8 解码，可忽略开头一个 BOM；
- 行结束符可以是 `CRLF`、`LF` 或 `CR`；
- 第一个冒号之前是 field name，冒号后至多移除一个空格，因此 `data:x` 和 `data: x` 都合法；
- 多个 `data` field 逐行追加 `LF`，dispatch 前移除末尾一个 `LF`；
- 冒号开头的行是 comment；
- `id` 含 NULL 时忽略；`retry` 只有全为 ASCII 数字时才接受。

来源：[WHATWG HTML Living Standard — Parsing an event stream](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream) 与 [Interpreting an event stream](https://html.spec.whatwg.org/multipage/server-sent-events.html#event-stream-interpretation)。

## 候选比较

| 候选 | 定位 | 增量与规范边界 | 内存控制 | 运行时/依赖 | 维护状态 | 对本仓库的判断 |
| --- | --- | --- | --- | --- | --- | --- |
| `eventsource-parser@3.1.0` | source-agnostic parser；callback 或单独的 TransformStream export | `feed()` 接受任意切片；源码显式保留 partial line，并处理 `LF`/`CR`/`CRLF`、跨 chunk CRLF、多行 data、comment/id/retry | `maxBufferSize` 限制 pending line + in-progress event | Node >=18；0 runtime deps；有 `test:bun` | 3.1.0 发布于 2026-05-27，最近版本专门改善大行的 O(N²) 与 buffer cap | **推荐**；边界与 passthrough 的现有 reader loop 完全匹配 |
| `parse-sse@0.1.0` | `Response`/`TransformStream` parser | 支持多行 data、id/retry、三种换行符；但源码用 `buffer.split(/\r\n|\r|\n/)`，chunk 以 `CR` 结尾、下个 chunk 以 `LF` 开头时会把两者当作两个换行，从而可能提前 dispatch | 无上限；反复 `buffer += text`，超长未换行输入也没有保护 | Node >=20；0 runtime deps；依赖 Web Streams globals | 2025-10-25 首发 0.1.0，目前只有初始化/发布两次 commit | API 简洁，但更年轻，且存在本场景关心的 chunk 边界缺口，不选 |
| `eventsource-client@1.2.0` | 完整 fetch/EventSource client，含重连、last-event-id、async iterator | 底层依赖 `eventsource-parser`，协议能力充足 | 由底层 parser 处理 | Node >=18，明确支持 Bun >=1.1.23；1 runtime dep | 2025-09-19 发布 1.2.0 | 过度：本仓库已经拿到 upstream `Response`，只需旁路解析，不能让另一个 client 接管 fetch/retry/lifecycle |
| `@microsoft/fetch-event-source@2.0.1` | 完整 fetch client + retry/page visibility；parser 是内部实现 | byte-level 增量 parser 能跨 chunk，并处理 CR/LF/CRLF、多行 data；但 `retry` 用 `parseInt`（会接受 `100x`），`id` 未按规范拒绝 NULL | partial line 会持续 concat，无 buffer cap | 0 runtime deps；面向 evergreen browser，README 还描述 Page Visibility 行为 | 包版本 2.0.1；仓库最后 commit 为 2023-02-03 | 过度且维护停滞；内部 parser 也不是本需求应依赖的稳定公共边界，不选 |

### 固定源码

- `eventsource-parser@3.1.0`：
  - [package.json](https://github.com/rexxars/eventsource-parser/blob/83db3dec52a3494e22ee7e6eb4e1349380f75e36/package.json)
  - [parser implementation](https://github.com/rexxars/eventsource-parser/blob/83db3dec52a3494e22ee7e6eb4e1349380f75e36/src/parse.ts)
  - [README / maxBufferSize / stream API](https://github.com/rexxars/eventsource-parser/blob/83db3dec52a3494e22ee7e6eb4e1349380f75e36/README.md)
  - [3.1.0 release commit](https://github.com/rexxars/eventsource-parser/commit/83db3dec52a3494e22ee7e6eb4e1349380f75e36)
- `parse-sse@0.1.0`：
  - [package.json](https://github.com/sindresorhus/parse-sse/blob/e9370e84515cd2a71fcc5d01ffd8fc5be17f2143/package.json)
  - [implementation](https://github.com/sindresorhus/parse-sse/blob/e9370e84515cd2a71fcc5d01ffd8fc5be17f2143/index.js)
  - [0.1.0 release commit](https://github.com/sindresorhus/parse-sse/commit/e9370e84515cd2a71fcc5d01ffd8fc5be17f2143)
- `eventsource-client@1.2.0`：
  - [package.json](https://github.com/rexxars/eventsource-client/blob/e8a59284f6bafad67410edb9d85f8f1af3a4f6d7/package.json)
  - [supported runtimes and client behavior](https://github.com/rexxars/eventsource-client/blob/e8a59284f6bafad67410edb9d85f8f1af3a4f6d7/README.md)
- `@microsoft/fetch-event-source@2.0.1`：
  - [package.json](https://github.com/Azure/fetch-event-source/blob/a0529492576e094374602f24d5e64b3a271b4576/package.json)
  - [internal parser](https://github.com/Azure/fetch-event-source/blob/a0529492576e094374602f24d5e64b3a271b4576/src/parse.ts)
  - [fetch/retry/Page Visibility scope](https://github.com/Azure/fetch-event-source/blob/a0529492576e094374602f24d5e64b3a271b4576/README.md)

## 建议的实现边界

### `text/event-stream`

1. 在 `@aio-proxy/server` 中把 `eventsource-parser@3.1.0` 声明为直接依赖。不要依赖 AI SDK 的间接 dependency，即便 lockfile 当前解析到同一版本。
2. 保持现有单 reader 转发循环，不使用 `Response.clone()` 或 `ReadableStream.tee()`；每个字节 chunk 仍只从 upstream 读一次并原样转发。
3. 复用一个 `TextDecoder`：每个 chunk 调用 `decode(chunk, {stream: true})`，结束时用 `decode()` flush，避免一个 UTF-8 code point 横跨 chunks 时损坏。
4. 将解码字符串 feed 给 `createParser({onEvent, onError, maxBufferSize})`。`onEvent` 只 JSON.parse `event.data` 并交给现有 protocol-specific usage normalization；`[DONE]` 直接忽略。
5. Anthropic usage 分散在 `message_start` 与 `message_delta`，继续做跨 event merge；OpenAI/Gemini 可保留最近一次有效 usage。
6. 为 parser 设置明确的 `maxBufferSize`。usage event 正常很小，超限时应禁用本次观测并继续原样转发，而不是让 parser error 伤害客户端请求。

`eventsource-parser` 的 cap 单位是 JavaScript characters，不是 response bytes；配置名和测试应该反映这一点。

### 非 SSE JSON

SSE parser 不负责普通 JSON response。按 `Content-Type`（并保留必要的协议兼容策略）选择 JSON 路径后，应：

- 设置独立的 byte cap，只在 cap 内保留 chunks；
- 一旦超过 cap，丢弃已采集 body、停止继续采集，但仍继续 passthrough；
- 流结束时仅对未超限的 body 做一次 decode/JSON parse；
- usage 观测是 best effort，不能为了记录 usage 阻塞、取消或报错客户端响应。

因此，引入 `eventsource-parser` 是必要但不充分的修复：它替代手写 SSE parser；JSON capture cap 则解决剩余的无界响应缓存问题。

## Bun / Web Streams 兼容性

Bun 官方文档展示 `fetch()` 的 `Response.body` 可直接取得 `ReadableStream` reader，且 Bun 实现了 WHATWG Streams，包括 `ReadableStream`、`TransformStream` 与 `TextDecoderStream`。不过推荐方案使用的是 `eventsource-parser` callback core，只要求字符串 feed；与现有 Bun/Web Streams 转发循环结合时依赖面更小。

来源：

- [Bun fetch：读取 Response body stream](https://github.com/oven-sh/bun/blob/588da0ef254e6184c14b76ca1cbee72b3a116ac4/docs/runtime/networking/fetch.mdx)
- [Bun SSE guide：ReadableStream response](https://github.com/oven-sh/bun/blob/588da0ef254e6184c14b76ca1cbee72b3a116ac4/docs/guides/http/sse.mdx)
- [Bun WHATWG Streams implementation](https://github.com/oven-sh/bun/blob/588da0ef254e6184c14b76ca1cbee72b3a116ac4/src/jsc/STREAMS.md)
