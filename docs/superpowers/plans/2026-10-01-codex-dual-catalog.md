# Codex 双份模型目录 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 同时提供本地完整 Codex 模型目录和非官方提示词精简的 HTTP 目录，让大目录可稳定加载并自动维护本地文件。

**Architecture:** server 共用解析逻辑生成 compact/full 投影，CLI 管理本机 Codex 目录。首次接入先写摘要命名的不可变完整文件，再用已有配置 journal 切换路径；后台由启动、成功模型快照发布、Codex 目录请求和六小时周期检查触发。接口只通知，不等待本地写盘。

**Tech Stack:** Bun、TypeScript、Hono、现有 Codex TOML/marker journal、安装锁、fileCacheStorage、bun:test；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-01-codex-dual-catalog-design.md`。用户已审阅设计并选择 subagent-driven-development 执行；各任务均有独立规格及质量审查。

## Global Constraints

- HTTP 模型目录上限为 1,048,576 字节。
- 原始精简模板预算不超过 6,144 UTF-8 字节。
- 50 条模型，6 条为本次采集的官方条目、44 条为合成条目，compact JSON 上限 786,432 字节。
- 目录权限 0700、文件权限 0600。
- 默认 compact，codex_instructions=full 显式获取 full；显式 compact 也接受。
- 本地目录只在 Codex 启动时加载，文件更新后需要重启 CLI 或 Desktop。
- 运行时每 6 小时进行周期检查，后台使用服务生命周期 signal。
- 只管理 CLI 进程 resolveCodexLocation 解析出的一个 Codex home，尊重 CODEX_HOME。
- 官方匹配依据 modelId；完整有效官方提示词与附加消息不裁剪；full 保留完整有效提示词且不恢复冗余副本。
- 现有身份验证及 Agent 协商保持不变；不从请求推断文件路径，不写远端客户端，不新增依赖。
- 目录文件、目录同步日志及新增目录元数据不得包含 token；现有认证 marker/config journal 的凭据持久化规则保持不变。
- 清理保护当前 TOML 引用和 marker.before 原目录；先安全恢复 config journal，再判断后台目标资格。
- 所有测试与新实现同域共置；新 handwritten 实现文件不超过 500 行，400 行时检查职责；现有 450 行 managed-config.ts 先拆私有事务职责再加功能。
- 保留当前去重修复与用户已有 bun.lock；不将用户改动纳入提交。所有实现提交追加 `Co-authored-by: Codex <noreply@openai.com>`。
- 工作区已存在；执行阶段用 using-git-worktrees 核实复用，不另建 worktree。若需要分支，使用 codex/ 前缀。

## Review Focus

1. 非官方 slug 看起来像官方模型、官方 modelId 被别名隐藏：按 modelId 选择模板，投影不改变路由集合（Task 1）。
2. 用户原有目录、旧 marker 或修改过的摘要文件：保留/恢复用户值，清理不能删除实际引用或 before 原目录（Task 2）。
3. 新文件落盘后 TOML/marker 提交中断：旧目录仍可用，startup 不因 modified 预检查阻挡 journal 恢复（Tasks 2/4）。
4. 首次目录获取/写盘/验证失败、command 授权尚未完成或 endpoint 改变：不提交悬空路径、不退休旧授权、不新增凭据副本、不伪报成功（Task 3）。
5. 模型变化发生在同步执行中、HTTP 请求取消或应用停机：最新变化会再跑，HTTP 取消不取消后台任务，停机不产生新任务（Task 4）。

---

## 文件职责与提交基线

源目录均相对仓库根。只有供 CLI/server 边界共享的 contracts 从 server 包入口导出；CLI 的 managed-config 私有 storage/transaction 不导出到更高层。

| 模块 | 文件及职责 |
| --- | --- |
| server 双投影 | `server/list-models/codex-client-models/`：现有解析与装配；新 `compact-instructions.md` 为精简正文，原默认正文保留 |
| server 注入契约 | `src/codex-catalog-sync/{index,contracts}.ts`：设计中的目录、来源、同步器、factory 类型，无文件访问 |
| CLI 文件事务 | `agent/codex/managed-config/catalog-storage.ts`：摘要文件准备/清理；`catalog-config.ts`：仅目录字段的配置事务；`config-operation.ts`：提取已有 recoverPending/completeOperation，不复制 journal |
| CLI 同步 | `agent/codex/model-catalog/{index,model-catalog,fetch-catalog}.ts`：串行调度、周期检查、HTTP full 获取 |
| 接入与生命周期 | 现有 setup、server create/close、Provider 快照发布及 models route 只接线 |

Task 1 的提交纳入当前四个去重实现/测试文件和既有 changeset；bun.lock 不纳入。后续任务逐一提交，不部署运行中的代理。无需改变 CLI/server 的 test:unit 扫描脚本，两者已经扫描共置测试。

### Task 1: compact/full 投影与接口契约

**Files:**
- Create: `packages/server/src/codex-catalog-sync/index.ts`, `contracts.ts`
- Create: `packages/server/src/server/list-models/codex-client-models/compact-instructions.md`
- Create: 同目录 `fixtures/official-models-2026-10-01.json`
- Modify: 同目录 `codex-client-models.ts`, `codex-assembly.ts`, 两个 `.test.ts`
- Modify: `packages/server/src/server/models-routing.ts`, `packages/server/src/server/server.models.test.ts`, `packages/server/src/index.ts`
- Modify: `.changeset/lazy-breads-start.md`（先描述这一任务独立可发布的接口精简行为，后续任务重写）

**Interfaces:**
- Consumes: `resolveEnabledModels(state)`、`readCodexModelsCache(options)`、当前 `normalizeInstructions`，不改变模型路由。
- Produces: 设计中的 `CodexCatalog`、`CodexInstructionsMode`、`CodexCatalogSource`、`CodexCatalogSync`、`CodexCatalogSyncFactory`、`CodexCatalogSyncReason`；从 `@aio-proxy/server` 导出这些类型。
- Produces: `codexClientModels(state: ServerState, options?: { fetchImpl?: typeof fetch; signal?: AbortSignal; instructionsMode?: CodexInstructionsMode }): Promise<CodexCatalog>`，缺省 compact。
- Produces: `renderDefaultInstructions(slug: string, mode?: CodexInstructionsMode): string`，缺省 full，避免现有内部调用语义意外改变；assemble 输入增加可选 instructionsMode，缺省 compact。官方无有效提示词的修复 fallback 仍使用 full。

- [x] **Step 1: 写投影和 HTTP 失败测试。** 从本次缓存的完整官方上游目录取 `gpt-6.1-sol`、`gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`、`gpt-5.6-sol`、`gpt-5.6-terra` 六条原行保存为上述声明式 fixture，标注采集日期/来源，不复制代理投影后的用户元数据；保留旧去重 regression，明确让其检查 full。

新增 `compact and full preserve catalog identity and official alias instructions`，断言：
```ts
expect(compact.models.map(({ slug }) => slug)).toEqual(full.models.map(({ slug }) => slug));
expect(compactOfficial.model_messages).toEqual(fullOfficial.model_messages);
expect(compactNonOfficial.model_messages).not.toEqual(fullNonOfficial.model_messages);
```
同时断言去掉提示词两字段后的整行深度相等；加入 `gpt-looking-synthetic` slug 和官方别名。新增 `50 mixed models fit compact budget`：长度 50、紧凑 JSON 字节 `<= 786_432`、full 合成提示词等于原默认模板渲染结果。HTTP 测试固定默认/显式两模式、非法值 400、未鉴权 401、非 Codex Agent 拒绝、Grok 与普通列表不改变；有效/空 template fallback 和上游未知字段在两模式保留。

- [x] **Step 2: 跑 RED。**
Run: `cd packages/server && bun test --preload=./__tests__/setup.ts src/server/list-models/codex-client-models src/server/server.models.test.ts`。
Expected: 现有去重检查通过，新模式/体积/参数测试失败；不触网。

- [x] **Step 3: 实现类型、投影与路由参数。** 按设计保留原默认正文，编写 <=6,144 字节的 compact 正文；不要使用自动截断。原模型解析只跑一次，mode 只决定合成模板；新增参数只在已通过现有鉴权/Agent 分支限制的 Codex 分支解析。以设计八场景人工核对 compact 的范围、权限和目标延续，不以字符串包含测试替代评审。

- [x] **Step 4: 跑 GREEN。** 重跑 Step 2；所有测试 PASS，50 条 compact 满足预算，full 有完整提示词。

- [x] **Step 5: 提交。** `git add` 仅上述文件及既有去重文件/changeset；`git commit -m "feat(server): add compact and full Codex catalogs" -m "Co-authored-by: Codex <noreply@openai.com>"`。提交前确认 staged 不含 bun.lock。

### Task 2: 不可变本地目录、配置所有权和恢复

**Files:**
- Create: `packages/cli/src/agent/codex/managed-config/catalog-storage.ts`, `catalog-config.ts`, `config-operation.ts`, `catalog-config.test.ts`
- Modify: 同目录 `managed-config.ts`, `managed-config.test.ts`, `marker.ts`, `index.ts`
- Modify: `packages/cli/src/agent/codex/config-document/provider-edits.ts`, `config-document.test.ts`
- Modify: `packages/cli/src/agent/codex/contracts.ts`

**Interfaces:**
- Consumes: Task 1 `CodexCatalog`；现有 `CodexLocation`、`CodexLease`、durableWrite/readRegularFile、配置 journal 和安装锁。
- Produces: 设计中 `PreparedCodexCatalog`、`CodexCatalogUpdateResult`、`prepareCodexCatalog`、`updateManagedCodexCatalog`、`pruneCodexCatalogs`，仅从 managed-config 的同域入口导出。
- Produces: configure/validate 输入的可选 `catalogPath: string`；`codexProviderEdits(providerId, baseUrl, auth, catalogPath?: string)`。不传参数时原测试仍成立。

- [x] **Step 1: 写文件/恢复/所有权失败测试。** 使用 mkdtemp 和现有 fixture，不访问真实 CODEX_HOME；新增测试：
  - `identical catalog does not rewrite file or config`：第二次 unchanged，原文件 inode/mtime 与 TOML/marker 内容相同。
  - `changed catalog commits a complete new path`：摘要路径改变、旧文件保留，JSON 仍含全部模型/完整有效提示词；model_messages 的附加字段变化也更新摘要。
  - `missing active digest file is repaired`：相同目录修复缺失文件，TOML 不重写。
  - `interrupted catalog switch recovers via config journal`：分别在新文件已写/TOML 未写、TOML 已写/marker 未写处注入失败；恢复后读取 config 指向的文件可以解析且与有效旧/新目录相等。
  - `user catalog is restored on remove`：原 `model_catalog_json = "/user/catalog.json"` 经显式接入后解除，恢复该值；外部文件未改。
  - `partial remove preserves a user-reselected digest catalog`：托管切换 A→B 后用户把 model_catalog_json 改回 A，remove 返回 partial；清理后实际配置仍指 A，A 文件可解析，不能因摘要匹配而删除。
  - `catalog pruning preserves a digest-valued before across updates`：显式接入前原目录为托管目录内 A；接入 B、再更新 C、D 后 A 始终存在；解除接入恢复 A 且文件可读。keep 只传当前/上一份时，prune 也必须自行发现并保护 before。
  - `uncertain references prevent pruning`：配置/marker 不能安全读取、引用不能明确解析或 pending journal 存在时不删除任何候选文件。
  - `legacy marker migrates only without authored catalog`：format 1/2 都能读，后台遇到用户原目录返回 skipped；无原目录能迁移。
  - `catalog drift and symlinks are preserved`：托管字段改动、摘要内容不匹配、父目录/文件 symlink 均不覆盖；prune 只删除可证明摘要一致的托管文件，pending journal 时不清理。
  - `concurrent update and remove share the installation lock`：解除后不得恢复 marker/目录配置；validateOnly 不创建目录文件。

- [x] **Step 2: 跑 RED。**
Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts --timeout 20000 src/agent/codex/managed-config src/agent/codex/config-document`。
Expected: 新接口/事务测试 FAIL，旧 marker 行为仍可观察。

- [x] **Step 3: 实现目录文件及字段事务。** 先把已有 recoverPending/completeOperation 提取到私有 config-operation.ts，让 450 行 managed-config.ts 降至 400 行以内；共享事务，不新增 journal 格式。prepare 用 `new Bun.CryptoHasher('sha256')` 对确切 `JSON.stringify(catalog) + '\n'` 求摘要，在安装 lease/fence 下 durableWrite；路径只允许当前 managedRoot 下的摘要文件。update 在锁内先安全恢复已有 journal，再重新检查 marker/配置/endpoint/摘要，构造只更新顶层目录字段的 TOML/marker，复用已有 configure journal；首次 configure 记录 prior 字段值。marker 的新目录所有权可选，不能改变旧格式必需字段集合。prune 在锁内重新读取实际 TOML 与 marker，把实际引用、before 原值和调用者 keep 合并；pending journal 或读取/引用不确定时整体跳过清理。remove 无论 removed/partial，提交后重新读取 TOML 并合并解除前捕获的原值，再清理已证实无保护引用且摘要匹配的文件；当前/上一份是最低保留集合，不是硬性只留两份。

- [x] **Step 4: 跑 GREEN。** 重跑 Step 2，所有恢复/锁/用户值测试 PASS；检查新增非测试文件 <=500 行。

- [x] **Step 5: 提交。** 仅 stage Task 2 文件；提交 `feat(cli): manage complete local Codex catalogs`，加规定 Co-authored-by footer。

### Task 3: 两种认证模式接入前获取完整目录

**Files:**
- Create: `packages/cli/src/agent/codex/model-catalog/index.ts`, `fetch-catalog.ts`, `fetch-catalog.test.ts`
- Modify: `packages/cli/src/agent/codex/setup/setup.ts`, `setup.test.ts`, `contracts.ts`
- Modify: `packages/cli/src/agent/codex/runtime/runtime.ts`, `packages/cli/src/agent/codex/dashboard-setup/dashboard-setup.test.ts`

**Interfaces:**
- Consumes: Tasks 1/2 类型及文件/config 操作；现有 `commitCodexSetup` 安装 lease 与 command 授权、`readCredential(...).accessToken`。
- Produces: `CodexCatalogFetchInput` 和 `fetchCodexCatalog(input, fetchImpl?)`（见设计）；从 model-catalog 入口导出。
- Produces: `CodexSetupContext.fetchCatalog?: (input: CodexCatalogFetchInput) => Promise<CodexCatalog>`，default 为 fetchCodexCatalog；所有现有 setup 测试注入本地 mock。

- [x] **Step 1: 写首次接入失败测试。** 新增 `keep-chatgpt writes catalog before committing its path` 与 `command fetches catalog after authorization`，记录 mock 调用顺序，验证 compact/full URL、实际选定 token、文件存在先于 config path、生成文件不含 token。参数化 `catalog fetch or write failure leaves configuration unchanged` 覆盖 HTTP 401/503、非 JSON、缺 models、缺必需模型字段、只读文件系统；command 保持可恢复授权 journal。另建已 active 的 command 安装，新增 `catalog preparation failure does not retire previous command auth`：分别在 fetch、durableWrite、重新读取/摘要验证处注入失败，retire/revoke 调用次数均为 0，原 credential/身份仍 active，TOML 与原 auth journal 状态不变；成功顺序断言 fetch→持久化→文件验证→validateCodexConfig→退休/revoke→commit。合法空模型数组接受，不保留已经移除的旧模型。超 1 MiB 的合法 full 目录成功写入，不套用 HTTP 客户端目录上限。Dashboard 用同一 commitSetup 的结果进行断言，不新增 UI。

- [x] **Step 2: 跑 RED。**
Run: `cd packages/cli && bun test --preload=./__tests__/setup.ts --timeout 20000 src/agent/codex/model-catalog src/agent/codex/setup src/agent/codex/dashboard-setup`。
Expected: 新 fetch/首次目录时序测试 FAIL，不触发真实授权。

- [x] **Step 3: 实现 fetch 与首次接入。** 按现有 endpoint/base URL 规则构造带 CLI package version 的 full 请求，Bearer 仅放 header，使用 context.signal；每行通过现有 `CodexUpstreamModelSchema` 与必需 base/template 类型检查，保留未知消息字段，任一非法行使首次获取失败。keep-chatgpt 切换必须先完成 full 获取、prepare 持久化、重新读取/摘要验证及含 catalogPath 的 validateCodexConfig，然后才能写 retiring 阶段 auth journal、退休/revoke 旧 command 安装，最后 commit；准备阶段失败不能推进退休流程。command 授权成功后获取/准备/验证目录，再提交配置。所有操作复用同一 setup lease；validateOnly 不准备文件。只有有效 full 文件准备成功才提交路径，恢复 complete 操作保持同样前置要求；既有已退休状态按原恢复规则处理，不宣称可以恢复已撤销的授权。

- [x] **Step 4: 跑 GREEN。** 重跑 Step 2，认证/错误/恢复/大文件测试 PASS；检查目录文件、目录同步日志及新增目录元数据无 token。现有 keep-chatgpt 的 experimental_bearer_token/marker/config journal 按原规则持久化，不能以“所有 journal 无 token”为验收，也不得添加额外凭据备份。

- [x] **Step 5: 提交。** 仅 stage Task 3 文件；提交 `feat(cli): prepare full catalog during Codex setup`，加规定 footer。

### Task 4: 后台同步器与四个触发入口

**Files:**
- Create: `packages/cli/src/agent/codex/model-catalog/model-catalog.ts`, `model-catalog.test.ts`
- Modify: 同目录 `index.ts`
- Modify: `packages/cli/src/run/run.ts`, `packages/cli/src/agent/host-port/gate.test.ts`
- Modify: `packages/server/src/server-state/types.ts`, `lifecycle.ts`, `lifecycle.test.ts`
- Modify: `packages/server/src/server/server.ts`, `create-routes.ts`, `models-routing.ts`, `server.models.test.ts`, `server-lifecycle.test.ts`
- Modify: `packages/server/src/server-log.ts`

**Interfaces:**
- Consumes: Task 1 source/factory types，Task 2 update 操作及 `inspectCodexConfig`/`readManagedCodexMarker`、现有 `recoverCodexConfigOperation(location, undefined, lease)` 与安装锁；本机位置复用 configuredLocation。
- Produces: `LocalCodexCatalogSyncOptions`、`createLocalCodexCatalogSync(options): CodexCatalogSyncFactory`，见设计，默认 clock 为六小时可清理 interval。
- Produces: `CreateServerOptions.localCodexCatalog?: CodexCatalogSyncFactory`；`ServerStateOptions.onProviderSnapshotChanged?: () => void`；`createRoutes` 最后新增可选 `onCodexCatalogRequest?: () => void`；`listModelsHandler(state, onCodexCatalogRequest?)`。
- Produces: typed `CodexCatalogSyncFailedLog`，事件 `codex.catalog_sync_failed`，只包含 errorType 和可选系统错误 code，加入现有 ServerLog union，不输出原错误正文/文件内容/token。

- [x] **Step 1: 写触发与失败隔离测试。** 模型同步测试注入 source、clock 和临时目录：
  - `all sync reasons load full and update the managed catalog`：四种 reason 触发，6 小时 clock 回调触发 periodic，收到模型变化后本地内容正确。
  - `notifications during a flight run once more with the latest catalog`：可控 promise 下连发 10 次通知，最大并发 1，第一次释放后恰好再跑一次，最终文件含最新模型。
  - `no managed target or mismatched endpoint performs no load`：load 调用 0 次，无文件生成；未注入 factory 的 server 也无文件 I/O。
  - `startup recovers a catalog switch before eligibility checks`：真实 config journal 注入 TOML 已写/marker 未写故障，经过同步器 schedule('startup') 恢复；不能直接调用 recovery 代替该测试。断言 marker/TOML 一致且新路径可读，source.load 不被 modified 预检查挡住。
  - `startup recovers an interrupted legacy catalog migration`：format 1/2 旧 marker 首次加入目录字段后同样故障，startup 恢复后有目录所有权，不误判为用户自写目录；恢复后 endpoint 不匹配仍不调用 load。
  - `live or unknown journal blocks sync without overwrite`：不可安全恢复时 source.load 为 0，配置/marker/候选目录不被改写，安全错误被记录；managedRoot 不存在时不创建目录或安装锁文件。
  - `background failure preserves old catalog and retries on next notification`：load/锁/write 错误记录安全日志，下一次通知可成功；不能通过失败后无限立即重试形成循环。
  - `close cancels the timer and pending load`：clock.clear 一次、source 的 signal aborted、close 后通知不调用 load；已提交目录保持可解析。
server tests：成功 startup/snapshot/request 发对应通知；回调抛错不改变快照提交和 HTTP 200；重建失败不通知；mock 不 resolve 的文件更新下 GET 仍返回 200；未鉴权、普通列表、其他 Agent、Grok 不发 request 通知；HTTP AbortController 取消不 abort 同步器 source。gate tests 固定现有 Docker/远端 endpoint 条件下 factory 不注入。

- [x] **Step 2: 跑 RED。**
Run CLI: `cd packages/cli && bun test --preload=./__tests__/setup.ts --timeout 20000 src/agent/codex/model-catalog src/agent/host-port`。
Run server: `cd packages/server && bun test --preload=./__tests__/setup.ts src/server-state/lifecycle.test.ts src/server/server.models.test.ts src/server/server-lifecycle.test.ts`。
Expected: 新调度/注入测试 FAIL。

- [x] **Step 3: 实现调度及接线。** factory 创建一个 AbortController；单次任务+dirty 标记。先只读检查 managedRoot 存在；不存在立即跳过。存在时用服务 signal 获取安装锁，调用 recoverCodexConfigOperation(location, undefined, lease)，随后重新读取配置/marker 判定 managed、endpoint 和目录所有权；不能用恢复前的 modified/旧 marker 结果提前跳过。有资格才释放锁并 source.load，Task 2 update 在再次获取锁后恢复/复查，防止加载期间解除接入/用户修改被覆盖。live/未知恢复状态只记录安全失败，等下个通知再尝试；每次失败只记录一次，不立即无限重跑。六小时 interval 必须 unref 并可清理，clock 用 fake 实现测试。commitConfig 在 manager.swap 后成功通知且隔离异常，不等待文件更新。createServer state 就绪后创建同步器，source.load 固定 full；startup 调度一次，close/catch 清理同步器。HTTP 只在鉴权后的 Codex 分支调用 schedule，回调异常隔离。run.ts 复用 localAgentHost 的安全 gate 与 endpoint 得到 configuredLocation/factory，仅允许时注入，后台不经 HTTP 获取以免递归触发。任何异步错误都被消费。

- [x] **Step 4: 跑 GREEN。** 重跑 Step 2；确认并发上限、最终最新目录、所有 timer 已清理、接口无等待、无未处理 rejection。

- [x] **Step 5: 提交。** 仅 stage Task 4 文件；提交 `feat(codex): synchronize local model catalogs across lifecycle events`，加规定 footer。

### Task 5: 实际客户端验收、文档与发布说明

**Files:**
- Create: `packages/cli/src/agent/codex/model-catalog/model-catalog.smoke.ts`（显式执行的隔离 app-server 验收，不纳入默认 unit tests）
- Modify: `website/docs/zh/guide/integrations/agents/codex.md`, `website/docs/en/guide/integrations/agents/codex.md`
- Modify: `.changeset/lazy-breads-start.md`

**Interfaces:**
- Consumes: 前四任务所有完成接口；本机 Codex binary 由显式 `--codex-bin <absolute path>` 提供，不硬编码安装路径。
- Produces: 本地与 HTTP 两种加载的可复跑验收、两种语言接入说明、单份准确的未发布 changeset。

- [x] **Step 1: 写并运行客户端验收使其暴露集成失败。** smoke 使用 mkdtemp 独立 CODEX_HOME/AIO_PROXY_HOME/workspace、动态端口 HTTP server，不读取真实凭据；接受参数 `--codex-bin` 和 `--count 50|100`。通过公开 `createServer` 建立代理，预填 Task 1 官方 fixture 及模型元数据缓存，配置六条官方路由和 count-6 条文本合成路由；server 的 fetch 包装器只在生成 POST 时拦截并记录请求、返回 mock 响应，目录 GET 仍由真实路由处理。利用公开 commitCodexSetup 流程获取 full 文件，读取 config 所指向的目录作为预期；app-server 初始化、model/list、thread/start、turn/start，只允许 localhost mock 请求。计数器在接入完成后清零，断言本地模型数量等于 count、full 模板在 POST instructions 中逐字相等、目录 GET 计数 0；100 条本地文件可以超过 1,048,576 字节。独立的 50 条远端 case 无 model_catalog_json，先通过真实接口取 compact 作为预期，再清零计数，断言 Codex compact 加载、GET 出现且 POST instructions 为 compact；保留官方提示词的请求也验证一条。必须捕获并清理进程/监听/临时目录，失败输出 RPC 步骤和诊断状态，不能输出敏感完整 payload。

- [x] **Step 2: 修复集成问题并跑 GREEN。** 抓包用例在独立测试缓存的官方行副本中设置 `use_responses_lite=false`、`prefer_websockets=false`，确保普通 Responses POST 包含 instructions；保持产品与原 fixture 字段不变，不将 Lite 请求缺顶层 instructions 判为提示词丢失。
Run: `bun packages/cli/src/agent/codex/model-catalog/model-catalog.smoke.ts --codex-bin <已核实的绝对路径> --count 50`，再 `--count 100`。
Expected: 模型数正确、full/compact instructions 相等、local 无目录 GET；100 条只要求本地 case，禁止给 HTTP 100 条套用任意容量保证。记录客户端 `--version`，不是凭文件名判断版本。

- [x] **Step 3: 更新用户文档与 changeset。** 中英说明默认本地完整目录、接口精简、四个刷新入口、六小时检查、重启生效、远端/Docker 限制、解除接入恢复用户原目录。重写现有 changeset 一段 <=5 行，target `aio-proxy`、`@aio-proxy/cli`、`@aio-proxy/server` 同为 minor，不叙述中间修复。新授权/文件失败不增加未经验证的兼容承诺。

- [x] **Step 4: 最终检查。**
Run: `bun run build`，然后 `bun run preflight`；Expected: build 成功，lint:types、oxfmt、全部 unit tests 通过。`git diff --check` 无输出；审阅 stage 不含用户 bun.lock；根据设计八场景审阅 compact 保留的权限/任务指导，报告它是行为变更而非已证明等价。不要用静态字面量测试代替客户端验收。

- [x] **Step 5: 提交与交付。** 仅 stage smoke、两份文档和 changeset；提交 `feat(codex): document and verify dual model catalogs`，加规定 footer。给出验证结果、重启限制和未部署状态；不创建/推送 PR，除非用户另有授权。

## 计划自审结果

两种投影及容量由 Task 1 覆盖；本地持久化、恢复、个人值及旧 marker 由 Task 2 覆盖；认证及时序由 Task 3 覆盖；所有通知、周期、错误/停机由 Task 4 覆盖；实际客户端协议、文档和发布由 Task 5 覆盖。五条 Review Focus 都有指定 regression。跨任务接口采用设计中的同一签名，无额外未定义的 helper 或未决定的实现占位。精简模板的语义不由 unit tests 证明，验收明确保留这一限制。

Astra 首轮提出的三项问题已对应到具体要求与测试：清理保护实际引用/before 并覆盖 partial remove 和连续更新；startup 先恢复 journal 再判断资格，覆盖真实同步入口及旧 marker 迁移；凭据限制只约束新增目录/日志/元数据，保留既有认证事务。同时明确 keep-chatgpt 的文件准备及验证先于退休旧授权，并增加三种准备失败注入。

Astra 第二轮完整复审确认上述问题及授权顺序疑点均已闭合，未发现新的阻塞问题。该结论仅针对设计与计划；功能尚未实施，产品测试尚未运行，不能将文档修订视为产品修复已验证。

## 执行记录

用户选择 subagent-driven-development 后，五个任务已顺序实现并逐一独立审查。Task 2 的幂等性问题经修复及限定范围复审闭合。最后一次 build 为 20/20、preflight 为 58/58，CLI 1,198/1,198、server 2,415/2,415 通过，另有既有跳过与非阻断警告。

Codex 0.159.2 实际验收：50 条本地 full 为 1,199,550 字节、100 条本地 full 为 2,219,100 字节，两者目录 GET 均为 0；50 条远端 compact 为 645,677 字节。三场均检查模型集合，并验证合成与官方两条普通 Responses POST 的 instructions 逐字一致。测试只在独立缓存副本关闭 Lite/WebSocket；不宣称其他传输或所有模型行为等价。blockedNetwork=0 只涵盖 Bun fetch guard 的观测范围，不是对子进程全部流量的审计。

实施时的最小职责补充：

- Task 3 新增同域私有 setup/catalog-preparation.ts，复用目录准备与验证，避免原 442 行 setup 继续累积职责；若划分不合适，代价是小模块重新合并。
- Task 4 增加 managed-config 同域资格检查操作，复用更新器的所有权与摘要规则；若不合适，代价是移除或内联这一内部接口。
- Task 4 增加安全日志事件的 bridge 映射，补全既有事件表；若不合适，代价是撤销一项映射。
- Task 4 同域导出 run.ts 的组合入口并加入窄 gate 测试依赖，不向更高层导出，验证拒绝分支不注入本地能力；若不合适，代价是移除这一内部测试入口。

用户原有 bun.lock 保留且未提交。没有推送、部署或修改用户实际 Codex 配置。整分支最终审查已由 Astra 完成，未发现新增 Critical、Important 或 Minor 问题；完整记录见 `docs/superpowers/reviews/2026-10-01-codex-dual-catalog-review.md`。本地目录更新仍需重启客户端。
