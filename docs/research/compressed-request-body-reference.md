# 入站压缩请求体：第一方实现调研

调研日期：2026-07-19。范围仅为三个本地、已更新的第一方仓库；框架行为只以其本地官方源码佐证。

| 仓库 | 当前 commit |
| --- | --- |
| CLIProxyAPI (CPA) | `93d74a890a44802f656d7f39a573916b2611896e` |
| claude-code-hub (CCH) | `595a7d988a91c730ed63a791b4a92acb5a0e9c41` |
| oh-my-pi (OMP) | `9fd6e97113f5ed3a847e66d346970efdf8afcad9` |

## 结论速览

| 项目 | 入站 Content-Encoding | 解压作用域 | 压缩/解压大小限制 | 解压后出站头 |
| --- | --- | --- | --- | --- |
| CPA | 仅共享 helper 支持 `zstd`；不支持 gzip/deflate/br | 只有调用 helper 的部分 OpenAI handlers；非全局 | 无通用压缩前或解压后限制 | 不是 raw HTTP 直通；执行请求只携带 body/选定 headers |
| CCH | `zstd`、`gzip`/`x-gzip`、`deflate`、`br` | `/v1`、`/v1beta` proxy 的共享 `ProxySession` | 两者默认各 100 MiB，超限 413 | 已解压则删 `content-encoding`；总是排除 `content-length` 后重算 |
| OMP | 不支持上述任一种 | 无解压层 | 原始线上 body 默认 1 MiB，超限 413 | 无模型 API raw passthrough；typed GitHub proxy 不转发客户端 CE/CL |

## 1. CLIProxyAPI

### 编码、位置与覆盖范围

CPA 不是依赖 Gin 自动解压。Gin 1.10.1 的 `Context.GetRawData()` 只是 `io.ReadAll(c.Request.Body)`，没有查看 `Content-Encoding`（本地官方 Gin 模块源码：`/Users/baran/go/pkg/mod/github.com/gin-gonic/gin@v1.10.1/context.go:906-911`）。CPA 在 `sdk/api/handlers/request_body.go:14-75` 的 `ReadRequestBody()` 之上自行处理：它读取 `Content-Encoding`，按逆序处理逗号编码链，但 switch 只有 `zstd`（以及空/`identity`）；`gzip`、`deflate`、`br` 均会产生 `unsupported request content encoding`。

若解码失败但原始字节本身是有效 JSON，CPA 容忍错误 header 而继续用原字节（`request_body.go:28-36`）；否则 handler 返回 400，例如 OpenAI Chat 的错误处理位于 `openai_handlers.go:103-115`。zstd 的端到端行为由 `openai_responses_compact_test.go:124-175` 覆盖。

这不是全局 HTTP middleware，也不是所有协议共享的 parser；它是 `sdk/api/handlers` 下的 helper，调用点仅见：

- OpenAI Chat Completions、Completions：`sdk/api/handlers/openai/openai_handlers.go:97-174`。
- OpenAI Responses 与 `/responses/compact`：`sdk/api/handlers/openai/openai_responses_handlers.go:372-417`。
- 部分 OpenAI image/video handlers：`sdk/api/handlers/openai/openai_images_handlers.go:586,873` 与 `openai_videos_handlers.go:218,230`。

路由注册确认这些入口分别覆盖 `/v1/chat/completions`、`/v1/completions`、`/v1/responses`、`/v1/responses/compact`（`internal/api/server.go:520-540`），以及 `/backend-api/codex/responses` 和 compact 别名（`server.go:550-559`）。相反，Anthropic Messages/Count Tokens 直接 `c.GetRawData()`（`sdk/api/handlers/claude/code_handlers.go:70-115`），Gemini `/v1beta/models/*action` 与 `/v1beta/interactions` 也直接 `c.GetRawData()`（`sdk/api/handlers/gemini/gemini_handlers.go:127-159`、`interactions_handlers.go:92-101`），所以都不覆盖入站 zstd，遑论 gzip/deflate/br。`/v1/alpha/search` 是独立路径，使用 `io.LimitReader`，亦无解压（`internal/api/server.go:659-670`）。

### 大小与重写

`ReadRequestBody()` 的 `c.GetRawData()` 与 zstd `io.ReadAll(decoder)` 均没有上限（`request_body.go:17-23,61-75`）。因此 CPA 对这些模型 API 路由没有同时限制压缩字节和解压字节的统一机制；`alpha/search` 的 16 MiB `LimitReader` 是单一 API 专用限制，且未检查“读取到 limit+1”来明确报告超限（`server.go:664-668`）。日志捕获的 32 MiB 上限不是入站接收限制（`internal/api/middleware/request_logging.go:23-24,146-149`）。

CPA 的模型执行对象把 body 与 headers 分开（`sdk/api/handlers/model_execution.go:28-54`），并将 handler 传进的 bytes 作为 `Payload`/`OriginalRequest`（`handlers.go:760-785`）。这是一套翻译/执行流水线，而非保留 HTTP entity 头的原始 HTTP 请求透传；因此没有与 CCH 相同的“解压后删 CE/CL”的请求重写步骤可复用。其 `header_filter.go:21-38` 中的 `Content-Length`/`Content-Encoding` 是**响应**上游 header 的过滤名单，不应误读为入站处理。

## 2. claude-code-hub

### 编码、位置与路由覆盖

CCH 在 Node runtime 中直接使用 `node:zlib`，而非依赖 Next/Hono 自动解压：`request-body-codec.ts:18-25` 导入 `zstdDecompressSync`、`gunzipSync`、`inflateSync`/`inflateRawSync` 和 `brotliDecompressSync`。支持 `zstd`、`gzip`、`x-gzip`、`deflate`、`br`（`request-body-codec.ts:72,111-135`）；`deflate` 先 zlib wrapper，失败再裸 deflate。`identity` 被忽略（`:99-105`），编码链按 HTTP 语义倒序处理（`:228-245`），但只允许一层（`:65-70,195-201`）。多层或坏压缩流分别为 400；未知编码记录告警并保留原字节/CE 给上游（`:195-218,235-244`）。

解压发生在共享 `ProxySession.fromContext()` 调用的 `parseRequestBody()`，即鉴权前，且 JSON 解析、模型选择、过滤、计费、日志与转发均使用解压后的 `requestBodyBuffer`（`src/app/v1/_lib/proxy/session.ts:235-252,1170-1262`）。这覆盖 `/v1/[...route]`：显式的 OpenAI Chat Completions 与 Responses，以及 `app.all("*")` 所接的 Anthropic Messages、其他 fallback 路由（`src/app/v1/[...route]/route.ts:39-62`）；同样覆盖 `/v1beta/[...route]`，其路由全部交给 proxy handler（`src/app/v1beta/[...route]/route.ts:18-20`），因此包含 Gemini。OpenAI image multipart 被明确排除：按原始 bytes 透传（`session.ts:1210-1232`）。

### 大小与超限行为

两个独立阈值均默认为 100 MiB：解压输出 `MAX_DECOMPRESSED_REQUEST_BYTES`，可由同名环境变量覆盖（`request-body-codec.ts:36-47`）；压缩线上输入 `MAX_COMPRESSED_REQUEST_BYTES` 默认跟随前者，也可独立覆盖（`:49-62`）。压缩输入先检查，超过 413（`:220-225`）；zlib 的 `maxOutputLength` 触发的输出上限同样转为 413（`:228-245`）。这些 proxy 路由不受 Next `proxyClientMaxBodySize` 钳制，故双限制是实际保护边界（`:36-42`）。

### raw passthrough / 重写头

共享 session 在实际解压后删除 `content-encoding`，明确说明 raw passthrough 同样发送明文（`session.ts:247-251`）。出站转发器一律将 `content-length` 放入 transport blacklist（`forwarder.ts:153-161`），由 HTTP 客户端依据实际 body 重算。故受支持编码的 raw 或重写请求都是“明文 + 无 CE + 重算 CL”；未知编码没有 decode，保留原 bytes 和 CE，但仍不转发入站 CL。`/v1/messages/count_tokens` 与 `/v1/responses/compact` 的 raw endpoint policy 不会绕过这份 session 入站处理（`endpoint-policy.ts:37-59,75-83`）。

## 3. oh-my-pi

OMP 当前可见的服务端代理是 typed GitHub REST/git 服务，而不是 OpenAI/Anthropic/Gemini 模型 API。其完整源码中 `python/robomp/src/proxy/server.py` 没有 `Content-Encoding`、gzip、zstd、deflate、br 或 decompress 的入站处理；因此不支持这些压缩编码，也没有框架自动解压的证据。

共享 `_read_body_capped()` 读取**原始** body，先验证 `Content-Length`，然后累计 stream 字节并写回 `request._body` 供后续重读（`server.py:383-417`）。它在鉴权中被调用，以原始 bytes 做 HMAC（`:419-439`），写端点随后通过 `_json_body()` 的 `request.json()` 解析（`:573-581`）。所以带压缩 CE 的 JSON 不会被解码：会先按压缩 bytes 验签，然后 JSON 解析失败并返回 400；读路由和写路由范围分别见 `:448-564` 与 `:583-825`。

该 raw-body cap 默认 1 MiB，环境变量为 `ROBOMP_GH_PROXY_MAX_BODY_BYTES`（`python/robomp/src/config.py:63-68`）。无效 Content-Length 返回 400，声明或实际累计超过 cap 返回 413（`server.py:394-414`）；测试覆盖 Content-Length 的早拒和未知/小 Content-Length 的流式超限（`python/robomp/tests/test_proxy_server.py:996-1031`）。服务不会把客户端 HTTP entity 原样转给模型上游，只有 typed GitHub 调用，故无 raw passthrough/rewrite 的 CE/CL 变换可报告。

## 对 aio-proxy 的最小直接结论

当前实现已经采用共享、有界的 JSON 入站解码：`readJsonRequest()` 在 `raw.clone()` 上先限制 encoded bytes，再按 `Content-Encoding: gzip` 或 `zstd` 解压并以同一个 8 MiB 上限限制 decoded bytes，随后才 JSON.parse（`packages/core/src/protocol/request.ts:10-34,38-69`）。所有适配器在 dispatch 前通过它解析 clone；例如 OpenAI Responses（`openai-responses.ts:12-16`）、Anthropic（`anthropic-messages.ts:28`）、OpenAI Completions（`openai-completions.ts:14`）和 Gemini（`gemini-generate-content.ts:42-48`）。

由此可得的最小结论是：

1. 共享读取路径已经正确覆盖需要 JSON 的 OpenAI Chat/Responses、Anthropic 与 Gemini；若要扩展 `deflate`/`br` 或多层编码，应继续在此 helper 增加，而不是在某条协议路由重复实现。
2. 8 MiB 的 encoded 与 decoded 双重边界已避免 CPA 式无界读取；它们目前共用同一阈值。若产品需要大图像/长上下文，应显式调整该共享上限或演进为独立阈值，而不是放宽其中一个读取步骤。
3. 重写已正确同时移除 `content-encoding` 和 `content-length`：通用 model rewrite 位于 `request.ts:77-85`，Responses 的 background/model rewrite 位于 `openai-responses.ts:55-63`。因此重写后的明文不会被上游二次解压，长度会由运行时重算。
4. same-protocol raw 即使**无需重写**，也已在 dispatch 前完成 clone 上的 JSON 解析；随后返回 `raw.clone()`，保留原始压缩 bytes 与 entity headers（Responses：`openai-responses.ts:34-37`；Gemini：`gemini-generate-content.ts:60-67`）。这维持 byte-level raw passthrough 契约，同时让路由决策可基于解压后的 JSON；不要把 raw 分支改为发送解压明文，除非产品明确改变该契约，并同时移除 CE/CL。

剩余产品决策仅是是否增加更多编码，或是否为 encoded/decoded 两个限制配置不同阈值；当前不需要按协议复制解压器。
