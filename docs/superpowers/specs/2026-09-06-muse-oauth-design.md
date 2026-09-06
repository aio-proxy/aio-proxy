# Muse Code OAuth Provider 设计

日期：2026-09-06  
状态：待用户规格审阅

## 背景

aio-proxy 已有 built-in OAuth plugin、`presentDeviceCode` 展示、TTL model catalog、ProviderV4 model capability 和只读 quota port，但尚未支持使用 Meta Muse Code 订阅访问 Meta Model API。

本设计参考 oh-my-pi（OMP）的 `muse-code` auth/provider/usage 实现，以及本仓库已落地的 Kimi Code / xAI Grok device-code 插件：

- OMP `packages/catalog/src/compat/rules/auth/muse-code.kdl`：RFC 8628 device-code、公开 client ID、固定 Meta OIDC URL、`refresh "none"`、device 成功后 hook 铸造 Model API key。
- OMP `packages/ai/src/registry/oauth/muse-code.ts`：`POST https://api.meta.ai/muse-code/key`、`onboard: true` 仅用于交互登录、订阅校验、`api_key` 持久化、禁止在后续 refresh/catalog 路径重铸。
- OMP `packages/ai/src/usage/muse-code.ts`：额度只来自同一 key 端点（无独立 usage URL），读取时不带 `onboard`。
- OMP `packages/catalog/src/compat/rules/providers/muse-code.kdl`：encrypted reasoning、effort ladder、以及 2026-09-05 验证过的 `` `custom` tools are not supported on this endpoint ``。
- Meta 公开文档（`dev.meta.ai` / `ai.developer.meta.com`）：`GET https://api.meta.ai/v1/models` 存在；Responses 是 agentic 主表面；已发布的 Muse Spark ID 包括 `muse-spark-1.1`、`muse-spark-1.2`、`muse-spark-1.3` 及其 Contributor 变体。

推理使用登录时铸造并持久化的 Model API key，而不是 Meta 账号 OAuth access token。plugin-sdk 的 device-code port 已经存在，本插件不改 SDK。

## 目标

- 新增随 aio-proxy 发布的 built-in `@aio-proxy/plugin-muse-code`。
- 使用 Meta `auth.meta.com` RFC 8628 device-code 登录，成功后铸造并持久化 Model API key。
- 用铸造出的 key 动态发现账号可用模型；可重试失败时回退到已文档化的 Muse Spark 快照。
- 通过已安装的 `@ai-sdk/openai` Responses provider 调用 `https://api.meta.ai/v1`。
- 只读读取订阅 `subs_usage` 窗口，不声明 reset。
- 保持现有 model-first routing、Provider weight 和 candidate fallback 不变。

## 非目标

- 不提供 Meta pay-as-you-go `MODEL_API_KEY` 粘贴登录；用户可自行添加 api provider。
- 不实现 Z.AI native-scheme、Claude、OpenRouter，也不把这些路由塞进本插件。
- 不修改 `@aio-proxy/plugin-sdk`（device-code port 已存在）。
- 不对 Meta OIDC 发送 `refresh_token` grant。
- 不实现 `refreshCredential`。账号 token 不可刷新；key 端点不是 refresh。
- 不在后续 catalog / runtime / quota 路径重铸 key（`onboard: true` 只出现在交互登录成功后的那一次 mint）。
- 不实现 CPA importer（未发现稳定的 CPA muse-code 类型）。
- 不提供 raw passthrough。
- 不实现 quota reset、reset credits、账号池或额度感知调度。
- 不把 OMP 的 `custom` tool 拒绝、encrypted-reasoning include 或 `max` effort 做成新协议。

## 核心决策

| 决策点            | 结论                                                                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件边界          | 独立 built-in `@aio-proxy/plugin-muse-code`，OAuth adapter ID 为 `default`                                                                     |
| Account options   | 空对象，不新增用户配置                                                                                                                        |
| OAuth flow        | 固定 Meta OIDC device/token URL + RFC 8628 polling；无 discovery                                                                               |
| OAuth client      | 公开 client ID `1031625952748946`（OMP `muse-code.kdl`）                                                                                      |
| OAuth refresh     | `refresh: none`。Adapter **省略** `refreshCredential`                                                                                         |
| 账号 token        | Device token 响应视为无 expiry、无可用 refresh_token。Login result **不**写 `expiresAt`                                                       |
| Key mint          | 登录成功后 `POST https://api.meta.ai/muse-code/key`，`onboard: true`，超时 20s，`aioProxy.traffic = 'control'`                                 |
| 持久化 credential | `{ oauthAccessToken, apiKey, email?, accountId? }`。之后只读已存 `apiKey`                                                                     |
| 模型发现          | 铸造 key 请求 `GET https://api.meta.ai/v1/models`，TTL 6 小时                                                                                  |
| Catalog fallback  | 仅可重试失败时使用已文档化 Muse Spark 快照                                                                                                    |
| Catalog protocol  | 一律 `openai-response`                                                                                                                        |
| 推理 endpoint     | `https://api.meta.ai/v1`，Bearer **apiKey**，`x-api-version: 1.0.0`                                                                            |
| Model codec       | `@ai-sdk/openai` 的 Responses（`openai.responses(modelId)`）                                                                                   |
| Runtime           | ProviderV4 model only，无 raw。image/embedding 仅当 catalog 对应数组非空                                                                       |
| Quota             | 无独立 usage URL。`POST /muse-code/key` 且 **不**带 `onboard`，稀疏读取，429 视为可重试失败                                                     |

## 插件与宿主边界

`packages/plugins/muse-code/` 负责：

- Meta device authorization、token polling、取消与错误分类；
- 登录后的 key mint、订阅校验、credential schema 与账号 fingerprint；
- 用铸造 key 做 TTL 模型发现、Spark 过滤和 curated fallback；
- `https://api.meta.ai/v1` 的 Responses ProviderV4 与 dynamic fetch（只注入 apiKey + 版本头）；
- 从 key 端点映射只读 quota snapshot。

宿主继续负责：

- 在 CLI/Dashboard 展示 device URL、user code 和进度；
- credential 持久化（本插件不刷新，因此不会走到 refresh single-flight）；
- catalog TTL、last-known-good 和 Provider ID 配置；
- quota context、snapshot validation、API/CLI 展示和通用错误边界；
- candidate selection、protocol conversion、fallback、请求记录和对外错误。

route、pipeline 和公共 plugin SDK 不增加 Muse / Meta 分支或新抽象。

## 展示文案与图标

`packages/core/src/plugins/builtins.ts` 注入中英文 copy；插件默认英文 fallback 与此一致。

| 字段                       | 英文                                                                      | 中文                          |
| -------------------------- | ------------------------------------------------------------------------- | ----------------------------- |
| pluginLabel                | Muse Code                                                                 | Muse Code                     |
| pluginDescription          | Use a Muse Code subscription to access Meta models                        | 使用 Muse Code 订阅访问 Meta 模型 |
| adapterLabel               | Login with Muse Code                                                      | 使用 Muse Code 登录           |
| deviceInstructions         | Enter code                                                                | 输入代码                      |
| waitingForAuthorization    | Waiting for Muse authorization                                            | 正在等待 Muse 授权            |

icon 锁定为 Lobe key `'meta'`。`@lobehub/icons-static-svg@1.94.0` 含 `icons/meta.svg`；本仓库 catalog 当前钉在 `1.93.0`。实现时读取已安装包的 `icons/` 目录确认 `meta.svg` 存在。若不存在，退回同一目录中最近的真实 key（优先 `meta-color`，再 `meta-brand`）。`validatePluginIcon` 只校验 slug 形态，但 `LobeIconKey` 在 plugin-sdk 构建期按已安装 SVG 生成，错误 key 会在类型检查失败。

## OAuth 登录

### 固定 endpoint

本插件不做 OIDC discovery。登录只向这两个 HTTPS URL 发控制面请求：

```text
POST https://auth.meta.com/oidc/device/authorization/
POST https://auth.meta.com/oidc/device/token/
```

两者都带：

```text
Accept: application/json
Content-Type: application/x-www-form-urlencoded
x-api-version: 1.0.0
```

以及 `aioProxy: { traffic: 'control' }`。KDL 未声明 scope；device 请求 body 只有公开 `client_id`。

### Device authorization

```text
client_id=1031625952748946
```

响应必须提供非空 `device_code`、`user_code` 和 verification URI。优先展示 `verification_uri_complete`，否则 `verification_uri`。`expires_in` 缺失或非正数时按 900 秒作为 **device-code 轮询截止**（不是账号 token expiry）。`interval` 缺失或非正数时按 5 秒，轮询间隔使用 `max(interval, 5)`。

通过已有 `context.authorization.presentDeviceCode({ url, userCode, instructions })` 展示。`instructions` 把 user code 追加到本地化 `deviceInstructions` 后面，格式与 Kimi 一致：字符串或每个 locale 值后接 `\n\n${userCode}`。

### Token polling

展示 device code 后立即第一次轮询，之后按当前 interval 等待：

```text
grant_type=urn:ietf:params:oauth:grant-type:device_code
client_id=1031625952748946
device_code=<device code>
```

行为对齐 Kimi / xAI：

- `authorization_pending`：`context.progress(waitingForAuthorization)`，等待当前 interval 后继续。
- `slow_down`：interval 增加 5 秒；若响应给出更大的正数 `interval`，取更大值，然后等待并继续。
- `access_denied`：立即失败（denied）。
- `expired_token`：立即失败（expired）。
- 其他 OAuth error、非 JSON、缺 `access_token`：立即失败。
- 超过 device `expires_in` 截止：timeout 失败。
- `context.signal` 在 HTTP 与 sleep 期间都可中止；中止后不保存 credential。
- 轮询遇到 408 / 429 / 5xx：视为 pending，等待后继续（与 Kimi token poll 一致）。
- 错误对象只含稳定 reason / status，不含 form、token 或完整 upstream body。

成功 token 必须有非空 `access_token`。即使响应出现 `refresh_token` 或 `expires_in`，也 **丢弃**：不写入 credential，不对 Meta OIDC 发 refresh grant。Login result **省略** `expiresAt`。

### Key mint（登录唯一一次）

Device 成功后立刻铸造 key。若 mint 失败，整个登录失败，**不得**把“只有 oauth token、没有 apiKey”的半成品写入 vault。

```text
POST https://api.meta.ai/muse-code/key
Accept: application/json
Authorization: Bearer <oauth access_token>
Content-Type: application/json
x-api-version: 1.0.0

{"onboard":true}
```

- `aioProxy: { traffic: 'control' }`
- `redirect: 'error'`
- timeout：`AbortSignal.timeout(20_000)` 与 `context.signal` 组合（`AbortSignal.any`）
- 这是本账号生命周期内唯一一次 `onboard: true`

响应按 OMP `museCodeKeyResponseSchema` 读取这些可选字段：`api_key`、`user_email`、`user_id`、`is_subs_active`、`subs_tier_id`、`subs_tier_name`、`subs_usage`、`require_payment`、`require_payment_action_url`、`action_url`。

登录失败条件：

- HTTP 非成功、无效 JSON、或无法解析为 object。
- `is_subs_active === false`。
- `api_key` 缺失或空白。若 `require_payment === true` 或存在 `action_url` / `require_payment_action_url`，错误文案带上该 URL（只带 URL，不带响应正文）。
- `user_id` 与规范化 email 都缺失（没有稳定账号身份，无法做 fingerprint）。

### Credential 与身份

```ts
type MuseCodeCredential = {
  readonly oauthAccessToken: string;
  readonly apiKey: string;
  readonly email?: string;
  readonly accountId?: string;
};
```

- `oauthAccessToken`：device token 的 access token，仅用于后续 **quota** 的 key 端点（不带 onboard）。永不发往 `/v1`。
- `apiKey`：mint 返回的 `api_key`。catalog 与 inference 只使用它。
- `email`：`user_email` 经 `trim()` + `toLowerCase()`；空则省略。
- `accountId`：非空 `user_id`（trim）。不用 email 填 `accountId`。

Fingerprint 为不可逆 SHA-256，输出 `sha256:` + 64 位小写 hex（与 xAI 宿主约定一致）：

1. 有 `accountId` 时 hash `account:<accountId>`
2. 否则 hash `email:<normalized email>`
3. 两者都无则登录已失败，不存在第三回退（不 hash token）

`suggestedKey = 'muse-' + hex.slice(0, 12)`（hex 不含 `sha256:` 前缀）。  
`accountLabel`：normalized email，否则 `accountId`，否则 `Muse Code`。  
secret（oauth token、apiKey）不进入 fingerprint 明文、label、日志或错误。

## Credential 生命周期（无 refresh）

Adapter **不**注册 `refreshCredential`。

`currentMuseCodeCredential(port)` 只 `port.read()` 并返回 `snapshot.value`。它：

- 不检查 expiry（credential 没有 `expiresAt`）；
- 不调用 `port.refresh`；
- 不请求 key 端点；
- 不重铸 `apiKey`。

catalog、runtime、quota 都通过这个只读 helper 取当前 credential。quota 再用其中的 `oauthAccessToken` 调 key 端点；catalog/runtime 只用 `apiKey`。

用户手动 refresh 在本插件上没有 upstream exchange。宿主若对无 `refreshCredential` 的 adapter 发起手动 refresh，走现有宿主行为；插件不补一层“假 refresh”。

## 模型发现

catalog policy 为 TTL 6 小时。发现使用持久化 **apiKey**（不是 oauth token）：

```text
GET https://api.meta.ai/v1/models
Authorization: Bearer <apiKey>
Accept: application/json
x-api-version: 1.0.0
```

`aioProxy: { traffic: 'control' }`。Meta 文档确认该 list-models 端点存在，返回 OpenAI-compatible `{ data: [...] }`，按 `created` 新到旧排序。

每个可用 entry 必须有非空 string `id`。分类：

- `muse-spark-` 前缀 → `language`，`extra: { protocol: 'openai-response' }`
- `muse-image-` 前缀 → `image`，同样 `extra.protocol = 'openai-response'`（Meta 文档：Muse Image 也走 Responses）
- 其他 ID（含 `muse-voice-transcribe-`、Glimmer、未知）丢弃。本插件不实现 speech / transcription runtime。

`displayName` 优先使用下方 curated 表，其次是 entry 的非空 `name` / `display_name`。动态结果中的 ID 是账号当前可用模型的权威集合：成功响应里没有的 curated ID **不**并回。合法空 `data` 视为权威空目录，不 fallback。

以下情况允许 **首次** 发现使用 curated fallback；后续 refresh 由宿主 last-known-good 负责：

- network、timeout、408、429 或 5xx；
- 无法解析的 JSON 或 envelope；
- `AbortError` **不** fallback（与 Kimi 一致）。

401/403 不 fallback，避免宣称账号具有实际没有的访问权。

curated fallback（仅 language；来自 2026-09-06 Meta Models 文档 + OMP `muse-code` defaultModel `muse-spark-1.3`）：

| id                           | displayName                      |
| ---------------------------- | -------------------------------- |
| `muse-spark-1.3`             | Muse Spark 1.3                   |
| `muse-spark-1.3-contributor` | Muse Spark 1.3 (Contributor)     |
| `muse-spark-1.2`             | Muse Spark 1.2                   |
| `muse-spark-1.2-contributor` | Muse Spark 1.2 (Contributor)     |
| `muse-spark-1.1`             | Muse Spark 1.1                   |

`ModelDescriptor` 只发布 ID、display name 和 `extra.protocol`。不复制 OMP 的 pricing、token-limit 或 thinking UI。

## Runtime

插件使用已安装的 `@ai-sdk/openai`：

```ts
createOpenAI({
  name: 'muse-code-oauth',
  baseURL: 'https://api.meta.ai/v1',
  apiKey: 'dynamic-credential',
  headers: { 'x-api-version': '1.0.0' },
  fetch: createMuseCodeDynamicFetch(credentials),
});
```

ProviderV4：

- `languageModel(modelId)` 显式返回 `openai.responses(modelId)`。
- `imageModel`：仅当 `context.catalog.image.length > 0` 时接到 `openai.imageModel(modelId)`；否则 throw unsupported。
- `embeddingModel`：仅当 `context.catalog.embedding.length > 0` 时接到 `openai.embeddingModel(modelId)`；当前分类器不会产生 embedding，因此实现上保持该分支但默认 throw。
- 不声明 speech、transcription 或 raw。

每次 model fetch 在发送前 `currentMuseCodeCredential()`，去掉 AI SDK placeholder authorization，写入：

```text
Authorization: Bearer <apiKey>
x-api-version: 1.0.0
```

保留 AI SDK 已设置的 `Content-Type`、`Accept`、请求体、abort signal 和其他非 authorization headers。不发送 `oauthAccessToken`。不把 model 请求标成 `traffic: 'control'`。不主动写 `Connection`，不伪造 TLS/browser fingerprint。不改写 `/responses` JSON（不移除 `reasoning.summary`，不做 custom→function 降级）。

上游非成功 response 原样交给 AI SDK 和现有 candidate loop。插件不增加内部 retry 或跨账号调度。

### 延期（明确不在本插件实现）

OMP provider kdl 与 Meta 文档还有这些能力，但本仓库现有 AI SDK + model-message 路径无法在不新增协议的前提下完整传递：

- **`include-encrypted-reasoning` / `include: ['reasoning.encrypted_content']`**：宿主 `modelMessagesToOpenAIResponses` 不写 `include`；跨协议转换还会丢掉 `encrypted_content`。本插件不注入该字段。入站 raw Responses 本可携带它，但本插件没有 raw。
- **effort ladder `minimal | low | medium | high | xhigh` 与 Spark 1.3 的 `max`**：宿主已把 `settings.reasoning` / `providerOptions.openai.reasoningEffort` 映射为 `reasoning.effort`。插件不重映射、不把 `xhigh` 压成 `high`、不单独声明 `max`。
- **`custom` tools**：OMP 于 2026-09-05 对 `api.meta.ai/v1` 验证 `` `custom` tools are not supported on this endpoint ``（400）。本插件不做 xAI 那种 custom→function fallback；上游 400 交给 candidate loop。
- **Chat Completions / Anthropic Messages**：Meta 文档声明 Muse Spark 也挂在这两条协议上，但本插件锁定 Responses。用户若需要 Completions/Messages，应使用 api provider，而不是本 OAuth 插件。
- **Muse Voice Transcribe / Glimmer**：不进入 catalog，不实现 WebSocket / ASR。

## Quota

OMP `packages/ai/src/usage/muse-code.ts` **没有**独立 usage URL。`SOURCE` 就是 `api.meta.ai/muse-code/key`。本插件同样：

```text
POST https://api.meta.ai/muse-code/key
Authorization: Bearer <oauthAccessToken>
Accept: application/json
Content-Type: application/json
x-api-version: 1.0.0

{}
```

注意：body 是空 object，**不是** `{ onboard: true }`。这不是 remint；OMP 也用空 body 读 usage，并注释 Meta 对同一账号返回同一个 `api_key`。插件 **忽略** 响应里的 `api_key`，不写回 vault。

- control traffic，20s timeout + `context.signal`
- 稀疏调用：插件不做进程内 usage 缓存；宿主 quota cache 已有 5 分钟 cooldown 与 in-flight 去重。credential 类型锁定，不把 `subs_usage` 塞进 vault。

`is_subs_active === false`：quota read 失败（稳定文案，不含 token/body）。

从 `subs_usage.window` 与 `subs_usage.weekly` 各最多产生一个 item。`used_percent` 必须是有限且 `>= 0` 的 number，否则该窗口不产生 item。

```ts
remainingRatio = 1 - Math.min(Math.max(used_percent, 0), 100) / 100
```

`resets_at`：string 走 `Date.parse`；number 若 `< 1e12` 视为 Unix 秒并乘 1000，否则视为毫秒。不可解析则省略 `resetsAt`。

| item id  | 条件                                                                 | displayName                                      |
| -------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| `window` | `subs_usage.window` 有有效 `used_percent`                            | 有限正数 `window_duration_mins` 时用 `Nh` / `Nm`；否则 Rolling window / 滚动窗口 |
| `weekly` | `subs_usage.weekly` 有有效 `used_percent`                            | Weekly quota / 周配额                            |

`window` 的稳定 id：`window_duration_mins` 为有限正数时用 `${Math.round(minutes)}m`，否则 `window`。

`plan`：非空 `subs_tier_name`，否则非空 `subs_tier_id`。两个都空则省略。

两个窗口都无效时 quota read 失败（与 Kimi“无有效行即失败”一致），不返回空 `items`。

错误分类（测试与实现使用 `MuseCodeQuotaError`，带 `retryable` + 可选 `status`；正文不含 secret）：

- network、timeout、408、429、5xx：`retryable: true`
- 401、403、`is_subs_active === false`、无效 JSON、无有效 item：`retryable: false`

宿主 quota cache 当前对多数 thrown error 一视同仁并进入 5 分钟 cooldown；`retryable` 仍要写对，避免把 429 伪装成永久订阅失败。不注册 `quota.reset`，不返回 `resetCredits`。

## Built-in 注册

与 xAI 插件相同的宿主接触面：

- `packages/core/src/plugins/builtins.ts` + `builtins.test.ts`：按 package name 字母序插入 `@aio-proxy/plugin-muse-code`（在 `plugin-kimi-code` 之后、`plugin-openai-chatgpt` 之前）。
- `packages/core/package.json`：`"@aio-proxy/plugin-muse-code": "workspace:*"`
- `.changeset/config.json` `fixed` 组加入 `@aio-proxy/plugin-muse-code`
- CLI 内置列表：`packages/cli/src/plugin-commands/plugin/add.test.ts`、`packages/cli/src/plugin-commands/provider-login/capability.resolution.test.ts`、`packages/cli/__tests__/binary-build.test.ts`

Changeset 同时 target `@aio-proxy/plugin-muse-code`、`@aio-proxy/core`、`aio-proxy`，全部 **minor**。不要只 target 内部包。

Dashboard 通过现有 built-in plugin/catalog 接口自动显示，不新增 dashboard 文件。

实现本任务时，`builtins.ts` / CLI 列表很可能与并行的 Claude / OpenRouter built-in PR 冲突。注册任务必须 rebase 后再改这些枚举，不要假设当前 `main` 的列表是最终列表。

## 测试策略

实现遵循 test-first。每个行为只保留最小有价值回归测试：

1. OAuth：device form + Meta 头、`presentDeviceCode`、`authorization_pending`、`slow_down`、deny、expire、timeout、abort、control traffic。
2. Mint：`onboard: true`、20s timeout 与 signal 组合、`is_subs_active === false`、缺 `api_key` 时带 payment URL、缺身份失败、成功后 persist `apiKey` 且 login result 无 `expiresAt`。
3. 身份：`account:` 优先于 `email:`、email 规范化、`suggestedKey` 前缀 `muse-`、secret 不进 fingerprint。
4. `currentMuseCodeCredential`：只 `read()`，永不 `refresh`、永不打 key 端点。
5. Catalog：Bearer **apiKey** + 版本头、Spark/image 分类、curated overlay、retryable fallback、401/空目录不 fallback、AbortError 不 fallback。
6. Runtime：ProviderV4 Responses、`https://api.meta.ai/v1/responses`、Bearer apiKey、无 oauth token、无 raw、catalog 无 image 时 image unsupported。
7. Quota：空 body POST key、忽略返回 `api_key`、window/weekly 比例与 `resetsAt`、429 retryable、inactive 失败、无 reset。
8. Plugin/built-in：`default` adapter、空 account options、中英文 copy、icon `meta`、无 `refreshCredential`、无 CPA importer、package version、embedded registration。

不为常量数组或实现字面量单独写低价值测试。完成前运行插件 unit + build，以及 `bun run check`；合并前跑 `bun run preflight`。

## 验收标准

- `aio-proxy provider login` 可选择 Muse Code，展示 device URL/code，授权且订阅有效后创建 OAuth Provider ID。
- 登录、轮询和发现可被用户取消，且不泄漏 token / apiKey。
- 非活跃订阅或缺 `api_key` 时登录失败；若上游给出 payment URL，错误消息包含该 URL。
- vault 中同时有 `oauthAccessToken` 与 `apiKey`；之后 catalog/runtime 不再调用 key 端点。
- `/v1/models` 展示该账号从 `api.meta.ai/v1/models` 动态发现的 Muse Spark（及若存在的 Muse Image）模型。
- 官方模型发现暂时失败时，新账号可使用 Spark curated fallback；401/403、Abort 或合法空目录不伪造可用模型。
- 任一入站协议经现有转换路径调用 Spark 时，实际 HTTP 打到 `https://api.meta.ai/v1/responses`，Authorization 为铸造 key，并带 `x-api-version: 1.0.0`。
- 现有 quota read 可返回 rolling/weekly 剩余比例与重置时间；不提供 reset。
- Adapter 不注册 `refreshCredential`；不对 `auth.meta.com` 发 refresh_token grant。
)
