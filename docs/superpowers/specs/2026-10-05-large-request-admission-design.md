# 大请求容量与诊断设计

## 问题与证据

本地 0.39.0 的 trace `741c75edbb86fc39debe301c44edea52` 在解析前返回 413，没有调用上游。Codex 会话 `01a10654-1747-7e92-9938-23e339ce9a28` 的最后一次压缩后历史包含 68 张图片，内嵌 Base64 合计约 64.89 MiB；历史 JSON 约 65.47 MiB。它不是实际 HTTP 请求大小的测量。客户端最后的操作是手动压缩，其请求仍被本地限制拒绝，导致会话无法通过压缩恢复。

2026-10-05 已 fetch 并核对以下远端版本：

| 项目 | commit | 相关行为 |
| --- | --- | --- |
| CLIProxyAPI | `8ef43e4df3b216a42493105d31c2873b69191473` | `ReadRequestBody` 没有显式通用大小上限；部分错误日志捕获限制为 32 MiB |
| new-api | `1a4166d8e8ba9802d2ca56fe8ecf0ed5404e80d5` | `MAX_REQUEST_BODY_MB` 默认 128；压缩请求检查解压后大小；支持磁盘缓存 |
| Magpie | `b45b410b0c920597c62f3a6e1dc13eaa2a6b5ae0` | 最新请求读取默认限制 128 MiB；有超过旧 64 MiB 的回归测试；日志正文独立限制 256 KiB |
| OpenCodex | `06841165f884a9176d701310638b2112aca7a514` | 默认入站限制 256 MiB，可配置到 512 MiB；明确记录压缩请求被容量限制阻断的问题 |

来源：各仓库 `.reference/` 中对应远端提交的 `request_body.go`、`middleware/gzip.go`、`request_bounds.go`、`request-decompress.ts`。这些限制是代理容量策略，不是 Codex 上游容量承诺。

## 容量契约

- 新增 `server.requestBody.maxBytes`，默认 `268435456`（256 MiB），接受 `1048576..536870912`（1..512 MiB）的整数。非法值拒绝配置，不静默 clamp，也不以 0 表示无限。
- 普通 JSON 入站请求的传输体与解压体分别检查，同用配置中的 `maxBytes`；直接调用 core 且无服务器上下文时使用 256 MiB 默认值。
- 明文请求同时受 encoded 与 decoded 限制，不能因为未解压而跳过 decoded 检查。
- 适配器明确声明的媒体限制仍优先：Images JSON edits `357564416`、multipart edits `851048559`、音频及视频各自的专用限制不被普通 JSON 配置缩小或放宽。Images generations、视频现有依赖默认常量的 64/128 MiB 限制需显式保留，不能随默认常量变化。
- 请求开始时固定配置快照；后续重读、model rewrite、raw fallback、Responses retry 使用同一个默认容量。并发请求和热更新不互相修改容量。
- 配置热更新影响新请求，已经开始的请求保留旧值。
- 当前 CLI `MAX_REQUEST_BODY_SIZE = EDITS_MULTIPART_ENCODED_LIMIT`，为 `851048559`，高于配置硬上限 512 MiB；不修改此值，不新增重启要求。保持合法媒体请求和 WebSocket 的既有行为。

## 传播方式与文件边界

在 core 的请求读取域增加 `AsyncLocalStorage<RequestBodyLimits>`，提供 `withRequestBodyLimits<T>(limits, operation): T` 与 `currentRequestBodyLimits(): RequestBodyLimits`。其作用仅为请求级的默认读取预算；不保存请求正文或 Provider 状态。服务器在进入预观察及解析前建立作用域；普通适配器与共享读取函数取作用域默认值，显式参数及媒体适配器仍使用自己的限制。

这是为了覆盖已有 clone、rewrite 和 raw retry 调用链，避免只放宽首次 parse 而重读仍使用旧默认值。保持协议适配器 stateless、共享 pipeline 唯一候选循环，不新增全局可变默认值，也不逐协议复制解码器。

`packages/core/src/protocol/request.ts` 已有 498 行，实施时按职责拆成 `request/`，保留 export-only `index.ts` 和原外部导入路径；流式解码、字节读取、错误定义各自独立。测试移动到同目录，不新建 `_test/`。

## 超限与错误诊断

- 合法声明长度超过上限：413，`request_too_large`，`bodyLimitStage: encoded`，测量类型 `declared`。
- 已读字节超过传输上限：413，encoded，测量类型 `observed_lower_bound`，不声称已读取完整长度。
- 解压输出超限：413，decoded；原生解码器不能提供大小时仅记录上限及 `measurement: unknown`，不补造字节数。
- 非法 Content-Length：400，`invalid_request`，固定 `bodyRejectReason: invalid_content_length`；不打印原始头值。
- 错误类保留 `new RequestBodyTooLargeError('Request body too large')` 兼容构造方式，增加可选类型化诊断字段；不向客户端暴露原生 zlib 错误。
- 日志及 trace 属性保存阶段、上限、测量类型、已知字节数和规范化的 Content-Encoding。敏感作用域只放行这些固定枚举和有限数字，继续过滤正文、任意请求头和 URL。
- 使用现有协议 error mapper 返回 JSON 错误形状；保持客户端 `request_too_large` 代码，不增加数据库表或迁移。

## 日志捕获与接收分离

- 新增 `server.logging.captureMaxBytes`，默认 `67108864`（64 MiB），接受 `0..67108864` 的整数；0 只关闭正文捕获，不关闭请求诊断或转发。
- 这是每 hop、每方向的正文日志预算；不改变日志开关、级别、保留天数或 Dashboard wire 读侧现有 1,048,576 UTF-16 code unit 预算。
- 达到预算后停止落正文 chunk，但继续完整转发、计数及终态记录。记录 `truncated: true`、`captureLimitBytes`、最终观察到的 `byteLength`；不得为了补齐日志额外 drain/cancel 客户端正文。
- 在 body tap 的输入字节边界截取日志前缀，不拆 UTF-8 字符，不在大型未终止 SSE 帧中无限积累日志缓存；业务 SSE 统计与 usage 观察不随日志截断停止。
- `omissionReason` 只使用 `privacy_policy`、`media_payload`、`capture_limit`。隐私检查不能完成也归入 `privacy_policy`，不能声称已识别出 Guardian。
- 预观察隐私检查保持独立的 64 MiB 检查预算，不因入站容量提高到 256/512 MiB 而读取更大的隐私探测正文；不能读取或确定时保持现有 fail-closed 策略。
- Dashboard wire 后端响应可以携带上述可选字段，旧日志继续可读。本次不改前端组件，不强制将完整大请求落盘。

## 验收与范围

1. 默认配置允许完整处理超过旧 64 MiB 的 Responses 请求和手动压缩请求，且上游收到末尾标记。
2. 小预算测试验证编码、解码、明文、chunked、声明长度及非法长度的边界；一个 65 MiB 真实载荷验证默认接线。
3. 并发请求、配置热更新、raw 重写及 fallback 不遗漏或串用限制；媒体专用限制不回退。
4. 截断/省略日志不改变转发字节、usage、SSE 终态；敏感内容不泄漏。
5. `bun run preflight` 通过；本地正式版本更新及原会话手动压缩属于后续运行验收，需实际验证上游接受，不能由单元测试代替。

不在本次增加磁盘 spool、进程级 admission 队列、上游容量猜测、自动删除会话历史、公开 API 限制探测或 Dashboard 配置 UI。保留用户现有 `bun.lock` 改动。历史 2026-07-19 spec 记录旧容量决策，不修改其历史叙述；本设计替代该默认容量及不可配置的限制。
