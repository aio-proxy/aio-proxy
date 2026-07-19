# Kimi Code OAuth Plugin 设计

日期：2026-07-19  
状态：已批准

## 背景

aio-proxy 已用 built-in plugin 承载 GitHub Copilot、OpenAI ChatGPT 和 Google Antigravity OAuth provider。Kimi Code 应使用相同的 `OAuthAdapter` seam，不在 CLI、server route 或 provider kind 中增加 Kimi 分支。

本设计参考两份 `.reference` 实现：

- Oh My Pi（OMP）的 Kimi Code OAuth、动态模型发现和 OpenAI/Anthropic 双协议调用。
- CLIProxyAPI（CPA）的 device flow、token refresh、`api.kimi.com/coding` runtime 与模型快照。

官方 Kimi Code 文档确认登录使用 RFC 8628 device-code flow，Kimi Code 平台请求必须使用 `api.kimi.com/coding/...`；官方第三方接入文档同时确认 Anthropic base URL 为 `https://api.kimi.com/coding/`，OpenAI-compatible base URL 为 `https://api.kimi.com/coding/v1`。公开文档没有给出 OAuth wire contract，因此 OAuth endpoint、client ID、polling error 和 `X-Msh-*` headers 以 OMP 与 CPA 的一致实现为互证依据。

## 目标

- 新增 built-in `@aio-proxy/plugin-kimi-code`，登录后可立即作为 routing provider 使用。
- 实现 Kimi Code RFC 8628 device-code 登录和 refresh token 轮换。
- 动态发现 Kimi Code 模型，并按服务端 `protocol` 选择 OpenAI-compatible 或 Anthropic runtime。
- 通过 Kimi Code API 读取周配额与全部短周期 quota window。
- 同协议请求提供 raw passthrough；跨协议请求继续由现有 pipeline 转换后调用 AI SDK model capability。
- 沿用宿主的 credential CAS、catalog last-known-good、fallback、usage capture 和 request recording。

## 非目标

- 不实现 Moonshot Open Platform API key provider；本插件只面向 Kimi Code 订阅与 `api.kimi.com/coding`。
- 不调用 `www.kimi.com` 网页会员接口补充月度或会员余额；该接口依赖 Cookie/JWT session headers，不属于 Kimi Code OAuth API contract。
- 不实现 quota reset；Kimi Code `/usages` 是只读接口，宿主不应把本地 cooldown reset 伪装成上游配额重置。
- 不复制 CPA 的 tool-message、reasoning 或模型名兼容补丁；只有 aio-proxy 的真实失败用例出现后才加入。
- 不新增 Dashboard 专用 UI、数据库表、CLI vendor 分支或公共 SDK 抽象。
- 不增加新的运行时依赖；复用 `@ai-sdk/openai-compatible`、`@ai-sdk/anthropic` 和平台 API。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| Plugin package | `@aio-proxy/plugin-kimi-code` |
| Capability ID | `default` |
| 登录方式 | RFC 8628 device-code flow |
| OAuth host | `https://auth.kimi.com` |
| Device authorization | `POST /api/oauth/device_authorization` |
| Token / refresh | `POST /api/oauth/token` |
| API base | `https://api.kimi.com/coding` |
| 模型目录 | Authenticated `GET /coding/v1/models`，失败时以 `kimi-for-coding` 静态条目作首次兜底 |
| Quota | Authenticated `GET /coding/v1/usages`，映射顶层周配额与全部短周期 limits |
| OpenAI runtime | `@ai-sdk/openai-compatible`，base URL `/coding/v1` |
| Anthropic runtime | `@ai-sdk/anthropic`，base URL `/coding` |
| Provider ID 建议 | `kimi-<refresh-token-sha256-prefix>`；不持久化或展示 token 原文 |
| Refresh threshold | access token 距过期不足 5 分钟时刷新 |

## 1. Package 与注册

新增 `packages/plugins/kimi-code/`，结构跟随现有小型 built-in plugin：

- `src/plugin.ts`：声明 adapter、登录编排和 catalog policy。
- `src/oauth.ts`：device authorization、polling、token refresh 与 token schema。
- `src/catalog.ts`：解析 `/models` 并映射 protocol metadata。
- `src/quota.ts`：解析 `/usages` 并映射只读 `OAuthQuotaSnapshot`。
- `src/runtime.ts`：credential refresh、AI SDK provider 和 raw transport。
- `src/headers.ts`：为 OAuth、catalog、refresh 和 inference 构造一致的 Kimi headers。
- `src/index.ts`：默认 descriptor、版本和公共导出。

`packages/core/src/plugins/builtins.ts` 只增加 package import、保留 identity 和中英文文案：

- Plugin label：`Kimi Code`
- Description：`Use a Kimi Code account to access models` / `使用 Kimi Code 账号访问模型`
- Adapter label：`Login with Kimi Code` / `使用 Kimi Code 登录`
- Device instructions：`Enter code` / `输入代码`
- Waiting text：`Waiting for Kimi authorization` / `正在等待 Kimi 授权`

账号没有公开 options，使用空 object schema 和空 form。Kimi client ID 按现有 OAuth built-in 的 build-time define 模式注入，并用 artifact smoke test 固定 fingerprint；client ID 是公开 OAuth 标识，不作为用户 secret 或配置项。

## 2. Device OAuth

开始登录时生成一个 32 位小写十六进制 device ID，并在整个账号生命周期内复用。请求 device authorization：

```text
POST https://auth.kimi.com/api/oauth/device_authorization
Content-Type: application/x-www-form-urlencoded

client_id=<embedded-client-id>
```

响应必须包含 `device_code`、`user_code` 和 `verification_uri`。`verification_uri_complete` 缺失时回退到 `verification_uri`；`expires_in` 缺失时使用 15 分钟，`interval` 缺失或非正数时使用 5 秒。

插件通过 `context.authorization.presentDeviceCode()` 展示 URL 和 user code，然后立即进行第一次 token 请求。后续行为：

- `authorization_pending`：等待当前 interval 后重试。
- `slow_down`：interval 增加 5 秒；若响应给出更大的 interval，使用更大值，然后重试。
- `expired_token`、`access_denied`：立即返回明确错误。
- 其他 OAuth error、非 JSON 或缺失字段：立即失败，不继续轮询。
- 到达 `expires_in` deadline 或宿主 signal abort：停止，不保存 credential。

成功 token 必须包含 `access_token`、`refresh_token` 和正数 `expires_in`。credential 保存：

```ts
type KimiCredential = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  deviceId: string;
};
```

`expiresAt` 保存真实 epoch milliseconds。登录 fingerprint 使用 refresh token 的 SHA-256，不将 token 放入 Provider ID、label、日志或诊断；suggested key 只取 hash 前 12 位。Kimi 没有在参考实现或公开文档中提供稳定 userinfo endpoint，因此 label 固定为 `Kimi Code`。显式 re-login 仍由宿主绑定已有 Provider ID。

## 3. Headers 与 refresh

所有 Kimi 请求共享以下 headers：

- `User-Agent: KimiCLI/<plugin-version>`
- `X-Msh-Platform: kimi_cli`
- `X-Msh-Version: <plugin-version>`
- `X-Msh-Device-Name`
- `X-Msh-Device-Model`
- `X-Msh-Os-Version`
- `X-Msh-Device-Id: <credential-device-id>`

操作系统字段来自 `node:os`，删除非可打印 ASCII；空值回退为 `unknown`。OAuth 表单请求使用 `Content-Type: application/x-www-form-urlencoded`；API 请求另外设置 `Authorization: Bearer <access-token>`。已有请求中的 authorization、API key 和旧 `X-Msh-*` 身份头由插件覆盖，避免把占位 credential 或客户端 credential 转发给 Kimi。

runtime/catalog 每次请求前读取 credential。若 `expiresAt <= now + 5 minutes`，通过宿主 `CredentialPort.refresh()` 执行：

```text
grant_type=refresh_token
refresh_token=<current-refresh-token>
client_id=<embedded-client-id>
```

refresh 响应必须包含 access token 和正数 expiry。若服务端未轮换 refresh token，保留旧值；若返回新 refresh token，原子保存新值。HTTP 401/403 产生 non-retryable `CredentialRefreshError`，网络错误、429 和 5xx 产生 retryable error，其余畸形响应按 non-retryable 处理。并发刷新、revision CAS 和跨请求 single-flight 由宿主负责，插件不增加锁。

## 4. 模型目录

catalog 使用 TTL policy（6 小时），请求：

```text
GET https://api.kimi.com/coding/v1/models
Authorization: Bearer <current-access-token>
```

只接受非空 string `id`。`display_name` 为 string 时映射为 `displayName`。每个 descriptor 写入最小 runtime metadata：

```ts
{
  protocol: entry.protocol === "anthropic" ? "anthropic" : "openai-compatible"
}
```

服务端 `protocol: "anthropic"` 使用 Anthropic；`null`、缺失和未知值使用 OpenAI-compatible，与 OMP 的 Kimi model mapping 一致。其他远端字段暂不复制到公共 catalog。

首次 catalog 请求失败时提供单条静态 fallback：`kimi-for-coding`、display name `Kimi for Coding`、protocol `openai-compatible`。该 model ID 与官方 Kimi Code 文档一致。宿主已有的 last-known-good catalog 负责后续失败兜底，不在插件内再维护缓存。

## 5. Runtime 与请求流

runtime 建立两个 provider，并按 catalog metadata 为 model ID 选择一个：

- `openai-compatible`：`createOpenAICompatible({ baseURL: "https://api.kimi.com/coding/v1" })`
- `anthropic`：`createAnthropic({ baseURL: "https://api.kimi.com/coding" })`

两者使用同一个 dynamic fetch。fetch 在发送前取得当前 credential，覆盖 Kimi auth/device headers，并保留 method、body、signal、redirect 和其他协议 headers。

raw resolver 只在 `input.protocol` 等于模型 metadata protocol 时返回 transport：

- `/v1/chat/completions` → `https://api.kimi.com/coding/v1/chat/completions`
- `/v1/messages` → `https://api.kimi.com/coding/v1/messages`

raw URL 只保留允许的协议 path 与 query，不接受客户端 host 作为 upstream 目标。OpenAI Responses、Gemini 或协议不匹配请求不 raw passthrough；现有 pipeline 将其转换为 model messages，并调用该模型对应的 AI SDK provider。

Kimi upstream error 原样交给已有 pipeline error/fallback 机制。插件不实现 candidate loop、stream preflight、usage capture 或 request recording。

## 6. Quota

adapter 注册只读 `quota.read(context)`，使用与 catalog/runtime 相同的 credential refresh 和 device identity headers 请求：

```text
GET https://api.kimi.com/coding/v1/usages
Authorization: Bearer <current-access-token>
```

该 wire contract 采用 CodexBar 已验证的 Kimi Code API 实现；CPA 提供 OAuth credential、device ID 和 identity header 的互证。插件不调用 CodexBar 的 `www.kimi.com` Billing/Membership 网页接口。

响应处理接受顶层 `usage` 和 `limits[]`：

- `limit`、`used`、`remaining` 可为 number 或十进制 string。
- reset timestamp 接受 `resetTime`、`resetAt`、`reset_time` 和 `reset_at`，输出 epoch milliseconds。
- 顶层 `usage` 映射为稳定 item ID `weekly`，中英文 label 为 `Weekly quota` / `周配额`。
- 每个有效 `limits[]` 使用 `window.duration` 与 `window.timeUnit` 生成稳定 ID 和中英文 label；不只读取第一项。
- `remainingRatio` 优先使用 `remaining / limit`；缺少 remaining 时使用 `1 - used / limit`，并夹在 `[0, 1]`。
- 缺少有效正数 limit 的行忽略；顶层与 limits 都没有有效行时视为畸形响应并失败。

`quota.read` 不缓存、不加锁：宿主负责 request lifecycle、error redaction 和 account credential CAS。插件不注册 `quota.reset`，也不返回 `resetCredits`。

## 7. 测试与验证

测试必须先失败再实现，集中保护以下行为：

- Device authorization 正确展示 URL/code；pending、slow-down、成功、拒绝、超时和 abort 行为正确。
- Token response 校验、refresh token 保留/轮换、5 分钟提前刷新和错误分类正确。
- Catalog 只接收有效 model ID，并正确映射 Anthropic/OpenAI protocol；首次失败返回官方 `kimi-for-coding` fallback。
- Quota 同时映射顶层周配额和全部短周期 limits，兼容 string/number、remaining fallback 与 reset key variants；畸形或非成功响应不泄露 token/response body。
- Runtime 使用当前 token/device ID 覆盖 headers，按 metadata 选择 AI SDK provider，并只对同协议开放 raw transport。
- Built-in identity、descriptor、中英文文案和 artifact 内嵌 client ID 正确。

不为常量、静态数组或实现细节单独写低价值测试。完成前运行：

```sh
bun run --filter @aio-proxy/plugin-kimi-code test:unit
bun run --filter @aio-proxy/plugin-kimi-code build
bun run --filter @aio-proxy/plugin-kimi-code test:artifact
bun run preflight
```

## 验收标准

- `aio-proxy provider login @aio-proxy/plugin-kimi-code`（或交互式 capability 选择中的 Kimi Code）显示 device verification URL 和 user code，授权后创建 OAuth Provider ID。
- credential vault 中保存 access token、refresh token、真实 expiry 和 device ID；明文 token 不进入 config、Provider ID、日志或错误。
- `/v1/models` 能展示动态 Kimi Code 模型；目录暂时不可用时，新账号至少能路由官方 `kimi-for-coding`。
- OAuth quota reader 能展示周配额和所有有效短周期窗口的剩余比例与重置时间；不暴露或伪造 reset 操作。
- OpenAI Chat Completions 与 Anthropic Messages 同协议调用使用 raw passthrough；其他入站协议使用现有转换路径。
- access token 在过期前刷新，refresh token rotation 不丢失，多个并发请求不产生重复持久化竞争。
- Kimi provider 失败后仍遵循现有 Provider weight 与 fallback 规则。
