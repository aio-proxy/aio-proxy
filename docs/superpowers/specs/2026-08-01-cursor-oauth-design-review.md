# Cursor OAuth 设计评审与修订清单

日期：2026-08-01
状态：评审结论（R1–R16 已并入 `2026-07-31-cursor-oauth-design.md`；R17–R19 与末尾 annotation 保持记录）

## 范围

本文件是对 [2026-07-31-cursor-oauth-design.md](2026-07-31-cursor-oauth-design.md) 的逐条评审与修订清单。每条给出 spec 位置、问题、修订动作与证据来源。**「必改」（R1–R9）与「建议改」（R10–R16）已全部并入主 spec，主 spec 现为唯一事实源**；本文件作为决策留痕与证据索引保留。「记录（Low / 已定性 / 不改）」的 R17–R19 与 annotation 维持原状，无需并入。每条 R 内引用的 spec 行号为并入前的旧定位，仅供追溯，勿据以再改主 spec。

## 参考源（三方交叉验证）

1. **OMP** = `.reference/oh-my-pi`：spec 的原始参考实现（编码 agent，模块级状态 + 原生工具执行）。
2. **opencodex** = `github.com/lidge-jun/opencodex`：第二个独立实现，且**与 aio-proxy 架构最接近**——同为独立、无本地 IDE 依赖的无状态代理，cursor adapter 位于 `src/adapters/cursor/**`（60+ colocated 测试 + 完整 devlog RCA）。多处独立踩坑并给出已落地、测试覆盖的解法。
3. **review agents**：`codex` 与 `omp` 两个默认模型对 spec 的逐条核查（wire 事实、seam、仓库规范）。

三源一致的结论优先级最高；OMP 与 opencodex 分歧处，opencodex 的取向通常更贴合本仓（无状态、有界存储、稳定身份）。

## 必改（Blocker / High）

> 状态：R1–R9 已并入主 spec（2026-08-01）。以下保留为决策留痕与证据索引。

### R1. B 类工具「正常透传」机制性不成立，改为无状态 history 延续

- 位置：spec L141「等价于 aio-proxy 的普通工具，正常透传」；L31、L178。
- 问题：Cursor 的客户端工具结果要求在**同一条仍开着的 h2 流**上同步回 `mcpResult`（终止性）。无状态代理把 `function_call` 交回下游 caller 后本轮流即关闭，结果要到**下一次入站请求**才来——turn 内没有可回的结果。「正常透传」在无状态代理下不可达。
- 修订：改述为「无状态 history 延续」三步——(a) Run#1 从 `mcpArgs` 发出 `function_call` 后**诚实挂起**（关流、不回写任何假的空 `mcpResult`）；(b) 即使输出含 `function_call` 也**保住真实 Cursor `conversationId`**（另用 `checkpointUsable=false` 表示 checkpoint 不可复用，但 conversation 句柄要留）；(c) 下一轮只带工具结果时对 Cursor 发 `ResumeAction`（而非空 UserMessage），并显式维护 `call_id ↔ toolCallId` 映射重建历史。
- 证据：opencodex `devlog/_fin/363_cursor-tool-continuation/00_overview.md`（结论 + 已验证 commit `46df4d6`）与 `02_break2-conversation-id.md`；对比 Kiro 有一等的 `userInputMessageContext.toolResults` 路径而 Cursor 没有。codex reviewer 判为 Blocker，成立。
- 备注：若要「原生同流回带」（更高保真），需长驻**有状态 live-bridge**（opencode-cursor `ActiveBridge` 模式），opencodex 明确列为 out of scope。是否上有状态桥是需要拍板的架构取舍；默认走无状态 history 延续。

### R2. `conversationState` 跨请求存储：删除「不自建会话存储」，改为有界内存存储

- 位置：spec L33、L62、L182「插件……不自建会话存储」「依赖宿主 session affinity 固定 provider」。
- 问题：Cursor 多轮不靠 caller 重发历史，而靠回带 `conversationState`（todos/fileStates/summaries）+ `blobStore`（历史正文按 blob-id 存的二进制副表，老 user 轮被服务端替换成占位）。这份状态**必须**在两次请求间存住。而 affinity 只是 `prioritizeAffinity` 的**重排序**（只决定选谁，不存数据），且被固定 provider 冷却/不健康时 candidate loop 会落到别的 provider → 状态错配/丢失。spec 指望 affinity 承担存储职责，属设计空洞。
- 修订：明确插件持有一份**有界**的按逻辑会话键的状态 + blob 存储，key 按身份维度隔离（避免跨租户串号）；affinity 仅用于尽量命中同 provider；affinity miss 时明确降级策略（丢状态重开 vs 报错）。删除「不自建会话存储」。
- 实现：**复用仓库现有 `lru-cache`**（root catalog `^11.5.2`，`server`/`core` 已以 `catalog:` 声明），不手写 prune/LRU。按既有先例用 `new LRUCache({ max, ttl, ttlAutopurge: true })`（见 `packages/server/src/routes/pipeline/provider-cooldown/provider-cooldown.ts`、`packages/core/src/models-dev/index.ts`）。opencodex 的 `OVERRIDE_TTL_MS`/`OVERRIDE_MAX_ENTRIES`/手写 `prune()` 仅作**语义参考**（TTL≈1h、上限≈2048），落地换成 lru-cache 的 `ttl`/`max`。
- 证据：opencodex `src/adapters/cursor/thread-continuity.ts`（有界 Map + `prune()` LRU + `cursorThreadScopeKey(threadId, identityScope)`）与 `src/adapters/cursor/kv-store.ts`（get/set clone 字节）。OMP 用的是无界模块级 Map（`conversationStateCache`/`conversationBlobStores`，内存泄漏）。codex B2 + omp H1 一致。

### R3. seam 触点是 5 处不是 4 处：Dashboard 前端有会「功能性中断轮询」的硬编码谓词

- 位置：spec L74「触及 4 处」、L81（前端仅「需渲染」）、L202。
- 问题：`packages/dashboard/src/modules/providers/services/oauth-service.ts` 的 `refetchInterval` **硬编码**了继续轮询的状态集（`preparing|device_code|loopback|discovering`）；新增的 `authorize_url` 不在集合内 → 等待用户授权期间**停止轮询**，永远刷不到 `succeeded`。这是功能性中断，不只是缺 UI。此外 `oauth-authorization-panel.tsx` 分支与取消按钮、i18n 文案都需新增。
- 修订：触点更正为 **5 处**，显式点名 `refetchInterval` 谓词必须加入 `authorize_url`；types 新 variant 的 `instructions?` 用 `DashboardLocalizedTextSchema`（与 device_code 一致）而非裸 string。
- 证据：codex H1。omp 亦独立指出前端是第五处改动。

### R4. exec 通道不是「统一 rejected」，改为按 case 分别应答（纯事实修正）

- 位置：spec L60、L139、L230「对每个 exec 请求回复 `rejected`」。
- 问题：exec switch 异构，各 case 用各自的 result schema：`read/ls/grep/write/delete/shell/diagnostics`→`rejected`；`fetch/backgroundShellSpawn/writeShellStdin`→`error: Not implemented`；`listMcpResources/readMcpResource/recordScreen/computerUse`→空结果；`default`→裸 ack。统一发一个 `rejected` 会 protobuf 类型不匹配。另：`todo` 根本不走 exec，是 `interactionUpdate` 的 `updateTodosToolCall`；`lsp` 不是独立 case，映射到 `diagnosticsArgs`。
- 修订：spec 改成「按 exec case 分别回以协议合法的 reject/error/empty/ack」的对照表；修正 L39/L137 的工具清单（`todo`/`lsp` 归类）。
- 证据：OMP `handleExecServerMessage` switch；opencodex `src/adapters/cursor/exec-policy.ts` 的 `CURSOR_EXEC_CASES_DENIED` 逐个列出、`requestContextArgs` 单独 `ok:true` 分支。codex H2 + omp M1 一致。**这是纯事实修正，无需决策。**

### R5. 抑制合成的 native tool-call 块（插件内部行为）

- 位置：spec L178（读循环）；补入「Runtime 结构」的插件内部要求。
- 问题：OMP 每个 exec 分支会先 `synthesizeCursorExecToolCall` 往输出合成一个 tool-call 块（为编码 agent 转录保真）。搬到 aio-proxy 会作为 caller 从未声明的 `read/bash` 等工具调用泄漏进响应，多数客户端报错。
- 修订：在插件出口**抑制**这些合成块，不落入 AI SDK 输出 parts。明确写成插件内部实现要求，不作为开放问题。
- 证据：codex H2 延伸。

### R6. 流收尾语义：`turnEnded` ≠ 干净 h2 结束，补 finishReason 映射

- 位置：spec L178「`turnEnded` 收尾」。
- 问题：应用层 `turnEnded` 不等于协议成功——需再等干净的 HTTP/2 end，并解析 Connect end-stream 错误帧；「ended before turnEnded」要 reject。spec 未区分文本 turn（finish `stop`）与工具 turn（finish `tool-calls`），也没提过早结束的失败路径。
- 修订：补一张「Cursor server message → AI SDK LanguageModelV4 stream part / finishReason」映射，并明确 `turnEnded` 后等干净 h2 end、end-stream 错误帧如何交回 candidate loop。
- 证据：codex H3；opencodex `src/adapters/cursor/framing.ts` + `transport.ts` 有对应的帧/收尾处理（`cursor-framing.test.ts`）。

### R7. 模型发现的错误模型：必须向上传播 HTTP 状态，否则「401 不兜底」不可实现

- 位置：spec L174「network/timeout/408/429/5xx 兜底；401/403 不兜底」。
- 问题：OMP `fetchCursorUsableModels` 对任何失败一律返回 `null`，非 2xx 在 `fetchViaHttp2` 内被吞——seam 处无法区分 401/500/timeout，`initialFallback(error)` 拿不到状态，验收项「401/403 不伪造模型」无法满足。
- 修订：自研 discover 必须**分类并向上传播** HTTP 状态/错误类型，不照搬 OMP 的塌缩式 null。
- 证据：codex H4。opencodex refresh 侧已有先例——`src/oauth/cursor.ts` 的 `isRetryableRefreshStatus`（429/5xx retryable，401/403 fail-fast）证明这种分类是可做且必要的。

### R8. fingerprint 改用 JWT `sub`（稳定身份），不用会轮换的 refresh token

- 位置：spec L63、L105「refresh token 的 SHA-256」。
- 问题：refresh token 会轮换（`data.refreshToken || 旧值`）。用它做指纹，token 一换下次登录算出不同值 → 同账号被当新 provider、破坏去重，还可能触发 `PROVIDER_FINGERPRINT_MISMATCH`。
- 修订：fingerprint/`accountId` 取 access token JWT 的 `sub`（附 `email` 小写辅助展示）。
- 证据：opencodex `credentialsFromCursorTokens`（`src/oauth/cursor.ts`）明确「extracting stable identity from JWT `sub` for multiauth」。OMP 用 refresh token 是其历史包袱，勿抄。codex H5 一致，判定 opencodex 正确。

### R9. 补全 runtime 必需 header

- 位置：spec L127-L128（只列 content-type + 3 个身份 header）。
- 问题：run 请求还需 `connect-protocol-version: 1`、`te: trailers`（读 grpc-status trailer 的前提）、`x-request-id`；discovery 用的 content-type 是 `application/proto`（**与 run 的 `application/connect+proto` 不同**）。
- 修订：把 header 清单补全，并注明 run 与 discovery 两端 content-type 不同、`te: trailers` 是读 trailer 的前提。
- 证据：opencodex `devlog/_fin/260709_pr_triage/004_cursor_fingerprint_analysis.md` 给了两端完整 header profile；omp H2 一致。

## 建议改（Medium）

> 状态：R10–R16 已并入主 spec（2026-08-01）。以下保留为决策留痕与证据索引。

### R10. `expiresAt` 5 分钟提前量勿双重扣减

- 位置：spec L55（存时提前 5 分钟）+ L109（读门槛又 `<= now + 5 分钟`）。
- 问题：两处都扣 = 提前 10 分钟刷新。
- 修订：二选一——存原始 `exp*1000`、门槛处单次扣；或存已扣值、门槛用 `<= now`。证据：opencodex `getTokenExpiry` 在**存时**扣 `EXPIRY_SKEW_MS`，读门槛不再扣（单次）。codex M1。

### R11. 删除 build-time client secret（`__AIO_PROXY_CURSOR_*__`）

- 位置：spec L195。
- 问题：Cursor 登录是纯 PKCE 公有客户端，全程无 client_id/secret；唯一「client 标识」是**明文** `x-cursor-client-version`（且 OMP run 与 discovery 两处 pin 值还不一致）。对明文串做「断言不落产物」的 artifact smoke test 是过度设计（照搬 kimi 的误植）。
- 修订：删除 client-secret define + smoke test；client-version 建模成普通常量（选定一个版本，注明可能被服务端 gate）。真正要脱敏的是**运行期 access/refresh token**——保留这条。
- 证据：opencodex 全程无 client secret（`src/oauth/cursor.ts` 登录 URL 仅 challenge/uuid/mode/redirectTarget）；client-version 是明文常量。codex M2 + omp M4 一致。

### R12. 工具经握手 `requestContextResult` 上报，不在 `AgentRunRequest` 里

- 位置：spec L129、L178（称 AgentRunRequest 带「B 类工具定义」）。
- 问题：`buildGrpcRequest` 不在 AgentRunRequest 放工具（注释：Tools are sent later via requestContext）；工具在服务端发 `requestContextArgs` 后由 `requestContextResult.requestContext.tools` 回上。
- 修订：更正为「工具经握手上报」。「握手必需」成立；但「否则不产出内容」代码无法证实（OMP/opencodex 都恒应答），标为**未证实**。证据：codex M3 + omp M3。

### R13. protobuf 走真正的 codegen，不手工裁子集

- 位置：spec L131「移植/生成 `agent_pb` 被用到的 message 子集」、L190。
- 问题：手工裁剪会变成**非生成**文件 → 受 300 行上限约束且易与 wire 漂移；而 AGENTS.md 明确「生成文件豁免」。
- 修订：走 vendored `.proto` + `protoc-gen-es` 代码生成，或整份 vendored 生成文件（标注 generated 获豁免），并说明 provenance/许可。证据：opencodex 采用 `src/adapters/cursor/gen/agent_pb.ts`（生成物单独目录）。codex M4。

### R14. 阶段一附带最小 `catalog.discover`

- 位置：spec L237（模型发现整体放阶段二）。
- 问题：`OAuthAdapter.catalog.discover` 是必填；阶段一不提供 catalog 则 adapter 不完整、装不进 builtins。
- 修订：阶段一附一个最小 catalog（static policy + curated 或空清单）使其可独立加载/测试；动态 `GetUsableModels` 留阶段二。证据：codex M5。

### R15. curated fallback 来源写准 + 明确是净新增

- 位置：spec L57、L174、L189。
- 问题：兜底数据源应是 `getBundledModels("cursor")`（bundled 模型注册表），而非 discovery 文件里的「snapshot」；且 OMP 失败直接返回 null、**不做**失败兜底，这条是 aio-proxy 净新增行为。
- 修订：修正来源描述并注明净新增。证据：omp M5。

### R16. 区分出站 heartbeat 与入站空闲看门狗

- 位置：spec L42（非目标里笼统的「心跳看门狗」）。
- 问题：OMP 有两样不同东西——出站 `clientHeartbeat` 定时保活 与 入站空闲看门狗。若 Cursor h2 流依赖客户端周期性 heartbeat，丢弃出站 keepalive 会让长生成中途被断。
- 修订：区分二者；出站 heartbeat 的必要性标为**未证实**，建议先验证或保留。证据：codex M6。

## 记录（Low / 已定性 / 不改）

- **R17（Low）** 轮询首轮有 ~1s 延迟（OMP 循环顶部先 sleep）；`context.signal` 中止支持是我方**净新增**（OMP/opencodex 的 poll 都要额外接 signal），且 abort 必须**绕过**连续错误计数直接抛出。opencodex `pollCursorAuth` 已把 signal 接进 `sleep` 并在 catch 里 `if (signal?.aborted) throw`——可直接对齐。（codex L1 + omp L1）
- **R18（Low）** 不照搬 OMP 的 refresh 错误回显响应正文与 `DEBUG_CURSOR` dump（泄漏面）。（codex L2）
- **R19（Low）** 文档路径漂移：candidate loop 实际在 `packages/server/src/routes/pipeline/attempt/attempt.ts`；464 明证在发现路径、run path 是外推；discovery unary `application/proto` 与推理 streaming `application/connect+proto` 帧格式不同，勿混用。（omp L3/L4/L5）
- **Annotation 2 / R4**：exec 异构是纯事实修正，已并入 R4，**无需用户判断**。
- **Annotation 5 / R5**：合成 tool-call 块抑制在插件内处理，已并入 R5。
- **Annotation 6（不改）**：出站重名碰撞（caller 自带名为 `aio_proxy__read` 的工具）**不处理**。保持 `toWireName`/`fromWireName` 纯函数，spec L170 现有入站边界说明保留即可。opencodex 亦为纯前缀 + `toolCallId` 配对，无特殊处理，取向一致。

## opencodex 额外洞见（供风险评估）

- **`resource_exhausted` 主要是服务端限流**，非缺 `x-cursor-checksum`（官方 IDE 在有额度时也复现）。`x-cursor-checksum`（Jyh cipher）逆向、随时变、ToS 风险高，peer 证据显示非必需——**不建议实现**，可写进「非目标」。（`004_cursor_fingerprint_analysis.md`）
- **native exec 可做成 config gate**：opencodex 有 `nativeLocalExec: off | codex-sandbox | on`，默认 `off`、fail-closed（`exec-policy.ts`）。我方 spec 明确不做 fs/shell → 保持全拒（R4 的分别应答），但这提供了未来「受控开放」的先例，可在设计里备注。

## 开放问题（需真实 Cursor 账号 e2e，离线不可验证）

1. B 类工具：Cursor 对 caller 工具只发 `toolCallStarted`（client-side 执行）还是也发 `mcpArgs`（要求 turn 内内联 result）？决定 R1 无状态延续是否足够。
2. A 类全拒后，Cursor 是否仍返回连贯文本并 `turnEnded`，还是挂起/空耗 token？——「编码降级、问答可用」目前是假设。
3. 握手不回 `requestContextResult` 是否真「不产出内容」（OMP/opencodex 均恒应答，无反例）。
4. 服务端是否 gate `x-cursor-client-version`；长流是否依赖出站 heartbeat。
5. `conversationState`/`blobStore` 的持久位置、键、TTL/上限/回收；affinity miss 降级策略（R2）。

## 结论

wire 层 spec 准确度高，raw 不可行论证与手写 LanguageModelV4 先例均成立。真正风险集中在阶段二三处核心机制（R1 B 类往返、R2 会话状态存储、R4 exec 异构），opencodex 已为这三处各给出落地且测试覆盖的解法。**阶段一**（R3 修正后的 5 处 seam + PKCE + refresh + R14 最小 catalog + R8 稳定 fingerprint）可独立推进；**阶段二**在澄清上述开放问题、并入 R1/R2/R6/R7 后再进入实现。
