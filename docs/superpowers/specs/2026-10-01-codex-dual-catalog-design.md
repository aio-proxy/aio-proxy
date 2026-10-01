# Codex 双份模型目录设计

本设计将本次对话的方案整理为实施计划的依据。用户提出同时写本地目录、保留接口目录，并让接口中的非官方模型使用精简模板。用户已审阅并授权实施“默认使用本地完整目录”及以下同步机制；实施与验证记录见对应计划。

## 问题与已验证事实

- 当前代理的 37 条模型目录为 1,604,006 字节，内置 Codex 0.159.2 的 HTTP 模型目录上限为 1,048,576 字节。
- 当前工作区已完成提示词副本去重，37 条降至 930,407 字节；保持相同构成扩展到 50 条仍超限。
- 当前默认模板为 17,775 UTF-8 字节；官方 gpt-6.1-sol / gpt-6-astra 的基础模板分别为 21,779 / 21,428 字节，两者附加功能消息相同。删除官方功能消息不属于本方案。
- 在隔离 CODEX_HOME 中，0.159.2 使用 model_catalog_json 加载了 100 条约 4 MB 的完整目录，生成请求携带完整模板；同次启动、列模型和启动会话没有模型目录 GET 请求。
- 本地目录只在 Codex 启动时加载，文件更新后需要重启 CLI 或 Desktop。本方案不实现热加载，也不自动重启客户端。

官方说明：https://developers.openai.com/codex/enterprise/roll-out-a-gateway 。实现验证基准为 0.159.2，不据此宣称其他版本全部兼容，也不新增未经验证的最低版本门槛。

## 两种投影

由现有 codexClientModels 共用模型解析、官方行匹配、排序、能力与窗口计算，只在合成提示词选择处分支。

| 投影 | 官方行及其别名 | 非官方合成行 |
| --- | --- | --- |
| compact：HTTP 默认 | 完整有效官方提示词、全部附加消息 | 自有精简模板 |
| full：本地文件/显式导出 | 完整有效官方提示词、全部附加消息 | 当前完整 default-instructions.md |

“官方”以真实上游 modelId 是否匹配 Codex 官方目录行判断，不能根据公开 slug 是否以 gpt 开头判断。两种投影的模型数量、顺序、slug、上下文窗口和其他能力完全一致。保留当前去重：有非空模板时 base_instructions 为必需的空字符串；修复空模板后再去重，没有模板时保留有效 base。full 表示完整有效提示词，不要求重新加入冗余副本。

GET /v1/models?client_version=<任意值> 默认 compact。新增 codex_instructions=full 显式获取 full；显式 compact 也接受，其他值在 Codex 分支返回 400 invalid_request。普通模型列表及 agent/schema 协商保持原有行为；Grok 凭据仍返回普通目录；非 Codex Agent 凭据不得借新参数绕过协议限制。full 导出复用现有鉴权，不允许查询参数指定文件路径。

精简模板另存 compact-instructions.md，原文件保留。原始精简模板预算不超过 6,144 UTF-8 字节，作为待行为验证的产品变更，不宣称无损。保留：用户目标及范围、已有授权延续、禁止未经授权外部消息、保护用户改动和破坏性操作边界、shell 引用与敏感信息、工具契约、验证后报告结果、技能读取及用户优先、进度/最终回复、上下文压缩后目标延续。合并人格、写作、重复沟通和技能解释。不要硬编码仅某个 Codex 版本存在的交互工具名称。

容量回归使用 50 条模型，6 条为本次采集的官方条目、44 条为合成条目，compact JSON 上限 786,432 字节，为 1 MiB 留出余量。它是明确构成的回归基准，不是任意 50 个官方别名或任意模型数量的保证；100 条及更大目录使用本地路径解决。

## 本地文件及配置所有权

只管理 CLI 进程 resolveCodexLocation 解析出的一个 Codex home，尊重 CODEX_HOME。不扫描其他账户或其他 home，不根据请求 IP、client_version、请求参数猜测本地路径。Docker/远端代理没有客户端文件系统能力，接口可用但不能替远端客户端写文件。

目录保存于 `<location.managedRoot>/model-catalogs/<sha256>.json`。内容为紧凑 JSON `{models:[...]}` 加一个结尾换行；摘要用该文件确切 UTF-8 内容计算。目录权限 0700、文件权限 0600，复用现有拒绝 symlink、普通文件读取及 durableWrite。模型提示词或任意其他字段变化都影响摘要。

采用内容摘要文件名而非覆盖一个固定文件，是为了复用现有 TOML/marker journal：先持久化完整的新文件，再事务切换顶层 model_catalog_json 和 marker。中断时配置要么指向原完整文件，要么可恢复到新完整文件，不会指向半写文件。相同内容不重写文件，也不重写 TOML/marker；目标文件缺失时可按摘要修复。摘要文件已经存在但内容不匹配时视为用户修改/冲突，不覆盖。

marker 的 fields 允许新增顶层 model_catalog_json 所有权；没有该字段的 format 1/2 旧 marker 仍合法。首次显式配置记录用户原值，解除接入恢复原值。后台在安装锁内恢复可安全判定的已有 config journal，再重新检查状态 managed、Provider ID/base_url 指向当前服务；不能在恢复之前因为 inspect 返回 modified 或目录字段暂未归入旧 marker 而跳过。live journal、指纹不匹配或未知恢复状态继续拒绝覆盖。恢复后的旧 marker 没有目录所有权且用户已写 model_catalog_json 时，后台跳过；用户重新执行配置可显式接管。旧 marker 没有目录字段且用户也没写目录时，可以在持有安装锁后迁移。

每次成功提交、清除 journal 后，清理保护集合为：新目录、上一个有效目录、当前 TOML 实际引用的 model_catalog_json，以及 marker 中该字段的 before（将来解除接入需要恢复的原目录）。保护路径即使位于 model-catalogs 内且摘要匹配也不能删除；“只保留两份”不适用于这些额外引用。prune 必须在安装锁内重新读取 TOML/marker 并计算保护集合，不能只信任调用者传入的 keep 提示。存在 pending journal、无法安全读取配置/marker 或不能明确解析引用时，整次清理跳过。

解除接入保留现有漂移字段行为，包括 remove 返回 partial 的情况。配置/marker 事务完成后重新读取实际 TOML，保护用户仍引用的路径，并合并解除前捕获的原值路径，再考虑清理；不能把摘要匹配当作文件已无引用的证据。其余仅删除摘要一致的托管文件，用户修改过的内容、未知文件和外部目录均保留。所有检查、写入、切换及清理在现有 Codex 安装锁和 ownership fence 下串行执行。

## 首次接入

CLI 与 Dashboard 都通过 commitCodexSetup，统一加入 full 目录获取。

keep-chatgpt 用选择的代理 token；command 用授权完成后的 ready accessToken。从已绑定 endpoint 获取 full，不加入共享缓存；目录文件、目录同步日志及新增目录元数据不得包含 token。现有 keep-chatgpt 的 experimental_bearer_token、marker.fields 与配置 journal 的认证持久化及恢复规则保持不变，不要求现有配置 journal 无 token，也不在本任务重构凭据存储。首次没有有效目录且请求/解析/写盘失败时不配置 model_catalog_json，不报告配置成功；保持现有可恢复授权流程。validateOnly 仍不写文件。

keep-chatgpt 从旧 command 安装切换时，顺序必须是：获取 full → 在同一安装 lease 下持久化并重新读取验证摘要文件 → validateCodexConfig（含 catalogPath，无文件写入）→ 写退休阶段授权 journal 并退休/撤销旧授权 → 提交 provider 配置及本地目录路径。获取、文件写入或验证失败时，不调用 retire/revoke，不推进授权 journal，旧授权保持有效。command 模式保持先完成授权，再获取/准备/验证目录、提交配置；失败保留可恢复授权流程。后台无需重新授权，直接通过 server 的目录加载回调读取当前 full 投影。

## 同步触发与分层

server 不访问 Codex home，只提供目录加载回调和生命周期通知；CLI 注入本地同步器。未注入时，server 只提供接口，不创建任何 Codex 文件。CLI 复用 run.ts 的 shouldEnableAgentHost 条件和绑定 endpoint 检查决定是否注入；不额外放宽现有本地文件访问条件。

| 触发 | 动作 |
| --- | --- |
| 首次 CLI/Dashboard 接入 | 同步获取 full、持久化文件、配置路径 |
| server 启动且状态可读取 | schedule('startup') |
| 成功发布 Provider 快照 | schedule('models-changed')；失败重建不触发 |
| 鉴权通过且进入 Codex client_version 分支 | schedule('request')，不等待写盘 |
| 运行时每 6 小时 | schedule('periodic')，使用现有 6 小时 Codex 官方目录缓存 TTL |

同步器单次执行，执行中收到通知只标记再跑一轮；下一轮重新加载最新状态。首先只读检查 managedRoot 是否存在；没有托管目录时跳过，不创建它。存在时获取安装锁，复用 recoverCodexConfigOperation 安全恢复已有 config journal，再重新检查 managed 配置/endpoint/原目录所有权；没有合法目标不加载 full、不写目录。live/未知 journal 失败只记录安全错误，不能按普通未托管状态吞掉。检查后释放锁再加载 full；准备和切换之前重新获取锁，再次恢复/检查资格，避免加载期间的解除接入或用户修改被覆盖。检查未变时无写入，缺失时修复，有变化才准备新文件并事务切换路径。后台任务使用服务生命周期 signal，不使用 HTTP 请求 signal。

文件/网络/锁错误只产生不含敏感值的 codex.catalog_sync_failed 日志，不改变接口的成功响应，也不破坏旧目录。关闭时取消周期检查及未完成加载、停止接收通知；已进入 journal 原子提交的短事务允许完成或由 journal 在下次恢复。

## 边界接口

server 新增 `codex-catalog-sync` 模块，仅 contracts 对包外导出：

```ts
type CodexCatalog = { readonly models: readonly Record<string, unknown>[] };
type CodexInstructionsMode = 'compact' | 'full';
type CodexCatalogSyncReason = 'startup' | 'models-changed' | 'request' | 'periodic';
type CodexCatalogSource = { readonly load: (signal: AbortSignal) => Promise<CodexCatalog> };
type CodexCatalogSync = { readonly schedule: (reason: CodexCatalogSyncReason) => void; readonly close: () => void };
type CodexCatalogSyncFactory = (source: CodexCatalogSource) => CodexCatalogSync;
```

CreateServerOptions 增加可选 localCodexCatalog: CodexCatalogSyncFactory。ServerStateOptions 增加可选 onProviderSnapshotChanged: () => void，在成功快照发布后通知，异常隔离。createServer 在 state 就绪后创建同步器；createRoutes 增加最后一个可选 onCodexCatalogRequest 参数，并传给 listModelsHandler。回调缺失时行为不变。server 的 source.load 固定 full，创建/关闭均与 app 生命周期绑定。

CLI managed-config 对同域公开三个操作，私有 storage/transaction 模块不向包级 barrel 导出：

```ts
type PreparedCodexCatalog = { readonly path: string; readonly digest: string };
type CodexCatalogUpdateResult = 'updated' | 'unchanged' | 'skipped';
prepareCodexCatalog(location: CodexLocation, catalog: CodexCatalog, lease: CodexLease): Promise<PreparedCodexCatalog>;
updateManagedCodexCatalog(input: { location: CodexLocation; baseUrl: string; catalog: CodexCatalog; signal: AbortSignal }, lease?: CodexLease): Promise<CodexCatalogUpdateResult>;
pruneCodexCatalogs(location: CodexLocation, keep: readonly string[], lease: CodexLease): Promise<void>;
```

prune 的 keep 是调用方额外保护提示，函数仍须在锁内读取实际配置、marker.before 并合并保护集合；有恢复不确定性时跳过清理。同步器直接复用既有 recoverCodexConfigOperation(location, undefined, lease)，不新增恢复协议。

configureCodexConfig 输入新增可选 catalogPath: string；validateCodexConfig 同步继承。codexProviderEdits 增加可选第四参数 catalogPath，不传时保留旧接口行为。所有 catalogPath 都必须是当前 managedRoot 下的合法摘要文件且读取、摘要验证成功。

CLI 新增 model-catalog 模块：

```ts
type CodexCatalogFetchInput = { readonly endpoint: string; readonly token: string; readonly signal: AbortSignal };
fetchCodexCatalog(input: CodexCatalogFetchInput, fetchImpl?: typeof fetch): Promise<CodexCatalog>;
type LocalCodexCatalogSyncOptions = {
  readonly location: CodexLocation; readonly endpoint: string;
  readonly onError: (error: unknown) => void;
  readonly clock?: { readonly setInterval: (callback: () => void, ms: number) => { readonly clear: () => void } };
};
createLocalCodexCatalogSync(options: LocalCodexCatalogSyncOptions): CodexCatalogSyncFactory;
```

CodexSetupContext 增加可选 fetchCatalog: (input: CodexCatalogFetchInput) => Promise<CodexCatalog>，缺省调用 fetchCodexCatalog；覆盖现有测试避免真实网络。请求 URL 从 endpoint 构造 `/v1/models?client_version=<CLI package version>&codex_instructions=full`，复用现有 base URL 规则。不添加新依赖。

## 验证与发布

单元/集成测试覆盖两种投影、官方别名、空模板修复、50 条体积、文件原子性与锁、旧 marker、个人目录恢复、首次失败、四种后台通知、周期更新、并发再跑、停机和失败隔离。额外固定：用户改回上一份摘要目录后 partial remove 仍可读取；before 指向摘要目录时连续更新不能删除它；startup 经真实同步器恢复 TOML 已写/marker 未写（包括旧 marker 首次迁移）；获取/写盘/文件验证失败不会退休旧 command 授权。运行内置 Codex 0.159.2 的隔离 app-server 验证 50/100 条 full 加载、无目录 GET、实际请求 instructions 完整；远端模式单独验证 compact。只向本地 mock Responses 服务发请求，不产生外部模型费用。

提示词抓包验收只在独立测试缓存的官方行副本中设 use_responses_lite=false、prefer_websockets=false，使请求经过普通 Responses POST；不改变产品默认字段。Responses Lite 请求没有顶层 instructions 不能被判定为提示词丢失。

精简模板评审按八种场景检查指导覆盖：解释请求、诊断请求、明确修改、追加用户约束、上下文压缩、用户脏工作区、破坏性操作、未经授权外部消息。离线评审与抓包不能证明所有模型行为等价；不把字节预算或模板字符串测试当作行为等价证据。

实现完成需 bun run preflight；未构建树先 bun run build 供 lint:types 解析 dist。更新现有未发布 changeset，不追加描述中间修复历史；产品及 CLI/server 同级 minor，说明本地完整目录、接口精简、更新后需重启。保留用户已有 bun.lock 改动。设计阶段只保存设计和计划；后续按用户授权完成产品实施并本地提交，没有部署或修改用户实际 Codex 配置。
