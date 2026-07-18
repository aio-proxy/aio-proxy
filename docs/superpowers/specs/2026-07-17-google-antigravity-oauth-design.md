# Google Antigravity OAuth Provider 设计

日期：2026-07-17  
状态：已完成设计访谈，待用户规格审阅

## 背景

aio-proxy 已有通用 OAuth plugin host、账号级 credential port、TTL model catalog、raw/model 双能力和唯一 candidate loop，但尚未支持 Google Antigravity。Antigravity 不是普通 Gemini API：它使用 Google OAuth、Cloud Code Assist 项目初始化、私有 CCA request envelope、动态 Hub headers、内部模型目录、thinking signature 和 provider-executed web search。

本设计参考仓库内的 `.reference/CLIProxyAPI`、`.reference/oh-my-pi` 和 `.reference/claude-code-hub`。实现目标不是复制任一项目的账号池或调度器，而是将 Antigravity 的协议正确性封装进现有 OAuth plugin seam，使 route 和 candidate loop 继续保持 provider-agnostic。

## 目标

- 新增随 CLI/二进制发布的 built-in `@aio-proxy/plugin-google-antigravity`。
- 完成 Google OAuth 登录、token refresh、邮箱识别和 Antigravity `projectId` 初始化。
- 同时提供 Gemini raw capability 与 ProviderV4 model capability。
- 动态发现账号可用模型，并生成稳定的 client-facing aliases 和 effort variants。
- 支持 Gemini 图片输入、Claude/Gemini thinking、thought signature/reasoning replay、Anthropic typed web search 和真实 token counting。
- 保持现有 model-first、Provider weight、跨 Provider fallback、诊断和 last-known-good catalog 语义。

## 非目标

- 不实现 credits/quota Dashboard。
- 不实现额度感知路由、CPA 账号池 scheduler 或 credential cooldown scheduler。
- 不实现图片生成；只支持模型声明允许的图片输入。
- 不模拟 HTTP/1.1、TLS、JA3 或浏览器网络指纹。
- 不把 session 用于账号 affinity；Provider 选择仍只由现有 model resolution、weight 和 fallback 决定。
- 不向 OpenAI Responses 暴露本次新增的 web search tool surface。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 插件包 | built-in `@aio-proxy/plugin-google-antigravity`，capability 为 `default` |
| OAuth client | 使用参考实现的 Google client ID/secret 源码常量 |
| OAuth redirect | 固定 `http://localhost:51121/oauth-callback`，允许粘贴完整 callback URL |
| OAuth 安全 | 严格校验 state；不使用 PKCE |
| OAuth scopes | 对齐参考实现的 5 个 scopes |
| 账号身份 | Google 邮箱作为 fingerprint/label；登录必须取得 Antigravity `projectId` |
| 项目初始化 | prod `loadCodeAssist`；缺 project 时 daily `onboardUser`，使用新版 metadata、tier、polling 和 headers |
| Endpoint | 默认 daily → prod；sandbox 不参与；配置 `baseURL` 后只请求该地址 |
| Catalog | 动态非空有效结果权威；TTL 6 小时；静态快照只处理可重试发现失败 |
| Runtime | Gemini raw + ProviderV4 model；model codec 对齐 `@ai-sdk/google` |
| Session | 协议语义优先规范化；确定性 wire session；不做 Provider affinity |
| Envelope | 每 logical request 一个 request ID；不维护 Hub trajectory/step/last-execution 链 |
| Replay | `model + normalized session` 跨 Antigravity Provider 共享，滑动 TTL 1 小时，最多 10,240 条 |
| Endpoint retry | 网络、429、明确 no-capacity 503 可换 endpoint；短 Retry-After 最多同账号重试一次 |
| 诊断 | 复用现有通用 DiagnosticCode，不增加 Antigravity 专用全局状态码 |

## 总体架构

### 插件边界

`packages/plugins/google-antigravity/` 拥有所有 Antigravity 私有行为：

- Google OAuth URL、callback code exchange、userinfo 和 refresh。
- Cloud Code Assist project 初始化。
- model discovery、静态快照、denylist 和 effort-family collapse。
- CCA envelope、Hub headers、endpoint fallback、SSE/JSON 解包和 upstream error classification。
- tool schema normalization、thinking/signature、grounding URL 修复和 token counting。
- ProviderV4 model wrapper 与 Gemini raw resolver。

插件只依赖 `@aio-proxy/plugin-sdk`、AI SDK provider packages 和通用工具依赖，不从 CLI、server 或 core 私有实现导入代码。

### 宿主边界

宿主继续拥有：

- loopback listener、manual callback、取消和超时。
- OAuth credential 持久化、refresh single-flight、lease 和 revision CAS。
- catalog last-known-good、TTL scheduler 和诊断持久化。
- Provider ID、Provider weight、alias config 和唯一 candidate loop。
- 入站协议解析、logical request identity、request/usage recording 和最终协议错误。

route 文件不得增加 Antigravity、OAuth 或 provider-kind 分支。

### 需要扩展的公共 seam

本功能需要对现有通用接口做三项窄扩展：

1. OAuth adapter 可基于首次成功发现的 `ModelCatalog` 提供 default alias suggestions。宿主只在新账号创建时写入这些 aliases；显式 re-login 和后续 catalog refresh 不覆盖已有 config alias。
2. runtime invocation 可收到宿主生成的 internal logical request context，包括 normalized session 和 logical request ID。raw 与 model capability 使用同一 context，endpoint/auth/provider retries 不重新生成 identity。
3. runtime provider 可选暴露 provider-aware token-count capability。count routes 使用正常模型解析和 candidate fallback；没有可用 capability 时才本地估算。

这些扩展必须保持现有 GitHub Copilot、OpenAI ChatGPT 和第三方 plugin source-compatible；新增字段均为 optional。

## OAuth 与账号初始化

### 授权请求

插件向宿主提交固定 loopback request：

- hostname：`localhost`
- port：`51121`
- path：`/oauth-callback`
- `allowManualCallbackUrl: true`

authorization URL 使用参考实现的 client ID、`access_type=offline`、`prompt=consent`、随机 state 和以下 scopes：

- `https://www.googleapis.com/auth/cloud-platform`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/cclog`
- `https://www.googleapis.com/auth/experimentsandconfigs`

宿主 listener 必须在浏览器打开前开始监听。自动 callback 与手工粘贴竞速时只能有一个完成者，所有完成、取消和超时路径都关闭 listener。

插件不使用 PKCE，但必须在 code exchange 前严格比较 state。callback hostname、port、path、OAuth error、缺 code 和 state mismatch 都作为 authorization failure，不写入或覆盖账号。

### Token exchange 与身份

code exchange 成功后，插件取得 access token、refresh token、expiry，并调用 Google userinfo 获取 email。email 是账号 fingerprint 和默认 label 的来源；缺 email 视为登录失败。

credential 至少保存：

- access token；
- refresh token；
- expires-at；
- email；
- Antigravity project ID；
- token endpoint 明确返回且刷新所需的标准 OAuth metadata。

secret、authorization code、完整 callback query 和 token response 不进入诊断、Dashboard 或普通日志。

### Project 初始化

登录阶段必须完成 project 初始化：

1. 使用 prod Cloud Code Assist endpoint 调用 `loadCodeAssist`，request metadata 为 `{ ideType: "ANTIGRAVITY" }`。
2. 若返回 project，规范化并保存 project ID。
3. 若缺 project，tier 依次取 `allowedTiers` 中的 default、`currentTier.id`、最后回退 `free-tier`。
4. 调用 daily `onboardUser`，body 使用 `tier_id` 和 `{ ide_type: "ANTIGRAVITY", ide_version: <dynamic Hub version>, ide_name: "antigravity" }`。
5. `onboardUser` 最多尝试 5 次，每次 request deadline 30 秒，未完成时等待 2 秒；headers 包含 `Accept: */*`、动态 User-Agent 和参考实现的 `X-Goog-Api-Client`。
6. onboarding 完成后再次确认 project ID 非空。

登录成功的定义包含 email、refreshable credential 和 project ID。不能取得 project ID 时返回 `AUTHORIZATION_FAILED`，不创建一个“登录成功但首次请求必失败”的账号。

### Refresh

调用前 access token 在过期时间前 5 分钟进入刷新窗口。刷新通过现有 `CredentialPort.refresh()` 完成，复用宿主 single-flight、SQLite lease 和 revision CAS。

刷新响应未提供新 refresh token 时保留旧值。`invalid_grant`、撤销或无法恢复的 credential failure 持久化为 `CREDENTIAL_REFRESH_FAILED` 并提示重新登录。瞬时网络错误可重试，不得覆盖仍有效的旧 credential。

上游请求收到 401/403 时，当前 logical request 强制 refresh 一次并只重试一次。第二次仍为 401/403 时结束当前 candidate；不得形成 refresh loop。

## Account options 与 endpoint

Antigravity account options 只有一个高级字段：

```ts
type GoogleAntigravityAccountOptions = {
  readonly baseURL?: string;
};
```

`baseURL` trim 后去掉尾部 `/`，必须是 HTTP(S) URL。未设置时 project initialization 使用 prod `loadCodeAssist` 和 daily `onboardUser`；inference、discovery 和 countTokens 使用 daily → prod，sandbox 不参与。设置后 project initialization、inference、discovery 和 countTokens 都只访问该地址，不进行 endpoint fallback。

不同 API 的路径固定追加在 normalized base URL 后，用户不能分别覆盖 OAuth、project 和 inference 子路径。

## 模型目录与 aliases

### 动态发现

插件调用 `/v1internal:fetchAvailableModels`，携带 access token、动态 Hub User-Agent 和与当前 endpoint 对齐的 headers。响应必须通过运行时 schema 校验。

发现结果分类为：

- 非空有效模型列表：成功且权威，完全替换该账号 catalog。
- 网络、timeout、5xx 或无效 payload：可重试失败。
- 401/403：授权失败，不使用静态快照伪造权限。
- 合法响应但没有 usable model：有效空目录，不使用静态快照。

首次登录遇到可重试失败时使用内置静态快照；遇到授权失败或有效空目录时产生 `CATALOG_UNAVAILABLE`。后续 TTL refresh 失败时，宿主继续使用 last-known-good catalog，并将状态标为 stale。

### TTL 与快照

catalog policy 为 6 小时。快照随插件版本发布，只包含最近验证可工作的 language models、input capabilities、context/output limits、thinking 和 web-search hints。快照不是动态结果的并集，也不会让已从账号目录消失的模型长期残留。

### 过滤与 family collapse

发现和快照共同应用以下规则：

- 排除 `isInternal === true`。
- 排除 `chat_20706`、`chat_23310`。
- 排除 `tab_flash_lite_preview`、`tab_jump_flash_lite_preview`。
- 排除已失效的 `gemini-2.5-pro`。
- 不删除仍可作为 effort target 的 wire IDs，例如 `gemini-2.5-flash-thinking`。

已知 effort family 在 catalog boundary 折叠为 client-facing logical model。只有实际发现的 targets 才进入 alias/variant suggestion，不能生成指向不存在模型的 variant。

示例：

- `gemini-3.5-flash`
  - `minimal`/`low` → `gemini-3.5-flash-extra-low`
  - `medium` → `gemini-3.5-flash-low`
  - `high` → `gemini-3-flash-agent`
- `claude-opus-4-6` → base/disabled target 与 `claude-opus-4-6-thinking` thinking target。

### 默认 alias 写入

adapter 基于首次成功 catalog 返回 default alias suggestions。宿主在新账号 config transaction 中校验所有 target 存在后写入 `providers[providerId].alias`。

re-login 始终保留用户当前 alias。后续 catalog refresh 不自动重写 config，也不在 runtime 临时删除用户 alias/variant。若某个已配置 target 不再出现在动态 catalog 中，Router 仍按配置向上游尝试该 wire model ID，由 Antigravity 的真实响应决定它是否仍可调用。插件不维护“托管 alias”第二套配置状态。

这一规则只适用于用户已经持有的配置。插件首次生成 defaults 时仍只引用当前 catalog 实际发现的 targets，不能主动创建已知缺失的 alias/variant。

## Runtime capabilities

### Gemini raw capability

插件为 `ProtocolId.Gemini` 提供 raw resolver。raw transport 只用于相同入站协议；它负责：

- 解析 Gemini generateContent/streamGenerateContent/countTokens request shape；
- 保留标准 Gemini 语义并移除不被 CCA 接受的字段；
- 写入 project、wire model ID、request type、request ID、session ID、tools 和 thinking config；
- 调用 Antigravity endpoint；
- 将 CCA JSON/SSE envelope 解包回标准 Gemini response；
- 映射协议形状错误。

跨协议请求不得通过 raw capability。

### ProviderV4 model capability

插件提供 ProviderV4 language model，并使用 `@ai-sdk/google` 的 Gemini codec/类型语义处理 model messages、tool calls、usage、finish reason 和 stream parts。网络调用仍由 Antigravity transport 完成，而不是直接访问公开 Gemini API。

model wrapper 读取宿主注入的 internal logical request context，以及 adapter 生成的 effort/thinking provider options。未知 provider options 不得泄漏到 CCA payload。

模型支持图片输入时保留 AI SDK image parts；本次 catalog 不暴露 image-generation modality。

## Logical session 与 request identity

### Normalized session

aio-proxy 不把任何单一 header 宣称为跨厂商标准。协议 adapter 或共享 session normalizer 按语义强度选择第一个有效来源，并为来源加 namespace：

1. 宿主可信 internal `sessionId`。
2. OpenAI Responses `conversation` ID。
3. OpenAI `prompt_cache_key`。
4. 可验证的 Claude Code `metadata.user_id` 内嵌 session。
5. body 扩展：`metadata.session_id`、`metadata.conversation_id`、顶层 `session_id`/`conversation_id`。
6. header 扩展：`session_id`/`session-id`，再 `x-session-id`。
7. 已存在映射的 OpenAI `previous_response_id`。
8. 规范化前几条消息得到的 transcript hash。
9. 新生成 session。

明确禁止默认使用 `X-Client-Request-Id`、OpenAI `x-request-id`、Anthropic `request-id`、任意未验证的 `metadata.user_id` 或 idempotency key。

原始值先 trim、限制长度并做来源 namespace，然后 hash 成内部 cache key。普通日志只记录 source 和截断 hash。

OpenAI response chain mapping 只在一次 response 成功完成后写入，将对外 response ID 关联到本次 normalized session。映射使用进程内滑动 TTL 1 小时和 10,240 条上限；查不到 `previous_response_id` 时跳过该来源，不能直接把每轮变化的 response ID 当作新 session root。

### Wire session

Antigravity `request.sessionId` 不直接复制客户端值。对 normalized session key 做 SHA-256，取前 63 位正整数并加负号，得到稳定 signed-decimal wire session。相同 logical session 在进程重启、endpoint fallback 和 Antigravity Provider fallback 后仍得到相同 wire session。

### Logical request ID

pipeline 在一次入站请求开始时生成 logical request UUID。Antigravity request ID 为 `agent-<uuid>`。同一个 logical request 的：

- daily/prod endpoint attempts；
- 401/403 refresh retry；
- 多个 Antigravity Provider candidates；

复用同一个 request ID。下一次入站请求生成新 ID。request ID 不从任何客户端 request-id header 派生。

### 并发 generation

不串行同 session 的整个请求，也不维护 Hub `agentId/trajectoryId/step/last_execution_id` 状态。`model + normalized session` state 为每个开始的 logical request 分配递增 generation。

成功 response 只在自身 generation 不旧于已提交 generation 时更新 signature/reasoning replay。旧请求晚完成不得覆盖更新请求已提交的 state；签名相关 400 的清理也必须带 generation guard，不能删除更新请求写入的 state。

这种策略不尝试把调用方主动创建的并发对话分支伪装成严格线性 conversation；它只保证共享状态不会被迟到的旧请求回滚。

## CCA envelope、headers 与 endpoint retry

### Headers

请求 headers 对齐当前参考实现的应用层行为：

- `Authorization: Bearer <access token>`；
- JSON/SSE content negotiation；
- 动态 `antigravity/hub/<version>` User-Agent；
- endpoint metadata、client metadata 和 reference-required labels；
- 不复制浏览器或 Go HTTP transport 指纹。

Hub version 由一个窄模块解析/更新，失败时使用插件内置已验证版本。版本发现不能阻断登录或调用。

### Endpoint fallback

未配置 `baseURL` 时，单个 Provider attempt 内按 daily → prod：

- fetch/network/connection reset：立即换下一个 endpoint；
- 429：解析 Retry-After；小于 3 秒时可在当前 endpoint 短重试一次，否则换 endpoint；
- 明确包含 no-capacity 语义的 503：换 endpoint；
- 401/403：先强制 refresh 一次，并从当前 endpoint 重试；
- 其他 4xx：不换 endpoint，返回请求级错误；
- 其他 5xx：保留错误并尽快结束当前 Provider attempt。

一个 endpoint 的短重试最多一次。插件不实现长 cooldown、quota scheduler 或跨请求 endpoint 熔断。当前 Provider attempt 失败后，现有 pipeline 决定是否尝试下一个 Provider candidate。

stream 一旦已经向客户端提交，不得切换 endpoint 或 Provider 重放。

## Thinking、signature 与 reasoning replay

### 通用原则

alias/variant 负责 effort → wire model ID；protocol middleware/adapter 负责 effort → thinking config。两者必须由同一 family definition 测试约束，避免 model ID 与 budget/level 不一致。

不注入通用 Antigravity persona。仅在协议正确性需要时注入专用提示，例如 Claude interleaved thinking 或 web-search behavior。

### Anthropic thinking

Anthropic → Antigravity 支持：

- 未设置：采用模型/协议默认行为。
- `disabled`：budget 0，关闭 thought summary。
- `enabled + budget_tokens`：固定预算。
- `adaptive + output_config.effort`：映射为固定内部 budget。

Claude 4.6 adaptive 映射：

| effort | budget |
| --- | ---: |
| low | 4096 |
| medium | 8192 |
| high | 16384 |
| max | 32768 |

固定预算必须 `>= 1024` 且 `< max_tokens`。无效 mode、缺 budget、budget 越界或与 max_tokens 冲突时，在调用上游前返回 Anthropic 风格 400。

### Signature 与 replay

完整采用 CPA 的恢复语义：

- 保存并往返 thought signature；
- 校验 signature 最小形状；
- 在 stateless 下一轮缺失时从 cache 补回；
- replay 必要的 reasoning/function-call parts；
- Anthropic core egress 输出 reasoning block，而不是只保留文本。

cache key 为 `model + normalized session`，不含 Provider ID。滑动 TTL 为 1 小时，最大 10,240 entries，进程内 best-effort。读取刷新 TTL；超过上限按最旧访问时间批量淘汰。

上游返回明确 signature/replay-invalid 400 时，只清理当前 generation 仍拥有的 cache，然后将该错误按既定恢复策略最多重试一次；不对普通 400 清 cache。

## Tool schema normalization

对函数工具 schema 完整采用 CPA 兼容规则：

- `parametersJsonSchema` → `parameters`。
- `$ref` 转成 description 提示。
- `const` 转单值 enum。
- 数字/布尔 enum 转字符串 enum。
- 将可表达约束搬入 description 后删除不支持关键字。
- 合并 `allOf`。
- 对 `anyOf`、`oneOf`、`type[]` 做确定的有损折叠。
- 删除 `$defs`、`$id`、`$comment`、`patternProperties`、`x-*` 等不支持字段。
- 删除不存在 property 的 required entries。
- 空 object 注入必填 `reason: string`。
- 嵌套无必填 object 注入 `_ : boolean`。
- Claude tools 强制标记 `VALIDATED`。
- 空 domain arrays 按未设置处理。

normalizer 是独立纯函数模块，输入不变性和幂等性必须有测试。工具级 schema 错误不做逐工具隔离增强；无法规范化整个请求时返回协议 400。

## Provider-executed web search

core 通用 tool representation 增加 provider-executed tool 类型，使协议 adapter 能表达“由上游 provider 执行，而不是本地 function call”的工具。

本次只支持 Anthropic typed `web_search_*` ingress：

1. Anthropic adapter 解析 typed tool 和 allowed/blocked domains。
2. 空 domain array 视为未设置。
3. runtime 转为 CCA `googleSearch`。
4. 仅当当前 discovered model 标记支持 web search 时发送。

响应 grounding URLs 只对 `vertexaisearch.cloud.google.com/grounding-api-redirect/...` 做 best-effort HEAD。成功时替换为最终 URL；timeout、非 2xx、缺 Location 或网络失败时保留原 URL，不让 URL 修复阻断模型响应。

OpenAI Responses web search 不在本次范围。

## Provider-aware token counting

### 公共能力

runtime provider 可选提供：

```ts
type TokenCountCapability = {
  readonly countTokens: (input: TokenCountInput) => Promise<TokenCountResult>;
};
```

具体类型由 plugin SDK/core 中立定义，不暴露 Antigravity payload。pipeline 为 count operation 复用正常 model resolution、Provider weight 和 fallback；candidate 不支持 count 时继续检查后续 candidate。

### 路由

- Anthropic `POST /v1/messages/count_tokens` 使用 Anthropic adapter 解析并返回标准 `{ input_tokens }`。
- Gemini `POST .../:countTokens` 使用 Gemini adapter 解析并返回标准 Gemini count response。
- Antigravity capability 调 `/v1internal:countTokens`，使用同一 model alias、wire model、project、headers、refresh 和 endpoint policy。
- 没有 candidate 支持，或所有真实 count attempts 均失败时，使用本地估算。

估算响应保持标准 JSON 不变，只增加：

```http
x-aio-proxy-token-count-estimated: true
```

真实 upstream count 不加该 header。count request 进入普通 request/attempt recording，但不记录为模型生成 usage。

## 错误、诊断与可观测性

### 持久诊断

复用现有诊断码：

- OAuth callback、token exchange、userinfo 或 project 初始化失败：`AUTHORIZATION_FAILED`。
- 永久 token refresh failure：`CREDENTIAL_REFRESH_FAILED`。
- 无 catalog、有效空 catalog 或不可恢复 discovery failure：`CATALOG_UNAVAILABLE`。
- ProviderV4/raw runtime 本地构造失败：`RUNTIME_CREATE_FAILED`。

不新增 Antigravity 专用全局 DiagnosticCode。细分 machine reason 只进入脱敏结构化日志，例如 `project_missing`、`oauth_invalid_grant`、`catalog_empty`、`upstream_no_capacity`。

### 请求级错误

协议 adapter 继续拥有最终错误形状：

- 本地 validation 失败：对应协议 400。
- 上游认证/权限失败：在 refresh retry 后作为 401/403 candidate failure。
- 429、no-capacity 503、网络错误：retryable candidate failure。
- 其他 4xx：默认不跨 endpoint 重试，但现有 candidate policy决定是否继续 Provider fallback。
- stream 已提交后的错误：只结束当前 stream，不重放。

全部 candidates 失败时保留最后失败，符合现有 pipeline 规则。

### 日志脱敏

不得记录：access token、refresh token、authorization code、callback query、Google email 原文、project metadata secrets、tool arguments 中的 secret-like values、完整 session key 或 thought signature。

可记录：Provider ID、endpoint category、model/wire model、session source、session hash prefix、logical request ID、attempt index、HTTP status、retry classification 和稳定 machine reason。

## 包与模块拆分

建议插件内部按责任拆分，保持每个 handwritten code file 不超过 300 行：

```text
packages/plugins/google-antigravity/
  src/
    index.ts
    plugin.ts
    schema.ts
    oauth/
      constants.ts
      login.ts
      refresh.ts
      project.ts
    catalog/
      discover.ts
      snapshot.ts
      families.ts
      aliases.ts
    runtime/
      provider.ts
      raw.ts
      transport.ts
      envelope.ts
      session-state.ts
      headers.ts
      endpoints.ts
      errors.ts
      stream.ts
      token-count.ts
    protocol/
      thinking.ts
      signatures.ts
      replay-cache.ts
      tool-schema.ts
      web-search.ts
      grounding-urls.ts
```

通用 session normalization、provider-executed tool type、token-count seam 和 Anthropic reasoning egress 放入已有 core/plugin-sdk responsibility，而不是从插件反向导出私有 helper。

## 实现顺序

实现计划应按可独立验证的 vertical slices 排列：

1. plugin package shell、credential/options schema、built-in registration。
2. OAuth login、project initialization、refresh 与 catalog discovery。
3. catalog aliases/families 与首次 config alias suggestions。
4. logical request/session context seam。
5. Antigravity transport、Gemini raw 和 model capability。
6. thinking、signature/replay 和 tool schema normalization。
7. Anthropic provider-executed web search。
8. provider-aware token counting routes/capability。
9. distribution wiring、文档、完整 routing matrix 和 preflight。

每个 slice 先增加最小失败测试，再实现通过；不得在 route 中临时加入 vendor branch 后留待清理。

## 测试策略

### OAuth 与 credential

- authorization URL、5 scopes、固定 redirect、state。
- 自动 callback、manual URL、两者竞速、timeout、cancel 和 listener cleanup。
- token exchange、userinfo email、缺 email。
- `loadCodeAssist`、tier 选择、`onboardUser` polling、缺 project。
- 5 分钟 refresh window、single-flight/CAS、refresh-token retention。
- 401/403 强制 refresh 恰好一次。

### Catalog 与 aliases

- daily/prod discovery、custom baseURL 单 endpoint。
- 非空权威结果、可重试 snapshot fallback、401/403 不 fallback、有效空目录。
- last-known-good 和 6 小时 TTL。
- denylist、`isInternal` 和 effort-family collapse。
- 只生成 target 完整的 alias variants。
- 新账号写 aliases；re-login 保留用户编辑。

### Runtime 与 routing

- Gemini same-protocol raw 优先。
- OpenAI Responses、OpenAI Chat Completions、Anthropic Messages 跨协议走 model capability。
- Provider weight/config order 和跨 Antigravity Provider fallback。
- daily → prod endpoint policy、Retry-After、no-capacity、普通 4xx。
- stream preflight 前可 fallback，提交后不重放。
- JSON 与 SSE envelope 解包、usage 和 finish reason。

### Session 与 replay

- 每个 session source 的优先级和 namespace。
- request IDs 明确不参与 session。
- deterministic signed-decimal wire session。
- logical request ID 在 endpoint/auth/provider retries 间复用。
- generation 防止旧 completion 覆盖新 replay。
- 1 小时滑动 TTL、10,240 上限和跨 Provider cache key。
- signature-invalid 400 generation-guarded clear。

### Thinking、tools 与 search

- Anthropic disabled、fixed budget、adaptive 四档和 validation 400。
- Gemini effort → wire ID 与 thinking config 一致。
- signature round-trip、reasoning egress 和 function-call replay。
- schema normalizer 的每条 CPA 规则、幂等性和 input immutability。
- Anthropic typed web search、empty domains、unsupported model。
- grounding redirect HEAD success/failure/timeout。

### Token counting

- Anthropic 与 Gemini route shape。
- normal model resolution、weight 和 fallback。
- Antigravity `v1internal:countTokens` request/response。
- unsupported/all-failed local estimate。
- estimate header，标准 JSON 不增加私有字段。

### 发布与回归

- built-in identity 不被 npm cache 覆盖。
- CLI/standalone binary 包含插件和依赖。
- GitHub Copilot、OpenAI ChatGPT plugin contract tests 不回归。
- route files 仍保持 thin registration。
- 最终运行 `bun run preflight`。

## 验收标准

- `aio-proxy provider login @aio-proxy/plugin-google-antigravity` 可完成浏览器或 manual callback 登录，并创建带邮箱 label、project ID 和初始 catalog 的 OAuth Provider。
- 同一 Google 账号 re-login 更新 credential，但不覆盖用户 alias、weight、enabled、name 或其他通用 Provider 配置。
- `/v1/models` 展示动态可用或合法 snapshot fallback 的逻辑模型，并保留用户显式配置的 aliases；即使 alias target 后续从目录消失，也继续按用户配置尝试上游。
- Gemini raw、OpenAI/Anthropic/Gemini cross-protocol model invocation 均可通过 Antigravity 工作。
- daily endpoint 网络/容量失败可切 prod；Provider attempt 失败后现有 candidate loop 可切下一个 Antigravity Provider。
- thinking/signature/reasoning 在 stateless 多轮请求中保持 best-effort 连续性，且 Provider fallback 不切断 cache。
- Anthropic typed web search 可触发 CCA googleSearch，并保留或修复 grounding URLs。
- Anthropic/Gemini token-count endpoints 优先调用真实 Antigravity countTokens，不支持或全失败时返回标准估算响应并带 estimate header。
- 永久 auth、catalog 和 runtime 问题显示现有稳定诊断；请求级错误保持入站协议形状。
- 所有相关测试通过，`bun run preflight` 成功。

## 已否决方案

### 新增 Antigravity provider kind

否决。OAuth plugin seam 已能封装账号、catalog、raw/model capabilities；新增 provider kind 会把 vendor 分支重新引入 config、server 和 route。

### 始终合并动态目录与静态快照

否决。它会长期暴露账号无权限或上游已移除的模型。快照只处理可重试发现失败。

### 以 `x-session-id` 作为 canonical session

否决。它是常见扩展但不是跨厂商标准，不能覆盖 OpenAI `conversation` 等协议原生语义。

### 使用 request-id 作为 session

否决。`X-Client-Request-Id`、`x-request-id` 和 Anthropic `request-id` 表示单次请求追踪，会破坏多轮连续性。

### 完整复制 Hub trajectory/step 链并串行同会话请求

否决。它增加状态机、锁和队头等待，而 aio-proxy 只需要稳定 session 与 replay continuity。确定性 session + generation guard 更适合代理服务器并发模型。

### 完全复制 CPA 的 last-completion-wins replay

否决。慢旧请求可能覆盖较新请求已提交状态。generation guard 保留并发能力并消除该回滚。

### 新增 Antigravity 专用全局诊断码

否决。现有诊断 seam 已覆盖 authorization、refresh、catalog 和 runtime failure；细分原因应留在脱敏日志，不扩大公共类型和 Dashboard 状态机。
