# Codex 双份目录整分支最终审查

审查范围：`fecac449a0987de917bab9e3f2895fff92139f53..b22a048161dec0a3b56ef77e91c6e36b8df44a5f`（7 个提交）。产品最后提交为 `baf236de3`，之后只有设计/计划执行记录。依据指定 code-reviewer.md、设计、实施计划、global-constraints.md、progress.md 和 Task 5 最终报告进行只读审查；本文件是唯一新增审查产物，没有修改产品文件、索引或 Git 历史。

## Strengths

- HTTP 与本地目录共享模型解析和投影。官方匹配仍使用真实 `model.modelId`，公开 alias 不会把官方模型误判成第三方；官方有效提示词与未知附加消息保留，空模板先修复再去重。compact/full 仅改变合成提示词，顺序、窗口和能力保持一致。`packages/server/src/server/list-models/codex-client-models/codex-client-models.ts:93`、`:146`，`codex-assembly.ts:99`。
- 完整目录获取复用现有 URL 和鉴权；Bearer 只放 header，逐行检查既有 schema、base 和模板类型，保留未知消息字段，空列表合法，full 不套用客户端 HTTP 1 MiB 上限。`packages/cli/src/agent/codex/model-catalog/fetch-catalog.ts:18`、`:33`。HTTP 参数处理在鉴权后的 Codex 分支，普通列表、Agent 协商及 Grok 优先行为保持原样。`packages/server/src/server/models-routing.ts:55`、`:62`、`:68`，`create-routes.ts:229`。
- 接入顺序完整：keep-chatgpt 在同一安装 lease 中 fetch、持久化、重读摘要验证和配置验证成功后才退休旧 command 身份；command 在授权完成后准备目录，失败保留可恢复 journal，complete 恢复也重新满足目录前置条件。CLI 和 Dashboard 经过同一 commitSetup。`packages/cli/src/agent/codex/setup/catalog-preparation.ts:14`、`:31`，`setup/setup.ts:138`、`:264`、`:336`。五种准备失败和成功调用顺序有行为测试，覆盖旧授权保持有效。
- SHA-256 内容寻址文件复用已存在的 durableWrite、0700/0600、普通文件与 symlink 检查；相同内容不替换文件，缺失文件能修复，摘要冲突拒绝覆盖。配置切换复用 TOML/marker journal，事务职责拆分保持原恢复协议。`packages/cli/src/agent/codex/managed-config/catalog-storage.ts:52`、`:64`，`config-operation.ts:41`、`:71`。
- 清理不只相信调用者 keep：锁内重新读取当前 TOML、marker.before 和 journal，保护可解析的实际引用；不确定引用、symlink、非法配置或 pending journal 跳过清理。remove 包括 partial 分支，提交后仍保护用户改回的旧摘要文件；before 在托管目录内时连续更新也不会删除。`packages/cli/src/agent/codex/managed-config/catalog-storage.ts:97`、`:148`，`managed-config.ts:378`。显式改 Provider ID 的路径先恢复原字段再生成新 ownership；无 catalogPath 的旧调用者保留已有目录 ownership；相同配置重入采用按路径比较的 marker 等价性，避免后台排序后反复写盘。`managed-config.ts:233`、`:246`、`:273`，`marker.ts:108`。
- 同步器先只读探测 managedRoot，再在锁内恢复 journal、检查 managed 字段、Provider ID/base URL、原目录归属及摘要。load 在锁外，更新器重新拿锁恢复并复查，抵御 load 期间解除接入、用户改路径和原目录被改写。旧 format 1/2 marker 只有无自定义目录时后台迁移，显式配置可以接管原值并在移除时恢复。`packages/cli/src/agent/codex/model-catalog/model-catalog.ts:36`，`managed-config/catalog-config.ts:20`、`:56`。
- 生命周期接线清晰：startup、成功快照发布、鉴权后的目录请求及六小时 interval；单次执行加 dirty 合并通知，下一轮读取最新状态，失败不会自行形成忙循环。请求不等待文件更新，HTTP abort 与服务 signal 分离；close/catch 均清理同步器，进入短事务后的中断仍由 journal 恢复。安装 lease 自身的 ownership 检查也绑定 signal。`model-catalog/model-catalog.ts:52`、`:71`，`packages/server/src/server/server.ts:71`、`:110`、`:130`，`server-state/lifecycle.ts:107`。
- 本地能力依旧受原 shouldEnableAgentHost 和配置 endpoint/实际绑定一致性约束；只解析 configuredLocation 的一个 Codex home。新增失败日志仅使用固定事件及 Error/typeof 分类，不输出 error message、目录内容或 token。`packages/cli/src/run/run.ts:39`、`:49`、`:58`。
- 实际 Codex 0.159.2 验收通过公开 createServer 与 commitCodexSetup，目录 GET 走真实路由，生成 POST 由 localhost mock 捕获；50/100 本地目录的 GET=0、模型集合和完整 instructions，以及 50 远端 compact 的加载均有实际客户端证据。测试只修改独立缓存副本的传输开关。文档明确重启要求、compact 非等价保证、远端文件边界；单份 changeset 对 aio-proxy/cli/server 统一 minor，内容描述最终行为。

## Issues

### Critical (Must Fix)

无。

### Important (Should Fix)

无。未发现需要阻塞合并的新增正确性、安全、所有权、恢复或跨任务集成问题。

### Minor (Nice to Have)

无新增代码问题。ledger 中延期的 lint/build/SDK 警告归类为已有基线诊断：最终报告已披露，原始 preflight 显示通过，不应因本任务扩展修改无关模块。它们也不能被表述成“无警告通过”。

## 验证依据与审查判断

- 复核主实现、跨任务调用关系、关联行为测试、journal/lease 与文件操作的既有契约；使用 CodeGraph 后按需查看 diff 和具体源码。复核全分支 `git diff --check` 无输出，没有重跑整套检查或客户端；没有尚需用针对性测试解答的具体代码疑点。
- 直接检查 `/tmp/aio-task5-build.log` 和 `/tmp/aio-task5-preflight.log`：build 20/20，preflight 58/58；CLI 1198 pass/0 fail，server 2415 pass/0 fail；Dashboard 1371 pass/1 skip，types 有既有 1 skip。完整计数与 Task 5 的 9127 pass/0 fail/2 skip 一致。缓存命中已在日志中明示；不把读取日志说成审查者重新执行测试。
- Task 5 报告记录最终 smoke：50 local full 1,199,550 字节，50 remote compact 645,677 字节，100 local full 2,219,100 字节；三场均验证官方与合成 instructions 相等，本地两场目录 GET 均为 0。代码确实检查这些行为，并从 TOML 实际引用文件取得 local 预期值。该证据支持本次目录加载和提示词传递要求。
- 隔离程度足以进行本次无真实模型计费的目录验收：独立临时 Codex/AIO/workspace，子进程仅获得受限环境和占位凭据，provider 指向 localhost，所有实际生成 POST 被本地 mock 截获，工具请求被拒绝，最终清理进程/监听/目录。不过 Bun fetch guard 不能阻止或观测 Rust 子进程全部出站请求；`blockedNetwork=0` 只按报告声明的范围解释，不作网络封锁证明。
- compact 人工检查覆盖解释/诊断/实施、后续约束、压缩延续、用户改动、破坏性操作和未授权消息八类指导；它是行为变更，没有把字节预算或抓包 equality 当成模型行为等价证明。
- 检查 `bun.lock` SHA-256 仍为 `3185426568b3d7b9d54afe7893e44029c0c944aac6e9b8940f6b3c42df24d7a2`。Git 状态只有该用户原有修改，未进入提交。
- 接受 ledger 已记录的职责拆分与窄测试接口裁定：它们服务于文件长度和既有类型/生命周期约束，没有新增用户可见范围。

## Recommendations

合并和发布时保留文档中的重启要求及验证范围说明。后续若要宣称更多客户端版本、默认 Lite/WebSocket 传输或强制离线保证，应另行提供对应验收；本分支不需要为这些未宣称能力扩展实现。

## Declined to judge

以下是本次考虑后未作为已验证能力判断的全部边界；不是未披露的产品缺陷：

- compact 与 full 对实际模型的语义/行为等价性：设计明确拒绝这一保证，八场景指导审阅和 mock 抓包均不能证明等价，本次按指导保留与披露是否充分判断。
- 默认 Responses Lite/WebSocket 的实际生成兼容性：验收按设计仅在独立 fixture 副本关闭开关，产品默认未改；普通 Responses POST 成功不能推导这些传输均经过实测。
- Codex 0.159.2 以外版本及 GUI Desktop 的完整端到端行为：当前指定实测基准是 0.159.2 app-server，未引入新的最低版本或全版本承诺；本次不把 CLI 验收扩大成 GUI 全流程保证。
- 任意模型构成或任意数量的 HTTP 目录容量：容量契约为六官方加四十四合成的 50 条基准，100 条用本地文件解决；特别是大量官方别名仍保留完整官方消息，不宣称都低于 1 MiB。
- 子进程全部网络流量的审计/强制封锁：smoke 没有 OS 网络沙箱，Bun guard 只覆盖本进程 fetch。受限环境与 localhost 生成捕获足以支撑本次避免实际模型计费的验收，但不能判断所有 DNS/遥测/未来客户端后台请求都不存在。
- 远端账户、其他 home 或容器外文件部署，以及运行中 Codex 的目录热加载：设计明确限定单一已解析 home 和启动时读取；本次检查越界访问未引入，不判断这些未实现能力。
- 既有通用文件/锁原语面对恶意同用户进程持续竞态修改父目录、hardlink 或 inode 的全面安全性：本分支要求复用这些原语；已核对新增调用的锁、fence、摘要、symlink 和保守清理规则，没有发现本分支引入的具体回归。没有把本次审查扩展成通用文件系统原语的完整对抗审计。
- 既有无关 Dashboard hooks、构建弃用及 SDK warning 的根因修复：不由此次改动引入且最终检查通过；已完成基线噪声分流，不作为本分支缺陷。

## Assessment

**Ready to merge? Yes。**

**Reasoning:** 实现满足双份目录的功能和边界约束，跨任务的授权前置、文件归属、可恢复切换、保守清理和生命周期同步衔接完整。最终构建/测试及实际客户端证据支持所宣称行为；上述未验证能力已明确限定，没有发现必须先修复的新增问题。
