# 大请求容量与诊断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解除本地代理对 Codex 大图片历史及压缩请求的旧 64 MiB 阻断，并使容量、隐私省略和日志截断可诊断。

**Architecture:** 普通请求采用可配置的 256 MiB 默认容量，core 请求域通过 AsyncLocalStorage 固定每次请求的默认预算，显式媒体限制优先。预观察、解析、重写及重试共享同一预算，日志捕获独立有界；沿用现有 error mapper、trace 和 wire 日志，不新增候选循环或数据库迁移。

**Tech Stack:** Bun、TypeScript、Zod、node:async_hooks、node:zlib、Hono、OpenTelemetry、bun:test、Changesets。

**Spec:** `docs/superpowers/specs/2026-10-05-large-request-admission-design.md`。

## Global Constraints

- `server.requestBody.maxBytes` 默认 `268435456`，整数范围 `1048576..536870912`；非法配置拒绝，不支持无限值。
- `server.logging.captureMaxBytes` 默认 `67108864`，整数范围 `0..67108864`；0 仅关闭正文捕获。
- 普通请求 encoded/decoded 双检查；媒体显式限制优先，Images generations、视频保留既有 64/128 MiB 限制。
- 请求固定配置快照，热更新仅影响新请求；CLI 外层 `851048559` 已足够，不修改监听限制或 WebSocket 接线。
- 隐私探测预算保持 64 MiB；fail-closed 不变，不记录敏感正文、任意头、URL 或原生 zlib 错误。
- 日志预算按 hop/方向计，Dashboard 读侧 `1048576` code unit 限制不变；不增加前端修改或依赖。
- 非测试实现文件不超过 500 行，400 行时检查职责；测试与源码同目录，公开入口只导出，私有文件不外泄。
- `bun run preflight` 为最终验收，先 build 以供 type-aware lint 解析跨包 dist；不提交用户的 `bun.lock` 改动。
- 每个实现提交带 `Co-authored-by: Codex <noreply@openai.com>`；changeset 必须同时包含内部包与 `aio-proxy` 产品包，使用 `bun changeset`。

## Review Focus

- 大请求首次解析成功但 model rewrite/raw retry 重新读取时又被旧默认值拒绝：Task 2 覆盖。
- 并发请求及热更新互相污染容量，或作用域退出后泄漏：Tasks 1、2 覆盖。
- 明文/chunked 请求逃过解压预算或声明长度检查：Tasks 1、3 覆盖。
- 提高普通请求容量改变媒体边界或 Bun 提前拒绝合法 Images multipart：Task 2 覆盖。
- 大型无终止 SSE 帧、UTF-8 边界、敏感检查失败导致日志缓存增长或内容泄漏：Task 4 覆盖。

---

## 文件结构与公共接口

| 文件域 | 职责 |
| --- | --- |
| `packages/types/src/config/request-body.ts` | 配置 schema、共享默认/硬上限；不依赖 core |
| `packages/core/src/protocol/request/index.ts` | 保留 `./request` 的 export-only 公共入口 |
| `request/request.ts` | JSON/text 读取、model rewrite 的编排 |
| `request/stream-decoder.ts` | 有背压的流式解码器及生命周期 |
| `request/body-reader.ts` | 有界字节读取、编码解析、缓冲解码及取消 |
| `request/errors.ts` | 请求读取错误与类型化容量诊断 |
| `request/limits.ts` | 默认预算、AsyncLocalStorage、公共预算作用域 |
| `packages/server/src/routes/pipeline/request.ts` | Content-Length 校验与拒绝分类 |
| `packages/server/src/request-logging/wire/body-capture/` | export-only index、单 hop/方向字节预算实现及同目录测试 |

保留其他模块的现有导入路径。流式解码器与 body-reader 私有协作者只在 `request/` 内导入。测试移动至同名目录；现有共享 request 测试仍保持一个文件。

### Task 1: 请求容量配置与 core 读取域

**Files:**
- Create: `packages/types/src/config/request-body.ts`。
- Modify: `packages/types/src/config/config.ts`、`index.ts`、`config.test.ts`、`config-acceptance.test.ts`（更新完整运行配置预期）。
- Move/Split: `packages/core/src/protocol/request.ts`、`request.test.ts` → 上述 `request/` 文件。
- Test: `packages/core/src/protocol/request/limits.test.ts`、`request/request.test.ts`。

**Interfaces:**
- Produces: `ServerRequestBodySchema`，输出 `{ maxBytes: number }`；导出 `DEFAULT_REQUEST_BODY_MAX_BYTES = 268435456`、`MAX_REQUEST_BODY_MAX_BYTES = 536870912`，由 config barrel 导出。
- Produces: `withRequestBodyLimits<T>(limits: RequestBodyLimits, operation: () => T): T`、`currentRequestBodyLimits(): RequestBodyLimits`，经 request/core barrel 导出；复制并冻结输入，默认 `{ encoded: 268435456, decoded: 268435456 }`。
- Preserves: `readJsonRequest(raw, limits?)`、`readRequestText(raw, limits?)`、`decodedRequestStream(raw, limits?, options?)`、`rewriteJsonRequestModel(raw, modelId)` 现有调用方式。未显式传 limits 时取作用域；显式参数优先。

- [ ] **Step 1: 写有产品意义的失败测试。** 在 config 测试验证实际运行解析/authoring JSON schema 均接受 512 MiB、拒绝 0、负数、小数及 512 MiB+1；在 core 测试验证并发预算、显式参数、scope 恢复及明文 decoded 限制：

```ts
expect(ConfigSchema.parse({ providers: {} }).server.requestBody.maxBytes).toBe(268435456);
expect(ConfigSchema.safeParse({ providers: {}, server: { requestBody: { maxBytes: 536870913 } } }).success).toBe(false);
// 两个交错 await 的 scope 读取相同 64-byte JSON；32-byte 预算失败、128-byte 预算成功。
expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
expect(currentRequestBodyLimits()).toEqual({ encoded: 268435456, decoded: 268435456 });
await expect(readJsonRequest(plain64Bytes, { encoded: 128, decoded: 32 })).rejects.toBeInstanceOf(RequestBodyTooLargeError);
```

- [ ] **Step 2: 运行测试确认失败。** `bun test packages/types/src/config/config.test.ts packages/core/src/protocol/request.test.ts`。预期新配置/作用域缺失或明文 decoded 上限未生效；不接受无关 fixture 故障为预期失败。
- [ ] **Step 3: 实现 schema、按职责拆分 request 并加入预算作用域。** 默认参数在每次读取入口解析一次，不能让异步 stream pull 回到旧 scope 后重新读取默认值。保留支持的编码、deflate fallback、背压和取消行为；显式 decoded 校验也覆盖明文路径。
- [ ] **Step 4: 运行移动后的 core 测试与完整配置契约测试。** `bun test packages/types/src/config packages/core/src/protocol/request`；预期全部 PASS，包括原 gzip/zstd/br/deflate、multipart streamed decoder 行为。
- [ ] **Step 5: 提交本任务。** stage 本任务明确文件；`git commit -m "feat(core): add scoped configurable request body budgets" -m "Co-authored-by: Codex <noreply@openai.com>"`。

### Task 2: 服务器接线、重读与媒体兼容

**Files:**
- Modify: `packages/core/src/protocol/adapter/adapter.ts`（三种工厂的默认 bodyLimits）、`audio-adapter/audio-adapter.ts`、`image-adapter/image-adapter.ts`、`video-adapter/video-adapter.ts`。
- Modify: `packages/core/src/protocol/openai-image/openai-image.ts`、`packages/core/src/protocol/openai-video/openai-video.ts`（显式保留旧 generations/视频限制）。
- Modify: `packages/server/src/routes/pipeline/observation.ts`、`index.ts`、`test-support.ts`、`packages/server/src/routes/token-count/token-count.ts`。
- Test: `packages/server/src/routes/pipeline/large-request/large-request.test.ts`（新建）、`packages/server/src/routes/token-count/token-count.body.test.ts`、现有 `packages/server/src/routes/openai-images.test.ts`、`packages/cli/src/run/run.test.ts`。
- Read: `packages/server/src/runtime.ts`、`server-state/reload.ts`、`__tests__/pipeline-helpers/`；不用增加另一个 server config accessor。

**Interfaces:**
- Consumes: Task 1 的 schema、`withRequestBodyLimits`、`currentRequestBodyLimits`。
- Produces: 在现有 `withProtocolRequestObservation` 外层，以请求入口取得的 config 快照运行预算 scope；语言之外默认工厂也读 scope，显式媒体工厂不变。
- Preserves: `ProviderRouteSource.currentProviderSnapshot()` 现有接口；已有 Responses lease 使用其快照，其余请求在入口捕获一次 current snapshot，不能在重读时再取配置。

- [ ] **Step 1: 写 pipeline 集成失败测试。** 使用 `pipeline()`/rawProvider 既有 harness，将可控小预算注入 config；测试正常 Responses、显式 compact、model rewrite、503 fallback、encrypted-content retry；记录上游实际解析的末尾字段和请求头。增加一次默认配置真实 65 MiB 测试（padding + 合法 JSON，单次顺序执行），同时验证内容尾部完整，不测试单纯常量。

```ts
expect(response.status).toBe(200);
expect(upstreamBody.input.at(-1).content).toBe('TAIL');
expect(upstreamRequest.headers.get('content-encoding')).toBeNull(); // 仅 rewrite 分支
expect(primaryCalls).toBe(1);
expect(backupCalls).toBe(1);
// 无 rewrite 的同协议 raw 分支：原压缩字节和 Content-Encoding 必须完全保留。
expect(forwardedBytes).toEqual(originalEncodedBytes);
```

- [ ] **Step 2: 运行失败测试。** `bun test packages/server/src/routes/pipeline/large-request packages/server/src/routes/token-count/token-count.body.test.ts`；预期自定义较小预算未传入共享读取/重读，或旧 64 MiB preflight 拒绝。
- [ ] **Step 3: 接入固定请求 scope。** scope 必须包含预观察、parse、rawRequest、raw retry 和候选调用。token-count 使用同一机制但保留自身选择流程。媒体限制不要与普通 JSON maxBytes 取 min；明确固定 Images generations、视频原有限制，并审计 ingress 对 REQUEST_BODY_LIMITS 的引用，避免漏改显式旧媒体边界。
- [ ] **Step 4: 增加并运行热更新、媒体与真实监听行为测试。** 用 deferred provider 暂停第一请求，切换 snapshot 后发第二请求，验证各自预算；Images JSON/multipart 与音频边界沿用现有 fixtures；从真实 Bun 监听器发送声明 >128 MiB 的小型请求并由可控 app 明确响应，证明已进入 app，避免低价值 options 常量断言。`bun test packages/server/src/routes/pipeline/large-request packages/server/src/routes/token-count packages/server/src/routes/openai-images.test.ts packages/cli/src/run/run.test.ts`，预期 PASS。
- [ ] **Step 5: 提交本任务。** `git commit -m "fix(server): admit large model requests through scoped budgets" -m "Co-authored-by: Codex <noreply@openai.com>"`，只 stage 本任务文件。

### Task 3: 分类拒绝与安全容量诊断

**Files:**
- Modify: `packages/core/src/protocol/request/errors.ts`、`body-reader.ts`、`stream-decoder.ts`、`request.ts`。
- Modify: `packages/server/src/routes/pipeline/request.ts`、`request.test.ts`、`index.ts`、`logging.ts`、`packages/server/src/routes/token-count/token-count.ts`。
- Modify: `packages/server/src/request-tracing/semantic/semantic.ts`、`packages/server/src/request-logging/capture-policy/capture-policy.ts` 及其测试。
- Test: Task 1 request 测试、Task 2 large-request 测试、现有 `pipeline/debug-logging.test.ts`；避免扩大 400 行 `server-log.ts`。

**Interfaces:**
- Produces: `RequestBodyLimitDiagnostic = { stage: 'encoded' | 'decoded'; limitBytes: number; measurement: 'declared' | 'observed_lower_bound' | 'unknown'; bytes?: number }`。
- Produces: `RequestBodyTooLargeError(message?: string, diagnostic?: RequestBodyLimitDiagnostic)`，`readonly diagnostic?`；无参数调用保持兼容。
- Replaces: `hasInvalidOrOversizedContentLength` → `inspectRequestContentLength(request: Request, limits: RequestBodyLimits): { kind: 'invalid' } | { kind: 'too_large'; diagnostic: RequestBodyLimitDiagnostic } | undefined`；更新所有调用者（包含 `routes/videos/videos.ts`），不遗留旧 helper。
- Produces: 日志字段 `bodyLimitStage`、`bodyLimitBytes`、`bodyMeasurement`、`bodyBytes`、`bodyRejectReason`、`bodyContentEncoding`；trace 采用对应 `aio_proxy.request.body.*` attribute 常量。encoding 仅允许 `identity/gzip/x-gzip/zstd/deflate/br/unsupported`。

- [ ] **Step 1: 写拒绝分类与隐私作用域失败测试。** 测试非法长度 400；声明 length 上限+1、无 length chunked 上限+1、gzip/zstd decoded 超限均 413；边界恰好相等成功；敏感作用域保留固定诊断，但过滤任意头值、正文和 native error message。

```ts
expect(invalidResponse.status).toBe(400);
expect(encodedResponse.status).toBe(413);
expect(rejected.bodyLimitStage).toBe('encoded');
expect(rejected.bodyMeasurement).toBe('observed_lower_bound');
expect(rejected.bodyBytes).toBeGreaterThan(rejected.bodyLimitBytes);
expect(decodedRejected.bodyLimitStage).toBe('decoded');
expect(decodedRejected.bodyMeasurement).toBe('unknown');
expect(decodedRejected.bodyBytes).toBeUndefined();
expect(JSON.stringify(sensitiveLogs)).not.toContain('private-input');
```

- [ ] **Step 2: 运行确认失败。** `bun test packages/core/src/protocol/request packages/server/src/routes/pipeline/request.test.ts packages/server/src/routes/pipeline/large-request packages/server/src/request-logging/capture-policy`；预期当前无诊断字段或非法 length 被当 413。
- [ ] **Step 3: 实现诊断和现有 trace/log 接线。** 字节读溢出提供已观察下界；原生 `maxOutputLength` 失败标记 decoded/unknown；用 mapper 保持各协议 envelope，不复制 zlib message。固定枚举显式加入敏感 allowlist，数字经 finite 检查；拒绝入口 log 与 root span 一致。
- [ ] **Step 4: 验证全部调用点。** `rg 'hasInvalidOrOversizedContentLength' packages` 应无实现/调用残留；`bun test packages/core/src/protocol/request packages/server/src/routes/pipeline packages/server/src/routes/token-count packages/server/src/routes/videos packages/server/src/request-logging/capture-policy` 应 PASS。视频现有不同错误 envelope 保持原协议契约。
- [ ] **Step 5: 提交本任务。** `git commit -m "fix(server): report request body rejection stages safely" -m "Co-authored-by: Codex <noreply@openai.com>"`。

### Task 4: 有界日志捕获、wire 诊断与交付

**Files:**
- Modify: `packages/types/src/config/config.ts`（ServerLoggingSchema）、`config.test.ts`、`packages/types/src/trace.ts`。
- Create: `packages/server/src/request-logging/wire/body-capture/index.ts`、`body-capture.ts`、`body-capture.test.ts`（三者均位于该目录；index 只导出）。
- Modify: `packages/server/src/request-logging/context/context.ts`、`wire/wire.ts`、`body-tap/body-tap.ts` 及各自现有测试。
- Modify: `packages/server/src/routes/pipeline/observation.ts`、`packages/server/src/server-state/lifecycle.ts`、`packages/server/src/runtime.ts`。
- Modify: `packages/server/src/dashboard-routes/traces/wire-log/build-hops.ts` 及现有 wire-log 测试。
- Modify: `website/docs/en/guide/configuration/server.md`、`website/docs/zh/guide/configuration/server.md`、`website/docs/zh/guide/reference/troubleshooting.md`。
- Create/Update: 与本任务对应的 `.changeset/*.md`；检查已有未发布相关 note，修正有冲突的叙述。

**Interfaces:**
- Produces: `BodyCaptureReason = 'privacy_policy' | 'media_payload' | 'capture_limit'`；`RequestLogScope.captureMaxBytes?: number`、`omissionReason?: BodyCaptureReason`，嵌套 scope 默认继承父预算及隐私禁令。
- Produces: `createBodyCapture(maxBytes: number): { write(chunk: Uint8Array): string; finish(): string; readonly truncated: boolean; readonly capturedBytes: number }`；input byteLength 为捕获度量，UTF-8 安全前缀，禁止保存完整大 chunk 副本。
- Produces: terminal/wire body 可选字段 `truncated`、`captureLimitBytes`、`omissionReason`；原 `byteLength` 为全部观察字节，旧事件无新字段可正常读取。
- Consumes: 现有 `preObservationCapturePolicy` 的 boolean privacy 结果；false 映射固定 `privacy_policy`。隐私 probe 使用独立常量 `67108864`，不取配置入站 maxBytes 或日志 captureMaxBytes。

- [ ] **Step 1: 写 budget 与转发行为失败测试。** 用 16-byte 日志预算和含 emoji 的 128-byte 正文，检查上游完整内容、日志前缀合法 UTF-8、terminal 原始 byteLength/truncated；0 budget 不落正文、转发成功；超大未终止 SSE 帧不累积日志且 usage/SSE observers 正常；敏感/压缩无法检查时没有正文。

```ts
expect(forwardedBytes).toEqual(originalBytes);
expect(capture.capturedBytes).toBeLessThanOrEqual(16);
expect(capturedText).not.toContain('\uFFFD');
expect(terminal).toMatchObject({ byteLength: 128, truncated: true, captureLimitBytes: 16 });
expect(zeroBudgetChunks).toHaveLength(0);
expect(zeroBudgetTerminal.omissionReason).toBe('capture_limit');
expect(sensitiveTerminal.omissionReason).toBe('privacy_policy');
expect(JSON.stringify(sensitiveEvents)).not.toContain('private-input');
```

- [ ] **Step 2: 运行确认失败。** `bun test packages/server/src/request-logging packages/server/src/routes/pipeline/debug-logging.test.ts`；预期现有正文捕获未应用预算。现有 debug payload 小于默认预算的测试继续成功。
- [ ] **Step 3: 实现捕获预算及终态传播。** body tap 在 source byte chunk 层为 diagnostics 提供有界前缀，业务 sourceRead/SSE/usage 观察处理全量；日志 SSE 专用缓存满预算后清空并停止追加。每 hop/方向建独立 capture；重用现有事件 sequence，终态只发一次，不为日志主动消费请求。保留隐私 fail-closed，不扩大 probe，日志不再与容量接收混用。
- [ ] **Step 4: 验证 wire 后端和旧日志兼容。** `bun test packages/types/src/config packages/server/src/request-logging packages/server/src/dashboard-routes/traces/wire-log packages/server/src/routes/pipeline/debug-logging.test.ts packages/server/src/routes/token-count/token-count-debug-logging.test.ts`；断言接口 schema 接受新增可选字段，旧事件可重建，取消/读取异常只一个 terminal，预期 PASS。
- [ ] **Step 5: 写文档和 changeset。** 给出 `server.requestBody.maxBytes: 268435456`、`server.logging.captureMaxBytes: 67108864` 示例，说明热更新、媒体专用限制、内存多倍占用及上游未知容量。用 `bun changeset` 创建 patch note，包含 `aio-proxy`、`@aio-proxy/core`、`@aio-proxy/server`、`@aio-proxy/types`（以实际变更为准）；note 一段 ≤5 行，描述大图片历史与压缩恢复，不叙述排查过程。
- [ ] **Step 6: 执行整体验证。** `bun run build` 后 `bun run preflight`；预期 type-aware lint、format、全部测试 PASS。使用单次 65 MiB 样例记录实际请求字节与最高 RSS；不将 token 或历史文件大小报告成 wire 大小，不做未授权真实上游重放。
- [ ] **Step 7: 提交并交付。** `git commit -m "fix(server): bound payload logging independently of admission" -m "Co-authored-by: Codex <noreply@openai.com>"`；不 stage `bun.lock`。报告测试结果、配置默认值及尚未完成的正式环境升级/原会话手动压缩验收；实施完成不等于上游成功。

## 自审与执行交接

- spec 的容量、作用域、媒体例外、拒绝分类、隐私、日志 budget 和旧 wire 契约分别落实到 Tasks 1–4；五类 Review Focus 均有对应测试。
- 公共 types/core/server 接口在每项 Interfaces 中固定；request 拆分保持外部路径，所有 private collaborators 留在目录内部。
- 不扩大前端、SDK、数据库或 CLI 监听容量范围；Bun 外层已经覆盖本设计上限，配置提高无需新增重启要求。
- 推荐原生执行：四项任务共享请求 scope、诊断与日志事件接口，顺序实现更容易保持一致；实施前读取本 spec 与本计划。
- 本轮只交付方案文档，未修改运行实现、部署、重放请求或原 Codex 会话。用户已经明确要求提供方案而不提问题，因此本次交付不追加执行方式选择问题。
