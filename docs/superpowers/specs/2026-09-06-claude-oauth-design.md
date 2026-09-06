# Claude Pro/Max OAuth Provider 设计

日期：2026-09-06  
状态：待用户规格审阅

## 背景

aio-proxy 已有 built-in OAuth plugin、loopback 授权、credential refresh port、TTL model catalog 和 ProviderV4 model capability，也已有 kind `api` 的 Anthropic API-key Provider。仓库尚未支持用 Claude Pro / Max 订阅 OAuth（而不是 `ANTHROPIC_API_KEY`）登录并调用模型。

本设计跟随 oh-my-pi 的 Anthropic 订阅流。CLIProxyAPI 当前把换票打到 `platform.claude.com`（注释写 Claude Code 2.1.220），但本插件不做 Firefox uTLS，token / refresh 仍用 `https://api.anthropic.com/v1/oauth/token`。身份、refresh 的 `anthropic-beta`、以及会签发 inference token 的 token URL，都以 oh-my-pi `anthropic` auth rule 与 `anthropic-identity` hook 为准。早期「platform = console token、不能 `user:inference`」对 *当前* CPA 不一定成立；对照见文末。

## 目标

- 新增随 aio-proxy 发布的 built-in `@aio-proxy/plugin-anthropic-claude`。
- 使用现有 `context.authorization.loopback` 完成 Claude Pro/Max PKCE 授权码登录；支持宿主已有的手动粘贴 callback URL。
- 在 code exchange 之后（以及 refresh 后身份缺失时）按 oh-my-pi `anthropic-identity` 补齐 account/org 字段。
- 用账号 access token 对官方 Anthropic `/v1/models` 做 TTL 发现，并只在可重试失败时使用 curated Sonnet/Opus/Haiku snapshot。
- 通过已安装的 `@ai-sdk/anthropic` 以 OAuth Bearer 调用 language model。
- CPA / omp import 识别 `type: "claude"`，导入后的 credential 形状与登录相同。
- 保持现有 model-first routing、Provider ID、Provider priority、Provider weight 和 candidate fallback 不变。

## 非目标

- 不实现 Anthropic API-key Provider；该能力已经以 kind `api` 存在。
- 不实现 Foundry，也不读取 `CLAUDE_CODE_USE_FOUNDRY`。
- 不为本插件增加 device-code；不实现 Codex device-code、Gemini CLI、Z.AI、OpenRouter 或 Muse。
- 不修改 `@aio-proxy/plugin-sdk` 的 `AuthorizationPort`，不新增 loopback / device 方法。
- 不实现 quota reset，也不在 v1 暴露任何 quota capability。
- 不实现账号池、额度感知调度或 provider-specific cooldown。
- 不提供 raw passthrough，也不实现 token-count capability。
- 不伪造 TLS / browser fingerprint（CPA 的 Firefox uTLS），不生成 `claude_device_ids`，不叠加 Claude Code beta 长列表。
- 不抽取通用 PKCE / loopback 框架，也不修改 ChatGPT、Antigravity 或其他 OAuth 插件行为。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 插件边界 | 独立 built-in `@aio-proxy/plugin-anthropic-claude`，OAuth adapter ID 为 `default` |
| Account options | 空对象，不新增用户配置 |
| 展示文案 | pluginLabel `Claude Pro/Max` / `Claude Pro/Max`；pluginDescription `Use a Claude Pro or Max account to access models` / `使用 Claude Pro 或 Max 账号访问模型`；adapterLabel `Login with Claude` / `使用 Claude 登录` |
| Icon | Lobe key `'anthropic'` |
| OAuth flow | PKCE S256 + 现有 `authorization.loopback`；hostname `localhost`，port `54545`，path `/callback`，`allowManualCallbackUrl: true` |
| OAuth client | 公开 client ID `9d1c250a-e61b-44d9-88ed-5944d1962f5e`（oh-my-pi / CPA 的 base64 `OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl`）。任务简述里的 `88e4` 与该 base64 不符，以可验证的 base64 为准 |
| Authorize | `https://claude.ai/oauth/authorize`，query 含 `code=true` |
| Token + refresh | `https://api.anthropic.com/v1/oauth/token`，JSON body。不跟随 CPA 当前 `platform.claude.com`（见下方对照） |
| Scopes | 空格分隔：`org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` |
| 身份 | token JSON 的 `account` / `organization`；缺失时 GET `https://api.anthropic.com/api/claude_cli/bootstrap`。org 只在登录时写入 |
| Fingerprint | 不可逆 SHA-256：只哈希 `account:<uuid>`。没有 `accountId` 则登录/导入失败（有 email 也不够）。格式 `sha256:<hex>`。`suggestedKey = 'claude-' + hex.slice(0, 12)` |
| CPA import | `types: ['claude']`，credential 形状与登录相同 |
| 模型发现 | OAuth Bearer GET `https://api.anthropic.com/v1/models`，TTL 6 小时，分页直到 `has_more` 为假 |
| Catalog fallback | 仅可重试发现失败：`claude-sonnet-5`、`claude-opus-5`、`claude-haiku-4-5` |
| Model extra | `{ protocol: 'anthropic' }`。`protocol` 必须放在 `extra`，不能放进 `modelMetadata`（宿主会剥掉未知 metadata 键） |
| Model codec | 已安装的 `@ai-sdk/anthropic` 4.0.3，`authToken` + `baseURL: 'https://api.anthropic.com/v1'` |
| Runtime capability | ProviderV4 `languageModel` only；不声明 raw、embedding、image、speech、tokenCount |
| OAuth beta | 所有需要 OAuth 推理/控制面兼容的请求写入 `anthropic-beta: oauth-2025-04-20`。不追加未验证的 Claude Code 额外 beta |
| Quota | v1 完全省略 `quota`。oh-my-pi 的 extra-usage remaining ratio 不是普遍、单形状字段，不能当稳定只读额度 |

## 插件与宿主边界

`packages/plugins/anthropic-claude/` 负责：

- PKCE、authorize URL、code exchange、refresh 和 identity bootstrap；
- credential schema、账号 fingerprint、suggested Provider ID 和展示 label；
- 动态模型发现、`claude-` language model 过滤、分页和 curated fallback；
- `@ai-sdk/anthropic` ProviderV4 与注入当前 access token 的 dynamic fetch；
- CPA `claude` 文件到 `ClaudeCredential` 的转换。

宿主继续负责：

- loopback 监听、打开浏览器、打印 authorize URL、手动粘贴 callback URL / code；
- credential 持久化、refresh single-flight、revision CAS 和 lease；
- catalog TTL、last-known-good 和 Provider ID 配置；
- candidate selection、protocol conversion、fallback、请求记录和对外错误。

route、pipeline 和公共 plugin SDK 不增加 Claude 分支或新 `AuthorizationPort` 方法。

## OAuth 登录

### Client ID 与嵌入

公开 client ID 是：

```text
9d1c250a-e61b-44d9-88ed-5944d1962f5e
```

oh-my-pi 把它存成 base64 `OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl`。对该字符串做 `atob` 得到上面的 UUID；CPA 源码使用同一 UUID。任务简述中的 `88e4` 是笔误，实现必须使用 `88ed`，否则 authorize / token 会被 Anthropic 拒绝。

源码不得出现明文 client ID。`rslib.config.ts` 把 base64 拆成两段再 `atob`，通过 `defineLibraryConfig({ source: { define: { __AIO_PROXY_CLAUDE_CLIENT_ID__: JSON.stringify(claudeClientId) } } })` 打进产物。`test/setup.ts` 把同一值赋给 `globalThis`，供 `bun test` 使用。`oauth.smoke.ts` 断言源文件没有明文或完整 base64，产物含明文 ID 且不含 `atob(`。

Client ID 的 SHA-256 hex（用于 smoke 固定指纹，不是账号 fingerprint）是：

```text
473668f2b13c71009d028ff0ef74c2cf76e71cbdd33b76e69fcc42d7e59aca4b
```

### Authorize

插件生成 32 字节 PKCE verifier 与 S256 challenge、32 字节 `state`，然后只调用现有：

```ts
const { code, redirectUri } = await context.authorization.loopback({
  state,
  redirect: { hostname: 'localhost', port: 54545, path: '/callback' },
  authorizationUrl: ({ redirectUri: selectedRedirectUri }) =>
    buildClaudeAuthorizationUrl({ challenge, redirectUri: selectedRedirectUri, state }),
  allowManualCallbackUrl: true,
});
```

插件不得调用 `presentDeviceCode`，也不得再调用 `presentAuthorizeUrl`：宿主 loopback 自己打开/打印 authorize URL，并在浏览器到不了本机时接受手动 callback。

Authorize URL 必须是：

```text
https://claude.ai/oauth/authorize
  ?client_id=<public client id>
  &code=true
  &code_challenge=<S256 challenge>
  &code_challenge_method=S256
  &redirect_uri=<host-selected redirect>
  &response_type=code
  &scope=org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload
  &state=<state>
```

`code=true` 是 oh-my-pi `authorize-params` 的锁定查询项。`redirect_uri` 必须使用 loopback 返回的 `redirectUri`，不得写死字符串。端口必须是 `54545`，禁止 `port: 'dynamic'`：Anthropic 公共 client 只登记该 URI。CLI 在固定端口占用且允许手工粘贴时**不会**改绑其它端口，而是继续使用 `http://localhost:54545/callback` 等用户粘贴。v1 手工粘贴只接受完整 callback URL；不解析 oh-my-pi 的裸 `code[#state]`。OpenRouter 的宿主 parse 门控按 authorize URL 是否带 `state` 决定；本插件 authorize URL **发送** `state`，因此缺 state 的 callback 仍被拒绝。

登录开始时可 `progress` 一次「Waiting for Claude authorization / 正在等待 Claude 授权」。`context.signal` 必须传到后续 token / identity 请求。

### Code exchange

成功拿到 `code` 后，向 token URL 发送 JSON POST（**不是** form）。字段顺序与 Claude Code / CPA 观察到的 key 顺序一致：

```json
{
  "grant_type": "authorization_code",
  "code": "<code>",
  "redirect_uri": "<loopback redirectUri>",
  "client_id": "<public client id>",
  "code_verifier": "<pkce verifier>",
  "state": "<state>"
}
```

请求头：

```text
Accept: application/json
Content-Type: application/json
```

code exchange **不**带 `anthropic-beta`。oh-my-pi 写明：Claude Code 只在 refresh 上发送该 beta，不在初次换票上发送。

`aioProxy: { traffic: 'control' }` 必须设置。

成功响应必须提供非空 `access_token`、非空 `refresh_token` 和正数 `expires_in`。任一缺失则登录失败，且错误文本不得包含 code、verifier、token 或完整 upstream body。

控制面与推理 fetch 一律 `options.fetch ?? context.fetch ?? globalThis.fetch`（Kimi `plugin.ts` / `runtime.ts` 同款）。禁止直接打 `globalThis.fetch`，否则会绕过宿主代理、录制和 traffic 标记。

`expiresAt` 按锁定公式计算：

```ts
expiresAt = now() + expires_in * 1000 - 5 * 60_000
```

5 分钟 skew 已经写进存储值。因此 `currentClaudeCredential()` 在 `now() >= expiresAt` 时刷新，**不要**再叠加 xAI/Kimi 那种 `now() + 5 * 60_000` 窗口，否则会提前 10 分钟刷新。

### 身份

token JSON 可能直接带：

```ts
{
  account?: { uuid?: string; email_address?: string };
  organization?: { uuid?: string; name?: string };
}
```

字段映射锁定为：

| 来源 | credential |
| --- | --- |
| `account.uuid` | `accountId` |
| `account.email_address` | `email`（trim + lower-case） |
| `organization.uuid` | `organizationId` |
| `organization.name` | `organizationName` |

登录阶段：若 `accountId` 与 `email` 都在，且 `organizationId` 也在，则不打 bootstrap。任一缺失则 GET：

```text
GET https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-8
Authorization: Bearer <access token>
Accept: application/json, text/plain, */*
Content-Type: application/json
User-Agent: claude-code/2.1.246
anthropic-beta: oauth-2025-04-20
```

`claude-opus-4-8` 是 oh-my-pi identity hook 当前使用的 bootstrap 探针模型，不是 catalog fallback 模型。`User-Agent` / SDK 版本取自 2026-09-06 读到的 oh-my-pi Claude Code fingerprint（PR 9801：`2.1.246` / `0.112.1`）。它们是冻结兼容指纹；本仓库 catalog 的 `@anthropic-ai/sdk` 是 `0.111.0`，不要改成该版本。版本漂移另开任务，禁止实现时静默 bump。

bootstrap JSON 读取：

```ts
oauth_account.account_uuid
oauth_account.account_email
oauth_account.organization_uuid
oauth_account.organization_name
```

只填补缺失字段，不覆盖 token 响应里已经有的值。bootstrap 失败（network、非 2xx、无效 JSON）本身不抛：保留已有 token 与已解析字段。若此时仍没有 `accountId`，`claudeLoginResult` 必须失败——仅有 email 也不行。`AbortError` / `context.signal.aborted` **必须**原样抛出（`signal.reason`），不得当成非致命 bootstrap 失败而继续 `claudeLoginResult`。手动 `refreshCredential` 同样如此。

登录只捕获一次 organization。refresh 不得改写已存储的 `organizationId` / `organizationName`：token JSON 即使带了不同的 `organization`，以及 bootstrap 即使返回了 org，都丢弃。`refreshClaudeCredential` 始终保留已存 org 字段。

### Credential 与 fingerprint

```ts
type ClaudeCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly email?: string;
  readonly accountId?: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
};
```

Zod schema 与该形状一一对应：三个 token 字段必填，四个身份字段 optional 且非空 string。

账号 fingerprint 只哈希 `account:<accountId>`（`accountId` 只 trim，不改大小写）。没有 `accountId` 时，`claudeLoginResult` 抛 `ClaudeIdentityMissingError`，即使有 email。禁止 `email:<addr>` 与 `refresh:<token>`：前者会在 refresh/重登补到 `accountId` 后改 fingerprint，宿主 `persistOAuthAccount` 会抛 `ProviderFingerprintMismatchError`。email 只用于 `accountLabel`，仍可选。这比 CPA「必须有 email」宽松，但要求稳定的 account UUID。

输出：

```ts
{
  fingerprint: `sha256:${hex}`,
  suggestedKey: `claude-${hex.slice(0, 12)}`,
  accountLabel: email ?? organizationName ?? 'Claude Pro/Max',
  credentials,
  expiresAt: credentials.expiresAt,
}
```

`sha256:` 前缀与 xAI 插件一致，便于宿主把算法写进 fingerprint。`suggestedKey` 只用 hex 前 12 位，不含前缀。

v1 **不**把 organization 编进 fingerprint。oh-my-pi 后续用 org 区分同一 email 下的多个订阅 workspace；本任务锁定的公式没有 org。同一 Anthropic account 的多个 org 在 v1 会得到同一个 Provider ID 建议。这是接受的限制，不是实现漏洞。

原始 access / refresh token、code、verifier 不得进入 Provider ID、label、日志或错误。

## Credential refresh

### 自动刷新（`currentClaudeCredential`）

runtime、catalog 与 identity 补齐都先经 `CredentialPort` 读当前 credential。当 `now() >= expiresAt` 时调用 `port.refresh()`，由宿主 single-flight / CAS。

refresh POST JSON：

```json
{
  "grant_type": "refresh_token",
  "client_id": "<public client id>",
  "refresh_token": "<stored refresh token>"
}
```

请求头（oh-my-pi 写明这些头只出现在 refresh，不出现在初次换票）：

```text
Accept: application/json
Content-Type: application/json
anthropic-beta: oauth-2025-04-20
User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider
```

`aioProxy: { traffic: 'control' }` 必须设置。

规则：

- 响应省略 `refresh_token` 时保留旧 refresh token。
- 有新 refresh token 时原子替换。
- `expiresAt = now() + expires_in * 1000 - 5 * 60_000`。
- 保留已存储的 `organizationId` / `organizationName`。
- 若刷新后 `accountId` 或 `email` 仍缺失，再跑一次 bootstrap；只填补 account/email，**不**写入 org。
- 向宿主返回新的 `expiresAt`；`accountLabel` 在有 email 时更新为规范化 email。

### 手动刷新（`refreshCredential`）

adapter 必须实现 `refreshCredential`。宿主在用户手动刷新时无条件调用它，即使 credential 尚未过期。实现不得按 `expiresAt` 短路；必须真正打 token URL。

### 错误分类

| 情况 | `CredentialRefreshError.retryable` | `reason` |
| --- | --- | --- |
| network / abort 以外的 fetch 失败 | `true` | `network` |
| 408 / 429 / 5xx | `true` | `http`（429/408）或 `upstream_5xx` |
| `invalid_grant` | `false` | `invalid_grant` |
| 401 / 403 / `invalid_client` | `false` | `rejected` |
| 其他 4xx | `false` | `http` |
| 无效 JSON、缺 access token、缺正数 `expires_in` | `false` | `invalid` |

错误对象只含 status 与稳定 reason。不得放入 request JSON、token 或完整 upstream body。`AbortError` 原样抛出，不当成 refresh 失败。

## 模型发现

catalog policy：`{ kind: 'ttl', ttlMs: 6 * 60 * 60_000 }`。

发现先 `currentClaudeCredential()`，再请求：

```text
GET https://api.anthropic.com/v1/models?limit=1000
Authorization: Bearer <access token>
Accept: application/json
anthropic-version: 2023-06-01
anthropic-beta: oauth-2025-04-20
```

`aioProxy: { traffic: 'control' }`。官方默认 `limit` 是 20，必须显式拉满并分页：仅当 `has_more === true` **且** `last_id` 为非空 string 时，用 `after_id` 继续。`has_more` 而无 `last_id` 视为无效 envelope（可重试）。最多 10 页；仍 `has_more` 则抛可重试 `ClaudeCatalogError`，避免把截断目录当成完整账号目录。401 / 403 以及其它 4xx（400 / 404 等）不可重试、不得 fallback。

接受 Anthropic envelope `{ data: [...], has_more, last_id }`。每个可用 entry 必须：

- `id` 为 trim 后非空 string，且以 `claude-` 开头；
- `type` 为 `'model'` 或不存在。

动态结果是账号当前可调用 language model 的权威集合。已知 curated ID 只补充缺失的 `displayName`；成功发现时不得把动态结果没有的 curated 模型并回去。

`displayName` 优先用官方 `display_name`；否则用 curated overlay；再否则省略。

每个 language descriptor 的 `extra` 固定为 `{ protocol: 'anthropic' }`。image / embedding / speech / transcription / reranking 均为空数组。

### Fallback

`initialFallback` 只在宿主第一次登录（尚无 account）且插件判定错误可重试时返回 snapshot。后续 refresh 由宿主保留 last-known-good。

可重试：

- network / timeout；
- 408 / 429 / 5xx；
- 无效 JSON / 无效 envelope；
- 分页未完成。

不可重试、不得 fallback：

- `AbortError` / 用户取消；
- 401 / 403；
- HTTP 成功但过滤后 language 为空（空目录是权威结果）。

curated snapshot 使用 2026-09-06 Anthropic Models overview 的 **当前** Sonnet / Opus / Haiku 公开 ID（不含 Fable，任务要求只要这三族）：

| id | displayName | 依据 |
| --- | --- | --- |
| `claude-sonnet-5` | Claude Sonnet 5 | 当前 Sonnet API / alias |
| `claude-opus-5` | Claude Opus 5 | 当前 Opus API / alias |
| `claude-haiku-4-5` | Claude Haiku 4.5 | 当前 Haiku alias；官方 pinned API ID 是 `claude-haiku-4-5-20251001` |

fallback 使用 dateless 当前名，因为它们是文档中的 current IDs。不发明 `claude-sonnet-5-preview` 之类 ID，也不把仍在售的 4.6/4.8 旧代模型塞进 v1 snapshot。

## Runtime

```ts
createAnthropic({
  name: 'anthropic-claude-oauth',
  baseURL: 'https://api.anthropic.com/v1',
  authToken: 'dynamic-credential',
  fetch: createClaudeDynamicFetch(credentials),
});
```

ProviderV4 只实现 `languageModel(modelId)`。`embeddingModel` / `imageModel` 抛「Claude Pro/Max OAuth does not support …」。不声明 `raw`、`tokenCount`。

v1 明确选择 model-only：同协议 Anthropic Messages raw 还需要 `anthropic-version`、可能的 Claude Code 指纹头，以及一套未在本仓库证明可安全复用的 beta 列表。Kimi 的 raw 走的是 Kimi 自己的 coding 网关，不能当作 Anthropic 官方 OAuth raw 的证据。未证明之前不提供 raw。

每次 dynamic fetch：

1. 用请求 signal 调用 `currentClaudeCredential()`；
2. 删除 `authorization`、`proxy-authorization`、`cookie`、`host`、`x-api-key`、`x-goog-api-key`、`anthropic-api-key`；
3. 写入 `Authorization: Bearer <accessToken>`；
4. 若没有 `anthropic-version`，写入 `2023-06-01`；
5. 确保 `anthropic-beta` 含 `oauth-2025-04-20`。若 AI SDK 已写其他 beta，按逗号拆开、去空、去重后把该 beta 放在最前再拼回；
6. 若没有 `User-Agent`，写入 refresh 同款 `anthropic-sdk-typescript/0.112.1 userOAuthProvider`；
7. 保留 method、body（非 GET/HEAD）、abort signal、redirect 和其他非 authorization 头。

推理请求是 model traffic：不要标 `aioProxy.traffic = 'control'`。不要写 `Connection`，不要伪造 TLS / browser fingerprint。

上游非成功 response 原样交给 AI SDK 和现有 candidate loop。插件不内部 retry，不跨账号调度。

已验证必须带的推理 beta 只有 `oauth-2025-04-20`（oh-my-pi PR 9801：缺它会让订阅 OAuth 被拒）。oh-my-pi 推理路径还叠了一长串 Claude Code beta；那些是 Claude Code 指纹，不是本插件已证明的最小集。v1 **只**保证 `oauth-2025-04-20`，不发明 extras。

## Quota

v1 **完全省略** `quota`。adapter 不设置该字段。

oh-my-pi 能从 OAuth `GET /usage` 解出 5h/7d 桶，以及可选的 Extra-usage `spend` / 遗留 `extra_usage`。Extra-usage remaining ratio **不是**稳定通用字段：

- 只有开通 Extra usage 的账号才有；
- 当前 `spend` 与遗留 `extra_usage` 两套形状；
- uncapped（`limit: null`）没有 remaining ratio；
- oh-my-pi 自己也把它标成 display-only，不参与 credential gating。

任务要求：只有存在稳定 extra-usage remaining ratio 时才做只读 quota，否则整段省略，且不得伪造百分比。因此 v1 不读 `/usage`，不返回 5h/7d item，也不返回 extra-usage item。后续若要加 quota，另开任务，且必须能从单一权威字段算出真实 `remainingRatio`。

## Built-in 注册

`packages/core/src/plugins/builtins.ts` 按现有名字的字典序插入 `@aio-proxy/plugin-anthropic-claude`（排在 `plugin-cursor` 之前）。`createEmbeddedBuiltIns()` 使用同一顺序。

中英文展示由 core 注入：

- plugin label：`Claude Pro/Max` / `Claude Pro/Max`
- description：`Use a Claude Pro or Max account to access models` / `使用 Claude Pro 或 Max 账号访问模型`
- adapter label：`Login with Claude` / `使用 Claude 登录`
- waiting：`Waiting for Claude authorization` / `正在等待 Claude 授权`

`packages/core/package.json` 增加 `"@aio-proxy/plugin-anthropic-claude": "workspace:*"`。`.changeset/config.json` 的 `fixed` 组必须加入新包，插在 `@aio-proxy/plugin-cursor` 之前。

CLI 里枚举 built-in 的测试一并更新：

- `packages/cli/src/plugin-commands/plugin/add.test.ts`
- `packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`
- `packages/cli/__tests__/binary-build.test.ts`

Dashboard 走现有 built-in catalog，不新增 dashboard 文件。

这些宿主文件也是 OpenRouter / Muse 等并行 PR 的碰撞面。实现顺序：先合本 PR，再 OpenRouter（唯一宿主 parse），最后 Muse。最后任务只按字母序 **插入** 本包名，不得用六插件快照覆盖已落地的兄弟包；也不要回填 `capability.resolution.test.ts` / `binary-build.test.ts` 里故意缺的 `@aio-proxy/plugin-xai-grok`。不要另开「共享脚手架」PR。

## CPA / omp import

`credentialImports.cpa.types` 锁定为 `['claude']`。宿主按 CPA 文件顶层 `type` 分发；omp 导入映射到同一 `claude` type。

接受的松散 JSON（`.loose()`）。字段名同时覆盖 oh-my-pi 嵌套形状和 CPA `ClaudeTokenStorage` 扁平形状（`internal/auth/claude/token.go`）：

```ts
{
  type: 'claude',
  access_token: string,      // 必填
  refresh_token: string,     // 必填
  expired?: unknown,         // CPA 键名 `expired`；能 Date.parse 的 string 则用该毫秒值；否则 0
  email?: string,
  account?: { uuid?: string; email_address?: string },
  account_id?: string,
  account_uuid?: string,           // CPA 扁平键
  organization?: { uuid?: string; name?: string },
  organization_uuid?: string,      // CPA 扁平键
  organization_name?: string,      // CPA 扁平键
}
```

忽略 `id_token`、`last_refresh`、`claude_device_ids`、`base_url` 等未知键。`expired` 是绝对时间戳，**不再**减 5 分钟。`account_uuid` / `organization_*` 只在对应嵌套字段缺失时填补。

导入后走与登录相同的 `claudeLoginResult()`。若 `accountId` 仍缺，用 `options.fetch ?? context.fetch ?? globalThis.fetch` 做一次非致命 identity bootstrap，再调用 `claudeLoginResult`。CLI 导入路径不传 `ImportOAuthAccountOptions.fetch`，因此 **不得** 把 bootstrap 门控在 `context.fetch` 上。bootstrap 之后仍没有 `accountId` 则该文件导入失败。

## 测试策略

实现遵循 test-first，每个行为只保留最小有价值回归：

1. Fingerprint / login result：只哈希 `account:<uuid>`；无 `accountId` 则失败（email-only 也失败）；suggestedKey；secret 不出现在 fingerprint 明文。补上 email 或轮换 refresh 不改变 fingerprint。
2. Authorize URL：固定 host/port/path、PKCE S256、`code=true`、完整 scope、使用宿主 redirect。
3. Code exchange：JSON body 字段、**不**带 beta、control traffic、缺 refresh/expiry 失败、错误不泄漏 secret。
4. Identity：token 已含身份则不打 bootstrap；缺失则 bootstrap；bootstrap 失败不阻断登录；refresh 不改写 org。
5. Refresh：省略 refresh token 时保留旧值；5xx retryable；`invalid_grant` non-retryable；`expiresAt` 含 5 分钟 skew；`currentClaudeCredential` 在 `now >= expiresAt` 时刷新；手动 `refreshCredential` 对未过期 credential 仍换票。
6. Catalog：Bearer `/v1/models`、分页、`claude-` filter、`extra.protocol`、可重试 fallback，以及 401 / 空目录不 fallback。
7. Runtime：ProviderV4 model-only、官方 base URL、Bearer + `oauth-2025-04-20`、去掉 placeholder / API key 头、保留 abort/body。
8. Plugin / CPA / built-in：默认 descriptor、空 account options、localized copy、icon、`claude` import、embedded 注册。

## 发布 / changeset

新包 `package.json` version 为 `0.19.2`，与当前 lockstep 对齐；changeset minor 后整组到 `0.20.0`。

只写 **一个** changeset，同时 target：

- `@aio-proxy/plugin-anthropic-claude`（minor）
- `@aio-proxy/core`（minor）
- `aio-proxy`（minor）

禁止只 target 内部包。不要跑 `changeset version` / `publish`。

## 验收标准

- `aio-proxy provider login` 可选择 Claude Pro/Max，打开 `claude.ai` authorize，并在授权或粘贴 callback 后创建 OAuth Provider ID。
- Provider ID 建议为 `claude-` + fingerprint hex 前 12 位；label 优先 email。
- 登录、刷新、发现可被取消，且不会泄漏 token。
- `/v1/models` 展示该 OAuth 账号从官方 Anthropic endpoint 动态发现的 `claude-` language models，且 `extra.protocol === 'anthropic'`。
- 官方发现暂时失败时，新账号可使用三条 curated fallback；401/403 或合法空目录不伪造模型。
- 任一入站协议经现有转换路径调用这些 model；实际上游是 `https://api.anthropic.com/v1` 的 AI SDK Anthropic 请求，带 OAuth Bearer 与 `oauth-2025-04-20`。
- CPA `type: "claude"` 文件可导入为同一 credential 形状。
- 不出现 quota 读/重置入口。
- access token 到已存储的 `expiresAt` 之后经宿主 credential port 更新；并发刷新仍由宿主 single-flight/CAS 保证。

## 已验证事实与未独立验证项

已从 oh-my-pi `anthropic.kdl`、`anthropic-identity` hook、Anthropic Models API 文档和本仓库 ChatGPT/Kimi/xAI 插件核对：

- authorize / token URL、scopes、`code=true`、PKCE、callback `54545/callback`；
- token JSON 的 account/org 字段名与 bootstrap URL / 字段；
- refresh 使用 JSON body + `oauth-2025-04-20` + Claude-Code-like User-Agent；
- 当前公开模型 ID `claude-sonnet-5` / `claude-opus-5` / `claude-haiku-4-5`；
- 宿主 loopback 已支持 `allowManualCallbackUrl`，无需新 port 方法；
- `@ai-sdk/anthropic` 已在 catalog，Kimi 已证明 `authToken` + dynamic fetch。

未能独立向 Anthropic 发直播请求核实：

- User-Agent 版本 `0.112.1` / `2.1.246` 来自 2026-09-06 的 oh-my-pi 源码与 PR 9801，不是本仓库对 Claude Code 的持续跟踪；
- OAuth Bearer 调 `/v1/models` 的精确过滤集（按官方 list 形状 + `claude-` 前缀处理）；
- 订阅账号是否总能调用 dateless alias（fallback 仍使用文档 current IDs）。
- CPA `platform.claude.com` 换票在无 uTLS 时是否被 Cloudflare 挡住；本设计不测这条路径。

## 与 CLIProxyAPI 的对照（2026-09-06 `main`）

依据：https://github.com/router-for-me/CLIProxyAPI `main`（2026-09-06）`internal/auth/claude/anthropic_auth.go`、`token.go`、`oauth_server.go`、`identity.go`，以及 `sdk/auth/claude.go`。这是对照，不是改跟。

| 点 | CPA `main` | 本设计 | v1 决策 |
| --- | --- | --- | --- |
| Authorize | `claude.ai/oauth/authorize`，`code=true`，PKCE S256，`localhost:54545/callback` | 相同 | 跟随 |
| Client ID | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | 相同 | 跟随 |
| Scope | `user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` | 上述再加 `org:create_api_key`（oh-my-pi） | 保持 omp。CPA 没有 `org:create_api_key` |
| Token / refresh URL | `https://platform.claude.com/v1/oauth/token`（注释：Claude Code 2.1.220 走这里）。更早曾用 `console.anthropic.com`（Cloudflare managed challenge，#1659）和 `api.anthropic.com`（#1660） | `https://api.anthropic.com/v1/oauth/token` | **不改跟 platform**。理由：本插件不做 uTLS；#1660 证明 `api.anthropic.com` 对非浏览器 POST 返回真实 OAuth 错误而不是挑战页；oh-my-pi 的 inference refresh 也在 api 域。早期「platform = console token、不能 `user:inference`」的说法对 *当前* CPA 不一定成立——CPA 认为 Claude Code 自己就打 platform。v1 仍锁 api 域，避免把 Cloudflare/uTLS 带进仓库 |
| 换票 body | 结构体字段顺序 `grant_type, code, redirect_uri, client_id, code_verifier, state`；`redirect_uri` 写死 | 同字段；`redirect_uri` 用 loopback 返回值 | 字段跟随。端口占用时 CPA 直接失败（`port already in use`）；我们仍用返回的 `redirectUri`，但 54545 不改绑 |
| `code#state` | `parseCodeAndState` 按 `#` 切开，fragment 覆盖 state | 宿主 v1 只收完整 callback URL | 不在本插件解析裸 `code#state`。CPA 的 loopback 本身也要求 query `code`+`state` |
| 换票头 | Axios 指纹：`Accept: application/json, text/plain, */*`，`User-Agent: axios/1.15.2`，`Connection: close`；无 `anthropic-beta` | `Accept/Content-Type: application/json`；无 UA；无 beta | 保持 omp。不抄 axios / Connection |
| 身份 | 换票后 GET `/api/oauth/profile` + `/api/oauth/claude_cli/roles`（失败只打日志）。profile **覆盖** token 里的 account/org | token 字段优先；缺则 GET `claude_cli/bootstrap`；失败不阻断；org 只在登录写一次 | 保持 omp bootstrap。不调用 CPA 的 profile/roles，也不在 refresh 里用 profile 改 org |
| Refresh body | `client_id` + `grant_type` + `refresh_token` + **`scope`（整份 ClaudeOAuthScope）** | `client_id` + `grant_type` + `refresh_token` | 不抄 `scope`。omp 的 refresh 带 `oauth-2025-04-20`，CPA refresh **不带** 该 beta |
| Refresh 头 | 同 axios 指纹 | `anthropic-beta: oauth-2025-04-20` + `User-Agent: anthropic-sdk-typescript/0.112.1 userOAuthProvider` | 保持 omp |
| `expiresAt` | `now + expires_in`，存 RFC3339，无 5 分钟 skew | 存 `now + expires_in*1000 - 5min` | 保持本仓库 skew |
| 并发 refresh | 进程内 singleflight + Retry-After 退避 | 宿主 credential port single-flight / CAS | 不在插件里再做一层 |
| TLS | Firefox uTLS，绕 Cloudflare | 普通 `fetch` | 明确不做 |
| Device | 登录生成 64-hex `claude_device_ids`，推理时当 Claude Code 设备指纹 | 不生成、不导入进 credential | 忽略 CPA 文件里的该数组 |
| 推理 | Messages raw + 一长串 Claude Code beta + 可选 CCH 签名 | ProviderV4 `@ai-sdk/anthropic`，只保证 `oauth-2025-04-20` | 保持 v1 最小集 |
| 存储 / 导入 | `type: "claude"`，扁平 `email` / `account_uuid` / `organization_uuid` / `organization_name` / `expired` | 同一 `type`，同时接受扁平 CPA 键和 omp 嵌套 `account` / `organization` | **补 CPA 扁平键**，否则真实 CPA 文件导不出 org/account |
| Email | `sdk/auth/claude.go` 在 `tokenStorage.Email == ""` 时登录失败 | 必须有 `accountId`；email 只做 label，可缺 | 要求的稳定字段不同。email-only 会在日后补到 `accountId` 后改 fingerprint，重登失败 |

Refresh 时 CPA 还会再用 profile **覆盖** email / account / org。本设计 refresh 只换票，不改已存 org。
