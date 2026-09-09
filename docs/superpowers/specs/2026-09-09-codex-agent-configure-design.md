# Codex Agent Configure 向导设计

状态：产品交互与认证选择已由用户确认，进入实施规划；尚未实施。实施前必须完成文末所列 Codex 契约验证。

实施计划：[Codex Agent Configure Implementation Plan](../plans/2026-09-09-codex-agent-configure.md)。

关联：[#327](https://github.com/aio-proxy/aio-proxy/issues/327)、[#310](https://github.com/aio-proxy/aio-proxy/issues/310)。

## 目标与已确认决定

`aiop agent configure codex` 是一套交互向导，完成后 Codex 可以连接当前用户运行的 aio-proxy。

1. 输入 Codex Provider ID，首次默认 `aio-proxy`，允许自定义。
2. 检测代理 API Key：未启用认证直接跳过；已启用则选择已有 Key，或选择生成新 Key。
3. 选中或生成的 Key 直接保存到 Codex 配置，用户无需另外设置环境变量。
4. 解释 Provider 对历史会话可见性的影响，询问是否迁移历史会话到目标 Provider。
5. 不读取用户对话正文来推荐模型，不新增模型选择步骤，不写、删除或恢复顶层 `model`。
6. 设置 `requires_openai_auth = true`，保留 Codex 原有登录流程；模型请求显式使用代理侧 token，避免回退到登录凭据。该设置不代表所有依赖官方后端的功能都已获得兼容保证。

上述决定修订 #327 中“写入顶层 model”及此前方案中默认使用 `env_key` 的要求。没有 API Key 时不自动开启代理认证。这里只使用代理自己的调用凭据，不使用上游 Provider 密钥。

## 交互流程

以下为示例，实际计数与标签来自检测结果：

```text
$ aiop agent configure codex

Codex 配置：~/.codex/config.toml
代理地址：http://127.0.0.1:9317/v1

? Provider ID › aio-proxy

检测到代理已启用 API Key 认证。
? 使用哪个 API Key？
  Codex 日常使用
  开发工具
  生成新的 API Key

Codex 本地会话选择器默认按当前 Provider 筛选历史。
切换到 aio-proxy 后，其他 Provider 下的旧会话可能不出现在列表中；会话没有被删除。
? 将原 Provider openai 下的 42 个历史会话迁移到 aio-proxy？
  是，迁移历史会话
  否，保留原有归属

配置已保存。历史会话迁移：42 个成功。
重新打开 Codex 后生效。
```

没有 API Key 时只显示“代理未启用 API Key 认证，跳过 Key 选择”。没有可迁移会话时显示计数为零并跳过迁移问题。

收集完选择后再写入，用户在提示期间取消不产生配置或凭据变更。不再增加重复的最终确认步骤。迁移范围及影响必须在用户回答迁移问题之前展示。

首次使用默认 Provider ID 为 `aio-proxy`；重复运行默认沿用当前受管 Provider ID。Provider ID 是 Codex 配置中的标识，不是 aio-proxy 上游 Provider ID。

目标 ID 已存在且不受本工具管理时，显示冲突并要求换一个 ID；不因名称相同自动接管。受管 ID 更新时保留最初的恢复基线。更换受管 ID 时复用字段归属与恢复规则，不能遗留工具独占的旧凭据。

## Codex 配置契约

默认目标为 `~/.codex/config.toml`。遵守 Codex 的全局目录设置，若设置有效的 `CODEX_HOME`，使用其全局 `config.toml`，并在向导开头展示实际路径。绝不定位或写入项目内的 `.codex/config.toml`。

无认证时写入：

```toml
model_provider = "aio-proxy"

[model_providers.aio-proxy]
name = "aio-proxy"
base_url = "http://127.0.0.1:9317/v1"
wire_api = "responses"
requires_openai_auth = true
experimental_bearer_token = "aio-proxy-local"
```

启用认证时，将 `experimental_bearer_token` 的值替换为用户选中或新建的代理 Key。未启用认证时的 `aio-proxy-local` 是固定的非秘密占位 token，不会加入 `server.apiKeys`、开启认证或引入 Key 选择步骤。显式 token 的作用是避免 `requires_openai_auth = true` 在缺少代理凭据时把 Codex 登录 token 发给本地代理。

Codex 当前源码先解析显式 Provider bearer token，再考虑 OpenAI 登录凭据；因此 `true` 可以和直接保存的代理 Key 配合。不能把实际 Key 填入 `env_key`，也不改 Codex 的 `auth.json`、Keychain 或 ChatGPT 登录状态。尚未登录的 Codex 可能仍显示原生登录提示；不承诺该设置能让匿名 Codex 跳过登录，或自动解锁全部官方功能。

只管理顶层 `model_provider` 和所选 Provider 表内本工具写入的字段。保留顶层 `model`、profiles、审批、sandbox、MCP、其他 Provider 以及用户添加的字段。TOML 修改要基于解析后的键路径，支持合法的带引号 ID、已有表和不同字段排列；不得用全局字符串替换改写文件。实现时需要选择支持保留无关内容的 TOML 编辑方式，并用注释、内联表和多行字符串夹具验证。

地址复用现有 loopback 解析并增加 `/v1`。凭据判断不能复用会吞掉配置错误的探测回退：无法解析配置不等于没有 API Key。

直接凭据配置与归属记录仅允许当前用户访问，新建文件使用 `0600`、私有目录使用 `0700`。Key 不进入日志、错误消息、列表输出或测试快照。

## API Key 选择与创建

- 用当前代理配置及 service.env 的现有解析逻辑获取有效 Key；选项仅显示标签或“API Key 1”等编号，不显示明文。
- Dashboard settings 返回 `****`，不能把该视图当作可用 Key 来源；也不为了向导向 Dashboard 增加明文密钥接口。
- 选择“生成新的 API Key”后使用密码学随机源，遵守现有代理 Key 格式；追加带有 Codex 用途标签的条目，保留现有 Key 和环境变量模板。
- 新 Key 的追加必须遵守配置写入锁和并发检查。优先复用现有配置修改/生效机制，不能对读取时的整个配置做无条件覆盖。
- 先保存代理端新 Key 并确认已生效，再向 Codex 写入它；生效验证只读，不发起计费推理请求。
- 配置不可写、模板不能解析或代理拒绝新 Key 时，明确失败，不报告“可使用”。代理离线时可以保存本地配置，但必须区分“已保存，未验证”和“已验证可用”。
- 若新 Key 已经提交而后续步骤失败，保留恢复信息并报告已创建 Key 的标签，不能假定跨两个配置文件的修改天然是一个事务，也不能无条件删除可能已被使用的 Key。
- `agent remove codex` 不撤销用户选择的共享 Key，也不自动撤销已生成但可能被复用的 Key；结果说明 Key 仍保留在代理设置中。

## 历史会话迁移

### 范围与说明

迁移能力作为 Codex 模块内部的独立操作，由 configure 向导调用，本期无需另加公开命令才能使用。

默认来源为切换前的有效全局 Provider ID，未配置时为 `openai`。迁移前按 Provider 汇总计数；若用户需要其他来源，可在同一阶段选择来源 Provider。禁止默认将所有 Provider 的会话混在一起迁移。

选定来源的现有会话包括已归档会话，预览分别显示数量；保留归档状态。已在目标 Provider 下的会话不重复处理。保持会话 ID、消息历史、模型、工作目录、标题、父子关系和时间顺序不变。更改的是归属，后续继续这些会话时会使用目标 Provider；不承诺不同上游之间可以复用加密推理状态。

文案应说“本地会话选择器默认按当前 Provider 筛选”，不能宣称不同 Provider 之间存在安全隔离，也不能把这一行为泛化成所有 App 或远程会话的永久限制。

### 持久化与恢复

已确认 Codex 的 rollout `session_meta` 中有 `model_provider`，SQLite `threads.model_provider` 也参与列表过滤；单改配置或只改其中一份不算迁移完成。

实施前先针对支持的 Codex 版本验证原生接口是否支持持久迁移：恢复会话时覆盖 Provider 不一定重写其持久归属，必须同时检验列表、重启和再次恢复。若原生接口满足契约，优先使用；若不满足，使用受版本与 schema 检查约束的离线迁移。

离线迁移需要 Codex 停止对相关存储写入。不能把 aio-proxy 自己的锁说成能阻止 Codex 写入。发现运行中的写入者、未知历史格式或不匹配的记录时拒绝迁移，保留已完成的 Provider 配置并报告原因。

离线实现必须具备：

1. 在修改前对选定记录进行完整预检，确认 ID、来源 Provider、存储位置及记录格式一致。
2. 保存只含本次变更的恢复日志及必要备份，并持久化进度。
3. 精确更新会话元数据与对应索引，不改对话内容、不删除数据库以强制重建。
4. 使用数据库事务及文件原子替换；跨存储通过恢复日志处理失败，不能假设一次 SQLite 事务能覆盖 JSONL 文件。
5. 重复执行不增加副本；中断后能够恢复或继续，报告成功、未处理和冲突数量。
6. 恢复只撤回仍与本次写入匹配的归属，不覆盖迁移后新增的对话内容。

当前 Codex 源码已经包含 legacy 和 paginated 历史格式。实现不能把扫描 `sessions/**/*.jsonl` 作为全版本方案；必须建立版本/格式兼容矩阵。未支持的格式在写入前明确拒绝，不做猜测性修改。兼容探测使用临时 Codex 数据目录与合成会话，不试改用户真实会话。

## list / remove 与插件边界

CLI 层增加 static-config 分支，现有 `@aio-proxy/types` 内服务插件、catalog 与 device-code 的 `AgentTargetSchema` 保持原语义。Codex 不进入插件资产安装、授权撤销或 post-upgrade adapter 更新循环。

独立 sidecar 记录实际全局配置路径、Provider ID、格式版本，以及每个受管字段修改前/最后写入的值。注释、字段重排或相邻配置被 Codex 重写不应丢失归属。凭据字段的记录同样受私有文件权限保护。

`agent list` 展示 Codex 的 Provider ID、配置路径、端点、归属/修改状态；`--check` 检查连接和凭据。不展示伪造的 installation ID、device-code、token 到期或授权状态。`--authorizations` 只列出现有插件授权。

`agent remove codex` 可以离线执行，逐字段撤销仍等于最后写入值的内容；保留用户后改的字段并报告。只清理工具创建且已空的表。没有有效归属记录时不按 Provider ID 猜测并删除配置。

移除配置不自动反向迁移历史会话。配置恢复与会话归属恢复是两个独立操作，迁移记录应说明如何恢复及其条件。

实施计划为恢复提供显式入口 `aiop agent configure codex --restore-migration <operation-id>`，仅撤回指定日志中仍可恢复的历史归属；不修改全局配置、Key 或模型。正常配置向导不增加额外步骤。

## 实施顺序与验收

1. **Codex 契约验证**：在隔离目录验证 `requires_openai_auth = true` 与直接 bearer token 的组合、全局 Provider 切换、不同存储格式和原生迁移可能性；锁定兼容范围与迁移路径。
2. **共享配置生命周期**：新增 Codex 配置编辑/归属模块，完成 configure/list/remove 的文件行为测试。
3. **凭据与交互向导**：复用 `@inquirer/prompts`，接入 Provider ID、Key 选择/生成、取消行为和脱敏输出。
4. **会话迁移模块**：实现预览、选择来源、迁移和失败恢复，并接入向导末步。
5. **命令与发布验证**：更新帮助、五种语言文案、README 与 changeset，覆盖真实 CLI 分发和原插件行为。

必须覆盖：无 Key 完全跳过凭据问题；已有 Key 与生成 Key 两条路径；自定义及冲突 Provider ID；顶层 `model` 原样保留；取消零写入；损坏 TOML；宿主重写；并发配置变更；迁移接受/拒绝/无历史；多个来源 Provider；归档与父子会话；迁移中断恢复；不支持格式；重复执行；remove 保留用户修改与 Key；完整输出不泄露密钥。

认证兼容验收矩阵包含 Codex 已登录/未登录与代理有 Key/无 Key 的四种组合。捕获请求确认使用代理 Key 或固定占位 token，不使用已有 ChatGPT token；另验证原有登录状态不变。官方功能按实际依赖逐项验证，不由 `requires_openai_auth` 单个开关推定全部正常。

集成验收使用临时目录运行 `configure → list --check → remove`；迁移额外验证重新启动 Codex 后历史会话可见且接续使用目标端点。执行仓库要求的 `bun run preflight`。新增实现文件与测试遵守同名目录布局和文件行数限制。

用 `bun changeset` 创建用户可见说明，至少同时覆盖 `aio-proxy` 与 `@aio-proxy/cli`；若新增 server 行为同时覆盖 server，产品包 bump 与内部包一致。此设计不包含安装、升级或自动启动 Codex，也不扩展 Pi/OpenCode 的授权协议。

## 调研依据与尚未验证的范围

- [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference)：Provider 字段、直接 bearer token、`env_key`、Responses、全局配置约束。
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)：列表的 `modelProviders` 过滤、resume 配置覆盖、不同历史格式的支持限制。
- Codex 源码观察基于 main commit `634ebc1865c6ac840ed3ba118f040d527bf4b55d`，不是已验证的最低支持版本：`codex-rs/tui/src/resume_picker.rs` 的 `picker_provider_filter` 对本地模式使用当前 Provider；`codex-rs/rollout/src/metadata.rs` 从 `session_meta` 提取 Provider；`codex-rs/state/src/runtime/threads.rs` 持久化并过滤 `threads.model_provider`。
- 同一 commit 的 `codex-rs/model-provider/src/auth.rs` 中 `resolve_provider_auth` 优先调用 `bearer_auth_for_provider`；`codex-rs/model-provider-info/src/lib.rs` 描述 `requires_openai_auth` 控制首次登录流程。仓库的 `authenticateStaticOrAnonymous` 在 `server.apiKeys` 为空时允许携带固定占位 token 的匿名请求。
- 仓库现状：`packages/cli/src/agent/agent.ts` 为插件生命周期；`packages/cli/src/control-plane/control-plane.ts` 已加载 service.env；`packages/server/src/dashboard-routes/settings/settings.ts` 的 Key 视图脱敏且变更使用 revision；`packages/server/src/config-store.ts` 提供有校验的配置修改入口。

尚未运行真实 Codex 迁移实验，因此不声称已确定所有版本的数据库路径、存储格式或原生迁移支持。实施顺序第一步必须产出经过实验的兼容结论，之后才能实现会话存储写入。
