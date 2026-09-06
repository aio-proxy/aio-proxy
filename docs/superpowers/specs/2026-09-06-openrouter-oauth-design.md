# OpenRouter OAuth Provider 设计

日期：2026-09-06  
状态：待用户规格审阅

## 背景

aio-proxy 已有 built-in OAuth plugin、loopback 授权、TTL model catalog、ProviderV4 model capability 和只读 quota，但尚未提供 OpenRouter 的 PKCE 登录。用户今天只能把 OpenRouter 配成普通 `api` provider 并粘贴已有 key。

OpenRouter 的 OAuth 与标准 OIDC 不同：没有 client 注册，PKCE S256 是唯一客户端证明；授权码兑换的不是可刷新 access/refresh 对，而是用户名下、从 OpenRouter credits 扣费的**持久 API key**。上游依据：

- pi：`packages/ai/src/auth/oauth/openrouter.ts`（2026-09-06 拉取）
- oh-my-pi：`packages/catalog/src/compat/rules/auth/openrouter.kdl`（`state "none"`、`credential.access "key"`、`refresh "none"`、`result "api-key"`）
- OpenRouter 官方 OAuth PKCE 文档与 `POST /api/v1/auth/keys` OpenAPI

本仓库现有 CLI `parseCallback` 与 Dashboard `parseOAuthCallback` **都要求** callback URL 的 `state` 等于 `LoopbackRequest.state`。OpenRouter 既不接收也不回显 `state`，因此本设计包含一次最小宿主解析改动，而不是新的 SDK port。

## 目标

- 新增随 aio-proxy 发布的 built-in `@aio-proxy/plugin-openrouter`。
- 用现有 `context.authorization.loopback` 完成 OpenRouter PKCE，兑换持久 API key。
- SSH / 无头环境可通过 `allowManualCallbackUrl` 粘贴回跳 URL 或授权码。
- 使用账号 API key 动态发现当前可用模型，映射到 language catalog；仅在可重试失败时使用小型 curated fallback。
- 用已安装的 `@openrouter/ai-sdk-provider` 调用 OpenAI-compatible language models（以及发现结果里实际出现的 embedding / image）。
- 用官方 key 探活接口读取只读剩余额度比例；不声明 reset，不实现 refresh。
- 保持现有 model-first routing、Provider ID、Provider priority、Provider weight 和 candidate fallback 不变。

## 非目标

- 不提供 `OPENROUTER_API_KEY` 粘贴登录；用户已经可以添加 `api` provider。
- 不实现 Z.AI、Claude、Muse、Gemini CLI。
- 不修改 plugin-sdk 类型或新增 AuthorizationPort 方法。唯一允许的宿主改动是 CLI / Dashboard 共用的 callback 解析（纯函数进 `@aio-proxy/shared`，两宿主只做错误映射）。
- 不发明 native-scheme 回调、固定端口或 `presentAuthorizeUrl` + 插件自建等待循环。
- 不实现 `refreshCredential`，不写 `expiresAt`。
- 不实现 CPA importer（未发现稳定的 OpenRouter CPA `type`）。
- 不提供 raw passthrough。
- 不调用需要 Management key 的 `GET /api/v1/credits`。
- 不实现账号池、额度感知调度或 provider-specific cooldown。
- 不新增 dashboard 专用文件；展示走现有 built-in / catalog / quota 接口。

## 核心决策

| 决策点             | 结论                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 插件边界           | 独立 built-in `@aio-proxy/plugin-openrouter`，OAuth adapter ID 为 `default`                                                              |
| Account options    | 空对象，不新增用户配置                                                                                                                   |
| OAuth flow         | 非标准 PKCE：authorize `callback_url` + S256；token `POST /api/v1/auth/keys` JSON                                                        |
| Client 注册        | 无。S256 verifier 是唯一客户端证明                                                                                                       |
| Loopback           | `hostname: '127.0.0.1'`，`port: 'dynamic'`，`path: '/callback'`，`allowManualCallbackUrl: true`                                          |
| Host-only state    | 插件生成 `LoopbackRequest.state`，**不**发给 OpenRouter。宿主按**已打开的 authorize URL 是否带 `state` 查询**决定 callback 是否要求 state |
| Credential         | `{ apiKey: string; userId?: string }`。省略 `refreshCredential` 与 `expiresAt`。`userId` 来自 token JSON 的 `user_id`                     |
| Fingerprint        | 有 `userId` 时 `account:<userId>`，否则 `key:<apiKey>`；`suggestedKey = 'openrouter-' + hex.slice(0, 12)`；label 固定 `OpenRouter`        |
| 模型发现           | TTL 6 小时；`GET /api/v1/models?output_modalities=text,embeddings,image` Bearer key                                                      |
| Catalog protocol   | 目录不广告协议时一律 `extra.protocol = 'openai-compatible'`                                                                              |
| Catalog fallback   | 仅可重试发现失败时使用 8 个已观测的热门 OpenRouter id                                                                                    |
| Model codec        | `@openrouter/ai-sdk-provider` `createOpenRouter`（catalog `2.10.0`），包一层 ProviderV4                                                  |
| Runtime capability | ProviderV4 `languageModel` 必选；`embeddingModel` / `imageModel` 接到同一 provider；无 raw                                               |
| Quota capability   | `GET https://openrouter.ai/api/v1/key` 只读 remaining ratio；无 reset                                                                    |
| Icon               | `'openrouter'`（Lobe slug）                                                                                                              |

## 插件与宿主边界

`packages/plugins/openrouter/` 负责：

- PKCE S256 生成、非标准 authorize URL、`/auth/keys` 兑换与错误分类；
- credential schema、fingerprint、suggestedKey、展示 label；
- 动态模型发现、模态分类和 curated fallback；
- `createOpenRouter` + dynamic Bearer fetch；
- key 探活 JSON 与只读 quota 映射。

宿主继续负责：

- CLI / Dashboard 打开授权 URL、loopback 监听、手工粘贴回调；
- credential 持久化、revision CAS 和 lease（本插件不刷新，CAS 只用于将来宿主通用路径）；
- catalog TTL、last-known-good 和 Provider ID 配置；
- quota snapshot validation、API / CLI 展示和通用错误边界；
- candidate selection、protocol conversion、fallback、请求记录和对外错误。

**唯一宿主改动**：从已打开的 authorize URL 计算 `stateRequired = url.searchParams.has('state')`。ChatGPT / Antigravity / Claude 的 authorize URL 带 `state`，因此缺 state 的 callback **仍拒绝**（Antigravity 无 PKCE，state 是唯一 CSRF 绑定）。OpenRouter 的 authorize URL 不带 `state`，此时才允许缺 state 的 `code` / `error`。`LoopbackRequest` 类型不改。纯解析放进 `@aio-proxy/shared`，CLI 与 Dashboard 只映射既有错误类型。

route、pipeline 和公共 plugin SDK 不增加 OpenRouter 分支或新抽象。

## OAuth 登录

### 非标准 PKCE（无 client、无 state）

登录不发现 OIDC、不注册 client、不带 `client_id` / `scope` / `redirect_uri` / `state`。插件本地生成 PKCE：

```ts
// 与 @aio-proxy/plugin-openai-chatgpt 的 generatePKCE 同算法，实现复制进本包，不跨插件 import
type PKCE = { readonly challenge: string; readonly verifier: string };
```

`verifier` 为 32 字节 CSPRNG 的 base64url；`challenge` 为 SHA-256(verifier) 的 base64url。`code_challenge_method` 固定 `S256`。不使用 `plain`。

Authorize（浏览器打开的唯一 URL）：

```text
https://openrouter.ai/auth?callback_url=<loopbackRedirectUri>&code_challenge=<challenge>&code_challenge_method=S256
```

参数名是 OpenRouter 的非标准集合：`callback_url` **不是** `redirect_uri`。官方文档、pi 与 oh-my-pi 均不把 `state` 放进该 URL。OpenRouter 回跳只带 `code`（或 `error`），**不回显 state**。

Token：

```text
POST https://openrouter.ai/api/v1/auth/keys
Accept: application/json
Content-Type: application/json
```

```json
{ "code": "<authorization code>", "code_verifier": "<verifier>", "code_challenge_method": "S256" }
```

成功 JSON 必须有非空 string `key`，这就是持久 API key。OpenAPI 还可能返回 `user_id`。非空 `user_id`（trim）写入 `credentials.userId`，并作为 fingerprint 的稳定账号身份。重新登录会铸造新 key；若仍返回同一 `user_id`，fingerprint 必须不变，否则宿主 `ProviderFingerprintMismatchError` 会拒绝 reconnect。缺 `user_id` 时退回 `key:<apiKey>`（该账号后续换 key 会 mismatch，这是接受的降级）。错误对象只暴露 HTTP status 与稳定 reason，不包含 code、verifier、key 或完整 upstream body。

该请求与后续 catalog / quota 探活一律 `aioProxy: { traffic: 'control' }`。

### Loopback 与 host-only state

`LoopbackRequest.state` 在 SDK 里是必填非空 string（CLI `requireValidRequest` 拒绝空 state）。插件必须生成一个 host-only state（`crypto.randomUUID()`），传给 `loopback`，但 **authorize URL builder 不得把它写成查询参数**。

```ts
const state = crypto.randomUUID();
const pkce = await generatePKCE();
const { code } = await context.authorization.loopback({
  state,
  redirect: { hostname: '127.0.0.1', port: 'dynamic', path: '/callback' },
  allowManualCallbackUrl: true,
  authorizationUrl: ({ redirectUri }) => {
    const url = new URL('https://openrouter.ai/auth');
    url.searchParams.set('callback_url', redirectUri);
    url.searchParams.set('code_challenge', pkce.challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return url.href;
  },
});
```

路径固定 `/callback`。不使用 pi 的随机 path，也不使用 oh-my-pi 的固定端口 `54549`。CLI 与 Dashboard 的 `Bun.serve` 都绑定 `127.0.0.1`；redirect hostname 使用 `127.0.0.1` 可避免 `localhost` 与实际 bind 不一致。

`allowManualCallbackUrl: true` 覆盖：

- 本机浏览器打到 loopback（URL 为 `http://127.0.0.1:<port>/callback?code=...`，无 `state`）；
- SSH / 另一台机器的浏览器：用户从地址栏复制上述回跳 URL 并粘贴；
- OpenRouter 页上展示的授权码（官方 headless 模式）或用户只粘贴 `code` 值。

本设计**仍然发送 `callback_url`**，不采用官方「省略 callback_url、只在网页展示 code」的 headless 变体。loopback 是主路径；手工粘贴是备用。

### 宿主解析（必须改，且必须按 authorize URL 门控）

当前实现（CLI / Dashboard 各一份）：

```ts
if (callback.searchParams.get('state') !== expectedState) throw /* STATE_MISMATCH */;
```

OpenRouter 浏览器回跳与手工粘贴的 URL 都没有 `state`，`get('state')` 为 `null`，登录在兑换前就会失败。这不是 SDK 缺口，是宿主 parse 过严。

**禁止**全局「缺 `state` + 有 `code` 就接受」。Antigravity 使用固定端口 `localhost:51121` 且 **没有 PKCE**；ChatGPT / Claude 使用固定知名端口。全局放宽会让本机任意页面用 `?code=` / `?error=access_denied` 完成或中止进行中的登录。

锁定行为（不新增 port、不改 `LoopbackRequest`）：

宿主在 `buildAuthorizationUrl` 之后计算：

```ts
const stateRequired = new URL(authorizationUrl).searchParams.has('state');
```

然后把 `{ stateRequired }` 传给解析函数。检查顺序锁定为：URL 或（仅 `stateRequired === false` 时）loose-code → origin 匹配（仅 URL）→ state 门控 → `error` → `code`。`error` **不得**排到 state 门控之前。错 `state` 的 `error=access_denied` 仍不 settle（现有 `callback.automatic.test.ts` 不变量）。

1. **匹配 expected redirect 的 URL**（协议 / hostname / port / pathname，且无 userinfo / hash）：
   - `stateRequired === true`：缺 state 或 state 不等于 expected → `STATE_MISMATCH`（ChatGPT / Antigravity / Claude）。
   - `stateRequired === false`：缺 state 则继续；state 存在且不等于 expected → 仍 `STATE_MISMATCH`。
   - 然后：`error` 查询存在 → `AUTHORIZATION_DENIED`；无 `code` → `CODE_MISSING`；否则接受 `code`。
2. **`new URL(raw)` 失败的手工输入**（仅手动粘贴；HTTP handler 的 `incoming.url` 永远是 URL）：
   - `stateRequired === true`：一律 `INVALID`。Claude / ChatGPT / Antigravity 的 v1 手工粘贴仍是完整 callback URL。
   - `stateRequired === false`：若字符串含 `state=` 且值不等于 expected → `STATE_MISMATCH`；否则从 `code=` 或（trim 后无空白、无 `://` 的）裸 token 取 `code`。
   - 错 origin 的完整 URL 仍走第 1 条并 `MISMATCH`。

实现：在 `@aio-proxy/shared` 新增纯函数 `resolveOAuthLoopbackCallback`（same-name 目录 `packages/shared/src/oauth-loopback-callback/`，并由 `packages/shared/src/index.ts` 再导出），返回 `{ ok: true, code }` 或 `{ ok: false, reason }`。CLI `run.ts` 与 Dashboard `authorization.ts` 在 `buildAuthorizationUrl` 之后传入 `{ stateRequired }`，两宿主只把 `reason` 映射到既有错误类。禁止再手写两份规则。现有 loopback `request()` 测试夹具的 authorize URL 必须带上 `state=`，否则会误走 OpenRouter 门控。

`packages/core/src/plugins/account-login/` 不校验 state，无需改动。不引入 native scheme，不绕开 `loopback`。

### Credential 与身份

```ts
type OpenRouterCredential = {
  readonly apiKey: string;
  readonly userId?: string;
};
```

`OAuthLoginResult`：

- `credentials.apiKey`：兑换得到的 key；
- `credentials.userId`：非空 `user_id`，否则省略；
- `fingerprint`：`sha256:` + SHA-256(`account:<userId>` 或 `key:<apiKey>`)；
- `suggestedKey`：`'openrouter-' + hex.slice(0, 12)`；
- `accountLabel`：`'OpenRouter'`；
- **省略 `expiresAt`**。

有 `userId` 时，换新 key 的重新登录 fingerprint 保持不变。不请求 email userinfo：`GET /api/v1/key` 的 `data.label` 是截断 key，不是邮箱。禁止把截断 key 或 `user_id` 当作展示 label。

secret 不进入 fingerprint 明文、label、日志或错误。

登录与兑换尊重 `context.signal`。取消必须中止 HTTP，且不得留下已兑换但未返回的 key 在日志里。

## Credential refresh

省略 `OAuthAdapter.refreshCredential`。持久 key 没有 refresh token，也不进入过期窗口。runtime / catalog / quota 只 `credentials.read()`，禁止为了「刷新」去打 `/auth/keys`。

宿主手动 Refresh 菜单对未声明 `refreshCredential` 的 adapter 保持隐藏（现有 `canRefreshCredential` 行为）。

## 模型发现

catalog policy 为 TTL 6 小时。发现使用当前 credential：

```text
GET https://openrouter.ai/api/v1/models?output_modalities=text,embeddings,image
Authorization: Bearer <apiKey>
Accept: application/json
```

`output_modalities` 默认只返回 text；加上 `embeddings,image` 才能让 embedding / image 出现在目录里。不请求 `audio` / `all`（避免把本插件不实现的语音/视频塞进 catalog）。官方文档：省略 `offset`/`limit` 时返回完整列表；实现不分页。

接受 `{ data: [...] }`。每个 entry 必须有非空 string `id`。用 `architecture.output_modalities`（string 数组）分类：

- 含 `text`，或该字段缺失（旧条目）：`language`；
- 含 `embeddings`：`embedding`；
- 含 `image`：`image`。

同一 id 可以进入多个 bucket。`name` 为非空 string 时作为 `displayName`。language 条目设置 `extra: { protocol: 'openai-compatible' }`。OpenRouter Models API **不**按模型广告 `openai-compatible` 与 `openai-response`；禁止猜测 Responses。

动态结果中的 ID 是账号当前可见模型的权威集合。curated ID 只在 fallback 快照里出现，不合并进成功目录。

以下情况允许首次发现使用 curated fallback，后续 refresh 由宿主保留 last-known-good：

- network、timeout、408、429 或 5xx；
- 无法解析的 JSON 或 envelope。

401/403 和合法但 `language` 为空的响应不使用 fallback。

curated fallback 是 **2026-09-06** `GET /api/v1/models?sort=most-popular` 的冻结快照（排除 `:free` 变体，避免宣称免费档访问权）。实现 PR 落地前再打一次该 URL；若某 id 已 404 / 改名则替换，之后不得再发明新 id。空 `architecture.output_modalities` 数组与字段缺失同等视为 `['text']`。

| id                          | displayName                      |
| --------------------------- | -------------------------------- |
| `openai/gpt-5.6-luna`       | OpenAI: GPT-5.6 Luna             |
| `google/gemini-3.7-flash`   | Google: Gemini 3.7 Flash         |
| `anthropic/claude-sonnet-5` | Anthropic: Claude Sonnet 5       |
| `anthropic/claude-opus-5`   | Claude Opus 5                    |
| `deepseek/deepseek-v4-pro`  | DeepSeek: DeepSeek V4 Pro 0423   |
| `deepseek/deepseek-v4-flash`| DeepSeek: DeepSeek V4 Flash 0423 |
| `moonshotai/kimi-k3`        | MoonshotAI: Kimi K3              |
| `minimax/minimax-m3`        | MiniMax: MiniMax M3              |

全部带 `extra: { protocol: 'openai-compatible' }`。不复制 OpenRouter pricing / tokenizer 私有体系。

## Runtime

插件使用 root catalog 已有的 `@openrouter/ai-sdk-provider@2.10.0`。`createOpenRouter({ apiKey, fetch })` 即官方工厂，参数直观。该包导出的是 ProviderV3（`languageModel` / `chat` / `textEmbeddingModel` / `imageModel`）；OAuth adapter 必须返回 `specificationVersion: 'v4'` 的 ProviderV4，因此包一层：

```ts
createOpenRouter({
  apiKey: 'dynamic-credential',
  fetch: createOpenRouterDynamicFetch(credentials),
  compatibility: 'strict',
});
```

```ts
{
  specificationVersion: 'v4',
  languageModel: (modelId) => openrouter.chat(modelId),
  embeddingModel: (modelId) => openrouter.textEmbeddingModel(modelId),
  imageModel: (modelId) => openrouter.imageModel(modelId),
}
```

`createOpenRouter()` 不设置 ProviderV3 `embeddingModel`，只设 `textEmbeddingModel`。宿主 `packageExposesEmbeddingModel` 因此对 `kind: ai-sdk` 的 `@openrouter/ai-sdk-provider` 返回 false。OAuth 插件必须把 ProviderV4 `embeddingModel` 接到 `textEmbeddingModel`；2.10.0 的 `OpenRouterEmbeddingModel.doEmbed` POST `/embeddings`。不要因宿主那份 exclude list 从 catalog 去掉 embeddings。Runtime 测试必须 `doEmbed` 一次，断言 `https://openrouter.ai/api/v1/embeddings` 和 durable Bearer。

`compatibility: 'strict'`：请求打的是官方 `https://openrouter.ai/api/v1`，不是第三方兼容代理。不声明 speech / transcription / reranking / raw。

每次 runtime fetch：`credentials.read()` 取当前 key，去掉 AI SDK placeholder `Authorization`，写入 `Authorization: Bearer <apiKey>`。保留 AI SDK 的 `Content-Type`、`Accept`、请求体、abort signal 和其他非 authorization headers。推理流量不标 `control`（默认 model）。不主动写 `Connection`，不伪造 TLS / browser fingerprint。

上游非成功 response 原样交给 AI SDK 和现有 candidate loop；插件不增加内部 retry 或跨账号调度。

若 `createOpenRouter` 的 LanguageModelV3 无法直接放进 ProviderV4 槽位，只允许最小类型断言。禁止改用 `@ai-sdk/openai-compatible` 或另一套编解码。

## Quota

adapter 实现 `OAuthQuotaCapability.read`，不实现 `reset`。

官方当前探活是 `GET https://openrouter.ai/api/v1/key`（OpenAPI `getCurrentKey`，limits 文档同步）。oh-my-pi 与若干旧文写的 `GET /api/v1/auth/key` **不在**现行 OpenAPI 里；实现只打 `/api/v1/key`。`GET /api/v1/credits` 要求 Management key，OAuth 签发的用户 key 不能用，禁止调用。

```text
GET https://openrouter.ai/api/v1/key
Authorization: Bearer <apiKey>
Accept: application/json
```

`aioProxy: { traffic: 'control' }`。用 `isPlainObject` 读 `{ data: { ... } }`。已核实字段：

- `limit`：`number | null`（key 级花费上限，USD；`null` 表示该 key 无上限）；
- `limit_remaining`：`number | null`；
- `usage` / `usage_daily` / `usage_weekly` / `usage_monthly`：累计/周期用量；
- `limit_reset`：如 `"monthly"` 或 `null`（**不是** Unix 时间戳，禁止填 `resetsAt`）；
- `label`：截断 key，不用作 accountLabel；
- 无 email。

映射：

- 当 `limit` 是有限正数且 `limit_remaining` 是有限数：一个 item `id: "credits"`，`displayName: { default: "Credits", "zh-Hans": "额度" }`，`remainingRatio = clamp(limit_remaining / limit, 0, 1)`；
- `limit === null`（key 无上限）：成功返回 `items: []`（与 Copilot 无计量座位相同：读成功但无表盘），不抛错、不伪造账号余额比例；
- `limit === 0`：`remainingRatio = 0`；
- `limit < 0` 或非有限数：quota read 失败。不要把负数当成已耗尽（`remainingRatio: 0`）；
- 缺 `data`、非 2xx、非法 JSON：quota read 失败。错误不含 key 或完整 body。

不声明 `quota.reset`，不返回 `resetCredits`。

## Built-in 注册

包壳复制 `packages/plugins/xai-grok/`（rslib、tsconfig、`oauth.smoke.ts`）。`packages/core/src/plugins/builtins.ts` 注册新 package，中英文展示：

- plugin label：`OpenRouter`
- plugin description：`Sign in with OpenRouter to mint an API key` / `使用 OpenRouter 登录并签发 API key`
- adapter label：`Login with OpenRouter` / `使用 OpenRouter 登录`
- icon：`'openrouter'`
- 进度文案：`Waiting for OpenRouter authorization` / `正在等待 OpenRouter 授权`

Icon 锁定 `'openrouter'`。`@lobehub/icons-static-svg@1.93.0` 含 `icons/openrouter.svg`。实现时 `ls` 已安装包确认该文件；缺失则改 `https:`/`data:` URI，不得猜邻近 slug。

同步：

- `packages/core/package.json` workspace dependency；
- `.changeset/config.json` `fixed` 组加入 `@aio-proxy/plugin-openrouter`；
- CLI：`packages/cli/src/plugin-commands/plugin/add.test.ts`、`packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`、`packages/cli/__tests__/binary-build.test.ts`。

新包 `package.json` version 为 `0.19.2`，与当前 lockstep 对齐。

Changeset：用 `bun changeset` 生成，不要手写固定文件名。`@aio-proxy/plugin-openrouter` minor + `@aio-proxy/shared` minor + `@aio-proxy/core` minor + `@aio-proxy/cli` minor + `@aio-proxy/server` minor + `aio-proxy` minor（共享 parse 与插件同批；产品包 bump 与内部包同级）。不要跑 `changeset version` / `publish`。

`packages/plugins/*` 已在 workspace glob 内。Dashboard 不新增文件。实现顺序：先合 Claude（无宿主 parse），再合本 PR，最后 Muse。最后任务只按字母序 **插入** 本包名，不得用六插件快照覆盖已落地的兄弟包；也不要回填 `capability.resolution.test.ts` / `binary-build.test.ts` 里故意缺的 `@aio-proxy/plugin-xai-grok`。

## 测试策略

实现遵循 test-first，每个行为只保留最小有价值回归测试：

1. 宿主 parse：authorize URL **无** `state` 时缺 state 可收 `code` / deny `error`；authorize URL **有** `state` 时缺 state 仍拒绝（保留 ChatGPT / Antigravity）；错 `state` 仍拒绝；loose-code 仅 `stateRequired === false`；错 origin 仍 mismatch；错误文本不含 secret。
2. OAuth：authorize 只有 `callback_url` / `code_challenge` / `S256`、无 `state`；token JSON 含 `code` / `code_verifier` / `S256`；`key` 成为 credential；fingerprint / suggestedKey 稳定；control traffic；取消与缺 `key` 失败。
3. Catalog：Bearer + `output_modalities`；text / embeddings / image 分桶；默认 `openai-compatible`；retryable fallback；401 / 空 language 不 fallback。
4. Runtime：ProviderV4、`createOpenRouter` base / strict、dynamic Bearer、abort/body 保留、无 raw。必须经 `createOpenRouterRuntime` 跑 `doGenerate`（`/api/v1/chat/completions`）、`doEmbed`（`/api/v1/embeddings`）和 image `doGenerate`（`/api/v1/images`），断言 durable Bearer，placeholder `dynamic-credential` 不得泄漏。
5. Quota：`GET /api/v1/key`、control traffic、`limit`/`limit_remaining` 比例、unlimited 空 items、负 `limit` 失败、无 reset。
6. Plugin / built-in：默认 descriptor、空 account options、中英文 copy、icon、`refreshCredential` 缺省、embedded 注册、CLI 枚举。

完成前运行新 plugin tests、CLI loopback tests、server oauth-login-session tests、core built-in tests，并执行 `bun run check`；发布门禁提到 `bun run preflight`。

## 验收标准

- `aio-proxy provider login` 可选择 OpenRouter，打开 `https://openrouter.ai/auth?...`，授权后创建 OAuth Provider ID。
- 本机 loopback 在 OpenRouter **不回传 state** 时仍能收下 `code` 并兑换 key。
- SSH / 无头用户粘贴 `http://127.0.0.1:<port>/callback?code=...`（无 state）或裸授权码可以完成登录。
- ChatGPT / Antigravity / Claude 进行中的 loopback：缺 `state` 的 `code` 或 `error` **不得** settle。
- 粘贴带错误 `state` 的其它 provider 回调仍被拒绝。
- 登录可被取消，且不泄漏 code、verifier 或 API key。
- `/v1/models` 展示该账号从 OpenRouter `/api/v1/models` 动态发现的 language 模型；发现结果含 embeddings / image 时目录对应 bucket 非空。
- 官方发现暂时失败时，新账号可使用 8 条 curated fallback；401/403 或合法空 language 目录不伪造模型。
- 任一入站协议通过现有转换路径可调用 OpenRouter language model；实际上游走 `https://openrouter.ai/api/v1` 并带 Bearer key。
- 现有 quota read 在 key 有 `limit` 时返回剩余比例；无 reset。
- 不出现 refresh 菜单或过期轮换。
- `OPENROUTER_API_KEY` 粘贴登录不存在于本插件。
