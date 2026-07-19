# GitHub Copilot OAuth Provider 设计

日期：2026-07-05
状态：待评审

## 背景

`subscription` provider 命名不够准确：它描述的是账号权益或付费形态，不是 aio-proxy 运行时真正需要实现的机制。这里改为 `oauth` provider：配置表达“这个 provider 由本地 OAuth 登录态驱动”，运行时负责登录、刷新、模型同步和调用。

当前 GitHub Copilot 只是第一个 OAuth provider。实现时应把现有占位的 `ProviderKind.Subscription` / `SubscriptionProviderSchema` 重命名为 `ProviderKind.OAuth` / `OAuthProviderSchema`，并把 config kind 从 `"subscription"` 改为 `"oauth"`。

本设计参考 OpenClaw 的 Copilot device flow / token refresh / base URL 推断 / model policy 逻辑，以及 opencode 的 Copilot `/models` 解析和请求头处理。`@ai-sdk/github-copilot` 不存在，不能作为依赖或运行时 provider。

## 核心决策

| 决策点          | 结论                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| Public kind     | `kind: "oauth"`                                                                                   |
| 公共抽象        | `BaseOAuthProvider` 抽象类                                                                        |
| 登录入口        | 第一版只做 `aio-proxy provider login copilot`，核心登录逻辑用 callbacks 暴露，后续 dashboard 复用 |
| Provider id     | base class 用 `prefix-userId` 生成；Copilot prefix 为 `copilot`                                   |
| Token 来源      | 只支持 device login，不做 env fallback 或 token import                                            |
| OAuth client id | 使用 OpenClaw 参考实现里的 `Iv1.b507a08c87ecfe98`                                                 |
| 模型来源        | 远端 `/models` 为准，本地 auth payload 缓存兜底                                                   |
| 同步策略        | 登录后强制同步；server 启动后台同步；运行中 TTL 1 小时                                            |
| 隐藏模型        | `model_picker_enabled=false` 不路由、不展示                                                       |
| Transport       | 按远端 `supported_endpoints` 映射到已有 bundled AI SDK providers                                  |
| Fallback 路由   | 本轮一起实现多 provider 候选和失败重试                                                            |

## 1. OAuth Provider 抽象

新增 OAuth provider runtime 抽象，目标是让 route 层继续只关心“能否 passthrough / 能否 invoke”，不把 GitHub Copilot 的登录态和模型目录细节散到各协议 route。

`BaseOAuthProvider` 负责：

- 持有 provider family prefix，例如 GitHub Copilot 使用 `copilot`。
- 提供 `login(callbacks)`，由 CLI 或未来 dashboard 注入展示授权 URL、提示、进度、取消信号。
- 接收子类登录返回的 `{ status, payload, userId, accountLabel? }`；base class 不解析 `payload`，只负责存储。
- 用 `${prefix}-${userId}` 组装最终 provider id，并把 provider config 插入用户配置。
- 读取、写入 `Auth` store 中 `(vendor, providerId)` 对应的 payload。
- 提供 `models()`，同步返回当前本地模型缓存，供 Router 和 `/v1/models` 使用。
- 提供 `syncModels({ force })`，异步刷新远端模型并更新 auth payload。
- 提供 `ensureAvailable()`，缺登录态、刷新失败或没有模型缓存时返回可读错误。

GitHub Copilot 子类负责：

- device code flow、polling、`slow_down`、超时和取消。
- 用 GitHub OAuth access token 换短期 Copilot token。
- 登录成功后调用 GitHub `GET /user` 解析账号身份。使用数字 `id` 作为稳定 `userId`；`login` 和公开 `email` 只作为展示 label，因为 email 可能为空且私有邮箱需要额外 scope。
- 从 Copilot token 的 `proxy-ep` 推断 API base URL；无法推断时 enterprise 用 `https://copilot-api.{domain}`，默认 `https://api.individual.githubcopilot.com`。
- 拉取 `/models`，过滤可用且 `model_picker_enabled=true` 的 chat 模型。
- 对可见模型尝试 POST `/models/{id}/policy` 启用 policy；失败不阻断登录和同步。

## 2. Auth Payload 与模型缓存

复用现有 `packages/auth-flows` 的 auth 表，不新增表，不写回用户 config。

GitHub Copilot auth payload 保存：

- `refresh`：GitHub OAuth access token，作为长期凭据。
- `access`：短期 Copilot bearer token。
- `expires`：`access` 过期时间，带安全 buffer。
- `enterpriseUrl`：可选 enterprise domain。
- `baseUrl`：当前 Copilot API base URL。
- `models`：远端同步后的 `ModelEntry[]` 加上内部 transport metadata。
- `syncedAt`：模型目录同步时间。

`models()` 只读本地 payload，因此保持同步 API。`syncModels()` 成功后用 CAS 更新 payload，失败时保留旧模型缓存。没有登录态或没有缓存时，该 OAuth provider 暂时没有可路由模型。

## 3. 调用与 Headers

不新增 `@ai-sdk/github-copilot`。按远端 `supported_endpoints` 选择现有 transport：

- `/v1/messages`：使用 bundled `@ai-sdk/anthropic`。
- `/responses`：使用 bundled `@ai-sdk/openai` 的 responses model resolver。
- `/chat/completions`：使用 bundled `@ai-sdk/openai-compatible`。

GitHub Copilot provider 在内部构造对应 AI SDK provider/options，注入 Copilot token、base URL 和 headers。headers 对齐 OpenClaw 的内置 Copilot provider：

- 固定 IDE-style headers：`User-Agent`、`Editor-Version`、`Editor-Plugin-Version`、`Copilot-Integration-Id: vscode-chat`。
- policy 请求加 `openai-intent: chat-policy` 和 `x-interaction-type: chat-policy`。
- 模型调用加 Copilot API 需要的版本/intent headers。
- 输入包含图片时加 `Copilot-Vision-Request: true`。
- tool-result 跟进、非普通用户续写等 agent 场景标记 `x-initiator: agent`，否则默认 `user`。

## 4. Router Fallback

按 AGENTS.md 的 model-first 路由原则，把 Router 从单一 resolution 改为候选列表：

- 同一个 alias 可对应多个 provider，按 config order/weight 顺序尝试。
- `providerId/modelAlias` 仍只解析指定 provider。
- disabled provider 不参与候选。
- raw API provider 同协议仍走 passthrough；协议不匹配仍桥到 AI SDK invoke。
- OAuth provider 只走 invoke，不走 raw passthrough。

Fallback 触发条件：

- 网络异常或 provider invoke 抛错。
- raw passthrough 返回 `429` 或 `5xx`。
- AI SDK 调用在响应提交前失败。

不 fallback 的情况：

- 上游返回普通 `4xx`。
- streaming response 已经开始写出。

所有候选都失败时，返回最后一个失败结果，保留 AGENTS.md 中“preserve final failure”的语义。前序失败可进入内部日志，第一版不改变公开错误格式。

## 5. CLI 登录入口

新增 `aio-proxy provider login copilot`：

- `copilot` 是 provider family，不是最终 provider id。
- 调用核心 `login("copilot", callbacks)`。
- CLI callbacks 在终端打印 verification URL、user code 和进度。
- 登录成功后 base class 生成 provider id，例如 `copilot-1234567`。
- CLI 将 `{ kind: "oauth", vendor: "github-copilot" }` 插入 config 的 `providers[providerId]`。
- 如果 `providers[providerId]` 已存在且也是 Copilot OAuth provider，只更新 auth payload 和模型缓存，不重复插入。
- 写入 auth payload，并强制执行一次模型同步。

这个 CLI 命令不承担 OAuth 逻辑，只负责把 terminal I/O 适配成 callbacks。dashboard 后续可用同一核心接口实现 start/poll/cancel 或 SSE UI。

## 非目标

- 不支持 env token fallback。
- 不支持 non-interactive token import。
- 不实现 dashboard 登录 UI。
- 不新增数据库表。
- 不新增 Copilot 专用 npm provider 依赖。
- 不路由 `model_picker_enabled=false` 的 utility/hidden 模型。

## 验收

- `provider login copilot` 完成 device flow 后，config 中出现 `copilot-<github-user-id>` provider，auth store 有 token、base URL、模型缓存。
- `/v1/models` 展示远端 picker-enabled Copilot 模型。
- Copilot provider 可通过 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages、Gemini 入站协议的现有 transform route 调用。
- Copilot `/models` 同步失败时，旧本地模型缓存仍可用。
- 同 alias 多 provider 时按顺序 fallback；`429`、`5xx`、网络异常触发下一个候选，普通 `4xx` 不触发。
- 全部候选失败时返回最后一个失败。
