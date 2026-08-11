# Cursor OAuth Plugin 设计

日期：2026-07-31  
状态：草案

## 背景

aio-proxy 已用 built-in plugin 承载 GitHub Copilot、OpenAI ChatGPT、Google Antigravity、Kimi Code 和 xAI Grok 的 OAuth provider，统一走 `packages/plugin-sdk` 的 `OAuthAdapter` seam：登录、TTL model catalog、credential refresh port、ProviderV4 model capability、可选 raw/quota。本设计评估以相同 seam 承载 Cursor 账号，并给出可行性判断与分阶段实现方案。

参考实现为 `.reference/oh-my-pi`（OMP）：

- OAuth：`packages/ai/src/registry/oauth/cursor.ts`（PKCE + 轮询 + JWT 过期解析 + refresh）。
- Runtime：`packages/ai/src/providers/cursor.ts`（约 2900 行，Connect-RPC over HTTP/2 + protobuf 双向流），配套生成代码 `packages/catalog/src/discovery/cursor-gen/agent_pb.ts`（约 15000 行）。
- 模型发现：`packages/catalog/src/discovery/cursor.ts`（`GetUsableModels`，同样 HTTP/2 + protobuf）。

公开文档没有给出 Cursor 的 OAuth wire contract 或 agent protocol，因此 endpoint、header 和 protobuf schema 以 OMP 的一致实现为唯一依据。Cursor 无第三方 API key，也没有 `@ai-sdk/cursor`，与已有插件（都在包装某个 `@ai-sdk/*`）存在结构性差异。

## 可行性结论

分两层，风险差距极大：

- **OAuth 登录 + refresh（低风险，独立可实现）**：PKCE + 轮询 + JWT 过期，纯 `fetch`/JSON，无额外运行时依赖。唯一 seam 缺口是 Cursor 无 user code、无 loopback：现有 `presentDeviceCode` 要求非空 `userCode`，`loopback` 需要本地回调 server，两者都不匹配 Cursor 的“打开 URL 后由插件自行轮询”模型。
- **Runtime（高风险，工作量大）**：必须手写一个 `LanguageModelV4`，自行实现 Connect 帧、protobuf 编解码和 HTTP/2 双向读写循环；`raw` passthrough 不可能（协议不在 `ProtocolId` 枚举内，且是双向流而非一问一答）。即使代理不执行任何工具，握手与内建工具应答循环仍不可省略。

结论：可行，但 runtime 成本远高于任何现有插件，应作为独立第二阶段，并在产品上明确接受“Cursor 内建工具不可用导致编码类任务降级”的取舍。

## 目标

- 新增 built-in `@aio-proxy/plugin-cursor`，登录后可作为 model-first routing provider 使用。
- 阶段一：实现 Cursor PKCE 登录、JWT 过期解析和 refresh token 轮换，credential 交由宿主 vault 管理。
- 阶段二：动态发现 Cursor 可用模型；手写 `LanguageModelV4`，通过 Connect/HTTP2/protobuf 调用 `AgentService/Run`，支持文本、thinking 与 B 类（MCP/函数调用）工具的双向流。
- 保持现有 model-first routing、Provider weight、candidate fallback、usage capture 和 request recording 不变。
- 多轮会话：插件持有一份有界（lru-cache）的按逻辑会话键状态 + blob 存储承载 `conversationState`；session affinity 仅用于尽量把同一逻辑会话命中同一 Cursor provider（affinity 只重排序、不提供存储）。

## 非目标

- 不支持 Cursor API key 或自定义 base URL；本插件只面向 Cursor 账号 OAuth。
- 不提供 raw passthrough：Cursor 协议不在 `ProtocolId` 枚举内，且为双向流，无法以现有 raw transport 表达。
- 不实现 A 类内建工具（文件/命令类：`read/write/delete/ls/grep/shell/diagnostics`；`todo` 走 interactionUpdate，`lsp` 归 diagnostics）：代理无文件系统与 shell，按 exec case 分别回以协议合法的 reject/error/empty/ack（见「两类工具」）。
- 不实现 images、embedding、speech、reranking capability。
- 不抽取通用双向流/Connect 框架，也不改动其他插件行为。
- 不复制 OMP 的 composer session、native search、media 等编码 agent 专属补丁；仅在 aio-proxy 出现真实失败用例后再评估。
- 心跳需区分**出站 `clientHeartbeat` 保活**与**入站空闲看门狗**两件不同的东西：入站看门狗可先不做；但出站 heartbeat 对 Cursor 长流是否必需**未证实**（若服务端依赖周期性保活，丢弃会让长生成中途断流），阶段二须先验证，未证实前保留出站 heartbeat，不随上一条一并丢弃。
- 不实现 `x-cursor-checksum`（Jyh cipher）：逆向、随时变、ToS 风险高，且 peer 证据显示非必需——**OMP 与 opencodex 均不发送该 header**（OMP run `cursor.ts` 与 discovery `cursor.ts` 的 header 仅 `x-ghost-mode`/`x-cursor-client-version`/`x-cursor-client-type` 等身份项，无 checksum），`resource_exhausted` 主要是服务端限流（官方 IDE 在有额度时也复现）。
- 阶段一不引入 protobuf 依赖；protobuf 只在阶段二 runtime 引入。

## 核心决策

| 决策点             | 结论                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Plugin package     | `@aio-proxy/plugin-cursor`                                                                |
| Capability ID      | `default`                                                                                 |
| 登录方式           | PKCE + 轮询（无 user code、无 loopback）                                                  |
| 登录 URL           | `https://cursor.com/loginDeepControl?challenge=&uuid=&mode=login&redirectTarget=cli`     |
| 轮询 endpoint      | `GET https://api2.cursor.sh/auth/poll?uuid=&verifier=`（1s→10s 退避，×1.2，上限 150 次） |
| Refresh endpoint   | `POST https://api2.cursor.sh/auth/exchange_user_api_key`（`Authorization: Bearer <refresh>`，body `{}`） |
| 过期时间           | 解析 access token JWT `exp`，提前 5 分钟；无法解析时回退 now + 1 小时                     |
| 登录呈现 seam      | 新增 `authorizeUrl`（仅 URL、无 code）presentation 状态（见「seam 缺口」）                |
| 模型发现           | `GetUsableModels`（HTTP/2 + protobuf），TTL 6 小时；首次失败用 OMP curated snapshot 兜底 |
| 推理 endpoint      | `POST https://api2.cursor.sh` path `/agent.v1.AgentService/Run`                          |
| Runtime capability | 手写 ProviderV4 `languageModel`，不提供 raw/embedding/image                              |
| A 类内建工具       | 按 exec case 分别应答（reject/error/empty/ack，协议合法）；抑制合成 tool-call 块         |
| B 类工具名冲突     | 保留名前缀 `aio_proxy__`，用纯确定函数双向映射（见第 6 节）                              |
| 多轮会话           | `conversationState` 有状态 → 插件有界存储（lru-cache）承载；affinity 仅尽力命中同 provider |
| Provider ID 建议   | `cursor-<access-token-JWT-sub-sha256-prefix>`（稳定身份）；不持久化或展示 token 原文     |

## 阶段一：OAuth 登录与 refresh

### seam 缺口与决策

Cursor 登录不产生 user code，也不用本地回调：客户端打开一个带 `challenge`/`uuid` 的 URL，随后用 `uuid`+`verifier` 轮询 `auth/poll`。现有 `AuthorizationPort` 只有两条路径，都不契合：

- `presentDeviceCode` 要求非空 `userCode`（`DeviceCodePresentation` 与 dashboard `device_code` 状态 `userCode: z.string().min(1)`）。塞占位 code 会在 CLI 与 Dashboard 显示误导性的“输入代码”。
- `loopback` 要求插件提供 `authorizationUrl(redirectUri)` 并由宿主起本地 server 收 `code`。Cursor 不回调本地端口，用不上。

决策：新增一个「仅展示 URL、由插件自行轮询」的 presentation 状态，命名 `authorizeUrl`。触及 5 处，但每处都很薄：

1. `packages/plugin-sdk/src/oauth.ts`：`AuthorizationPort` 增加 `presentAuthorizeUrl({ url, instructions? }): Promise<void>`。
2. `packages/types/src/dashboard-oauth.ts`：`DashboardOAuthSession` 增加 `status: 'authorize_url'` 变体（`url: z.url()`，`instructions?` 用 `DashboardLocalizedTextSchema`，与 device_code 一致），无 `userCode`。
3. `packages/server/src/oauth-login-session/authorization.ts`：实现 `presentAuthorizeUrl`，publish `authorize_url` 会话。
4. `packages/cli/src/plugin-commands/authorization.ts`：实现 `presentAuthorizeUrl`（打开浏览器 + 打印 URL，不打印 code）。
5. `packages/dashboard/src/modules/providers/`：`services/oauth-service.ts` 的 `refetchInterval` 继续轮询谓词**必须**加入 `authorize_url`（否则等待授权期间停止轮询、永远刷不到 `succeeded`——功能性中断，不只是缺 UI）；`components/oauth-authorization-panel.tsx` 增加该状态分支与取消按钮；新增 i18n 文案。

Dashboard 前端为 `authorize_url` 状态渲染“打开链接并等待授权”，无 code 输入框（详见第 5 处）。轮询循环仍在插件内（与 kimi/xai 相同），宿主只负责展示 URL 与传递 `signal`。

（备选：塞占位 `userCode` 走现有 `device_code` 状态，零 seam 改动，但用户界面上会出现无意义的 code，产品体验较差。默认采用新状态方案；若要求最小改动可回退到占位方案。）

### 登录流程

1. 生成 PKCE `verifier`/`challenge` 与随机 `uuid`；构造登录 URL 并通过 `context.authorization.presentAuthorizeUrl({ url })` 展示。
2. 立即开始轮询 `GET https://api2.cursor.sh/auth/poll?uuid=&verifier=`：
   - HTTP 404：尚未完成，按退避（`delay = min(delay * 1.2, 10s)`，初值 1s）继续。
   - HTTP 2xx：解析 `{ accessToken, refreshToken }`，成功返回。
   - 其他状态：计入连续错误；连续错误达 3 次即失败（对齐 OMP）。
   - 达到最大轮询次数（150）以 timeout 失败；`context.signal` 在请求与等待期间均可中止。
3. 从 access token JWT 解析 `exp` 得到 `expiresAt = exp*1000 - 5 分钟`；无法解析回退 now + 1 小时。**5 分钟提前量只在此一处施加**，刷新门槛用 `<= now`（不可存时与门槛两处都扣，否则实际提前 10 分钟刷新）。

credential 保存：

```ts
type CursorCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
};
```

登录 fingerprint 取 access token JWT `sub`（稳定身份）的 SHA-256；`suggestedKey` 取 `cursor-` 加前 12 位 hex；不把 token 放入 Provider ID、label、日志或诊断。**不用 refresh token 派生指纹**——refresh token 会轮换（见下），用它会导致同账号再次登录算出不同指纹、被当新 provider、破坏去重。可从 JWT 额外取 `email`（小写）辅助展示。Cursor 无稳定 userinfo endpoint，label 固定为 `Cursor`。

### Refresh

runtime/catalog 每次请求前读取 credential；`expiresAt <= now` 时通过宿主 `CredentialPort.refresh()` 执行（`expiresAt` 已含 5 分钟提前量，见登录流程第 3 步）：

```text
POST https://api2.cursor.sh/auth/exchange_user_api_key
Authorization: Bearer <current-refresh-token>
Content-Type: application/json

{}
```

响应含新 `accessToken`（与可选 `refreshToken`）。服务端未轮换 refresh token 时保留旧值；返回新值则原子替换。错误分类沿用现有约定：401/403 与 `invalid_grant` non-retryable，network/408/429/5xx retryable，畸形响应 non-retryable。并发刷新、revision CAS、single-flight 由宿主负责。

## 阶段二：Runtime

### 不可回避的运行时成本

即便代理不执行任何工具，以下都必须实现：

- Connect-over-HTTP/2 双向读写循环：请求 `POST https://api2.cursor.sh` path `/agent.v1.AgentService/Run`；需手写 5 字节 Connect 帧。run 与 discovery 两端 content-type **不同**：run 用 `application/connect+proto`（streaming），discovery 用 `application/proto`（unary，见「模型发现」）。HTTP/1.1 会被拒（464，明证在 discovery 路径，run 为同源外推）。
- 请求 header（run，完整清单）：`content-type: application/connect+proto`、`connect-protocol-version: 1`、`te: trailers`（读 `grpc-status`/`grpc-message` trailer 的前提）、`authorization: Bearer <access>`、`x-ghost-mode: true`、`x-cursor-client-type: cli`、`x-cursor-client-version: <cli 版本串>`、`x-request-id: <uuid>`。client-version 是**明文常量**（非 secret），选定一个版本；服务端是否 gate 该版本为**未证实**。
- 握手：服务端先发 `requestContextArgs`，插件回 `requestContextResult`。工具在此通道上报（`requestContext.tools`），**不在** `AgentRunRequest` 里（OMP 注释：Tools are sent later via requestContext）。「握手必需」成立；「否则不产出内容」为**未证实**推断（OMP/opencodex 均恒应答，无反例）。
- 内建工具应答：服务端通过同一 h2 流发 exec 请求（`ExecServerMessage` 的 oneof，按 protobuf case 而非 name 路由），插件必须逐条应答。
- protobuf 编解码：用 `@bufbuild/protobuf`（protobuf-es，**非 gRPC、非 protobufjs**）。走真正的代码生成（vendored `.proto` + `protoc-gen-es`）或整份 vendored 生成文件并标注为 generated 以获 300 行豁免；**不手工裁子集**（手裁属非生成文件，受行数上限约束且易与 wire 漂移）。需说明复制来源的 provenance/许可。opencodex 采用 `src/adapters/cursor/gen/agent_pb.ts`（生成物单独目录）可参考。

因此不存在“轻量转发”路径：`raw` 不可行，必须手写 `LanguageModelV4`（precedent：`packages/plugins/google-antigravity/src/runtime/provider.ts` 已手写 ProviderV4 + LanguageModelV4）。

### 两类工具

**A 类（内建 agent 工具）**：文件/命令类 `read/write/delete/ls/grep/shell/diagnostics`（`todo` 不走 exec，是 `interactionUpdate` 的 `updateTodosToolCall`；`lsp` 不是独立 case，映射到 `diagnosticsArgs`）。OMP 常量 `CURSOR_NATIVE_TOOL_NAMES` 恰为 8 个。由服务端在同一 h2 流上发起 exec 请求，**无法通过请求或 proto 字段关闭**。

决策：**按 exec case 分别应答**（协议合法），而非统一一个 `rejected`——exec switch 是异构的，各 case 用各自的 result schema，统一发 `rejected` 会 protobuf 类型不匹配：

- `read/ls/grep/write/delete/shell/diagnostics`：无 handler → `rejected`。
- `fetch/backgroundShellSpawn/writeShellStdin`：`error: "Not implemented"`。
- `listMcpResources/readMcpResource/recordScreen/computerUse`：空结果。
- `default`（未知 case）：裸 ack（仅 id+execId，防服务端挂起）。

并**抑制合成的 tool-call 块**：OMP 每个 exec 分支会先 `synthesizeCursorExecToolCall` 往输出合成一个 tool-call（为编码 agent 转录保真）。aio-proxy 必须在插件出口抑制，不落入 AI SDK 输出 parts——否则会作为 caller 从未声明的 `read/bash` 等工具调用泄漏进响应，多数客户端报错。语义代价：Cursor 模型期望这些工具存在，编码类任务会降级；纯问答不受影响。此取舍写入验收说明。（未来若要「受控开放」本地 exec，可参考 opencodex `nativeLocalExec: off|on` 的 config gate、默认 off/fail-closed；本设计不做。）

**B 类（MCP/普通函数调用工具）**：调用方声明的工具，经握手 `requestContext.tools` 上报（名字经 `toWireName`）。**不能声称「正常透传」**：Cursor 的客户端工具结果要求在同一条仍开着的 h2 流上同步回 `mcpResult`（终止性），而无状态代理把 `function_call` 交回下游 caller 后本轮流即关闭，结果要到下一次入站请求才来——turn 内没有可回的结果。采用**无状态 history 延续**（opencodex `devlog/363` 已验证）：

1. Run#1 从 `mcpArgs` 发出 Responses `function_call` 后**诚实挂起**：关流，**不回写**任何假的空 `mcpResult`（回假 ack 会让 Cursor 以为工具成功、提前结束）。
2. 即使输出含 `function_call` 也**保住真实 Cursor `conversationId`**（另用 `checkpointUsable=false` 标记 checkpoint 不可复用，但 conversation 句柄要留）。
3. 下一轮只带工具结果时，对 Cursor 发 `ResumeAction`（而非空 UserMessage），并显式维护 `call_id ↔ toolCallId` 映射重建历史。

（原生「同流回带」——保持 h2 流开着等 caller 回结果再注入 `mcpResult`，即 opencode-cursor `ActiveBridge` 有状态桥——更高保真但需长驻状态，本设计**不做**，列为可选后续。）

### B 类工具名冲突（确定式映射，非映射表）

OMP `buildMcpToolDefinitions` 会静默丢弃名字命中 `CURSOR_NATIVE_TOOL_NAMES` 的调用方工具（`tools.filter(t => !CURSOR_NATIVE_TOOL_NAMES.has(t.name))`）。因此调用方若有名为 `read` 的工具，会被 Cursor 吞掉。

处理：上报前给命中保留集的工具名加前缀 `aio_proxy__`，回程再去前缀。采用**纯确定函数**，不维护 per-request 映射表（评审反馈：映射表属过度设计）：

```ts
// 保留集 = CURSOR_NATIVE_TOOL_NAMES
const PREFIX = 'aio_proxy__';

// 出站（上报给 Cursor 前）
const toWireName = (name: string): string =>
  RESERVED.has(name) ? PREFIX + name : name;

// 入站（Cursor 回程工具调用还原为调用方名字）
const fromWireName = (name: string): string =>
  name.startsWith(PREFIX) && RESERVED.has(name.slice(PREFIX.length))
    ? name.slice(PREFIX.length)
    : name;
```

要点：

- 双向、无状态、可单测；只在插件内部转换，用户侧声明与回程看到的都是原名 `read`。
- 必须应用于所有出/入路径，包括多轮 `conversationState`（OMP `buildConversationTurns`）里的历史工具调用/结果。
- `toolCallId`/`callId` 原样透传：配对靠 ID 而非名字。
- 匹配为大小写敏感精确匹配。
- 已知取舍（文档化）：若调用方真的把工具命名为 `aio_proxy__read`，`fromWireName` 会误还原为 `read`。接受该理论边界，不为它引入状态表。

### 模型发现

catalog policy TTL 6 小时，通过 `GetUsableModels`（HTTP/2 + protobuf；unary `application/proto`，与推理的 streaming 帧格式不同，勿混用）发现账号可用模型；只接受非空 string model id。首次发现失败（network/timeout/408/429/5xx/无法解析）时用 curated snapshot（源自 `getBundledModels("cursor")`）作首次兜底；401/403 或合法空目录不兜底，避免宣称不存在的访问权。后续失败由宿主 last-known-good 承担。

**错误模型要求（净新增）**：discover 必须**分类并向上传播 HTTP 状态/错误类型**，不能照搬 OMP 的塌缩式 `null`（OMP 对任何失败一律返回 `null`、非 2xx 在 transport 内被吞，seam 处无法区分 401/500/timeout，`initialFallback(error)` 拿不到状态就无法执行「401/403 不兜底」规则）。curated fallback 亦是 aio-proxy 净新增行为（OMP 不做失败兜底）。

### Runtime 结构

`createRuntime` 返回 `OAuthRuntimeResult`，仅 `provider`（ProviderV4，`languageModel` 手写，`embeddingModel`/`imageModel` 抛 unsupported）。`languageModel(modelId)` 的 `doStream` 负责：建立 h2 流 → 发送 `AgentRunRequest`（当前 turn + `conversationState` 历史；B 类工具经握手 `requestContext.tools` 上报，名字经 `toWireName`）→ 读循环分派 `interactionUpdate`（文本/thinking/toolCall，工具名经 `fromWireName`）、`execServerMessage`（握手回 context；A 类 exec 按 case 分别应答并抑制合成块；B 类 `mcpArgs` 发出 `function_call` 后诚实挂起）、`conversationCheckpointUpdate`（回收新的 `conversationState`）→ `turnEnded` 收尾。

**收尾语义**：`turnEnded` ≠ 协议成功——其后仍须等待干净的 HTTP/2 end，并解析 Connect end-stream 错误帧；「ended before turnEnded」按失败 reject 交回 candidate loop。需一张「Cursor server message → AI SDK LanguageModelV4 stream part / finishReason」映射，区分文本 turn（finish `stop`）与工具 turn（finish `tool-calls`）。`doGenerate` 可在 `doStream` 之上聚合。上游非成功响应交由现有 candidate loop 与 fallback，不在插件内 retry 或跨账号调度。

### 多轮与 session affinity

`conversationState`（含 todos/fileStates/summaries）+ `blobStore`（历史正文按 blob-id 存的二进制副表，老 user 轮被服务端替换成占位）是有状态多轮上下文，跨请求延续，**必须由插件存住**——caller 不会在 wire 里重发它。session affinity 只是候选**重排序**（决定选谁，不提供存储），且被固定 provider 冷却/不健康时 candidate loop 会落到别的 provider。因此：

- 插件持有一份**有界**的按逻辑会话键存储承载 `conversationState` + blobStore，key 按身份维度隔离（避免跨租户串号）。**复用仓库现有 `lru-cache`**（root catalog，`server`/`core` 已 `catalog:`），按既有先例用 `new LRUCache({ max, ttl, ttlAutopurge: true })`（见 `provider-cooldown.ts`、`models-dev/index.ts`）；语义参考 opencodex `thread-continuity.ts`（TTL≈1h、上限≈2048），不手写 prune。
- session affinity（`docs/superpowers/specs/2026-07-24-trace-session-affinity-design.md`）仅用于**尽量**把同一逻辑会话命中同一 Cursor provider（prompt-cache 连续性）。
- affinity miss（绑定 provider 不可用、落到别的 provider）时明确降级：**丢弃状态、以新 conversation 重开**，不复用错配状态。

## Package 与注册

新增 `packages/plugins/cursor/`，跟随现有小型插件布局并遵守 colocated 测试与 300 行上限：

- `src/oauth/`：PKCE、轮询、refresh、JWT 过期、credential schema。
- `src/catalog.ts`：`GetUsableModels` 解析与 curated fallback。
- `src/wire/`：手写 Connect 5 字节帧编解码与 h2 transport（不含 protobuf 定义）。
- `src/gen/`：vendored protobuf-es 生成物（`agent_pb.ts` 等），整份标注 generated 获 300 行豁免，附来源 provenance/许可（见阶段二「protobuf 编解码」，不手工裁子集）。
- `src/tool-names.ts`：`toWireName`/`fromWireName` 与保留集（+ `tool-names.test.ts`）。
- `src/runtime/`：手写 LanguageModelV4、run 循环、exec 应答、conversation turns。
- `src/store/`：有界会话状态 + blobStore（`lru-cache`），按逻辑会话键 + 身份 scope。
- `src/plugin.ts` / `src/index.ts`：adapter 声明、descriptor、版本与导出。

依赖：阶段二新增 `@bufbuild/protobuf`（`catalog:`，两包以上共用时登记 root catalog）；会话状态存储复用现有 `lru-cache`（`catalog:`）。**无 build-time client secret**：Cursor 登录是纯 PKCE 公有客户端，全程无 client_id/secret；唯一「client 标识」是明文 `x-cursor-client-version`（普通常量，非 secret），不建模成 `source.define`、不做「断言不落产物」的 secret smoke test。真正需要脱敏的是**运行期 access/refresh token**（不进日志/config/Provider ID）——保留该约束。

host 触点（对齐 kimi/xai 落地清单）：

- `packages/core/src/plugins/builtins.ts`（+ `.test.ts`）：注册 package、版本、中英文文案（label `Cursor`；description `使用 Cursor 账号访问模型`；adapter label `使用 Cursor 登录`；authorize 文案 `打开链接完成授权` / `正在等待 Cursor 授权`）。
- `packages/core/package.json`：加 workspace dependency；`bun.lock` 随 workspace 更新。
- `packages/cli/src/plugin-commands/*` 相关测试更新（capability 列表、authorize_url 呈现）。
- `packages/dashboard/src/modules/providers/`：`oauth-service.ts` 的 `refetchInterval` 谓词加入 `authorize_url`、`oauth-authorization-panel.tsx` 新增状态分支与取消按钮、i18n 文案（见 seam 第 5 处）。
- 阶段一 seam：`plugin-sdk`/`types`/`server`/`cli`/`dashboard` 的 `authorize_url` 状态**五处**改动（见「seam 缺口与决策」）。

## 测试与验证

test-first，每个行为只保留最小有价值回归：

- OAuth：PKCE/URL 构造、轮询 404 退避、成功解析、连续错误上限、timeout、abort（abort 绕过错误计数直接抛）；JWT `exp` 解析与回退；fingerprint 取自 JWT `sub`（refresh 轮换后指纹稳定）。
- Refresh：refresh token 保留/轮换、`expiresAt` 单次 5 分钟提前（不双扣）、错误分类（401/403/`invalid_grant` non-retryable，429/5xx/network retryable）。
- `authorize_url` seam：plugin-sdk 端口、types schema（`instructions` 用 localized）、server publish、CLI 呈现（无 code）、dashboard `refetchInterval` 谓词含 `authorize_url`（回归「等待授权期间停止轮询」）。
- Catalog：有效 id 过滤、curated 首次兜底（源自 `getBundledModels("cursor")`）、401/403/空目录不兜底；discover 向上传播 HTTP 状态分类。
- 工具名映射：`toWireName`/`fromWireName` 双向、保留集精确匹配、`conversationState` 历史一致性、`aio_proxy__read` 边界行为。
- Runtime：握手回 `requestContextResult`、A 类 exec **按 case 分别应答**（reject/error/empty/ack）且合成 tool-call 块被抑制、B 类 `mcpArgs` → `function_call` 后诚实挂起且保住 `conversationId`、下一轮 `ResumeAction` 续传工具结果、文本/thinking 输出、`turnEnded` 后等干净 h2 end 与 end-stream 错误帧、Connect 帧与 protobuf 往返、错误交回 candidate loop。
- 会话存储：有界 `lru-cache`（TTL/上限/身份 scope 键）、affinity miss 降级为丢状态重开。

不为常量或静态数组单独写低价值测试。完成前运行：

```sh
bun run --filter @aio-proxy/plugin-cursor test:unit
bun run --filter @aio-proxy/plugin-cursor build
bun run preflight
```

## 验收标准

- `aio-proxy provider login @aio-proxy/plugin-cursor`（或交互式 capability 选择）展示 Cursor 授权 URL，无 user code；授权后创建 OAuth Provider ID。
- credential vault 保存 access/refresh token 与真实 expiry；明文 token 不进入 config、Provider ID、日志或错误。
- `/v1/models` 展示账号动态可用模型；发现暂不可用时新账号可用 curated fallback；401/403 或空目录不伪造模型。
- 任一入站协议经现有转换路径可调用 Cursor 模型，实际请求以 Connect/HTTP2/protobuf 发往 `AgentService/Run` 并带 Cursor 身份 header。
- A 类内建工具 exec 按 case 分别应答且不使流中断、合成 tool-call 块不泄漏给 caller；纯问答任务可用，编码类任务按已声明取舍降级。
- B 类工具函数调用经无状态 history 延续（`function_call` → 诚实挂起 → 下一轮 `ResumeAction` 续传结果，`conversationId` 保留）；与内建保留名冲突时经 `aio_proxy__` 前缀双向映射，用户侧只见原名。
- access token 到期前刷新（refresh rotation 不丢失、指纹稳定不重复建 provider）；多轮 `conversationState` 由插件有界存储承载，affinity 尽量命中同 provider、miss 时丢状态重开。
- Cursor provider 失败后仍遵循现有 Provider weight 与 fallback 规则。

## 阶段划分建议

- **阶段一（低风险，独立交付）**：`authorize_url` seam（5 处）+ PKCE 登录 + refresh + credential 存储 + **最小 `catalog.discover`**（static policy + curated 或空清单——`OAuthAdapter.catalog.discover` 必填，缺它 adapter 装不进 builtins）。可独立测试与合入，不含 protobuf 依赖。
- **阶段二（高风险，工作量大）**：模型发现 + 手写 LanguageModelV4 + Connect/HTTP2/protobuf + 握手 + A 类 exec 分别应答 + B 类无状态 history 延续 + 前缀映射 + `conversationState` 有界存储 + affinity。建议阶段一合入后再单独立项，并在澄清开放问题（见评审）后进入实现。
