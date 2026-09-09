# Grok Build Agent Integration 设计

- 日期：2026-09-09
- 状态：设计已确认，进入实现计划阶段；尚未开始实现
- 对应 issue：[#329](https://github.com/aio-proxy/aio-proxy/issues/329)
- 基线：Grok Build `1.0.24 (68e414c661e3)`；aio-proxy `989e5ebb`

## 1. 决策与范围

新增内置 Agent target `grok`，通过 Grok 原生的全局配置和 external auth command 接入。登录入口名称固定为 `AIO Proxy`。Grok 决定何时需要登录或刷新；aio-proxy CLI 只做宿主适配，调用现有 Agent runtime 的 device authorization / refresh 函数，持久化凭据并输出 Grok 所需的结果。

不重新实现 token 签发、轮换、重放保护或撤销。Grok 拥有独立 installation ID 和 token family，不使用 OpenCode / Pi / OMP 的实际凭据，也不复制上游 Provider 凭据或 `server.apiKeys`。

本设计补充 [Agent Provider Integrations 设计](2026-08-18-agent-provider-integrations-design.md)，保持已有三个插件目标的行为不变。#329 原来安排在 Codex / Claude Code 之后，是基于共享静态配置机制的交付顺序。实测证明 Grok 存在鉴权命令接口，本增量采用该原生接口，不依赖 #327 / #328 的实现，也不在本期定义面向所有静态目标的通用框架。配置字段归属规则可以供后续目标参考。

交付：`agent configure grok`、`agent list` 中的 Grok 状态、`agent remove grok`、`agent auth grok`，以及真实宿主兼容测试。只管理一个用户全局 Grok 配置根和一个本机 aio-proxy endpoint。

非目标：安装、更新或代为启动 Grok；项目配置；远程 aio-proxy；Grok 云端 relay / headless relay；完整 OIDC server；第三方 Agent adapter SDK；实现 Grok 的用户、设置或资源分发服务；恢复用户此前的 Grok 云端登录；为 Grok 建立一套独立模型目录缓存或定时刷新机制。

## 2. 实测依据与兼容基线

2026-09-09 使用 macOS arm64 Grok `1.0.24`、独立 `GROK_HOME`、本地模拟 HTTP 服务和假 token 完成黑盒验证；后续关键用例使用 OS 沙箱禁止非 loopback 网络。

| 路径 | 证据与结论 |
| --- | --- |
| `grok login` | 执行 external helper，保存 external 会话凭据 |
| `models_base_url` + helper，无 `XAI_API_KEY` | `/v1/models` 和 `/v1/chat/completions` 都发送 helper 返回的 Bearer token |
| 接近过期 | helper 收到 `GROK_AUTH_EXPIRED=1`；随后请求使用新 token |
| 同一 ACP 会话的两轮请求 | 第一轮使用 8 秒 token；等待 9 秒后第二轮自动刷新并成功，未重建进程或会话 |
| 较早签发的 token 被推理接口拒绝 | 401 触发 helper，换用新 token 重试成功 |
| 刚签发的 token 被拒绝 | 宿主记录 `current token freshly minted, skipping refresh`；继续拒绝会令本轮失败 |
| 全新配置直接 `grok -p` | 不自动执行首次 helper 登录；提示未登录 |
| ACP 登录方法 | 名称为 `AIO Proxy`，`external_provider: true` |

Grok 随附 `02-authentication.md` 明确规定：helper 返回的 `refresh_token` 只保存作参考；刷新通过重新运行命令完成，不由 Grok 发送 OAuth refresh grant。因此 helper 不向 Grok 输出 RT。

最低支持版本定为已实测的 `1.0.24`。沿用已有目标的版本策略：低版本或未知版本 configure 给出警告，不声明已验证兼容。实现验收需要固定版本的真实宿主测试；macOS 以外的平台，在对应宿主二进制和命令调用约定通过测试前，不声明兼容。

本次实验只证明宿主接口与基本流式文本路径，不替代真实 aio-proxy 的设备码、撤销、并发和工具调用验收。实验中对过期前刷新及较早签发的 401 用例修改了测试凭据时间戳；连续会话用例实际等待过期。没有确定刚签发保护窗口的准确长度，不在实现中硬编码该窗口。

## 3. 用户旅程与 CLI 契约

```text
aio-proxy agent configure grok
grok login
grok models
grok -m <aio-proxy-model-id>

aio-proxy agent list [--check] [--authorizations] [--json]
aio-proxy agent remove grok
aio-proxy agent revoke <installation-id>
```

1. configure 检测 `grok --version`，解析全局路径与现有 aio-proxy loopback endpoint，合并必要字段并创建 installation 元数据。
2. configure 不启动 Grok、不启动 server、不读取或改写 Grok 的 auth 文件，不签发 token。离线配置可完成，但明确提示先启动 aio-proxy。没有 Dashboard 密码等导致设备授权不可用的情况沿用现有诊断。
3. 输出原生登录命令 `grok login`、模型查看和选择方法。登录由用户主动执行，helper 的设备码 URL 交给 Grok 展示，用户在现有 Dashboard 授权页批准。
4. 登录成功后，Grok 自行读取模型目录和发起推理。configure 不改写 `[models].default`，不猜测用户配置中存在的模型。首次选择由 Grok 的 `-m` / `/model` 完成。
5. Grok 后续调用 helper 获取或刷新凭据；无需用户维护 API Key 环境变量。

增加面向宿主的命令：

```text
aio-proxy agent auth grok --installation-id <uuid>
```

installation ID 参数由 configure 生成，绑定具体受管安装；旧配置中残留的命令不能自动授权新安装。该参数不携带 secret。endpoint 从有效 marker 读取，不接受任意 URL 参数。helper 的认证请求只访问该 origin，拒绝跨 origin 重定向，并沿用 runtime 的设备码 URL 校验。独立执行该命令遵守相同 stdout/stderr 和登录规则。

`agent auth` 的 stdout 只允许一行 JSON；启动日志、更新提示、设备码和错误必须在 stderr。成功格式为：

```json
{"access_token":"...","expires_in":900}
```

`expires_in` 是输出时的实际剩余秒数，向下取整，必须大于 0；复用缓存时不能重新报告完整 900 秒。失败 stdout 为空，退出码非零。RT 不输出；使用相同字段集合返回登录与刷新结果。

## 4. 路径与受管文件

全局根 `G` 采用 Grok 原生的 `GROK_HOME`，未设置时为 `~/.grok`。支持绝对路径和明确展开的 `~/`；拒绝其他相对路径。覆盖根仍是用户级配置，不搜索项目 `.grok`。helper 继承 Grok 进程的 `GROK_HOME`，按相同默认规则定位根目录，不另外传递路径参数。解析后仍校验 marker 的 installation ID；环境或目录不匹配时失败，不尝试查找或授权其他安装。

```text
G/config.toml                        # 用户与宿主共享
G/aio-proxy/.aio-proxy-managed.json   # 复用 installation marker 的身份字段
G/aio-proxy/ownership.json            # 仅记录受管字段的原值、最近写入值与事务状态
G/aio-proxy/credential.json           # CLI 拥有的 AT/RT、到期时间及 revision
G/.aio-proxy.lock                    # installation 生命周期与凭据操作互斥
```

`aio-proxy` 目录只保存数据，没有插件脚本或第二份 CLI。身份 marker 继续包含 `format`、`managedBy`、`agent`、`installationId`、`adapterVersion`、`endpoint`。ownership/credential 文件有独立格式版本并验证同一 installation ID、target 和 endpoint。

新建私有目录权限为 `0700`，私有文件及新配置文件为 `0600`。已有配置保留权限；不 chmod 用户整个 Grok 根。拒绝受管文件的 symlink/hardlink 等无法证明归属的路径；已有用户 config 为 symlink 时本期明确拒绝，保留原文件。输出只报告路径和冲突字段名，不输出原始凭据或完整配置。

命令必须引用稳定的 aio-proxy 安装入口，保留升级会替换的稳定路径，不固化版本缓存目录；按宿主 shell 规则引用可执行文件和每个参数。包含空格、引号的安装路径需要 artifact 测试。开发态 Bun 启动器不可误认为发布后的 aio-proxy 可执行文件。

## 5. 全局配置与请求目的地

设 aio-proxy 原点为 `E`，示例 `http://127.0.0.1:9317`。只写以下七个叶子字段：

| 字段 | 写入值 | 用途 |
| --- | --- | --- |
| `endpoints.models_base_url` | `E/v1` | 推理 |
| `endpoints.models_list_url` | `E/v1/models` | 明确覆盖已有目录 URL，避免沿用另一个服务的目录 |
| `endpoints.cli_chat_proxy_base_url` | `E` | 全局凭据涉及的 session 辅助服务 |
| `endpoints.xai_api_base_url` | `E/v1` | 全局 API 地址 |
| `endpoints.managed_config_url` | `E/__grok_unavailable/managed-config` | 阻止沿用远端管理配置地址；本地 404 是预期结果 |
| `auth.auth_provider_command` | 本节对应的绝对 CLI 命令 | 登录和刷新 |
| `auth.auth_provider_label` | `AIO Proxy` | 原生登录入口名称 |

`managed_config_url` 只是写入本地不可用地址，不新增对应 server 路由。`/user`、`/settings`、资源 bundle 等 aio-proxy 未实现的辅助接口可以失败；不能为消除这些失败而伪造用户身份、转发到 xAI，或新增 Grok 私有协议代理。实施验收必须证明这些失败不阻断本地登录、模型列表与推理。

`[auth]` 是 `[grok_com_config]` 的别名。已有设置只使用后一种写法时，修改其对应叶子并在 ownership 记录实际路径；否则使用 `[auth]`。同语义受管字段同时出现在两种别名下时拒绝修改，避免猜测合并优先级。`models_list_url` 的 `models_endpoint` 别名采用相同规则：单独存在时在原路径修改，两者并存时拒绝；不能留下生效的旧地址。

这是将当前 Grok 全局模型/登录接到一个 aio-proxy 的模式。现有显式指向其他服务的 `[model.*]` / `[model_providers.*]` 自定义 endpoint 会与全局凭据形成额外用途；本期将其报告为路由冲突并拒绝自动接管，不删除、改写这些模型。原生内置模型使用本节全局端点。已有非路由配置，如界面、权限、MCP、hooks、skills，保持不变。

configure 检查当前进程可见的相关环境覆盖和组织级配置限制；若它们令这些受管值不生效，返回具体字段冲突。不能修改组织策略、用户 shell 配置或清空 API Key。检查仅代表当前可见环境，list 不声称能证明所有未来 Grok 进程的环境。发布兼容测试需要从实际请求证明，没有 aio-proxy AT/RT 被发送到非受管 origin；涉及 relay、独立远端模型等额外功能不在本期支持范围。

## 6. 合并、幂等与还原

使用能定位 TOML 语法范围的编辑方式，只修改受管叶子及必要的表头，保留其他字段、注释和顺序。不能用正则猜测 TOML 结构，不能 parse 后全量重新序列化。支持 quoted keys、dotted keys、inline table 等合法表达；实现若不能安全编辑某种形式，必须在写入前给出明确错误，不能损坏配置。

第一次 configure 允许替换上述受管叶子的原值，并把“原先不存在”与具体值区分保存；备份只覆盖这些叶子，不复制整个用户配置。已有 `aio-proxy` 目录没有有效 marker 时拒绝接管。原配置非法 TOML 时不写任何用户文件。

再次 configure：

- installation ID、有效凭据和最初原值保持不变；最近写入值随真正的配置更新调整。
- 当前值等于上次受管值时，可更新稳定 CLI 路径或版本元数据；无变化则幂等。
- 当前受管字段被用户修改或删除时，报告冲突并停止自动重写，避免把用户修改当成新的可覆盖基线。
- endpoint 变化不迁移旧凭据。本期要求先对旧 installation 执行 remove，再 configure 到新 endpoint；不将旧 RT 发送给另一个地址。
- 高于当前 CLI 支持的状态格式或 adapter 版本不降级，沿用 `newer` 提示。

remove 对每个受管叶子执行三方比较：当前值仍等于最近写入值，才恢复最初原值；最初不存在则删除该叶子。当前值被用户修改或删除则保留现状并在结果列出跳过的字段。只删除由本操作创建且现在为空的表，不删除用户配置文件，不恢复整个文件快照。

所有 aio-proxy 写操作使用同一安装锁、最新读取和同目录原子替换。宿主不参与我们的锁，因此写前重读并检测 inode/内容变化，发现变化则重算或退出，不提交旧快照。这里不声称能阻止不合作的外部写者在最终检查与 rename 之间写入；命令提示在 Grok 不同时保存设置时执行配置修改，测试覆盖可检测的并发修改，避免虚假的无竞态保证。

ownership 中记录待提交操作和逐字段 before/after，再写 config，最后标记已提交。崩溃后依据当前字段与这两个值恢复：仅将已确定写入的叶子记为受管；遇到第三种值保留并报告冲突。恢复不回滚整个共享文件。configure/auth/remove 都必须先处理未完成事务。

## 7. 凭据状态机与并发

CLI 保存 `installationId`、`endpoint`、`revision`、`accessToken`、`refreshToken`、`accessExpiresAt`、`status`。RT 到期、撤销等最终状态以服务端为准，不伪造服务端未返回的到期信息。损坏、安装绑定不匹配或未知版本的状态不得用于请求。

### 普通调用

在同一安装锁内读取并验证 marker/config/credential。有 RT 时调用公共 `refreshAgentCredential()`，不因缓存 AT 尚未过期就绕过服务端校验；这样用户撤销后再次执行 `grok login` 能进入重新授权，不会反复拿到已撤销的缓存 AT。只有等待同一轮刷新且观察到新 revision 的并发调用可复用新结果。缺少凭据或服务端确认 `invalid_grant` 后，允许交互调用开始现有 device flow。设备码 URL 和状态在 stderr；超时、取消或拒绝不输出 token。

从无凭据进入授权时使用公共 `requestDeviceAuthorization()` 和 `pollDeviceAuthorization()`。总交互期限不超过 240 秒，并受服务端 device-code 到期限制，留在 Grok 已验证的 300 秒交互调用期限内。refresh 的临时网络失败不自动变成新的 device flow。

### `GROK_AUTH_EXPIRED=1`

只允许静默刷新。即使缓存 AT 看起来尚未到期，也不能原样交回导致 401 的旧凭据。缺 RT、确定无效的 RT 或需要用户操作时快速非零退出；不得打开浏览器、等待 stdin 或轮询 device code，由 Grok 决定何时进入交互登录。

一次静默调用的锁等待、网络和持久化总预算不超过 5 秒，以适应实测 7 秒宿主超时。预算耗尽保留可恢复状态并失败；不在临近 deadline 时开始无界重试。服务端的 `invalid_grant` 与临时网络/5xx 必须区分，后者不删除 RT。

### 锁与轮换持久化

configure、auth、remove 共用安装锁。复用或小范围提取仓库已有的文件锁进程身份、陈旧持有者恢复和 fencing 机制；不以进程内 single-flight 代替跨进程互斥，也不直接拿 server 数据库 ownership lock 管理 CLI 文件。

普通交互授权期间保留安装锁，设置 heartbeat；其他静默调用在自己的 5 秒预算内失败即可，不发起第二个登录。拿锁后必须重读状态，不能使用等待前缓存的 RT。对并发静默调用，记录等待前 revision：若拿锁后发现另一调用已轮换并持久化新的有效 AT，复用这个新 revision，不再次轮换；否则执行一次刷新。

refresh/login 成功后，先原子持久化完整的新 AT/RT/revision，再输出 AT。输出失败不回滚已经保存的新凭据。网络请求前记录可恢复的 refresh-in-flight 状态；进程中断或响应丢失后，仅在服务端现有短重放窗口内重试同一 RT，超过窗口转为需要重新登录，避免无限重放旧 RT。复用现有协议的窗口规则，不调整服务端防重放语义来适配客户端。

Grok 对刚签发 token 的保护属于宿主行为，不通过伪造时间或循环重签绕开。测试必须覆盖并发轮换后其他 Grok 进程的恢复；若最终被宿主拒绝，呈现原生重新登录/重试路径，不能承诺所有 401 都无感恢复。

## 8. 身份、模型目录与撤销

给 `AgentTargetSchema` 增加 `grok`，对应 client ID 为 `aio-proxy-grok`。同时更新请求 schema、服务端 client/target 校验、repository 的 target 解码和 admin 展示；不能只扩展 TypeScript union。现有数据库 target 列为 text，没有需要为了此枚举值新增的表结构。保持 token TTL、family rotation 和撤销规则不变。

Grok 使用普通 OpenAI-compatible `GET /v1/models`，不假装消费插件专用的中立 Agent catalog schema。由现有 AT 认证保护请求，响应保持现有普通模型目录结构；本期不添加 Grok 私有目录协议、后台刷新 timer 或 CLI 的 LKG。模型到协议的映射遵从宿主，默认 Chat Completions；代理继续通过现有 pipeline 完成跨协议转换和 failover。

remove 按顺序执行：

1. 验证 marker，获取安装锁，恢复事务并写入 removing 状态，使后续 helper 拒绝签发或返回凭据。
2. 对 marker 原 endpoint 撤销 installation。失败则保留目录、凭据和可重试状态；禁止离线 SQLite mutation 或 force-remove。未登录过的 installation 通过服务端既有 unknown/idempotent revoke 结果处理。
3. 撤销成功后清除 CLI 私有凭据，按第 6 节只恢复仍归属于本安装的字段。
4. 清理受管目录。任何失败保留足以重试的 marker/事务记录；用户新加的未知文件不递归删除。重新 configure 在成功移除后使用新的 installation ID。

不读取、备份或修改 `G/auth.json`，不代执行 `grok logout`。Grok 可能保留已撤销的 AT；它不能访问受保护推理，且旧 helper 参数不能获得新安装凭据。用户切回原来的 Grok 登录方式时自行重新登录，不承诺恢复其旧云端会话。

`agent revoke <id>` 保持仅撤销服务端、不改宿主文件的契约。其后的交互登录可重新授权同一 installation；静默 helper 不能自行重新批准。现有匿名和 `server.apiKeys` 模式保持不变；无论 server 是否要求通用 API Key，该接入都使用 installation 身份。

## 9. list、升级与代码边界

Grok 列表项带 `integrationKind: auth-command`，仍显示宿主版本、installation ID、endpoint 和授权状态。有效 marker 与配置漂移分开：`configuration` 为 `current / modified / missing / recovery_required`；marker 无效或未归属才作为冲突。配置漂移不丢失 installation 的可见性和撤销入口。

离线 list 只读，不签发、不刷新、不恢复事务、不输出 AT/RT。目录状态标为 `host_managed`，schema compatibility 为 `not_applicable`；不套用插件的 `fresh/stale` 或 LKG 指标。`--check` 与 `--authorizations` 继续通过本机 admin snapshot 查询服务端授权，Grok 身份与 orphan 的识别不依赖配置字段是否仍一致。

公共 `AgentTarget` 包含四个目标；插件 asset、受管插件目录安装和 post-upgrade 插件刷新循环明确只接收三个 plugin targets。不能给 Grok 填假插件资产。CLI helper 随 aio-proxy 二进制升级，Grok 配置引用稳定入口，不要求每次升级重写共享 TOML。未来修改受管字段格式需由显式 configure 执行可恢复迁移；旧二进制拒绝未知格式。

| 模块 | 职责 |
| --- | --- |
| `packages/cli/src/agent/grok/` | Grok configure/inspect/remove、TOML 字段归属和事务 |
| `packages/cli/src/agent/grok-auth/` | 薄命令适配、凭据状态和跨进程刷新协调 |
| `packages/agent-provider/runtime/` | 复用现有 device-code、token 请求与错误分类；必要时补充可复用 deadline 支持 |
| `packages/types/src/agent-integration/` | target/client ID 与兼容的结果类型 |
| `packages/core/src/agent-identity/`、server auth | 接受新增身份；保持既有鉴权语义 |
| CLI 命令输出和 i18n | 原生登录提示、配置漂移和只读诊断 |

私有模块保持在对应目录内，`index.ts` 只导出公共入口。新增 CLI 对公共 runtime 的使用要声明直接 workspace 依赖。TOML parser 的具体库选择留给实现计划的依赖评估；必须满足第 6 节可检验的编辑契约，不由 spec 预造通用工具框架。

## 10. 验收与发布

必须通过的行为验证：

- 固定宿主 `1.0.24` 与实现时当前版本：configure → 原生登录 → 设备码批准 → 普通模型目录 → 流式文本及一次工具调用 → 自动刷新；拒绝、取消和超时路径。
- 编译产物运行真实 helper，验证 stdout 仅含 JSON、stderr 展示登录 URL、`AIO Proxy` label、路径引用与升级后入口稳定。
- 普通 AT 和 RT 的签发、client mismatch、轮换、重放与 installation 撤销；重启 server 后身份可继续使用；未知 target 仍被拒绝。
- 同一 Grok 进程跨过期继续推理，较早签发的 401 恢复，以及刚签发 401 的宿主限制；至少两个 helper 进程并发，旧 revision 不覆盖新 RT。
- 刷新响应丢失、写凭据前崩溃、保存后 stdout 中断、陈旧锁持有者恢复、remove 与登录/刷新竞争。
- TOML 无文件、已有用户设置、注释、别名、dotted/quoted key、inline table、非法 TOML、配置漂移、用户新增字段、重复 configure、endpoint 改变、未知格式、路径链接、默认/自定义 `GROK_HOME` 继承与安装 ID 不匹配、每个提交阶段崩溃与可检测的外部改写。
- remove 只撤销本安装，只还原未变的受管字段；用户修改保留；离线撤销失败保留可恢复记录；不触碰 Grok auth 文件。
- helper token 的实际目的地包括模型发现、推理和辅助请求。正常本地使用不把 aio-proxy token 送往外部 origin，辅助 404 不触发云端鉴权替代；显式外部模型与受管覆盖冲突可解释且不损坏原配置。
- OpenCode/Pi/OMP 的已有 tests 与 artifact/compatibility 验证继续通过，plugin 更新流程不尝试给 Grok 安装脚本。

单元测试按模块 colocate，只保护上述行为与回归。真实 Grok 二进制是兼容验证依赖，不成为 aio-proxy 的构建或运行时依赖。常规实现完成门槛为 `bun run preflight` 与受影响 Agent artifact/compatibility 测试通过；本次仅提交设计文档，不宣称这些实现验收已经通过。

实现发布使用一条简短 changeset，产品包 `aio-proxy` 与实际修改的内部包使用一致 minor bump；不为本设计文档单独添加功能发布说明。不改变 plugin-sdk 公共 API 时不把它作为无关发布目标。

## 11. 备选方案与结论

- 静态 API Key：可以访问模型，但丢失现有 installation、轮换与精确撤销能力，且用户已选择 external helper，不采用。
- 把 AT/RT 都输出给 Grok：不会令 external helper 模式自动执行 refresh grant，反而多一份 RT，拒绝。
- 新建 OIDC server：超出已存在的 device-code runtime 能力需求，拒绝。
- 复制 Pi/OpenCode 的 OAuth 实现到 CLI：已有公共 runtime，拒绝。
- 无条件恢复整个 config/auth 快照：会覆盖用户和宿主的后续修改，拒绝。

产品方向已确定；本设计列出的文件格式、生命周期和宿主限制均给出具体处理规则。实现计划见 [Grok Build Agent Integration Implementation Plan](../plans/2026-09-09-grok-build-agent-integration.md)；后续按计划完成实现和验证，不需要先完成 Codex 或 Claude Code 接入。
