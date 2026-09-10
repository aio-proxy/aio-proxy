# Codex Agent Configure 向导设计

状态：修订后的双模式行为已实现，并完成受影响单元测试、构建和主机契约验证。真实 AIO Proxy 双模式端到端、官方 Computer Use/插件兼容，以及 native/paginated 迁移写入仍未验证；具体证据和限制见[契约验证报告](2026-09-09-codex-contract-verification.md)与 Task 7 报告。现有提交 `ec170fce` 已包含静态配置向导、字段归属、list/remove 和受限的历史迁移，本次鉴权增量已接入产品。

实施计划：[Codex Agent Configure Implementation Plan](../plans/2026-09-09-codex-agent-configure.md)。关联：[#327](https://github.com/aio-proxy/aio-proxy/issues/327)、[#310](https://github.com/aio-proxy/aio-proxy/issues/310)。

## 目标与已确认决定

`aiop agent configure codex` 是交互向导，帮助用户把 Codex 模型请求接入本机 AIO Proxy，同时选择是否保留 ChatGPT 登录相关功能。

1. 首次 Provider ID 默认 `aio-proxy`，用户可以自定义；重复配置沿用受管 ID。
2. 新增“是否保留 ChatGPT 登录相关功能？”选择，首次默认保留；重复配置沿用已保存的鉴权模式。
3. 保留时设置 `requires_openai_auth = true`，有代理 API Key 则只选择已有 Key，并直接保存到 `experimental_bearer_token`；没有 Key 则跳过选择，使用非秘密占位 token `aio-proxy-local`。
4. 不保留时使用 Codex 原生 command 鉴权，不选静态 Key；通过 AIO Proxy 现有 Agent 设备授权与 token 刷新协议建立 Codex 专属 installation。
5. 两种模式都不创建代理 API Key，不改 `server.apiKeys`，不代用户开启代理认证。
6. 继续提供可选历史会话迁移，不写、删除或恢复顶层 `model`，不新增模型选择步骤。
7. 产品显示名统一为 `AIO Proxy`。命令、包名、目录、协议标识和默认 Provider ID 仍保留 `aio-proxy`。

这替代旧稿中的“选择或生成新 Key”和“始终使用静态 Key”设计。用户已选择后续使用 `superpowers:subagent-driven-development`，实施始终使用 `gpt-5.6-luna`；须等本轮文档审阅确认后再恢复。

## 向导交互与文案

```text
$ aiop agent configure codex

Codex 配置：~/.codex/config.toml
AIO Proxy 地址：http://127.0.0.1:9317/v1

? Provider ID › aio-proxy

保留后，Codex 可继续使用已有 ChatGPT 登录提供的相关功能。
模型请求仍通过 AIO Proxy；此选项不会自动登录 ChatGPT。
? 是否保留 ChatGPT 登录相关功能？
  保留（默认）
  不保留
```

选择“保留”且有 Key：

```text
? 使用哪个 AIO Proxy API Key？
  Codex 日常使用
  开发工具
```

仅列出已有 Key 的标签或编号，即使只有一个也由用户选择；不展示明文，不提供新建入口。没有 Key 则显示“AIO Proxy 未启用 API Key 认证，跳过 Key 选择”。

选择“不保留”：

```text
将使用 AIO Proxy 命令鉴权，无需选择 API Key。
部分依赖 ChatGPT 登录的官方功能可能不可用；已有登录凭据不会被删除。
```

之后沿用会话预览与迁移选择：

```text
Codex 本地会话选择器默认按当前 Provider 筛选历史。
切换到 aio-proxy 后，其他 Provider 下的旧会话可能不出现在列表中；会话没有被删除。
? 将原 Provider openai 下的 42 个历史会话迁移到 aio-proxy？
  是，迁移历史会话
  否，保留原有归属
```

先收集 Provider ID、鉴权模式、必要的 Key 选择和迁移选择，再进行持久化或设备授权。没有历史则跳过迁移问题；多个来源可以选择，默认来源为切换前的有效全局 Provider，未配置时为 `openai`，不默认合并所有来源。

提示阶段取消不产生本次配置、凭据或会话变更。已有未完成操作仍先走现有显式恢复入口，恢复不冒充本次向导的零写入。首次 command 授权在选择收集完成后进行：展示现有 Dashboard 设备授权 URL 和状态，等待用户批准；无需先运行另一条登录命令。运行时 helper 绝不打开浏览器或等待交互。

设备授权会产生服务端 challenge 和可恢复的私有准备状态，因此进入该阶段后的取消不能宣称服务端零副作用。尚未拿到 token 时，保持原 Codex 配置和历史，清理可安全清理的本次私有准备文件，challenge 按现有协议到期。已经拿到 token 后的失败必须按下述生命周期记录处理。

不再添加重复的最终确认。配置成功后报告鉴权模式、配置路径、连接验证结果、迁移结果和“重新打开 Codex 后生效”。迁移不支持或失败不否定已经成功保存的 Provider 配置。

## 两种 Codex 配置契约

全局目标默认 `~/.codex/config.toml`，遵守现有 `CODEX_HOME` 解析规则，并展示实际路径。不搜索或管理项目内 `.codex/config.toml`。地址复用现有 loopback 解析并增加 `/v1`，协议固定 `responses`。

### 保留 ChatGPT 登录相关功能

```toml
model_provider = "aio-proxy"

[model_providers.aio-proxy]
name = "AIO Proxy"
base_url = "http://127.0.0.1:9317/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "aio-proxy-local"
```

代理有 Key 时，最后一行换为用户所选的已有代理 Key。无 Key 时显式占位 token 防止模型请求回退到 ChatGPT 登录 token；它不加入代理配置、不启用认证，也不表示已经验证连接。此模式不写 `auth` 或 `env_key`。

`requires_openai_auth = true` 保留 Codex 识别已有 ChatGPT 登录的路径，不是自动登录、续期登录或官方插件兼容保证。未登录时仍可能需要 Codex 原生登录操作。不读取或改写 `auth.json`、Keychain，不调用 logout。

### 不保留 ChatGPT 登录相关功能

```toml
model_provider = "aio-proxy"

[model_providers.aio-proxy]
name = "AIO Proxy"
base_url = "http://127.0.0.1:9317/v1"
wire_api = "responses"

[model_providers.aio-proxy.auth]
command = "/stable/path/to/aiop"
args = ["agent", "auth", "codex", "--installation-id", "<uuid>"]
timeout_ms = 5000
refresh_interval_ms = 300000
```

此分支省略 `requires_openai_auth`，不写 `experimental_bearer_token`、`env_key`。Codex 原生校验禁止 command auth 与这些字段组合，不能用 `requires_openai_auth = true` 同时实现两种效果。

`command` 是发布安装中稳定的绝对 CLI 入口，保留升级会更新的稳定入口路径，不固化版本缓存或开发态 Bun 路径。按 Codex 的可执行文件与参数数组契约写入，不拼接 shell 命令；路径中的空格和引号作为 TOML 字符串处理。找不到可持续使用的入口时，在授权和配置变更前失败。

helper 命令为 `aiop agent auth codex --installation-id <uuid>`，`aio-proxy` 别名同样可用。只接受 installation ID，不接收任意 endpoint、静态 Key 或 refresh token 参数。按相同 `CODEX_HOME` 规则定位受管数据；旧 ID、目录不匹配或失去归属时失败，不自动创建新 installation。

## Agent 授权与运行时 helper

command 模式复用 `@aio-proxy/agent-provider-runtime` 的 `requestDeviceAuthorization()`、`pollDeviceAuthorization()`、`refreshAgentCredential()`。目标是 `codex`，client ID 是 `aio-proxy-codex`，身份绑定 installation ID 和原 loopback endpoint。不是上游 Provider 密钥，也不是用户共享的代理 Key；即使代理未启用通用 API Key 认证，此模式仍使用 installation 授权。

首次配置需要 AIO Proxy 在线且现有设备授权功能可用。未设置 Dashboard 密码、服务离线、批准被拒绝或到期时，明确报告原因，保持原 Codex 配置；不悄悄切换静态模式，不代用户开启服务或设置密码。初次授权等待受服务端 `expires_in`（当前 600 秒）和用户取消限制。

helper 的输出与期限：

- 无 stdin。成功只向 stdout 写原始 bearer access token 和一个换行，不写 JSON、引号、设备码、日志或更新提示；refresh token 永不输出。
- 本机期限为从 CLI 入口计时的 4500 毫秒，包含锁等待、网络、状态读取与持久化，留在 Codex 的 5000 毫秒超时内。
- helper 只进行静默刷新；没有凭据、确定失效或撤销时，stderr 提示重新执行 configure，非零退出，绝不启动 device flow。
- 普通独立调用也刷新，以响应 Codex 在 401 后重新调用 helper 的行为；不能总是返回仍未过期但已经被拒绝的缓存 AT。只有识别出重叠调用已完成刷新时才复用其结果。
- AT/RT 轮换结果必须先原子持久化再输出。输出前失败 stdout 为空；输出过程中失败可能留下部分 stdout，但必须非零退出，保留新 RT 供恢复。
- 网络/5xx/超时与确定的 `invalid_grant` 分开处理；临时失败不删除 RT，也不隐式重新申请授权。

同一 installation 的 configure、helper、模式切换和 remove 共用跨进程锁，复用仓库文件锁的进程身份、存活检查、heartbeat 与 fencing。不能以现有进程内串行队列替代文件锁。拿锁后重读状态；交互授权持锁期间，其他 helper 在自己的期限内失败，不启动第二份授权。

凭据记录包含 revision、最近交付 owner 及可恢复的 refresh-in-flight 状态。重叠调用通过等待前观察到的有效锁 owner/revision 和拿锁后的交付变化识别同一次刷新；正常独立调用仍须访问服务端。先保存新凭据，再输出，最后标记交付完成。失去锁所有权后不能继续写入或输出。

响应丢失或进程退出后，仅在服务端现有 30 秒重放窗口内恢复同一 RT；超出窗口或返回 `replay_lost` 时转为需要重新授权，禁止无限重放消耗过的 RT。沿用现有 15 分钟 AT、refresh family 轮换和撤销语义，不为 Codex 改 token 协议。多 Codex 进程持有旧 AT 时仍可能触发原生 401 重试；不承诺所有并发场景完全无感。

CLI 的 OAuth 请求与撤销请求只访问绑定 origin，拒绝重定向，复用设备授权 URL 校验。helper 在网络前、输出前均核验受管 Provider、endpoint 和鉴权字段；有漂移就停止交付。此检查不声称能识别宿主进程所有项目/profile/命令行覆盖，也不保证阻止不合作的外部写者在最后检查之后修改配置。

## API Key 只读选择

- 使用当前代理配置和 service.env 的现有解析逻辑获取有效 Key；配置损坏或模板解析失败是错误，不能当成“没有 Key”。
- Dashboard settings 的 `****` 视图不是凭据来源，不新增明文密钥接口。
- 保留配置 revision/选择失效检测；收集完提示后重读，Key 或环境模板发生变化则在 Codex 写入前失败。
- 删除生成 Key、随机源、代理配置 transaction/reload 和新 Key 补偿逻辑。原版本已经创建的 Key 不自动删除。
- 通过带所选 token 的受保护只读模型目录请求检查凭据；`/health` 成功仅表示连通，不能证明 Key 有效。不发起计费推理请求。
- 静态模式允许服务离线时保存本地配置，但结果必须标明“已保存，未验证”；在线返回 401/403 时不保存无效凭据。无 Key 占位分支也必须在提交前复查认证状态。

## 受管状态、切换和移除

沿用 `<CODEX_HOME>/.aio-proxy/codex-config.json` 的逐字段 before/applied 归属、配置 journal 和迁移日志。配置 marker 升为 format 2，记录鉴权模式；兼容读取 format 1 并识别为保留模式，第一次成功变更时升级，保留最初恢复基线，list 不隐式写入升级。未知版本拒绝修改。

command 模式另存 `codex-command.json`（身份与生命周期）、`codex-credential.json`（AT/RT 和轮换状态）、`codex-auth-operation.json`（设置/切换/移除进度）。锁位于全局根的 `.aio-proxy.lock`，不能随受管目录清理而删除另一进程的锁。记录与 credential 必须匹配 configPath、installation ID、target 和 endpoint；不可因文件存在就信任。

新建私有目录 `0700`、凭据文件 `0600`；凭据所在 TOML 与归属记录继续按现有私有文件规则处理。受管文件拒绝符号链接、硬链接和目录逃逸；不修改用户整个 Codex 根目录权限。Key、AT、RT 不出现在日志、错误、list/JSON 或快照中，唯一例外是 helper 成功的专用 stdout。

只管理 `model_provider`、所选 Provider 的公共字段和所选模式的鉴权叶子。继续基于 TOML 键路径做源码范围编辑，保留注释、内联表、多行字符串、quoted ID、profiles、MCP、其他 Provider 及用户字段。新增对 `auth.args` 字符串数组和超时整数的精确编辑与结构比较。

目标 Provider ID 已存在且不受管时拒绝接管。受管字段被用户修改时不能在 configure 中静默覆盖。模式切换只清除仍归属于本工具的另一种鉴权字段；存在不受管的冲突认证字段时报告冲突，不能生成 Codex 拒绝加载的混合配置。

| 操作                  | 行为与失败边界                                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 保留 → 保留           | 只读选择已有 Key/占位 token，更新受管字段；不建立 Agent installation                                                                               |
| 保留 → command        | 完成预检与所有选择，记录待设置 installation，批准并保存凭据后提交 TOML/marker，最后激活 helper；中途不改变历史                                     |
| command → command     | 同一根和 endpoint 保持 installation ID；凭据有效时无需再次批准，确定失效后由 configure 重新授权；helper 不自行授权                                 |
| command → 保留        | 先预检静态凭据与目标配置；记录 retiring 阶段阻止 helper，撤销旧 installation，删除私有凭据，再提交静态配置；失败保留可重试日志，不伪造原授权仍有效 |
| command 更换 endpoint | 不转移或发送旧 RT；先完成旧 installation 移除，再重新 configure，取得新 ID                                                                         |
| 更换受管 Provider ID  | 沿用配置恢复基线，清理旧受管字段；同 endpoint 的 command installation 可以保留，身份记录随配置事务更新                                             |
| remove 保留模式       | 可以离线，逐字段恢复仍等于 applied 的内容；保留用户修改及所有代理 Key                                                                              |
| remove command 模式   | 标记 retiring 并阻止 helper，向原 endpoint 撤销；成功或已有 missing/expired 后清除私有凭据，再逐字段恢复；服务离线则保留可重试状态，不报告 removed |

首次授权已成功但配置提交失败时，保留仅本用户可访问的 pending installation、凭据和操作日志，helper 拒绝交付；重新 configure 恢复提交，或 remove 撤销清理。不得抛下未记录的服务端授权，也不得无条件删除可能已经生效的凭据。已有 command 被撤销后无法靠文件回滚使授权复活；恢复必须据日志继续完成目标状态。

配置移除与会话恢复始终独立，remove 不自动反向迁移。不得递归删除未知文件或迁移备份。

## list、服务端和插件边界

Codex 仍由 CLI 独立管理全局配置，不安装 Pi/OpenCode 插件资产，也不进入插件 post-upgrade 更新循环。JSON 中现有 `integration: "static-config"` 保留为配置接入方式，新增 `authMode: "keep-chatgpt" | "command"` 表示认证方式。

- `agent list` 展示 Provider ID、路径、端点、鉴权模式、归属/漂移/未完成状态；默认只读本地数据。
- 静态模式不伪造 installation、device-code 或授权状态；command 模式显示实际 installation ID，`--check` 结合只读服务端授权快照与现有 token 检查，不轮换或重新授权。
- `--check` 使用存储的受管 endpoint；不拿新解析出的其他地址验证旧 token。AT 到期时报告需要刷新，不因 `/health` 返回 200 声称授权可用。
- `--authorizations` 纳入真实 Codex command installation，并正确判断本地 configured/orphaned；静态配置不产生授权条目。
- `agent revoke <installation-id>` 沿用仅撤销服务端的契约。撤销后 helper 快速失败，由用户重新 configure 批准；不增加 `agent revoke codex` 别名。

共享 Agent 身份 schema/client ID 与 repository 解码增加 `codex`，同时把插件专用 target 集合固定为 `opencode | pi | omp`。目录协商、插件资产、宿主探测、安装与升级仍使用插件集合，不能因扩大授权 target 集合而让 Codex 落入 Pi 分支。

当前服务端 `/v1/models` 会拒绝无插件目录协商的 Agent token。为已认证 `grant.target === "codex"` 放行现有目录分流：有 `client_version` 返回既有 Codex 目录，否则返回普通 OpenAI 模型目录。畸形协商参数、target 不匹配和其他插件无协商请求仍拒绝；不能让未认证请求绕过认证。Responses 继续复用现有 pipeline，不新建推理或 failover 循环。

Grok #329 的设计可作并发与生命周期参考，但该工作区尚无 Grok 实现，本增量不依赖其未落地的 helper、类型或共享层，不修改其他工作区。

## 历史迁移：保留现有范围

迁移是 Codex 内部独立能力，两个鉴权分支在配置提交后调用相同接口。默认来源、多个来源选择、归档计数、归属解释和不重复处理目标 Provider 的行为保持不变。

保持会话 ID、消息正文、模型、工作目录、标题、父子关系、归档状态及时间顺序；更改 Provider 归属后，续聊使用目标 Provider，不保证跨上游的加密推理状态可复用。文案只说明本地默认筛选，不宣称安全隔离或所有 App/远程会话的永久限制。

已完成的真实实验见[契约验证报告](2026-09-09-codex-contract-verification.md)：测试 Codex `0.146.0`，原生 resume 覆盖不能持久迁移；native/paginated 写入仍不支持。现有实现仅处理经验证的 legacy JSONL 与对应已验证索引，并在缺失位置、未知 schema/格式、元数据不一致或活动写者时阻止写入。本轮不扩大迁移兼容范围。

继续使用完整预检、恢复日志、备份、数据库事务和文件原子替换处理跨存储失败；不删除数据库强制重建，不只改一份索引。AIO Proxy 文件锁不能阻止 Codex 写入。迁移要求相关写入者停止，失败报告成功、未处理和冲突数量，不把全部跳过算成完整迁移。

恢复入口保持 `aiop agent configure codex --restore-migration <operation-id>`，只恢复仍满足日志条件的历史归属，不询问鉴权、不连接 OAuth、不修改配置或模型。迁移与恢复测试继续使用临时目录和合成历史。

## 兼容证据与验收

已知事实：

- 官方文档规定 command helper 返回原始 bearer token，默认超时 5000 毫秒、主动刷新间隔 300000 毫秒，不能与 `env_key`、直接 bearer token、`requires_openai_auth` 混用。
- 本机 Codex `0.146.0` 的正常启动已实测拒绝 `auth` 加 `requires_openai_auth = true`，错误为 `provider auth cannot be combined with requires_openai_auth`。
- 在隔离 HOME/CODEX_HOME、假 ChatGPT 凭据并禁止外网的 app-server 实验中：静态 token + true 的 `account/read` 保留模拟 ChatGPT account，command 模式得到 `account: null`、`requiresOpenaiAuth: false`。用户另外实测确认部分官方功能会消失。
- 既有报告证明静态代理 token/占位 token 的请求优先级和受限的历史契约；本轮已实现 AIO Proxy command helper 与 401 重试路径，但真实 AIO Proxy 服务端端到端、完整 Computer Use/插件功能仍未验证，不宣称它们全部通过。

实施验收覆盖：两种模式及首次/重复默认；有 Key/无 Key/失效选择；无 Key 的并发变化；保留/不保留均不创建 Key；登录/未登录不泄露 ChatGPT token；嵌套 TOML、quoted ID、数组比较、format 1 升级；提示取消；设备授权失败与批准后提交失败；两个方向切换；刷新并发、响应丢失、撤销、超时、stdout 纯净；普通/Codex 模型目录与插件协商隔离；两个分支的迁移接受、拒绝、不支持及独立恢复；list/remove 不泄露凭据。

实际兼容实验使用固定版本 Codex、临时全局目录、合成身份和本机模拟服务。记录测试版本和平台，不由一次 macOS 测试推定所有平台/版本兼容。CLI artifact 测试验证安装入口在含空格路径、升级后和别名下仍可调用。现有测试与主机契约实验验证了 helper 的原始 token、401 后重试和安全边界；由于真实 AIO Proxy 服务端链路未运行，不能据此宣称所有部署环境和依赖 ChatGPT 登录的功能均可用。

实施按仓库要求运行了 `bun run preflight`、`bun run check` 和所有受影响包测试；preflight 的既有 Dashboard 类型错误以及 server/CLI 基线失败已记录在 Task 7 报告中。验证使用临时目录和合成身份，不运行真实用户配置操作。

现有 `.changeset/codex-static-config.md` 已复写，去掉新建 Key 的旧说明，描述两种鉴权和现有迁移范围；按实际修改包覆盖 `aio-proxy`、`@aio-proxy/cli` 以及 server/types/core/runtime 等内部包，产品包 bump 与内部包一致。

## 参考

- [Codex 自定义 Provider 与 command 鉴权](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)
- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference#configtoml)
- [Codex app-server account/read](https://learn.chatgpt.com/docs/app-server#1-check-auth-state)
- [Codex 插件的 API Key 可用性](https://learn.chatgpt.com/docs/plugins#api-key-availability)与[Computer Use](https://learn.chatgpt.com/docs/computer-use)
- [现有 Codex 契约验证报告](2026-09-09-codex-contract-verification.md)
