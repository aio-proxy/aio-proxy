---
slug: chatgpt-oauth-login
status: awaiting-approval
intent: clear
pending-action: write .omo/plans/chatgpt-oauth-login.md
approach: 从 main 切 `feat/chatgpt-oauth-login` 分支后开工；新增 openai-chatgpt vendor 的 OAuth provider（PKCE loopback 于 http://localhost:1455，用 Bun.serve），沿用 packages/oauth 的 BaseOAuthProvider 抽象；在 packages/server 里为 chatgpt 分派专用 runtime provider，走 @ai-sdk/openai 的 responses transport（resolveModel: resolveOpenAIResponsesModel）并注入自定义 fetch 完成 URL 改写 + per-instance single-flight token 刷新（Auth.set 保留 fingerprint）+ Bearer/ChatGPT-Account-Id/originator=codex-tui/User-Agent=codex-tui/0.135.0/session-id 头；扩展 Types 里 vendor 为 `OAuthVendor` enum；给 CLI 增加 login <family=chatgpt>（models 用 {alias,id} 内嵌形式，不写顶层 alias）；模型清单硬编码 gpt-5.5 白名单；TDD 覆盖 PKCE、token 交换、refresh、URL 改写、账户 id 提取（JWT decode 使用 jose，object guard 使用 es-toolkit，不手写 decode/isRecord）、fingerprint 保留、Responses-API body 形状、login form、CLI 写配置这些关键分支。
---

# Draft: chatgpt-oauth-login

## Components (topology ledger)
- oauth-provider | ChatGPT PKCE loopback login + refresh + JWT claim 提取 in packages/oauth | active | packages/oauth/src/github-copilot/index.ts:35 (类比模板)
- types-vendor | 新增 `OAuthVendor` enum，并让 vendor schema 基于 enum（github-copilot | openai-chatgpt） | active | packages/types/src/provider.ts:41
- server-runtime | server 侧按 vendor 分派，为 chatgpt 构造带自定义 fetch 的 @ai-sdk/openai runtime provider | active | packages/server/src/oauth-runtime.ts:9, packages/server/src/provider-runtime.ts:41
- cli-login | provider login chatgpt 子命令，写回 aio-proxy.json | active | packages/cli/src/provider-commands.ts:66

## Open assumptions (announced defaults)
- assumption | adopted default | rationale | reversible?
- Auth 存储 vendor key | OAuthVendor.OpenAIChatGPT (= "openai-chatgpt") | 与 provider vendor enum 保持完全一致，避免第二个映射表 | 可改（enum + 若干 test fixture）
- Auth prefix / providerId 前缀 | "chatgpt" | Auth prefix 是 provider id 的第一段，用户直觉上 chatgpt 比 openai 更贴，且不与 configured openai API provider 名冲撞 | 可改
- account fingerprint | JWT chatgpt_account_id | 与 openclaw / CLIProxyAPI 一致；同一账户续 login 时 CAS 保持一致，跨账户切换会更新 fingerprint | 可改
- 硬编码模型白名单 | gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark（黑名单 gpt-5.5-pro） | 用户已确认对齐 anomalyco codex.ts | 用户可覆盖时改
- login redirectUri | http://localhost:1455/auth/callback（不允许覆盖 host） | 与三家参考完全一致；OpenAI 端可能只放行 localhost | 可后续加 --host 覆盖
- refresh 触发时机 | lazy：每次请求 access.expires < Date.now() 前若干秒时刷新 | 与 anomalyco 一致；无后台调度器；简单 | 未来可加背景调度
- User-Agent | 用户已选 codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0) 静态字符串 | 用户裁定 | 可改
- originator 头 | codex-tui | 用户裁定 | 可改
- 上游 baseURL | https://chatgpt.com/backend-api/codex（响应端点拼 /responses） | 三家参考一致 | 不改

## Findings (cited - path:lines)
- BaseOAuthProvider 抽象、loginForm、payload、providerId 命名机制：packages/oauth/src/oauth-provider.ts:75-98
- Auth 存储 CAS + 明文 payload：packages/oauth/src/store.ts:16, packages/oauth/src/store.ts:109
- Auth payload 惯例：包含 access / refresh / expires 等，list 时 hasToken/expiresAt/accountLabel 从 payload 读：packages/oauth/src/payload.ts:22-46
- GitHub Copilot 参考模板（device flow + fetchJson + models）：packages/oauth/src/github-copilot/index.ts:35, packages/oauth/src/github-copilot/index.ts:115, packages/oauth/src/github-copilot/index.ts:170, packages/oauth/src/github-copilot/schema.ts:1-68
- Types vendor literal 位置：packages/types/src/provider.ts:41
- Types 中 OAuthProvider 未被 config schema omit id，key 在 config 里作为 provider id：packages/types/src/config.ts:15-29
- server 中 vendor union 的第二处 literal：packages/server/src/runtime.ts:12
- server oauth-runtime 现只支持 copilot：packages/server/src/oauth-runtime.ts:1-111
- provider-runtime 里 OAuth 分派单一分支：packages/server/src/provider-runtime.ts:41-47
- @ai-sdk/openai loader 直接透传 options（可含 fetch）：packages/core/src/provider/ai-sdk-loader.ts:32-36
- createAiSdkProvider 消费 config.options 作为 loader 入参：packages/core/src/provider/ai-sdk.ts:142-144
- CLI provider login 硬编码 family：packages/cli/src/provider-commands.ts:66-87
- CLI 写配置模式（models + alias 键）：packages/cli/src/provider-commands.ts:80-98
- 现有 test hook 惯例（AIO_PROXY_TEST_COPILOT_LOGIN）：packages/cli/src/provider-commands.ts:100-107
- copilot test 的 fetch mock + isolateHome 模式：packages/oauth/_test/github-copilot.test.ts:20-70

参考实现（外部）：
- openclaw PKCE 常量与 authorize：github.com/openclaw/openclaw extensions/openai/openai-chatgpt-oauth-flow.runtime.ts#L30, #L298
- openclaw loopback callback server：extensions/openai/openai-chatgpt-oauth-flow.runtime.ts#L329
- openclaw token exchange + refresh：#L192-L296, #L556
- openclaw account claim 提取：extensions/openai/openai-chatgpt-auth-identity.ts#L72
- CLIProxyAPI 常量、参数：internal/auth/codex/openai_auth.go#L23-L86
- CLIProxyAPI PKCE：internal/auth/codex/pkce.go#L13-L56
- CLIProxyAPI URL 改写与 headers：internal/runtime/executor/codex_executor.go#L741, #L1580-L1646
- anomalyco codex.ts URL 改写、模型白名单、fetch 拦截：packages/opencode/src/plugin/openai/codex.ts

## Decisions (with rationale)
- 只做 PKCE loopback（用户裁定）；device code 不实现，后续加也不影响 API 契约。
- 沿用 BaseOAuthProvider + Auth 存储 + loginForm.prompts，不新增 auth 抽象；loginForm.prompts 为空数组（PKCE 不需用户输入）。
- Runtime 层用 @ai-sdk/openai + 自定义 fetch：既能同 protocol passthrough（inbound openai-response）也能被 route-dispatch.ts 已有的 toAiSdkProvider(OAuth 分支) 走 ai-sdk 路径 crossover。zero 新代码路径，符合 AGENTS.md。
- Fetch wrapper 语义（严格照搬 anomalyco 模式）：删除 caller 传的 authorization 头 → 若 access 到期取 refresh 单飞 → 命中 /v1/responses 或 /chat/completions 时把 URL 改写到 codexApiEndpoint → 注入 authorization=Bearer + ChatGPT-Account-Id + Originator + User-Agent + session-id。
- 模型白名单硬编码在 chatgpt oauth provider 里；provider.models() 直接返回，login 时把它们写入 config.models + alias。
- test 通过 fetch mock 覆盖：authorize / token / refresh / models() / URL 改写行为，不真的起 http server（在 login 测试里注入一个 fake redirectPromise 或者对 startLocalOAuthServer 做一层可注入依赖）。
- Auth payload schema：{ access, refresh, expires, accountId, accountLabel, models } —— accountId 双份存（既在 fingerprint 也在 payload，方便 fetch wrapper 无需重解析 JWT）。

## Scope IN
- packages/oauth: 新增 openai-chatgpt/ 子目录（index.ts + oauth-flow.ts + jwt.ts + schema.ts）+ 从 src/index.ts 导出
- packages/oauth: PKCE 生成 + authorize URL builder + loopback server + token exchange + refresh
- packages/types: OAuthProvider vendor 扩为 z.enum
- packages/server: server/src/oauth-runtime.ts 抽出 vendor 分派；新增 chatgpt runtime provider（自定义 fetch）；server/src/runtime.ts 里 OAuthProviderInstance.vendor union
- packages/cli: provider login 支持 chatgpt family；写配置注入 kind=oauth + vendor=openai-chatgpt + models + alias
- 全部 TDD：先写测试、后写实现，单元测试至少覆盖：PKCE 生成、authorize URL 参数、token exchange、refresh、JWT claim 提取、fetch wrapper URL 改写与 header 注入、login form shape、models() 返回值、CLI 写 config 行为

## Scope OUT (Must NOT have)
- 不实现 device code flow（不代码，不留半成品）
- 不动 /packages/dashboard（登录 UI 后续独立计划）
- 不引入后台 refresh 调度器
- 不做 originator/UA 的用户可配置化（走硬编码，等第二版）
- 不改 GitHub Copilot 现有分支的行为
- 不新增 npm 依赖
- 不写 e2e（e2e 保留给未来集成一次真实 chatgpt 登录测试；本轮只 unit）
- 不引入除现有之外的 zod schema 版本 / 未预置的 ai-sdk 包

## Open questions
（无 - 全部经用户裁定或有 defensible default）

## Approval gate
status: awaiting-approval
