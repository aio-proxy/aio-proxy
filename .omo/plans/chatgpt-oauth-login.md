# chatgpt-oauth-login - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** aio-proxy 支持"用 ChatGPT Plus/Pro 订阅账号登录并直接把 gpt-5.5 系列模型代理出去"的能力：一条 CLI 命令走浏览器 PKCE 授权，本地存 token，上游请求自动刷新 token 并伪装成 Codex 官方客户端命中 chatgpt.com Codex 端点。

**Why this approach:** 沿用仓库已有的 OAuth provider 抽象（GitHub Copilot 用同一套），把 ChatGPT 视作第二个 vendor；与 Codex 上游对话的所有魔法（token 刷新、URL 改写、伪装头）都塞在一层自定义 fetch 里交给 @ai-sdk/openai，不新增 provider kind、不加运行时依赖。

**What it will NOT do:** 不做无头 device code 登录、不做后台自动刷新任务、不动 Web dashboard、不允许把 originator 或 User-Agent 改成用户自定义值（本轮全部硬编码）。

**Effort:** Medium
**Risk:** Medium - upstream 若变更 originator/UA 校验或改 Codex 端点契约，需要跟进；PKCE loopback 依赖 1455 端口本机可用。
**Decisions to sanity-check:** 只上 PKCE loopback（不做 device code）；模型硬编码 gpt-5.5/5.4/5.4-mini/5.3-codex-spark 白名单；伪装成 codex-tui 而非 aio-proxy 或 codex_cli_rs；vendor 字符串定为 "openai-chatgpt"，CLI family 定为 "chatgpt"。

Your next move: 直接 `$start-work` 开工，或先跑一次 dual Momus 高精度 review 再开工。完整执行细节见下。

---

> TL;DR (machine): Medium/Medium; adds openai-chatgpt OAuth vendor with PKCE loopback login, custom-fetch runtime provider that rewrites URL to chatgpt.com/backend-api/codex/responses and injects codex-tui headers; TDD across 12 todos in 4 waves.

## Scope
### Must have
- `packages/oauth` 新增 `openai-chatgpt` 子模块：PKCE 生成、authorize URL 构造、http://localhost:1455/auth/callback 回调 server、`/oauth/token` exchange 与 refresh、JWT `chatgpt_account_id` 提取、`BaseOAuthProvider` 子类、硬编码模型白名单
- `packages/types` 里 `OAuthProviderSchema.vendor` 从 `z.literal("github-copilot")` 扩为 `z.enum(["github-copilot", "openai-chatgpt"])`
- `packages/server` 里 OAuth runtime 分派按 `vendor` 分支：GitHub Copilot 保持现状；ChatGPT 走 `@ai-sdk/openai`（responses transport）+ 自定义 `fetch`：删除 caller 的 Authorization、按 expires 单飞刷新、把 `/v1/responses` 与 `/chat/completions` 改写到 `https://chatgpt.com/backend-api/codex/responses`、注入 `Authorization: Bearer <access>`、`ChatGPT-Account-Id`、`Originator: codex-tui`、`User-Agent: codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)`、`session-id` UUID
- `packages/server/src/runtime.ts` 里 `OAuthProviderInstance.vendor` 扩为 union
- `packages/cli` 里 `provider login chatgpt` 子命令：走浏览器（`open`/`xdg-open`），写回 `aio-proxy.json` 里 `kind=oauth`, `vendor=openai-chatgpt`, `models=[{alias,id}...]`（不写顶层 `alias`——`OAuthProviderSchema` 无该字段，会被 zod strip）
- 全模块 TDD：所有实现前先写失败测试（bun:test），单元测试覆盖 PKCE、authorize URL params、token exchange、refresh、JWT claim 提取、fetch wrapper 的 URL 改写与 header 注入、login form 形状、models 返回、CLI 写 config
### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不实现 device code flow（本轮）
- 不动 `packages/dashboard`
- 不新增后台 refresh 调度器
- 不改 GitHub Copilot 分支行为
- 只允许新增 `jose` 与 `es-toolkit` 两个运行时依赖（JWT decode 使用 `jose`，对象 guard 使用 `es-toolkit`；其它依赖一律不加）
- 不做 originator / User-Agent 用户可配置化
- 不写 e2e / integration 测试（保留下一版）
- 不实现 device code、manual code paste、preflight TLS 检查
- 不允许 originator / UA 从环境变量或 config 读入
- 不允许 chatgpt runtime provider 复用 GitHub Copilot 的 headers
- 不改 `Auth` 存储 schema（沿用现 CAS 与 payload JSON 存法）

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD - bun:test（现仓库 `bun test _test/*.test.ts` 已经在跑）
- 每个新增/修改文件的测试先于实现落盘且必须先失败一次；`bun run preflight` 必须最终通过
- Evidence: `.omo/evidence/task-<N>-chatgpt-oauth-login.<ext>`（每 todo 的 QA 命令输出/日志）

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave.
- Wave 0（前置，串行必须先跑）：T0 branch
- Wave 1（可并行）：T1 types-schema、T2 oauth-jwt、T3 oauth-pkce、T4 oauth-schema
- Wave 2（依赖 Wave 1）：T5 oauth-flow-loopback、T6 oauth-flow-token、T7 oauth-provider-class
- Wave 3（依赖 Wave 2）：T8 server-runtime-fetch-wrapper、T9 server-runtime-dispatch、T10 cli-login-chatgpt、T11 oauth-index-export
- Wave 4（依赖前）：T12 preflight-check

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| T0 branch | - | ALL | - |
| T1 types-schema | T0 | T9, T10 | T2, T3, T4 |
| T2 oauth-jwt | T0 | T6, T7, T8 | T1, T3, T4 |
| T3 oauth-pkce | T0 | T5, T6 | T1, T2, T4 |
| T4 oauth-schema | T0 | T6, T7, T11 | T1, T2, T3 |
| T5 oauth-flow-loopback | T3 | T7 | T6 |
| T6 oauth-flow-token | T2, T3, T4 | T7, T8 | T5 |
| T7 oauth-provider-class | T2, T5, T6 | T8, T10, T11 | - |
| T8 server-runtime-fetch-wrapper | T2, T6, T7 | T9 | T10 |
| T9 server-runtime-dispatch | T1, T8 | T12 | T10 |
| T10 cli-login-chatgpt | T1, T7 | T12 | T8, T9 |
| T11 oauth-index-export | T4, T7 | T12 | T8, T9, T10 |
| T12 preflight-check | T9, T10, T11 | - | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 0. Repo root: 从 main 切工作分支 `feat/chatgpt-oauth-login` 并保留 plan/draft 文件 - expect `git branch --show-current` === `feat/chatgpt-oauth-login`，plan/draft 仍在 worktree
  What to do / Must NOT do: `git checkout -b feat/chatgpt-oauth-login`（当前 main 干净、只有 `.omo/drafts/chatgpt-oauth-login.md` 与 `.omo/plans/chatgpt-oauth-login.md` 两个 untracked，跟随分支切换）；不做首个 commit（plan/draft 文件本轮不进 git，交给用户按仓库习惯决定）；不 push；不 rebase；不动其它分支。DO NOT `git add .`；DO NOT `git stash`（无未 commit 修改）。若分支已存在则 `git checkout feat/chatgpt-oauth-login`（幂等）；若 worktree 有本 plan 之外的 dirty 文件则**停下**并报告用户（避免误覆盖）。
  Parallelization: Wave 0 | Blocked by: - | Blocks: T1, T2, T3, T4（后续所有 todo 都在这个分支上做 commit）
  References: `git status --porcelain`（当前 clean 除本 plan artifacts）；本仓库无 CONTRIBUTING.md 分支命名约定（AGENTS.md 未指定），沿用 `feat/<slug>` 惯例
  Acceptance criteria: `git branch --show-current` 输出 `feat/chatgpt-oauth-login`；`git status --porcelain` 只列 `.omo/drafts/chatgpt-oauth-login.md` 与 `.omo/plans/chatgpt-oauth-login.md`（或用户自行决定的等价状态）；`git log -1 --format=%H origin/main..HEAD` 为空（还未产生 commit）
  QA scenarios: happy - 手工 `git branch --show-current && git status --porcelain` 与预期一致；failure - 若 `git checkout -b` 报错分支已存在，改跑 `git checkout feat/chatgpt-oauth-login`（一次即可）；failure - 若 worktree 有其它 dirty 文件，QA 手动 `git status` 报告后由用户决定 stash / commit。Evidence `.omo/evidence/task-0-chatgpt-oauth-login.log`
  Commit: N（切分支不 commit）

- [x] 1. `packages/types/src/provider.ts:41`: 新增 `OAuthVendor` enum 并让 `OAuthProviderSchema.vendor` 使用 `z.enum(OAuthVendor)`，包含 `github-copilot` 与 `openai-chatgpt` - expect ProviderSchema 能 parse 两个 vendor
  What to do / Must NOT do: 遵循同文件 `ProviderKind` / `ProviderProtocol` 模式新增 `export enum OAuthVendor { GitHubCopilot = "github-copilot", OpenAIChatGPT = "openai-chatgpt" }`；`OAuthProviderSchema.vendor` 必须写成 `z.enum(OAuthVendor).describe("OAuth vendor.")`；同时更新相关测试从字符串或 enum 常量均可，但 schema 必须基于 enum；不动其它字段；不引入 `openai` 之类的第三个值。
  Parallelization: Wave 1 | Blocked by: - | Blocks: T9, T10, T12
  References: `packages/types/src/provider.ts:38-42`（当前定义），`packages/types/src/provider.ts:121-128`（导出类型），`packages/types/_test/`（如无对应测试则新建 `provider.test.ts`）
  Acceptance criteria: `bun test packages/types/_test/provider.test.ts` 中：`ProviderSchema.parse({ kind: "oauth", vendor: "openai-chatgpt", id: "chatgpt-user123", enabled: true })` 成功；`... vendor: "openai" ...` 抛 zod 错误
  QA scenarios: happy - `bun test packages/types/_test/provider.test.ts -t "openai-chatgpt vendor"` 通过；failure - `bun test ... -t "unknown vendor rejected"` 通过。Evidence `.omo/evidence/task-1-chatgpt-oauth-login.log`
  Commit: Y | `feat(types): allow openai-chatgpt oauth provider vendor`

- [x] 2. `packages/oauth/src/openai-chatgpt/jwt.ts` (new): 用 `jose` decode JWT，并用 `es-toolkit` 的对象 guard 读出 access token 里的 `payload["https://api.openai.com/auth"].chatgpt_account_id` claim - expect 返回 `string | undefined`
  What to do / Must NOT do: 新增依赖只限 `jose` 与 `es-toolkit`（优先加到 root catalog，并在 `packages/oauth/package.json` dependencies 引用 catalog；若 monorepo 约定不适用则最小改动加到 `packages/oauth/package.json`）；JWT payload decode 必须用 `jose`（例如 `decodeJwt`），不要自己 `Buffer.from(..., "base64url")`；对象判断必须用 `es-toolkit`（例如 `isPlainObject` / `isObject`，按库实际导出选择），不要手写 `isRecord`；claim 优先级：top-level `chatgpt_account_id` > nested object `payload["https://api.openai.com/auth"].chatgpt_account_id` > `organizations[0].id`。DO NOT verify signatures；DO NOT throw on malformed input（`jose` 抛错时 catch 并 return `undefined`）。
  Parallelization: Wave 1 | Blocked by: - | Blocks: T6, T7, T8
  References: 外部 anomalyco `parseJwtClaims`/`extractAccountIdFromClaims`：`https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/openai/codex.ts`；openclaw `extensions/openai/openai-chatgpt-auth-identity.ts:5-102`：`https://github.com/openclaw/openclaw/blob/main/extensions/openai/openai-chatgpt-auth-identity.ts`；CLIProxyAPI `internal/auth/codex/jwt_parser.go`：`https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/codex/jwt_parser.go`
  Acceptance criteria: 单元测试用 `jose`/fixture token（有 top-level `chatgpt_account_id` / 有 nested / 只有 `organizations`）分别断言正确 accountId；1 个 malformed token（只有 2 段）断言 `undefined`；源码中不得出现 `Buffer.from(` 或手写 `function isRecord`/`const isRecord`。
  QA scenarios: happy - `bun test packages/oauth/_test/openai-chatgpt.test.ts -t "extractAccountId prefers top-level claim"` 通过；failure - `bun test ... -t "extractAccountId returns undefined for malformed token"` 通过。Evidence `.omo/evidence/task-2-chatgpt-oauth-login.log`
  Commit: Y | `feat(oauth): add ChatGPT JWT accountId extractor`

- [x] 3. `packages/oauth/src/openai-chatgpt/pkce.ts` (new): PKCE verifier + S256 challenge + state - expect verifier 是 43 字符 URL-safe，challenge 是 verifier 的 base64url(SHA-256)
  What to do / Must NOT do: 沿用 anomalyco 的字符集（`A-Za-z0-9-._~`）与 43 长度；`base64UrlEncode` = base64 → `+/` → `-_` → 去 `=`；`generateState` = 32 random bytes → base64url。DO NOT 用 crypto.randomUUID（entropy 不同）；DO NOT 使用 base64 with padding。
  Parallelization: Wave 1 | Blocked by: - | Blocks: T5, T6
  References: anomalyco `codex.ts:generatePKCE/base64UrlEncode`：`https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/openai/codex.ts`；openclaw `extensions/openai/openai-chatgpt-pkce.runtime.ts` + `src/plugin-sdk/provider-oauth-runtime.ts:247-267`：`https://github.com/openclaw/openclaw`；CLIProxyAPI `internal/auth/codex/pkce.go:13-56`：`https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/auth/codex/pkce.go`
  Acceptance criteria: 生成 100 组，每组 verifier length===43、只含允许字符集、challenge===base64url(sha256(verifier)) 全部成立
  QA scenarios: happy - `bun test packages/oauth/_test/openai-chatgpt.test.ts -t "generatePKCE produces valid verifier and challenge"` 通过；failure - `bun test ... -t "base64url strips padding"` 通过。Evidence `.omo/evidence/task-3-chatgpt-oauth-login.log`
  Commit: Y | `feat(oauth): add PKCE helpers for ChatGPT OAuth`

- [x] 4. `packages/oauth/src/openai-chatgpt/schema.ts` (new): 定义 `tokenResponseSchema`（access_token/refresh_token/id_token?/expires_in?）、`ChatGPTPayload` 与 `ChatGPTModel` 类型 - expect `z.output` 与 `OAuthLoginPayload` 兼容
  What to do / Must NOT do: token response 用 `.passthrough()` 保持前向兼容；`expires_in` 缺失时 fallback 3600（在 provider 内 apply，不在 schema 里）；同时 export `type ChatGPTModel = OAuthProviderModel`（本轮不带额外 metadata；仅作为对外 named type，未来加 quota/context 时不影响 caller）。DO NOT include user info schema（本轮不 fetch userinfo）。
  Parallelization: Wave 1 | Blocked by: - | Blocks: T6, T7, T11
  References: `packages/oauth/src/github-copilot/schema.ts:23-31`（类比），`packages/oauth/src/oauth-provider.ts:54-73`（`OAuthLoginPayload` 与 `OAuthProviderModel` 契约）
  Acceptance criteria: 单元测试 `tokenResponseSchema.parse` 接受最小必需字段、拒绝缺 access_token；`ChatGPTPayload` 类型有 `access/refresh/expires/accountId/models` 字段；`ChatGPTModel` 是 `OAuthProviderModel` 的 alias（`type` 层校验通过 `bun run check`）
  QA scenarios: happy - `bun test packages/oauth/_test/openai-chatgpt.test.ts -t "tokenResponseSchema parses valid response"` 通过；failure - `... "tokenResponseSchema rejects missing access_token"` 通过。Evidence `.omo/evidence/task-4-chatgpt-oauth-login.log`
  Commit: Y | `feat(oauth): add ChatGPT OAuth schemas`

- [x] 5. `packages/oauth/src/openai-chatgpt/loopback.ts` (new): 用 `Bun.serve` 起 `localhost:1455` 的 callback 监听，路径 `/auth/callback` 匹配 code+state - expect 收到匹配 state 的请求 resolve `{ code, state }`，state 不匹配则 reject
  What to do / Must NOT do: 使用 `Bun.serve({ hostname: "127.0.0.1", port: 1455, fetch(req) {...} })`（注意本仓库 Bun 1.3.14）；返回 `{ waitForCode(signal?: AbortSignal): Promise<{code, state}>, close(), redirectUri: "http://localhost:1455/auth/callback" }`；`waitForCode` 接受可选 `AbortSignal`，abort 时 close server 并 reject 出 `ChatGPTOAuthAbortedError`；成功页面写一段静态 HTML "You may close this window"；错误页写 error 文案；`Bun.serve` 抛错（例如端口占用）时抛 `ChatGPTOAuthPortInUseError(port)`（携带 port 与原始 error）。测试里通过 `hostname: "127.0.0.1", port: 0`（`Bun.serve` 支持随机端口）+ `server.port` 拿实际端口写入 `redirectUri`，避免真占 1455——因此 `createLoopbackServer({ port })` 需要接收 `port` 参数（默认 `1455`）。DO NOT 用 `node:http`（Bun 项目，全部走 Bun.serve）；DO NOT keep-alive；DO NOT 允许 host 覆盖，只允许 port 参数覆盖（仅用于测试）。
  Parallelization: Wave 2 | Blocked by: T3 | Blocks: T7
  References: 外部 anomalyco `codex.ts:startOAuthServer/waitForOAuthCallback`（github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/openai/codex.ts）；`extensions/openai/openai-chatgpt-oauth-flow.runtime.ts:329-401` (github.com/openclaw/openclaw)；`internal/auth/codex/oauth_server.go:69-220` (github.com/router-for-me/CLIProxyAPI)；`packages/cli/src/main.ts:92-96`（同项目 Bun.serve 用法）
  Acceptance criteria: 测试用 `port: 0` 拿到 `server.port` 后 `fetch("http://localhost:${port}/auth/callback?code=abc&state=xyz")`，断言 `waitForCode()` 返回 `{ code: "abc", state: "xyz" }`；state 不匹配时 return 400 且 waitForCode reject `ChatGPTStateMismatchError`；`AbortController.abort()` 后 waitForCode reject `ChatGPTOAuthAbortedError`；port-in-use 时抛 `ChatGPTOAuthPortInUseError`
  QA scenarios: happy - `bun test packages/oauth/_test/openai-chatgpt.test.ts -t "loopback resolves on matching state"` 通过；failure - `... "loopback rejects on state mismatch"` 通过；failure - `... "loopback rejects when abort signal fires"` 通过；failure - `... "loopback throws ChatGPTOAuthPortInUseError when Bun.serve fails"` 通过（用 mock 让 Bun.serve throw）。Evidence `.omo/evidence/task-5-chatgpt-oauth-login.log`
  Commit: Y | `feat(oauth): add ChatGPT OAuth loopback callback server`

- [x] 6. `packages/oauth/src/openai-chatgpt/oauth-flow.ts` (new): `exchangeCodeForTokens(code, verifier)` + `refreshAccessToken(refreshToken)`，都 POST `https://auth.openai.com/oauth/token` - expect 返回 `{ access, refresh, expires, accountId }`
  What to do / Must NOT do: `exchange` body: `grant_type=authorization_code&code=&redirect_uri=&client_id=&code_verifier=`；`refresh` body: `grant_type=refresh_token&refresh_token=&client_id=`；从 access_token 或 id_token JWT 提取 accountId（重用 T2）；`expires` = `Date.now() + (expires_in ?? 3600) * 1000`；response !ok 时抛 `ChatGPTTokenExchangeError` 携带 status。DO NOT include client_secret；DO NOT retry（依赖 upstream 幂等）。
  Parallelization: Wave 2 | Blocked by: T2, T3, T4 | Blocks: T7, T8
  References: 外部 anomalyco `codex.ts:exchangeCodeForTokens/refreshAccessToken`：`https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/openai/codex.ts`；openclaw `extensions/openai/openai-chatgpt-oauth-flow.runtime.ts:192-296, 556-573`：`https://github.com/openclaw/openclaw`；CLIProxyAPI `internal/auth/codex/openai_auth.go:91-278`：`https://github.com/router-for-me/CLIProxyAPI`
  Acceptance criteria: 用 fetch mock 断言 request body 精确匹配预期字段；对 mock 200 response 断言解析出 `access/refresh/expires/accountId`；对 mock 400 response 断言抛 `ChatGPTTokenExchangeError`；refresh 不改变 refresh_token 值时正确回填
  QA scenarios: happy - `bun test packages/oauth/_test/openai-chatgpt.test.ts -t "exchangeCodeForTokens posts x-www-form-urlencoded"` 通过；happy - `... "refreshAccessToken updates access and expires"`；failure - `... "exchangeCodeForTokens throws on 400"` 通过。Evidence `.omo/evidence/task-6-chatgpt-oauth-login.log`
  Commit: Y | `feat(oauth): add ChatGPT OAuth token exchange and refresh`

- [x] 7. `packages/oauth/src/openai-chatgpt/index.ts` (new): `OpenAIChatGPTOAuthProvider extends BaseOAuthProvider<ChatGPTPayload>`，`vendor="openai-chatgpt"`, `prefix="chatgpt"`, `loginForm.prompts=[]`；`login()` 编排 PKCE→loopback→open browser→exchange，构造 payload 并调 `this.store()`；`models()` 返回硬编码白名单 - expect `provider.login({}, callbacks)` 端到端 mock 通过后返回 `{ providerId: "chatgpt-<accountId>", payload, status: "authenticated", userId, accountLabel }`
  What to do / Must NOT do: 白名单：`gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark`（每个 alias===id）；`accountLabel` 用 accountId（无 email fetch）；`onAuth({ url })` 触发时 caller 打开浏览器；`callbacks.signal` 通过 `AbortSignal` 传给 `waitForCode(signal)` 与 `fetch(..., { signal })` — 不通过 close 事件手工桥接。`loginForm.label` 使用**字符串字面量** `"Login with ChatGPT (Plus/Pro)"`（不引入 i18n key，避免 T12 触发 paraglide 未编译错误；后续单开一个 i18n plan）。DO NOT 内嵌 `open`/`xdg-open`（那是 CLI 层的事）；DO NOT 拉 userinfo；DO NOT 写除 payload 外的 side effect；DO NOT 使用 `m["oauth.openai-chatgpt.login_label"]()`。
  Parallelization: Wave 2 | Blocked by: T2, T5, T6 | Blocks: T8, T10, T11
  References: `packages/oauth/src/oauth-provider.ts:75-98`（父类契约）；`packages/oauth/src/github-copilot/index.ts:35-113`（同型模板；label 用 i18n key，本 todo 不学此点）；openclaw `extensions/openai/openai-chatgpt-oauth-flow.runtime.ts:420-550`（编排参考，`https://github.com/openclaw/openclaw`）；CLIProxyAPI `sdk/auth/codex.go:53-197`：`https://github.com/router-for-me/CLIProxyAPI`
  Acceptance criteria: `provider.loginForm` 深等于 `{ type: "oauth", label: "Login with ChatGPT (Plus/Pro)", prompts: [] }`；`provider.models(payload)` 返回长度 4 的数组；用 fetch mock 完整跑一次 login，断言 `Auth.get("openai-chatgpt", "chatgpt-<accountId>")?.payload.access` 命中，`accountLabel === accountId`；`AbortController.abort()` 时 `login()` reject
  QA scenarios: happy - `bun test packages/oauth/_test/openai-chatgpt.test.ts -t "login stores payload and returns providerId"` 通过；happy - `... "models returns hardcoded whitelist"`；failure - `... "login rejects on state mismatch"`；failure - `... "login rejects when abort signal fires"`。Evidence `.omo/evidence/task-7-chatgpt-oauth-login.log`
  Commit: Y | `feat(oauth): add OpenAI ChatGPT OAuth provider`

- [x] 8. `packages/server/src/oauth-runtime.ts`: 新增 `createOpenAIChatGPTRuntimeProvider(config)` 与共用 helper `codexFetchWrapper({ providerId, getPayload, refresh, endpoint })` - expect 请求 `/v1/responses` 或 `/chat/completions` 时被改写到 `https://chatgpt.com/backend-api/codex/responses`，注入 5 个头（Authorization + ChatGPT-Account-Id + Originator + User-Agent + session-id），token 到期时**每 provider instance 单飞**刷新并回写 Auth（**保留 fingerprint**），后续请求走 `@ai-sdk/openai` 的 responses transport
  What to do / Must NOT do:
  - 走 `createAiSdkProvider` 时**必须** `resolveModel: resolveOpenAIResponsesModel`（复用 `packages/core/src/provider/api-bridge.ts` 里已有的 helper），确保上游 body 是 Responses API 格式（`input: [...]`）而非 chat-completions（`messages: [...]`）——否则 URL 改到 responses 端点但 body 是 chat 格式必然 400。若 `resolveOpenAIResponsesModel` 未 export，本 todo 顺带把它 export 出去。
  - fetch wrapper 逻辑严格照 anomalyco `codex.ts:auth.loader().fetch`：删除 caller 的 authorization 头 → 若 access 缺失或 `expires < Date.now()` 则用**闭包内 `let refreshPromise: Promise<...> | undefined` 作 per-instance single-flight**（不用 module-level Map，避免不同 providerId 相互 block）→ refresh 后 `Auth.set(vendor, providerId, newPayload, providerId)` **必须传第 4 个参数** `providerId` 作 fingerprint（与 `BaseOAuthProvider.store()` 的写法一致，见 oauth-provider.ts:88），不然会把 fingerprint 重置为 null 破坏后续 CAS。→ 拼请求头 `authorization: Bearer <access>`, `ChatGPT-Account-Id: <accountId>`, `Originator: codex-tui`, `User-Agent: codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)`, `session-id: <crypto.randomUUID()>` → URL 命中 `/v1/responses` 或 `/chat/completions` 时替换为 `https://chatgpt.com/backend-api/codex/responses`（其它路径原样）→ 调用 `fetch`。
  - 上游返回 401 时不吞异常，直接 propagate（下一次请求会因 `expires < now` 再次触发 refresh，本轮不做 401→forced refresh 循环，避免无限重试）。
  - runtime provider 用 `createAiSdkProvider({ kind: AiSdk, packageName: "@ai-sdk/openai", options: { apiKey: "sk-oauth-placeholder", baseURL: "https://chatgpt.com/backend-api/codex", fetch: wrapper } }, { resolveModel: resolveOpenAIResponsesModel })`。
  - DO NOT 保留 caller 传的 authorization；DO NOT 每次请求都重解 JWT（accountId 已在 payload）；DO NOT 覆盖 `chat/completions` / `v1/responses` 之外的路径；DO NOT 用 module-level lock；DO NOT 在 `Auth.set` 时省略 fingerprint。
  Parallelization: Wave 3 | Blocked by: T2, T6, T7 | Blocks: T9
  References: `packages/server/src/oauth-runtime.ts:1-111`（现结构 + `aiConfig` helper）；`packages/core/src/provider/ai-sdk-loader.ts:32-36`（`fetch` 通过 `AiSdkProviderLoadOptions` 的 `[key: string]: unknown` 透传）；`packages/core/src/provider/api-bridge.ts:70-75`（`resolveOpenAIResponsesModel` 已被 API bridge 使用的模式）；`packages/core/src/provider/ai-sdk.ts:80-118`（`invoke` 走 `resolveModel` → `streamAiSdkText`）；`packages/oauth/src/store.ts:42-68`（`Auth.set` 第 4 参数默认 `null` → 必须显式传 fingerprint）；`packages/oauth/src/oauth-provider.ts:87-89`（`store()` 传 fingerprint 的正确写法）；外部 anomalyco `codex.ts:auth.loader().fetch`：`https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/plugin/openai/codex.ts`；CLIProxyAPI `internal/runtime/executor/codex_executor.go:36-40, 741-800, 1580-1646`：`https://github.com/router-for-me/CLIProxyAPI`
  Acceptance criteria: `packages/server/_test/oauth-chatgpt-runtime.test.ts` 通过：mock fetch 记录被调 URL 与 headers；用一个已过期 payload 断言 refresh 触发一次；两个并发请求断言 refresh 只调用一次（**per-instance** single-flight，两个不同 providerId 不共享）；断言 URL 从 `.../v1/responses` 改到 `chatgpt.com/backend-api/codex/responses`；断言全部 5 个头都被设置且值精确（Authorization / ChatGPT-Account-Id / Originator / User-Agent / session-id 是 UUID v4 格式）；refresh 后 `Auth.get(...)?.accountFingerprint === providerId`（未被重置）；上游 body **是 Responses API 格式**（含 `input` 字段而非 `messages`）
  QA scenarios: happy - `bun test packages/server/_test/oauth-chatgpt-runtime.test.ts -t "wrapper injects auth headers and rewrites URL"` 通过；happy - `... "wrapper deduplicates concurrent refresh per instance"`；happy - `... "wrapper preserves accountFingerprint across refresh writes"`；happy - `... "wrapper sends Responses-API body shape"`；failure - `... "wrapper propagates upstream 401"`（不吞异常）。Evidence `.omo/evidence/task-8-chatgpt-oauth-login.log`
  Commit: Y | `feat(server): add ChatGPT OAuth runtime provider with fetch wrapper`

- [x] 9. `packages/server/src/oauth-runtime.ts` + `packages/server/src/provider-runtime.ts:41` + `packages/server/src/runtime.ts:12`: 按 vendor 分派，OAuthProviderInstance.vendor 扩为 union - expect vendor="github-copilot" 走 copilot 分支，vendor="openai-chatgpt" 走 chatgpt 分支
  What to do / Must NOT do: 在 `oauth-runtime.ts` 里 export `createOAuthRuntimeProvider(config)`：`switch (config.vendor)`，两个 case 分别 return；`provider-runtime.ts:42` 从 `createGitHubCopilotRuntimeProvider(provider)` 改成 `createOAuthRuntimeProvider(provider)`；`runtime.ts:12` 的 `vendor: "github-copilot"` 改为 `vendor: "github-copilot" | "openai-chatgpt"`。DO NOT 在 provider-runtime 里加逻辑（vendor 分派只在 oauth-runtime）；DO NOT 引入新 kind。
  Parallelization: Wave 3 | Blocked by: T1, T8 | Blocks: T12
  References: `packages/server/src/oauth-runtime.ts:9`；`packages/server/src/provider-runtime.ts:41-47`；`packages/server/src/runtime.ts:12`
  Acceptance criteria: 现有 `packages/server/_test/*.test.ts` 里 GitHub Copilot 相关测试全部通过（不回归）；新增 chatgpt 分派单元测试断言 `createOAuthRuntimeProvider({ vendor: "openai-chatgpt", ... }).kind === "oauth"` 且 `invoke` 存在
  QA scenarios: happy - `bun test packages/server/_test -t "vendor dispatch resolves openai-chatgpt to chatgpt runtime"` 通过；happy - `... "vendor dispatch keeps github-copilot behavior"`（回归）；failure - `... "vendor dispatch throws on unknown vendor"`（虽然 zod 已挡，仍加 assertNever 分支）。Evidence `.omo/evidence/task-9-chatgpt-oauth-login.log`
  Commit: Y | `refactor(server): dispatch OAuth runtime provider by vendor`

- [x] 10. `packages/cli/src/provider-commands.ts:66-98`: 支持 `family === "chatgpt"`；抽出 `runChatGPTLoginForCli()` 类似 `runCopilotLoginForCli`，写 `aio-proxy.json` 时用 `kind: "oauth", vendor: "openai-chatgpt"`，模型清单以 **`ModelEntry` 内嵌 alias** 形式落 config（不写顶层 `alias` 字段，因 `OAuthProviderSchema` 无该字段，zod 会 silent strip）- expect `aio-proxy provider login chatgpt` 完整跑通并把 provider 添加到 config
  What to do / Must NOT do: 支持 `AIO_PROXY_TEST_CHATGPT_LOGIN` env（同 copilot 惯例）在测试里注入 fake payload 跳过 http 交互；`onAuth({ url })` 时用 `openBrowser(url)`；不用 `select`/`input` 交互（loginForm.prompts 为空）；写 config 时的 provider 对象为 `{ kind: "oauth", vendor: "openai-chatgpt", models: [{ alias: "gpt-5.5", id: "gpt-5.5" }, ...4 项] }`（`ModelEntrySchema` 允许 `{ alias, id }` 对象形式，见 `packages/types/src/common.ts:5-14`）—— **不要**写顶层 `alias: {...}`；provider key 用 `providerId`（"chatgpt-<accountId>"）保持与 Auth 存储一致。DO NOT 支持除 `copilot` 与 `chatgpt` 外的第三个值；DO NOT 引入新 CLI flag；DO NOT 顶层写 `alias`。
  Parallelization: Wave 3 | Blocked by: T1, T7 | Blocks: T12
  References: `packages/cli/src/provider-commands.ts:66-107`（当前实现，注意 GitHub Copilot **也会**顶层写 `alias`——这是本 todo 决定不再照抄的点，见 `provider-commands.ts:80-98`），`packages/types/src/common.ts:5-14`（`ModelEntrySchema` 支持 `{alias, id}` 对象），`packages/types/src/provider.ts:37-42`（`OAuthProviderSchema` 无 `alias` 字段），`packages/cli/src/main.ts:165-167`（子命令注册），`packages/cli/_test/`（如已存在则加 test，否则新建 `provider-commands.test.ts`）
  Acceptance criteria: `AIO_PROXY_TEST_CHATGPT_LOGIN='<json>'` 下 `providerLogin("chatgpt", { config: <tmp path> })` 写入的 config JSON `providers[<providerId>]` 深等于 `{ kind: "oauth", vendor: "openai-chatgpt", models: [{alias:"gpt-5.5",id:"gpt-5.5"},{alias:"gpt-5.4",id:"gpt-5.4"},{alias:"gpt-5.4-mini",id:"gpt-5.4-mini"},{alias:"gpt-5.3-codex-spark",id:"gpt-5.3-codex-spark"}] }`；`Auth.get("openai-chatgpt", <providerId>)` 返回预期 payload；写完的 config 用 `ConfigSchema.parse(...)` 能成功且 provider.models 长度 4（保证 zod 不 strip）
  QA scenarios: happy - `bun test packages/cli/_test/provider-commands.test.ts -t "chatgpt login writes config and Auth"` 通过；happy - `... "chatgpt login is idempotent"`（跑两次结果一致）；happy - `... "written config parses through ConfigSchema"` 通过；failure - `... "unknown family exits 1"` 保持通过（回归）。Evidence `.omo/evidence/task-10-chatgpt-oauth-login.log`
  Commit: Y | `feat(cli): add provider login chatgpt subcommand`

- [x] 11. `packages/oauth/src/index.ts`: 从 `./openai-chatgpt` re-export `OpenAIChatGPTOAuthProvider`, `openAIChatGPTOAuthProvider`, `type ChatGPTPayload`, `type ChatGPTModel` - expect `import { openAIChatGPTOAuthProvider } from "@aio-proxy/oauth"` 可用
  What to do / Must NOT do: 只 add 4 个 export，不动现有排序；不 re-export 内部 helper（PKCE / loopback / oauth-flow / jwt / schema 保持内部）。`ChatGPTModel` 已在 T4 中定义（`type ChatGPTModel = OAuthProviderModel`）。
  Parallelization: Wave 3 | Blocked by: T4, T7 | Blocks: T12
  References: `packages/oauth/src/index.ts:1-29`
  Acceptance criteria: `bun run --filter @aio-proxy/oauth check` 通过；`packages/oauth/_test/index-exports.test.ts` 断言导出的 4 个符号非空
  QA scenarios: happy - `bun test packages/oauth/_test -t "index exports openAIChatGPTOAuthProvider"` 通过；failure - 无（纯声明），改为 `bun run check` 无 TS 错误作为 negative 兜底。Evidence `.omo/evidence/task-11-chatgpt-oauth-login.log`
  Commit: Y | `feat(oauth): export ChatGPT OAuth provider`

- [x] 12. Repo root: `bun run preflight` 通过 - expect `bun run check && turbo run test:unit` 无 error
  What to do / Must NOT do: 修全部剩余 lint / type / test 失败；不 lift 任何测试；不加 `// @ts-ignore`；不加 `biome-ignore`。
  Parallelization: Wave 4 | Blocked by: T9, T10, T11 | Blocks: -
  References: `package.json:44` (`preflight`), `turbo.json`, `biome.json`
  Acceptance criteria: `bun run preflight` exit code 0；`git status --porcelain` 除本次改动外无产物泄漏
  QA scenarios: happy - `bun run preflight` 通过；failure - 若失败，日志里定位到具体 file:line 并回到对应 todo 修复。Evidence `.omo/evidence/task-12-chatgpt-oauth-login.log`
  Commit: N（回归项，不产生新 commit）

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
- [x] F2. Code quality review
- [x] F3. Real manual QA
- [x] F4. Scope fidelity

## Commit strategy
- 全部工作在 T0 切出的 `feat/chatgpt-oauth-login` 分支上；不合入 main、不 push（等 dual Momus 或用户明确指令再 push / 提 PR）
- 一 todo 一 commit（T0 切分支不 commit、T12 preflight 不 commit，其它都 commit）
- 每个 commit 都必须过 lefthook 与 commitlint（Conventional Commits）
- Wave 内的 commit 顺序与 dependency matrix 一致；Wave 边界不做 squash（保留每一步的 TDD 证据）
- 全部完成后跑一次 `bun run preflight`，绿了再交给用户处理 push / PR

## Success criteria
- `bun run preflight` 通过（zero warning）
- `AIO_PROXY_TEST_CHATGPT_LOGIN='<fixture>' bun packages/cli/src/main.ts provider login chatgpt --config <tmp>` 端到端写出配置且 exit 0
- `Auth.list()` 里能看到新 vendor `openai-chatgpt` 的行，`hasToken=true`，`accountLabel` 非空
- 现有 GitHub Copilot 单元测试全绿（无回归）
- 新增 `packages/oauth/openai-chatgpt/` 目录含 `index.ts, oauth-flow.ts, loopback.ts, pkce.ts, jwt.ts, schema.ts` 六个文件，不多不少
- 新增 fetch wrapper 的两个关键分支（refresh 单飞、URL 改写）都被测试直接覆盖
