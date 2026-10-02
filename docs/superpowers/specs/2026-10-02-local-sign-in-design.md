# 复用本机已有登录作为订阅 Provider 账号

对应 issue #475。用户已在本机用厂商工具登录同一订阅时，可以选"使用本机 {工具} 的登录"代替浏览器 OAuth。本轮实现 SDK 能力、ChatGPT（Codex）与 GitHub Copilot；Claude Code 另开 issue。

## 已核实的事实

- Codex 0.159.3：`$CODEX_HOME/auth.json`（默认 `~/.codex`，0600），结构 `{auth_mode, OPENAI_API_KEY, tokens: {id_token, access_token, refresh_token, account_id}, last_refresh}`。配置 `cli_auth_credentials_store = "keyring"` 时没有该文件，视为无本机登录。
- ChatGPT 插件使用与 Codex 相同的 client_id，两边 token 互通。
- OpenAI 轮换 refresh token 并拒绝重用旧值：Codex 内置"refresh token was already used"错误。
- Codex 在 401 时按 account_id 从磁盘重新加载 auth.json，账号不同则跳过。
- Copilot 的 `githubToken` 是长期 token，刷新只是用它换短期 Copilot token，不轮换。存储在 `~/.config/github-copilot/apps.json`（键 `<host>:<appId>`）或旧版 `hosts.json`（键 `<host>`），条目含 `oauth_token`。

## 轮换策略

一次性复制会让先刷新的一方作废另一方的 refresh token；永不刷新则在 Codex 不运行时 token 过期后不可用。因此：**对会轮换的存储，以宿主存储为准并写回**。

aio-proxy 仍保存一份镜像，摘要、刷新调度、加密等现有机制不变。同步逻辑是 core 中包装凭据端口的一个函数，运行在框架 exchange 回调里，即刷新租约内、CAS 之前。关联账号的每次刷新：

1. 重新读取账号行，标记已清除（期间改为浏览器登录）则按普通账号刷新，不触碰宿主。
2. 调用插件 `read` 读取宿主存储。fingerprint 与账号不同则以不可重试错误失败，诊断提示重新关联。
3. **较新者为准**：宿主 `expiresAt` 晚于镜像时以宿主为基准（工具自己刷新过），否则以镜像为基准（上次写回失败时由此修复宿主）。
4. 用基准执行 exchange。
5. 若未中止，调用插件 `write(next, previous)` 写回。插件仅在宿主仍持有 `previous`（同一账号、同一 refresh token）时替换，否则跳过，避免覆盖用户在 exchange 期间切换的账号或迟到回调覆盖更新的值。写回失败只记录脱敏错误，结果仍返回给框架 CAS 进镜像。

首次关联的目录发现使用同一包装（基于内存端口），因此关联时宿主 access token 已过期也会写回。

插件不实现 `write` 表示其存储不轮换：关联时一次性复制，之后刷新不再读取宿主存储（Copilot）。

残余风险：
- 运行中的 Codex 进程若在主动刷新前不重载磁盘，内存中的旧 refresh token 可能失败一次。实现完成后在真实机器上做一次端到端验证。
- 写回成功后租约丢失导致 CAS 失败时，账号进入不可重试诊断；恢复方式是对该 Provider 再次"使用本机登录"（fingerprint 相同，直接采纳宿主的新值）。租约丢失本身罕见，不为此增加自动恢复路径。

## SDK

`OAuthAdapter` 增加可选字段，纯增量：

```ts
export type OAuthLocalSignIn<AccountOptions, Credential> = {
  readonly source: LocalizedText;
  readonly detect: (context: { readonly signal: AbortSignal }) => Promise<boolean>;
  readonly read: (context: OAuthCredentialImportContext, options: AccountOptions) => Promise<OAuthLoginResult<Credential>>;
  readonly write?: (context: { readonly signal: AbortSignal }, next: Credential, previous: Credential) => Promise<void>;
};
```

`detect` 只检查存在，不得读取或返回秘密，因此入口不显示邮箱。`read` 只在用户明确选择后调用。框架负责检测时机、同意、UI 和刷新编排，server 不对内置插件特殊处理。

## 存储与生命周期

- 插件仓库 `accounts` 表新增可空列 `local_sign_in`（迁移），由框架写入，不出现在用户配置中，避免手改配置绕过同意。
- 账号摘要带出该标记与 `source`，Dashboard Provider 卡片显示"已关联本机 {source} 登录"徽标；删除确认说明不会登出该工具。
- 删除 Provider 只删 aio-proxy 自己的行，从不调用 `write`，宿主存储字节不变。
- 浏览器登录的账号没有标记，刷新永不读写宿主存储。

## 入口

- core：`loginOAuthAccount` 增加 `localSignIn` 开关，用 `read` 代替授权步骤，其余（账号选项渲染、fingerprint 校验、目录发现、持久化）不变，写入时带标记；之后用浏览器重新登录会清除标记。因此关联也适用于已有 Provider 的重新登录。
- server：插件能力列表为每个 adapter 附带 `localSignIn: { source }`，仅当 `detect` 为 true 时出现；Dashboard 登录会话的启动参数增加 `localSignIn`。Docker/无头环境没有宿主存储，选项自然不出现。
- Dashboard：OAuth 授权面板登录按钮旁增加"使用本机 {source} 登录"，仅检测到时显示，点击前说明将读取另一个应用的凭据。
- CLI：`provider login` 检测到本机登录时在交互选择中提供该选项，另有非交互参数 `--local-sign-in`。

## 插件实现

- ChatGPT：`detect` 对 `$CODEX_HOME/auth.json` 做 stat；`read` 用 `isPlainObject` 与 zod 解析，要求 `auth_mode` 缺省或以 `chatgpt` 开头（拒绝 `apikey`）且 token 齐全，否则抛不含文件内容的通用错误；`write` 读取当前文件，确认其 `refresh_token` 仍等于 `previous` 后，只替换 `tokens` 与 `last_refresh`（刷新响应省略 id_token 时保留原值），保留其他字段，0600 临时文件后 rename。凭据新增可选 `idToken`，保证写回的 id_token 是新的。
- Copilot：`detect` 检查 `$XDG_CONFIG_HOME/github-copilot`（默认 `~/.config/github-copilot`）下 `apps.json` 或 `hosts.json` 存在；`read` 按账号选项的主机选条目，优先 appId 与插件 client_id 相同者，用 token 换一次 Copilot token 并取用户 ID 作 fingerprint；不实现 `write`。

## 隐私

宿主存储读出的凭据值不进入日志、trace、诊断、错误消息或 API 响应。框架在插件调用边界规范化错误：`read`/`write` 的失败替换为只含错误码的错误（关联时为 `OAUTH_LOCAL_SIGN_IN_INVALID`），exchange 的错误按宿主凭据值脱敏。账号 ID 等身份标识与浏览器登录同等对待（例如出现在建议的 Provider ID 中），不属于凭据。所有读取都发生在用户选择之后。

## 验证

全部使用临时目录作宿主存储：无存储时选项不出现；损坏或不完整的存储干净失败且错误不含内容；刷新后宿主文件含新 refresh token 且其他字段保留；宿主先刷新时 aio-proxy 采纳宿主值、不重用旧 token；fingerprint 变化时失败；删除 Provider 后宿主文件字节不变；浏览器登录账号刷新不触碰宿主存储。
