# xAI Grok OAuth Provider 设计

日期：2026-07-19  
状态：已确认，进入实现

## 背景

aio-proxy 已有 built-in OAuth plugin、device-code 展示、credential refresh port、TTL model catalog 和 ProviderV4 model capability，但尚未支持使用 SuperGrok 或 X Premium+ 账号访问 Grok。

本设计参考 `.reference/oh-my-pi`（OMP）、`.reference/CLIProxyAPI`（CPA）、`.reference/CodexBar` 与 `.reference/Cli-Proxy-API-Management-Center`：OAuth 使用 OMP/CPA 一致的 xAI Grok CLI public client、scope 和 RFC 8628 device flow；模型发现沿用 OMP 对官方 xAI `/v1/models` 的调用；模型推理与额度读取使用 Grok CLI proxy。

## 目标

- 新增随 aio-proxy 发布的 built-in `@aio-proxy/plugin-xai-grok`。
- 支持 xAI OIDC discovery、device authorization、token polling、取消和 refresh token 轮换。
- 使用账号 access token 动态发现当前可用的 Grok chat models。
- 使用 Grok CLI proxy 调用 OpenAI Responses-compatible language models。
- 使用同一 OAuth credential 主动读取当前 credits 剩余比例与周期重置时间。
- 保持现有 model-first routing、Provider weight 和 candidate fallback 不变。

## 非目标

- 不支持 xAI API key；本插件只处理 Grok OAuth 账号。
- 不增加官方 API/CLI proxy 切换选项或自定义 base URL。
- 不实现 images、video、voice、STT、websocket 或 `/responses/compact`。
- 不实现 quota reset、reset credits inventory 或 dashboard 专用适配。
- 不提供 raw passthrough；所有入站协议都通过现有 model invocation path。
- 不抽取通用 device-flow 框架，也不修改 GitHub Copilot 或 OpenAI ChatGPT 插件行为。
- 不实现账号池、额度感知调度或 provider-specific cooldown。

## 核心决策

| 决策点             | 结论                                                                         |
| ------------------ | ---------------------------------------------------------------------------- |
| 插件边界           | 独立 built-in `@aio-proxy/plugin-xai-grok`，OAuth adapter ID 为 `default`    |
| Account options    | 空对象，不新增用户配置                                                       |
| OAuth flow         | OIDC discovery + RFC 8628 device authorization                               |
| OAuth client       | xAI Grok CLI public client ID `b1a00492-073a-47ea-816f-4c329264a828`         |
| OAuth scopes       | `openid profile email offline_access grok-cli:access api:access`             |
| 模型发现           | OAuth Bearer token 请求 `https://api.x.ai/v1/models`，TTL 6 小时             |
| Catalog fallback   | 仅可重试发现失败时使用 OMP curated chat snapshot                             |
| 推理 endpoint      | `https://cli-chat-proxy.grok.com/v1`                                         |
| Model codec        | 已安装的 `@ai-sdk/openai` Responses provider                                 |
| Runtime capability | ProviderV4 model only，不提供 raw resolver                                   |
| Quota capability   | 主动读取 Grok CLI weekly/monthly billing，暴露只读 quota items，不声明 reset |

## 插件与宿主边界

`packages/plugins/xai-grok/` 负责：

- xAI OIDC endpoint discovery 与安全校验；
- device-code request、polling、token parsing 和 refresh；
- credential schema、账号 fingerprint 和展示 label；
- 动态模型发现、chat model 过滤和 curated fallback；
- Grok CLI proxy URL、headers 和 Responses request compatibility。
- Grok CLI weekly/monthly billing JSON 请求与 quota snapshot 映射。

宿主继续负责：

- 在 CLI/Dashboard 展示 device URL、user code 和进度；
- credential 持久化、refresh single-flight、revision CAS 和 lease；
- catalog TTL、last-known-good 和 Provider ID 配置；
- quota context、snapshot validation、API/CLI 展示和通用错误边界；
- candidate selection、protocol conversion、fallback、请求记录和对外错误。

route、pipeline 和公共 plugin SDK 不增加 Grok 分支或新抽象。

## OAuth 登录

### OIDC discovery

登录首先请求：

```text
GET https://auth.x.ai/.well-known/openid-configuration
Accept: application/json
```

响应必须包含 `device_authorization_endpoint` 和 `token_endpoint`。两个 URL 都必须：

- 使用 HTTPS；
- hostname 为 `x.ai` 或以 `.x.ai` 结尾；
- 可被标准 `URL` 解析。

任一 endpoint 校验失败时中止登录，且不得向该 URL 发送 client ID、device code 或 refresh token。

### Device authorization

插件向发现的 device authorization endpoint 发送 form POST：

```text
client_id=b1a00492-073a-47ea-816f-4c329264a828
scope=openid profile email offline_access grok-cli:access api:access
```

响应必须提供非空 `device_code`、`user_code`、verification URI、正数 `expires_in` 和正数 `interval`。优先展示 `verification_uri_complete`，否则展示 `verification_uri`；宿主通过 `presentDeviceCode()` 处理浏览器与终端交互。

### Token polling

插件立即向发现的 token endpoint 执行第一次轮询，之后按 `max(interval, 5)` 秒等待：

```text
grant_type=urn:ietf:params:oauth:grant-type:device_code
client_id=b1a00492-073a-47ea-816f-4c329264a828
device_code=<device code>
```

- `authorization_pending`：等待当前 interval 后继续。
- `slow_down`：将 interval 增加 5 秒后继续。
- `access_denied`、`expired_token` 或其他 OAuth error：立即失败。
- 超过 device `expires_in`：以 timeout 失败。
- `context.signal` 在 HTTP 请求和等待期间都可中止流程。

成功响应必须包含 access token、refresh token 和正数 `expires_in`。credential 保存：

```ts
type XAIGrokCredential = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly email?: string;
  readonly subject?: string;
};
```

`email` 与 `subject` 从 `id_token` 读取，缺失时尝试 access token。JWT 只做未验证的展示/身份 claim 解码，不作为 token 有效性校验。

账号 fingerprint 始终为不可逆 SHA-256：依次 hash `sub:<subject>`、`email:<normalized email>`，两者都缺失时 hash `refresh:<refresh token>`。`suggestedKey` 使用 `grok-` 加 fingerprint 前 12 个 hex 字符；label 优先使用 email，其次使用 subject，最后使用 `xAI Grok`。secret 不进入 fingerprint 明文、label、日志或错误。

## Credential refresh

access token 在 `expiresAt` 前 5 分钟进入刷新窗口。runtime 和 model discovery 都先通过 `CredentialPort` 取得当前 credential；需要刷新时调用 `CredentialPort.refresh()`。

refresh 前重新执行 OIDC discovery 并重新校验 token endpoint，然后发送：

```text
grant_type=refresh_token
client_id=b1a00492-073a-47ea-816f-4c329264a828
refresh_token=<stored refresh token>
```

刷新响应没有新 refresh token 时保留旧值；有新 token 时原子替换。保留原 credential 的 email/subject，并向宿主返回新的 `expiresAt` metadata。

错误分类：

- network、408、429、5xx：`CredentialRefreshError`，`retryable: true`；
- `invalid_grant`、撤销、401、403、`invalid_client`：`retryable: false`；
- invalid JSON 或缺 access token/expiry：`retryable: false`。

错误对象只包含 status 和稳定 reason，不包含 request form、token 或完整 upstream body。

## 模型发现

catalog policy 为 TTL 6 小时。发现使用刷新后的 access token请求：

```text
GET https://api.x.ai/v1/models
Authorization: Bearer <access token>
Accept: application/json
```

接受 OpenAI-compatible `{ data: [...] }`；每个可用 entry 必须有非空 string `id`。只保留 `grok-` language models，并排除 OMP 已确认的非 chat prefixes：

- `grok-imagine-`
- `grok-stt-`
- `grok-voice-`

动态结果中的 ID 是账号当前可用模型的权威集合。已知 curated ID 只补充 display name；不会把动态结果缺失的 curated model 并回成功目录。

以下情况允许首次发现使用 curated fallback，后续 refresh 由宿主保留 last-known-good：

- network、timeout、408、429 或 5xx；
- 无法解析的 JSON 或 envelope。

401/403 和合法但没有可用 Grok chat model 的响应不使用 fallback，避免宣称账号具有实际没有的访问权。

curated fallback 与 OMP 当前 chat snapshot 对齐：

- `grok-build`
- `grok-build-0.1`
- `grok-4.3`
- `grok-4.5`
- `grok-4.20-multi-agent-0309`
- `grok-4.20-0309-reasoning`
- `grok-4.20-0309-non-reasoning`
- `grok-composer-2.5-fast`

本仓库 `ModelDescriptor` 只发布 ID、display name 和必要 metadata；不复制 OMP 私有 model manager 的 pricing、thinking UI 或 token-limit 体系。

## Runtime

插件使用已安装的 `@ai-sdk/openai`：

```ts
createOpenAI({
  name: "xai-grok-oauth",
  baseURL: "https://cli-chat-proxy.grok.com/v1",
  apiKey: "dynamic-credential",
  fetch: createXAIGrokDynamicFetch(credentials),
});
```

ProviderV4 的 `languageModel(modelId)` 显式返回 Responses model。插件不声明 embedding、image、speech 或 raw capability。

每次 fetch 在发送前读取/刷新 credential，移除 AI SDK placeholder authorization，并写入 CPA 当前需要的身份 headers：

```text
Authorization: Bearer <access token>
X-XAI-Token-Auth: xai-grok-cli
x-grok-client-version: 0.2.93
User-Agent: xai-grok-workspace/0.2.93
```

保留 AI SDK 已设置的 `Content-Type`、`Accept`、请求体、abort signal 和其他非 authorization headers。不主动写 `Connection` 或伪造 TLS/browser fingerprint。

对 `/responses` JSON request 只做一个已由 OMP 验证的 compatibility patch：如果存在 `reasoning.summary`，移除 `summary`，同时保留 `reasoning.effort`。请求体不是 JSON、不是 `/responses` 或没有该字段时原样转发。暂不复制 CPA 的 composer session、native x_search、media、websocket 和大量 tool-specific patches。

上游非成功 response 原样交给 AI SDK 和现有 candidate loop；插件不增加内部 retry 或跨账号调度。

## Quota

adapter 实现现有 `OAuthQuotaCapability.read`，但不实现可选的 `reset`。每次读取先通过 `currentXAIGrokCredential()` 取得或刷新 credential，然后并发请求 Grok CLI billing：

```text
GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
GET https://cli-chat-proxy.grok.com/v1/billing
Authorization: Bearer <access token>
Accept: */*
x-xai-token-auth: xai-grok-cli
x-grok-client-version: 0.2.93
User-Agent: xai-grok-workspace/0.2.93
x-userid: <OAuth subject，若存在>
```

请求沿用 account context 的 abort signal。两个 endpoint 独立解析，至少一个返回有效 quota item 即成功；network error、非 2xx 和无有效 billing payload 使对应请求失败，只有两者都失败时 quota read 才失败。插件不把 OAuth token 或完整响应 body 放入错误文本。

响应只读取 JSON `config` 中已观察到的字段：

- weekly item 使用 `creditUsagePercent` 和 `currentPeriod.end`。
- monthly item 使用 `monthlyLimit`、`used` 和 `billingPeriodEnd`；included usage 为 `min(used, monthlyLimit)`，不把超出套餐的 on-demand usage 混入比例。
- 百分比接受有限 number 或 numeric string，并 clamp 到 `0...100`；重置时间只接受可解析日期并输出毫秒 Unix timestamp。
- camelCase 与 snake_case 字段均兼容。

quota snapshot 最多包含两个 item：

```ts
{
  items: [
    { id: "weekly", label: { default: "Weekly limit", "zh-Hans": "周额度" }, remainingRatio, resetsAt },
    { id: "monthly-credits", label: { default: "Monthly credits", "zh-Hans": "月度额度" }, remainingRatio, resetsAt },
  ],
}
```

缺失的 endpoint 不产生占位 item。`resetsAt` 使用毫秒 Unix timestamp，以匹配 plugin SDK。snapshot 不返回 `resetCredits`：billing 中的 credits 是可消费额度，不是宿主定义的手动 reset credit inventory；adapter 也不声明 `quota.reset`。

## Built-in 注册

`packages/core/src/plugins/builtins.ts` 注册新 package，并提供中英文展示文本：

- plugin label：`xAI Grok`
- description：使用 SuperGrok 或 X Premium+ 账号访问 Grok models
- adapter label：使用 xAI Grok 登录
- device/progress copy：输入 code、等待 xAI 授权

`packages/core/package.json` 增加 workspace dependency，root lockfile 随 workspace package 更新。Dashboard 通过现有 built-in plugin/catalog 接口自动显示，不新增 dashboard 文件。

## 测试策略

实现遵循 test-first，每个行为只保留最小有价值回归测试：

1. OAuth flow：endpoint host validation、device request form、`authorization_pending`、`slow_down`、timeout/abort 和 credential identity。
2. Refresh：旧 refresh token fallback、rotated refresh token、5xx retryable 与 `invalid_grant` non-retryable。
3. Catalog：Bearer `/v1/models`、非 chat filter、curated display overlay、retryable fallback，以及 401/空目录不 fallback。
4. Runtime：ProviderV4 model-only、CLI proxy URL、dynamic authorization/client headers、abort/body preservation 和 `reasoning.summary` removal。
5. Quota：CLI auth headers、weekly/monthly JSON、partial success、remaining ratio、reset timestamp 与 read-only capability。
6. Plugin/built-in：默认 descriptor、空 account options、localized copy、icon、package version、quota registration 和 embedded registration。

完成前运行新 plugin tests、core built-in tests，并执行 `bun run preflight`。

## 验收标准

- `aio-proxy provider login` 可选择 xAI Grok，展示 device URL/code，并在授权后创建 OAuth Provider ID。
- 登录、刷新和发现过程可被用户取消，且不会泄漏 token。
- `/v1/models` 展示该 OAuth 账号从官方 xAI endpoint 动态发现的 Grok chat models。
- 官方模型发现暂时失败时，新账号可使用 curated fallback；401/403 或合法空目录不伪造可用模型。
- 任一入站协议通过现有转换路径可调用 Grok model，实际 HTTP Responses 请求发送到 CLI proxy 并带 CPA 身份 headers。
- 现有 quota read 接口可返回 Grok credits 剩余比例和周期重置时间；不提供 reset 操作或 reset credits。
- access token 到刷新窗口后通过宿主 credential port 安全更新；并发刷新继续由宿主 single-flight/CAS 保证。
