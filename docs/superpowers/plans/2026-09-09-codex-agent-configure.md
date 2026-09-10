# Codex Agent Configure Authentication Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 Codex 向导中加入“是否保留 ChatGPT 登录相关功能”的选择，分别配置已有代理 Key 或 Agent command 鉴权，并继续提供历史迁移与准确的 list/remove 行为。

**Architecture:** 保留 `ec170fce` 已完成的 Codex 全局 TOML 编辑、归属 journal 和受限 legacy 迁移。command 分支复用现有 Agent 设备授权/refresh family，增加 Codex 身份、原生目录访问、私有凭据和静默 helper；静态分支删去创建 Key 的行为。两种模式共享同一配置归属与安装生命周期，插件资产和升级仍只处理 OpenCode/Pi/OMP。

**Tech Stack:** Bun >=1.4.2、TypeScript、`bun:test`、`bun:sqlite`、`@inquirer/prompts`、Zod、现有 `es-toolkit`、已安装的 `toml-eslint-parser@1.0.3`，以及 workspace 包 `@aio-proxy/agent-provider-runtime`。不新增外部依赖。

**Spec:** [Codex Agent Configure 向导设计](../specs/2026-09-09-codex-agent-configure-design.md)。执行前同时读取 spec；本计划替代旧版七个任务，不重新实施已完成的模块。

**Status:** Tasks 1–7 implementation work is complete. The SDD ledger and `task-1-report.md` through `task-7-report.md` record the per-task evidence; available unit, build, and host-contract checks are complete, while the recorded preflight/baseline failures and live AIO Proxy, Computer Use, plugin, and native/paginated migration limits remain open. Task checkboxes below preserve their original acceptance requirements and are not marked for unavailable evidence.

## Global Constraints

- 用户已确认继续实施；以下任务适用于当前独立 worktree。实施前后仍须保留 spec/plan 与代码的一致性。
- 后续执行方式已选 `superpowers:subagent-driven-development`；实施始终使用 `gpt-5.6-luna`，不再询问执行方式。
- 首次 Provider ID 默认 `aio-proxy`，用户可以自定义；重复配置沿用受管 ID。
- 产品显示名统一为 `AIO Proxy`。命令、包名、目录、协议标识和默认 Provider ID 仍保留 `aio-proxy`。
- 不写、删除或恢复顶层 `model`，不新增模型选择步骤。
- 首次默认 `keep-chatgpt`，重复配置沿用已保存模式；旧 format 1 marker 解释为 `keep-chatgpt`。
- `keep-chatgpt` 写 `requires_openai_auth = true` 和 `experimental_bearer_token`；有 Key 只选已有 Key，无 Key 跳过选择并使用非秘密 `aio-proxy-local`。
- `command` 省略 `requires_openai_auth`，不写 `experimental_bearer_token`、`env_key`；写原生 `auth.command/args/timeout_ms/refresh_interval_ms`。
- command target 为 `codex`，client ID 为 `aio-proxy-codex`；helper 为 `aiop agent auth codex --installation-id <uuid>`。
- command `timeout_ms = 5000`、`refresh_interval_ms = 300000`；helper 从 CLI 入口计时的总预算为 4500 毫秒。
- 两种模式都不创建代理 API Key，不改 `server.apiKeys`，不代用户开启代理认证。
- 使用全局 `CODEX_HOME`/`~/.codex/config.toml`，固定 Responses 与本机 loopback `/v1`，不管理项目配置。
- 提示阶段取消零写入；先收集全部选择，再进行设备授权或持久化。已有未完成操作单独显式恢复。
- 初次 command 授权在 configure 完成，helper 不打开浏览器、不读 stdin、不发起 device flow。
- helper 成功 stdout 仅有原始 AT 和换行；其他输出不能含 Key/AT/RT，RT 永不输出。
- 新建私有目录 `0700`、凭据文件 `0600`；不改真实 Codex auth.json、Keychain 或用户历史来做实验。
- 沿用 Agent AT 15 分钟、30 秒重放窗口与现有 family 撤销语义；不新建鉴权协议或推理循环。
- 迁移仅保留现有经验证的 legacy 范围；native/paginated 继续阻止写入。remove 不自动反向迁移。
- 新实现文件少于 500 行，达到 400 行评估职责拆分；测试放同名目录，`index.ts` 仅导出，不跨模块导入私有协作者。
- 所有 shell 命令以 `rtk` 开头。提交信息附带 `Co-authored-by: Codex <noreply@openai.com>`。
- 不实施 Codex 安装、升级或自动启动。兼容实验只启动隔离的测试进程；不依赖 Grok 工作区尚未实现的代码。

## 基线、执行顺序与交付边界

基线已完成：`config-document/`、`managed-config/`、`credentials/`、`wizard/`、`sessions/`、CLI 分发、五种语言、README 和 `.changeset/codex-static-config.md`。本轮按下面的增量任务执行；旧 SDD 账本中“任务完成”不代表这些新任务已经完成。

顺序：`1 → 2 → 3 → 4 → 5 → 6 → 7`。任务 1 锁定 command 宿主行为；任务 2 是独立的服务端身份/目录契约；任务 3 是配置数据契约；任务 4 是凭据与跨进程执行；任务 5 是可恢复生命周期；任务 6 将这些能力接入产品；任务 7 做完整验收与发布说明。每项都有独立可拒绝/接受的验收边界。

实施沿用当前隔离 worktree；先读实际 git 状态，避免覆盖用户改动。任务提交只暂存列出的相关文件，不使用 `git add -A`。

旧验证记录仅作为基线：`bun run check` 曾通过；旧 preflight 有 dashboard `use-oauth-editor-session.ts` 的 TS2322/TS2589，CLI 559 通过、13 个 macOS upgrade/path 失败。后续应运行当时的真实检查并比较结果，不能用旧结论跳过新增鉴权的验证，也不为本次文档修改运行全仓测试。

## 文件与职责

下表路径相对仓库根；Codex 模块根记为 `C = packages/cli/src/agent/codex/`，runtime 根为 `R = packages/agent-provider/runtime/src/`。

| 文件                                                              | 增量职责                                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/cli/scripts/verify-codex-command-auth.ts`               | 新增隔离原生 command 契约实验；现有迁移实验不重写                                |
| `packages/types/src/agent-integration/`                           | 总授权 target 增加 Codex，插件 target 显式分离                                   |
| `packages/core/src/agent-identity/identity-repository.ts`         | 从持久存储恢复 Codex target                                                      |
| `packages/server/src/server/server.ts` 与 `server.models.test.ts` | 已认证 Codex 普通/Codex 目录分流                                                 |
| `C/contracts.ts`、`C/config-document/`、`C/managed-config/`       | 鉴权 union、数组/整数叶子、format 2 marker 与模式切换的归属                      |
| `packages/core/src/file-lock/lease/`                              | 从已有 config lock 提取可复用进程 lease，保留 fencing 与恢复语义                 |
| `C/storage/`                                                      | 从既有 managed-config 私有 storage 移动持久写入能力，并提供 Codex 安装锁公共边界 |
| `C/command-auth/`                                                 | 身份/凭据状态、设备授权、静默刷新与原始 stdout 交付                              |
| `C/command-location/`                                             | 查找稳定发布入口，生成 Codex 命令参数，不依赖开发态启动器                        |
| `C/setup/`                                                        | 静态/command 配置、切换和授权操作 journal                                        |
| `C/lifecycle/`                                                    | list/check/remove 的本地归属与服务端撤销协调                                     |
| `C/credentials/`                                                  | 只读 Key 选择，删除生成/写代理配置/reload                                        |
| `C/wizard/`、`C/codex.ts`                                         | 两种提示分支、取消、配置后迁移与独立 restore 分发                                |
| `packages/cli/src/agent/output/`、`main.ts`、`update-notify/`     | CLI helper 分发、无噪声 stdout、结果与帮助                                       |
| `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`          | 鉴权选择、设备授权、恢复/撤销和准确品牌文案                                      |
| `npm/aio-proxy/README.md`、现有 changeset                         | 面向用户解释最终行为，不保留“创建 Key”的旧说明                                   |

任务 4 新模块采用 `index.ts`（仅导出）、同名主实现、同名测试。私有 `credential-store.ts`、`refresh.ts` 留在 `command-auth/`，只经其公开入口协作。任务 5 的 `setup/journal.ts` 同样不从包级 barrel 导出。

## Task 1：补充原生 command 兼容证据

**Files:** Create `packages/cli/scripts/verify-codex-command-auth.ts`；Modify `docs/superpowers/specs/2026-09-09-codex-contract-verification.md`。参考现有 `packages/cli/scripts/verify-codex-contract.ts` 的隔离进程与 JSON-RPC 操作，既有历史夹具不改。

**Interfaces:** 新脚本导出下面的实验接口，报告仅包含布尔结论、版本、平台与脱敏错误。仅执行显式传入的 Codex 可执行文件。

```ts
export type CommandAuthProbe = {
  readonly version: string;
  readonly platform: string;
  readonly rawTokenAccepted: boolean;
  readonly incompatibleConfigRejected: boolean;
  readonly refreshAfter401: boolean;
  readonly refreshInvocationObserved: boolean;
  readonly staticAccountType: 'chatgpt' | null;
  readonly commandAccountType: 'chatgpt' | null;
  readonly authFilesUnchanged: boolean;
};
export declare function verifyCodexCommandAuth(executable: string): Promise<CommandAuthProbe>;
```

- [ ] **Step 1：建立合成实验输入。** 用临时 HOME/CODEX_HOME、假 JWT、本地服务和临时 helper，不访问真实凭据。helper 使用独立参数数组，覆盖空格路径。只记录 token 是否与预期相等，不记录 header。

```ts
const authTable = (command: string, args: readonly string[]) => `
[model_providers.proxy.auth]
command = ${JSON.stringify(command)}
args = ${JSON.stringify(args)}
timeout_ms = 5000
refresh_interval_ms = 300000
`;
const rawHelper = String.raw`process.stdout.write("probe-command-token\n");`;
```

以上 `JSON.stringify` 仅编码合成 TOML 字符串，不用于 shell 拼接。实际命令通过 `Bun.spawn([executable, ...args])` 传递。stdin 为空；分别注入 raw token、JSON、空输出、非零退出、超过 5 秒五种结果。

- [ ] **Step 2：跑真实原生契约。** 普通启动验证 `auth + requires_openai_auth = true` 拒绝加载；分别用静态和 command 配置调用 app-server `account/read`。向本地模型请求第一次返回 401，观察 helper 再次执行及第二次请求的 token；单独用缩短的实验刷新间隔观察 helper 是否再次执行，不能据此宣称新 token 已发送或用于请求，生产配置保持 300000。设置全部实验进程的总期限并清理子进程。

Run: `rtk proxy bun packages/cli/scripts/verify-codex-command-auth.ts /opt/homebrew/bin/codex`

Expected: 对实际版本逐项记录结果；未实现 helper 前，这只是宿主契约实验，不宣称生产功能通过。若 raw token 或 401 路径不符合文档，停止 command 产品接线并记录具体证据，不修改生产认证字段来绕过冲突。

- [ ] **Step 3：将通过条件写入脚本并复跑。** 新增报告小节区分旧静态实验、新原生 command 实验与尚未运行的真实 AIO Proxy 链路。

```ts
import { strict as assert } from 'node:assert';
const result = await verifyCodexCommandAuth(process.argv[2]!);
assert.equal(result.rawTokenAccepted, true);
assert.equal(result.incompatibleConfigRejected, true);
assert.equal(result.refreshAfter401, true);
assert.equal(result.refreshInvocationObserved, true);
assert.equal(result.staticAccountType, 'chatgpt');
assert.equal(result.commandAccountType, null);
assert.equal(result.authFilesUnchanged, true);
```

同时记录 JSON 并非 Codex bearer 输出协议、空值/超时/非零退出的失败方式，不据此宣称 Computer Use 或所有插件兼容。版本基线仍明确为实测 `0.146.0`，不凭空定义最低版本。

- [ ] **Step 4：提交实验与报告。**

```bash
rtk git add packages/cli/scripts/verify-codex-command-auth.ts docs/superpowers/specs/2026-09-09-codex-contract-verification.md
rtk git commit -m "test(cli): verify Codex command authentication contract" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 2：接通 Codex Agent 身份与原生模型目录

**Files:** Modify `packages/types/src/agent-integration/{agent-integration.ts,agent-integration.test.ts,index.ts}`；`packages/core/src/agent-identity/{identity-repository.ts,identity-repository.test.ts,agent-identity.test.ts}`；`packages/server/src/agent-authorization/{routes.test.ts,device-challenges.test.ts}`；`packages/server/src/server/{server.ts,server.models.test.ts}`；`packages/server/src/server/list-models/agent-catalog/agent-catalog.ts`；`packages/cli/src/agent/{agent.ts,agent.test.ts,assets/assets.ts,hosts/hosts.ts,managed-installation/install.ts,managed-installation/test-fixture.ts}`；`packages/cli/src/upgrade/{upgrade.ts,post-upgrade-agents.ts,post-upgrade-agents.test.ts}`。收窄 `R/catalog-client/` 与 `R/managed-state/` 的插件消费者，保留 OAuth 接口接受总 target 集合。

**Interfaces:**

```ts
export const AgentPluginTargetSchema = z.enum(['opencode', 'pi', 'omp']);
export type AgentPluginTarget = z.output<typeof AgentPluginTargetSchema>;
export const AgentTargetSchema = z.enum(['opencode', 'pi', 'omp', 'codex']);
export type AgentTarget = z.output<typeof AgentTargetSchema>;
// AGENT_CLIENT_ID 增加 codex: 'aio-proxy-codex'。
```

device/token/admin/身份 marker 使用总集合；catalog schema/query、插件 host/assets/managed installation/post-upgrade 使用插件集合。`createAgentIdentityService()`、runtime OAuth 函数签名和 token 格式不变。

- [ ] **Step 1：写行为回归并确认失败。** device request 接受 Codex 配对 client ID；拒绝跨 target/client；保存/重开数据库仍能读取 Codex installation。现有 server fixture 签发 Codex AT，测试 `/v1/models` 及 `?client_version=0.146.0` 分别返回普通目录和既有 Codex 目录；无协商 Pi AT 仍为 400，畸形协商仍 400，过期/撤销仍 401。

```ts
expect(
  AgentDeviceCodeRequestSchema.safeParse({
    client_id: 'aio-proxy-codex',
    agent: 'codex',
    installation_id: '11111111-1111-4111-8111-111111111111',
    adapter_version: '0.21.0',
  }).success,
).toBe(true);
expect(
  AgentCatalogQuerySchema.safeParse({
    agent: 'codex',
    adapter_version: '0.21.0',
    schema_version: '1',
  }).success,
).toBe(false);
```

这些 schema 断言与实际 device/目录请求放在同一验收中，不能只测 enum 字面量。

Run: `rtk proxy bun test packages/types/src/agent-integration packages/core/src/agent-identity packages/server/src/agent-authorization packages/server/src/server/server.models.test.ts`

Expected: 新 Codex device、持久恢复或无协商目录用例在基线上失败。

- [ ] **Step 2：最小扩展身份并保留插件边界。** 更新 client ID schema 和 repository `asAgentTarget`；数据库 target 已为 text，不新增表。授权路由复用现有匹配/签发/撤销流程。目录协商处理之后仅收窄通用拒绝条件：

```ts
if (grant !== undefined && grant.target !== 'codex') {
  return context.json(
    {
      error: {
        code: 'invalid_request',
        message: 'Invalid Agent catalog negotiation.',
      },
    },
    400,
  );
}
if (context.req.query('client_version') !== undefined) {
  return context.json(await codexClientModels(state, { signal: context.req.raw.signal }));
}
return context.json(await listModels(state));
```

不移动前置认证与协商校验，不用 query 参数伪装 Codex 身份。更新全部 `AgentTargetSchema.options` 插件循环为 `AgentPluginTargetSchema.options`；总身份数据仍保留 Codex。CLI 的现有 Codex 独立分发保持在插件 parse 之前。

- [ ] **Step 3：验证签发/刷新/撤销和旧目标回归。** 复跑 Step 1，另跑 runtime 的 OAuth/catalog 测试与 CLI agent、post-upgrade 测试；检查插件安装捕获列表不包含 Codex。`bun run lint:types` 用于发现未收窄的穷举分支，不能用 `as AgentPluginTarget` 隐藏问题；`bun run check` 只提供常规 lint 与格式检查。

```bash
rtk proxy bun test packages/agent-provider/runtime/src packages/cli/src/agent packages/cli/src/upgrade/post-upgrade-agents.test.ts
rtk proxy bun run lint:types
rtk proxy bun run check
```

- [ ] **Step 4：仅提交本任务文件。**

Commit subject: `feat(agent): support Codex device credentials and native catalogs`，附规定 co-author footer；不要暂存 Task 1 以外的未完成文件。

## Task 3：让 TOML 与归属记录支持两种认证模式

**Files:** Modify `C/contracts.ts`、`C/config-document/{config-document.ts,ast-edits.ts,config-document.test.ts,index.ts}`、`C/managed-config/{managed-config.ts,marker.ts,journal.ts,managed-config.test.ts}`。既有同名测试继续扩展，不另造重复测试目录。

**Interfaces:**

```ts
export type CodexAuthMode = 'keep-chatgpt' | 'command';
export type CodexAuthConfig =
  | { readonly mode: 'keep-chatgpt'; readonly token: string }
  | { readonly mode: 'command'; readonly installationId: string; readonly command: string };
export type ManagedValue = string | boolean | number | readonly string[];
// ValueSlot / FieldEdit 保留现有 present 判别。
export function codexProviderEdits(providerId: string, baseUrl: string, auth: CodexAuthConfig): readonly FieldEdit[];
export function configureCodexConfig(input: {
  readonly location: CodexLocation;
  readonly providerId: string;
  readonly baseUrl: string;
  readonly auth: CodexAuthConfig;
}): Promise<ConfigCommit>;
```

`CodexMarkerV1` 保留原有 `format: 1`；`CodexMarkerV2` 使用 `format: 2`，保留原有字段并增加 `authMode`，command 分支必须包含 `installationId`，静态分支不含它。解析返回的 `CodexMarker` 为二者 union；`ConfigInspection` 增加可选 `authMode` 和 `installationId`。只读兼容 V1，成功提交时写 V2。

- [ ] **Step 1：补模式切换的行为测试并跑红。** 从含注释、自定义模型、带引号 ID 的静态配置切到 command，实际 `Bun.TOML.parse` 成功，旧 token/true 消失，helper args 保留路径空格；切回后 `auth` 不残留。测试再次运行无 diff、数组结构相等、手改 args/endpoint 导致冲突、remove 保留用户字段、V1 最初恢复值不丢失。

```ts
const edits = codexProviderEdits('custom.proxy', 'http://127.0.0.1:9317/v1', {
  mode: 'command',
  installationId: '11111111-1111-4111-8111-111111111111',
  command: '/tmp/AIO Proxy/bin/aiop',
});
const next = editCodexDocument('model = "keep-model"\n', edits);
expect(Bun.TOML.parse(next)['model']).toBe('keep-model');
const prefix = ['model_providers', 'custom.proxy'];
expect(readManagedField(next, [...prefix, 'name'])).toEqual({ present: true, value: 'AIO Proxy' });
expect(readManagedField(next, [...prefix, 'requires_openai_auth'])).toEqual({ present: false });
expect(readManagedField(next, [...prefix, 'experimental_bearer_token'])).toEqual({ present: false });
expect(readManagedField(next, [...prefix, 'auth', 'args'])).toEqual({
  present: true,
  value: ['agent', 'auth', 'codex', '--installation-id', '11111111-1111-4111-8111-111111111111'],
});
```

`readManagedField` 是既有公开入口，扩展后返回的 slot 支持数组；不要将整份含 token TOML 放快照。

Run: `rtk proxy bun test packages/cli/src/agent/codex/config-document packages/cli/src/agent/codex/managed-config`

- [ ] **Step 2：扩展叶子编辑并更新归属规则。** 对数组和整数使用 AST 编码/解码，不全量序列化文档。`args` 仅支持字符串数组、timeout 仅接受有限整数；slot 比较按数组内容。公共字段 `name` 写 `AIO Proxy`。

```ts
const commandLeaves = (id: string, executable: string) => ({
  command: executable,
  args: ['agent', 'auth', 'codex', '--installation-id', id],
  timeout_ms: 5000,
  refresh_interval_ms: 300000,
});
```

删除另一模式的叶子前校验归属和当前 applied 值。不受管的 `env_key`、headers、其他 auth 方式仍报告冲突；不因为目标是 command 就整体删除用户 `auth` 表。只删除本工具创建且已空的表。更换 Provider ID 保留基线并清理旧受管字段，V1 journal 仍可恢复。

- [ ] **Step 3：复跑并检查调用点。** 更新当前静态调用点临时传 `{ mode: 'keep-chatgpt', token }`，保持产品行为到 Task 6 才接入新选择；不趁此保留创建 Key 作为最终需求。

```bash
rtk proxy bun test packages/cli/src/agent/codex/config-document packages/cli/src/agent/codex/managed-config
rtk proxy bun run check
```

- [ ] **Step 4：提交配置数据契约。** Commit subject: `feat(cli): manage both Codex authentication configurations`，附规定 co-author footer。

## Task 4：实现受安装锁保护的设备凭据与静默 helper

**Files:** Create `packages/core/src/file-lock/lease/{index.ts,lease.ts,abandoned-owner.ts,lease.test.ts}`，从 `packages/core/src/plugins/config-file/{lock.ts,abandoned-owner.ts}` 移动通用进程 lease 实现，原 config lock 保留兼容 wrapper；Modify `packages/core/src/index.ts` 及相关锁测试导入。Move `C/managed-config/storage.ts` → `C/storage/storage.ts`，Create `C/storage/{index.ts,installation-lock.ts,storage.test.ts}`；Modify原 storage 调用的模块导入。Create `C/command-auth/{index.ts,command-auth.ts,credential-store.ts,refresh.ts,command-auth.test.ts}`、`C/command-location/{index.ts,command-location.ts,command-location.test.ts}`；Modify `packages/cli/package.json`、`bun.lock` 增加现有 workspace runtime 依赖。

**Interfaces:** Core 公共 lease 是已有 lock 的提取，不暴露 config-file 私有模块；保留 heartbeat、进程 starttime、恢复 fence 和过期判定。

```ts
export type ProcessFileLock = {
  readonly owner: string;
  readonly withOwnership: <T>(action: (assertOwned: () => Promise<void>) => Promise<T>) => Promise<T>;
  readonly withOwnershipFence: <T>(action: (assertOwned: () => Promise<void>) => Promise<T>) => Promise<T>;
  readonly release: () => Promise<void>;
};
export function acquireProcessFileLock(path: string, signal?: AbortSignal): Promise<ProcessFileLock>;
export function observeProcessFileLock(path: string): Promise<{ readonly owner: string } | undefined>;
export type CodexLease = ProcessFileLock;
export function withCodexInstallation<T>(
  location: CodexLocation,
  signal: AbortSignal,
  operation: (lease: CodexLease) => Promise<T>,
): Promise<T>;
```

`observeProcessFileLock` 只返回已校验存活与进程身份的 owner，未知/死亡不提供复用依据。安装锁用 `<CODEX_HOME>/.aio-proxy.lock`。configure/remove 增加可选第二参数 `lease?: CodexLease`；`recoverCodexConfigOperation(location, confirmRecovery?, lease?)` 保留原确认回调，lease 放第三参数。未传 lease 时自己取得锁，传入时校验 ownership，不递归拿同一锁。

```ts
export type CodexCommandInstallation = {
  readonly format: 1;
  readonly marker: AgentManagedMarker & { readonly agent: 'codex' };
  readonly configPath: string;
  readonly providerId: string;
  readonly status: 'pending' | 'active' | 'retiring';
};
export function resolveCodexAuthCommand(): Promise<string>;
export function readCodexCommandIdentity(location: CodexLocation): Promise<CodexCommandInstallation | undefined>;
export function prepareCodexCommandInstallation(
  input: {
    readonly location: CodexLocation;
    readonly providerId: string;
    readonly endpoint: string;
    readonly adapterVersion: string;
  },
  lease: CodexLease,
): Promise<CodexCommandInstallation>;
export function authorizeCodexInstallation(
  input: {
    readonly location: CodexLocation;
    readonly installation: CodexCommandInstallation;
    readonly signal: AbortSignal;
    readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void>;
  },
  lease: CodexLease,
): Promise<void>;
export function activateCodexCommandInstallation(
  location: CodexLocation,
  installationId: string,
  lease: CodexLease,
): Promise<void>;
export function retireCodexCommandInstallation(
  location: CodexLocation,
  installationId: string,
  lease: CodexLease,
): Promise<void>;
export function clearCodexCommandInstallation(
  input: {
    readonly location: CodexLocation;
    readonly installationId: string;
    readonly revocation: AgentRevokeStatus;
  },
  lease: CodexLease,
): Promise<void>;
export function inspectCodexCommandCredential(input: {
  readonly location: CodexLocation;
  readonly check: boolean;
  readonly signal: AbortSignal;
}): Promise<{
  readonly credentialStatus: 'missing' | 'ready' | 'expired' | 'reauthorize';
  readonly connection: 'ok' | 'offline' | 'unauthorized' | 'invalid_response' | 'not_checked';
}>;
export function writeCodexAuthToken(input: {
  readonly location: CodexLocation;
  readonly installationId: string;
  readonly signal: AbortSignal;
  readonly writeToken: (token: string) => Promise<void>;
}): Promise<void>;
```

`authorizeCodexInstallation` 负责在 configure 内刷新已有凭据或发起批准，并原子保存，不输出 token。activate 必须校验已提交的受管配置与身份一致；retire 先阻止 helper；clear 只接受既有成功/expired/missing 撤销结果。`inspectCodexCommandCredential` 不轮换，check 时只使用有效缓存 AT 请求绑定 endpoint 的只读目录，不返回 secret。`writeCodexAuthToken` 只静默刷新/重叠复用，在锁内调用 `writeToken`，写完再标记 deliveredBy，不返回带 secret 的普通 CLI result。

- [ ] **Step 1：写凭据协议及真实双进程失败用例。** 用本地合成 OAuth server 记录 refresh 次数和调用 client ID，断言 helper 输出前新 RT 已落盘；无凭据 helper 不请求 device endpoint。两进程同时调用只完成必要轮换，验证保存前、保存后未输出、已交付未释放锁三个窗口。复用 lease 原有 fencing/死亡持有者回归，不用只跑同进程 Promise 的测试代替跨进程。

```ts
const delivered: string[] = [];
await writeCodexAuthToken({
  location,
  installationId,
  signal: AbortSignal.timeout(4500),
  writeToken: async (token) => {
    const persisted = JSON.parse(await Bun.file(`${location.managedRoot}/codex-credential.json`).text());
    expect(persisted.accessToken).toBe(token);
    expect(persisted.refreshToken).not.toBe(previousRefreshToken);
    delivered.push(token);
  },
});
expect(delivered).toHaveLength(1);
```

以上变量由测试在临时目录中创建的合成 installation/token fixture 提供；fixture 依次使用 `prepareCodexCommandInstallation`、`authorizeCodexInstallation`、`configureCodexConfig` 和 `activateCodexCommandInstallation` 建立，禁止拷贝用户 credential。再覆盖网络失败保留 RT、确定 invalid_grant 要求重新授权、超时/锁竞争退出、symlink/hardlink 拒绝。

Run: `rtk proxy bun test packages/core/src/file-lock/lease packages/cli/src/agent/codex/command-auth packages/cli/src/agent/codex/command-location`

Expected: 新接口缺失或行为不满足而失败；不以静态常量测试替代轮换行为。

- [ ] **Step 2：提取锁并实现持久状态。** `codex-command.json` 存身份；`codex-credential.json` 存下面的私有状态，并在读取时校验 format、绑定、枚举、时间和 token 形状。

```ts
// command-auth/credential-store.ts 私有类型。
type CredentialState = {
  readonly format: 1;
  readonly installationId: string;
  readonly endpoint: string;
  readonly revision: number;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly status: 'ready' | 'refreshing' | 'reauthorize';
  readonly refreshStartedAt?: number;
  readonly deliveredBy?: string;
};
```

使用现有原子替换/fsync/最后读取校验；增加硬链接检查。`accessExpiresAt` 根据 token 请求开始时间加 `expires_in` 保守计算，不捏造服务端未返回的 RT 到期时间。所有调用网络前与输出前校验 identity/config/模式/endpoint/ownership。OAuth 使用受约束 fetch wrapper：绑定 origin、`redirect: 'error'` 和同一 signal；沿用 runtime 的设备 URL 校验。

- [ ] **Step 3：实现轮换和交付顺序。** 拿锁前只观察有效 owner 与非秘密 revision/deliveredBy，拿锁后重读完整 credential。revision 增加、交付 owner 变化或交付 owner 等于已观察的有效锁 owner，且 AT 至少剩 1 秒时可重叠复用；否则独立调用刷新。网络前原子记录 refreshing，成功后存新 RT/AT/revision 并清除 deliveredBy，输出完成后标记本 owner。

```ts
const response = await refreshAgentCredential(installation.marker, state.refreshToken, {
  signal: input.signal,
  fetch: boundFetch,
});
const accessExpiresAt = requestStartedAt + response.expires_in * 1000;
// 用持久状态写入新 revision 后，才允许调用 input.writeToken(response.access_token)。
```

`boundFetch` 是本模块按身份 origin 校验、拒绝重定向的私有 fetch 实现，`requestStartedAt` 在发请求前捕获。临时失败不删除 RT；中断后的同 RT 重试仅在已有 30 秒窗口内，窗口外或 `replay_lost` 写 reauthorize 并失败。输出失败保留新凭据，不能回滚到旧 RT；失去 fence 就停止写入和交付。401 后的独立调用必须刷新，不能凭 AT 未到期直接复用。

- [ ] **Step 4：实现稳定入口解析并验证。** 从已安装的 `aiop`/`aio-proxy` 入口解析绝对路径并验证版本调用；保留稳定 symlink 入口，不 `realpath` 固化其版本目标。拒绝 Bun/Node 开发入口或缺失命令。参数为数组，空格/引号路径无需 shell 引用。该只读解析在设备授权前完成。

```ts
const args = ['agent', 'auth', 'codex', '--installation-id', installationId];
// Codex TOML 的 command 是 executable，args 是上面的字符串数组。
const processHandle = Bun.spawn([executable, '--version'], { stdout: 'pipe', stderr: 'pipe' });
```

测试含空格的稳定入口、`aiop` 别名、升级替换入口后的调用、未知入口拒绝和非 TTY；不将源码入口视为发布兼容通过。

- [ ] **Step 5：跑绿并确认提取未破坏现有锁。**

```bash
rtk proxy bun test packages/core/src/file-lock packages/core/src/plugins/config-file packages/cli/src/agent/codex/storage packages/cli/src/agent/codex/managed-config packages/cli/src/agent/codex/command-auth packages/cli/src/agent/codex/command-location
rtk proxy bun run check
```

- [ ] **Step 6：提交 runtime 增量。** Commit subject: `feat(cli): add durable Codex command credentials`，附规定 co-author footer。

## Task 5：完成只读 Key 与可恢复的配置/撤销生命周期

**Files:** Modify `C/credentials/{credentials.ts,credentials.test.ts}`、`C/contracts.ts`、`C/wizard/{index.ts,index.test.ts}`；Create `C/setup/{index.ts,setup.ts,journal.ts,setup.test.ts}`、`C/lifecycle/{index.ts,lifecycle.ts,lifecycle.test.ts}`；Modify `C/codex.ts`、`C/command-auth/`、`packages/cli/src/agent/control-plane/` 的调用衔接。`codex.ts` 保留薄组装与 restore 分发，凭据与生命周期职责放上述命名模块。

**Interfaces:**

```ts
export type KeySelection = { readonly kind: 'none' } | { readonly kind: 'existing'; readonly id: string };
export type ResolvedCredential = {
  readonly token: string;
  readonly kind: 'placeholder' | 'existing';
  readonly label?: string;
  readonly verified: boolean;
};
export type KeySnapshot = {
  readonly choices: readonly KeyChoice[];
  readonly resolve: (selection: KeySelection) => Promise<ResolvedCredential>;
};
export type CredentialDeps = {
  readonly file: { readonly read: () => Promise<Record<string, unknown>> };
  readonly loadEnvironment: () => void;
  readonly readEnvironment: () => Readonly<Record<string, string | undefined>>;
  readonly check: (token: string) => Promise<'ok' | 'offline' | 'unauthorized' | 'invalid_response'>;
};
export type CodexSetupSelection = {
  readonly providerId: string;
  readonly auth:
    | { readonly mode: 'keep-chatgpt'; readonly keys: KeySnapshot; readonly selection: KeySelection }
    | { readonly mode: 'command'; readonly command: string };
};
export type CodexSetupCommit = ConfigCommit & {
  readonly authMode: CodexAuthMode;
  readonly credential: 'placeholder' | 'existing' | 'agent';
  readonly connection: 'ok' | 'offline' | 'not_checked';
  readonly installationId?: string;
};
export type CodexSetupContext = {
  readonly location: CodexLocation;
  readonly endpoint: string;
  readonly adapterVersion: string;
  readonly signal: AbortSignal;
  readonly onDevice: (device: AgentDeviceCodeResponse) => Promise<void>;
};
export function commitCodexSetup(selection: CodexSetupSelection, context: CodexSetupContext): Promise<CodexSetupCommit>;
export function recoverCodexAuthOperation(
  context: CodexSetupContext,
  action: 'complete' | 'remove',
): Promise<'none' | 'completed' | 'blocked'>;
```

`recoverCodexAuthOperation` 只在已解释影响、用户选择恢复后调用；`remove` 命令本身即授权恢复移除。公共 `listCodexAgent(check)` 与 `removeCodexAgent()` 保持入口签名，内部委托 lifecycle。`CodexRemoveResult.status` 增加 `blocked`，command 的 `authorization` 为 `revoked | expired | missing | pending`；静态不制造授权状态。

`CodexListResult` 保留现有字段，新增 `authMode?: CodexAuthMode`、`installationId?: string`、`lifecycle?: 'pending' | 'active' | 'retiring'`、`authorization?: 'not_checked' | 'active' | 'expired' | 'revoked' | 'missing'` 和 `credentialStatus?: 'missing' | 'ready' | 'expired' | 'reauthorize'`。后三项仅用于有真实 command 身份的情况；未检查服务端时 authorization 是 not_checked，不能以本地缓存冒充 active。移除与列举类型分别由 `C/lifecycle/` 导出，`C/codex.ts` 重新导出以兼容既有调用方。

- [ ] **Step 1：写产品行为测试并跑红。** 静态配置无法调用代理写入/reload；无 Key 在提交前再次读取，后来启用认证必须失败；选择消失或模板变动必须失败。command 初次批准后配置写失败留下 pending，helper 拒绝，恢复后才生效。command → 静态与 remove 在撤销失败时返回 blocked 并保留可重试记录。

```ts
const readonlyFile = {
  read: async () => ({ server: { apiKeys: [] }, providers: {} }),
};
const snapshot = await inspectProxyKeys({
  file: readonlyFile,
  loadEnvironment: () => {},
  readEnvironment: () => ({}),
  check: async () => 'offline',
});
expect(snapshot.choices).toEqual([]);
expect((await snapshot.resolve({ kind: 'none' })).kind).toBe('placeholder');
```

此测试通过只读依赖形状验证无需写代理配置；补充带有效最小配置的真实文件夹具与 revision 变化，避免单靠 mock 声称并发正确。使用 GET `/v1/models` 验证 token，禁止把公开 `/health` 当授权成功。

Run: `rtk proxy bun test packages/cli/src/agent/codex/credentials packages/cli/src/agent/codex/setup packages/cli/src/agent/codex/lifecycle`

- [ ] **Step 2：删除 Key 创建并实现 journal。** 删除 `kind: 'new'/'created'`、随机源、transaction/reload、创建失败补偿和相应过时测试。同步从当前静态向导移除新建选项、created 分支与 `CodexConfigWriteError` 的仅创建用途，更新 `keys.resolve(selection)` 调用，使本任务可独立编译和测试；新增 mode 提问仍由 Task 6 接入。保留 Key 只读解析、选择指纹和脱敏错误，旧版本已经创建的 Key 原样保留。操作 journal 使用 `codex-auth-operation.json`，写版本、操作 ID、原/目标模式、installation ID、阶段和最小恢复数据，不复制全部用户 TOML。

```ts
// setup/journal.ts 私有；targetConfig 按 CodexAuthConfig 校验并以 0600 存储。
type AuthOperation = {
  readonly format: 1;
  readonly operationId: string;
  readonly configPath: string;
  readonly kind: 'configure' | 'switch' | 'remove';
  readonly fromMode?: CodexAuthMode;
  readonly phase: 'prepared' | 'authorized' | 'retiring' | 'revoked' | 'config-written';
  readonly installationId: string;
  readonly targetConfig?: CodexAuthConfig;
  readonly providerId: string;
};
```

现有配置 journal 继续负责 TOML/marker 原子归属；auth journal 负责授权与撤销边界，二者恢复按 phase 和当前字段校验继续，遇第三种值保留并报告冲突，不能全量回滚共享文件。恢复时 endpoint 从已校验的 installation 身份读取；当前 context.endpoint 改变则阻止切换，不能把旧 RT 发送到新地址。普通静态更新无需创建 auth journal。

- [ ] **Step 3：接入安装状态转换。** 在同一 lease 内按 spec 的转换表实现：静态 → command 先 pending、授权、持久凭据、配置提交、active；同 endpoint 重配复用 ID；command → 静态先验证选中静态凭据与归属，再 retiring/revoke/清凭据/提交配置；更换 command endpoint 要求先移除。原 endpoint 撤销拒绝重定向。

```ts
const prepared = await prepareCodexCommandInstallation(
  {
    location: context.location,
    providerId: selection.providerId,
    endpoint: context.endpoint,
    adapterVersion: context.adapterVersion,
  },
  lease,
);
await authorizeCodexInstallation(
  {
    location: context.location,
    installation: prepared,
    signal: context.signal,
    onDevice: context.onDevice,
  },
  lease,
);
await configureCodexConfig(
  {
    location: context.location,
    providerId: selection.providerId,
    baseUrl: codexBaseUrl(context.endpoint),
    auth: { mode: 'command', installationId: prepared.marker.installationId, command: selection.auth.command },
  },
  lease,
);
await activateCodexCommandInstallation(context.location, prepared.marker.installationId, lease);
```

此片段放在已 narrowing 为 `selection.auth.mode === 'command'` 的分支中，并在每一步前后推进 journal；配置提交后才激活身份。授权前拒绝/取消不改原配置，授权后失败保留 pending 信息。command → 静态在已撤销阶段失败不能“恢复原登录”，恢复时继续静态提交。

- [ ] **Step 4：实现只读 list/check 和 remove。** 静态离线 remove 逐字段恢复；command 先 retiring，撤销成功/expired/missing 才清凭据与还原 TOML；离线不得声称 removed。保留未知文件与 migrations。`--check` 用存储的 endpoint、只读 admin 快照和缓存 AT 检查，不触发 refresh/device。补全 `--authorizations` 的 Codex configured/orphaned 匹配；单独 revoke 不改配置。

测试包括：服务离线、旧 endpoint、partial remove 用户漂移、remove 后旧 helper ID 被拒绝、重新 configure 新 ID、Key/AT/RT 未出现在 JSON、list 不升级 V1 marker、不发 OAuth token 请求。

- [ ] **Step 5：跑绿并提交生命周期。**

```bash
rtk proxy bun test packages/cli/src/agent/codex/credentials packages/cli/src/agent/codex/setup packages/cli/src/agent/codex/lifecycle packages/cli/src/agent/codex/managed-config packages/cli/src/agent/agent.test.ts
rtk proxy bun run check
```

Commit subject: `feat(cli): support recoverable Codex authentication switching`，附规定 co-author footer。

## Task 6：接入向导、纯 stdout helper 与五种语言

**Files:** Move `C/wizard/index.ts` → `C/wizard/wizard.ts`、`C/wizard/index.test.ts` → `C/wizard/wizard.test.ts`，Create export-only `C/wizard/index.ts`；Modify `C/codex.ts`、`C/codex.test.ts`、`C/index.ts`、`packages/cli/src/{main.ts,main.test.ts,main.rendering.test.ts}`；Move `packages/cli/src/agent/output.ts` → `packages/cli/src/agent/output/output.ts`、`output.test.ts` → `output/output.test.ts`，Create export-only `output/index.ts`、私有 `output/codex-output.ts`；Modify `packages/cli/src/update-notify/{update-notify.ts,update-notify.test.ts}`、`packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`。

**Interfaces:**

```ts
export type CodexPrompts = {
  readonly providerId: (defaultId: string, occupied: readonly string[]) => Promise<string>;
  readonly authMode: (defaultMode: CodexAuthMode) => Promise<CodexAuthMode>;
  readonly key: (choices: readonly KeyChoice[]) => Promise<KeySelection>;
  readonly sources: (groups: readonly SessionGroup[], previous: string) => Promise<readonly string[]>;
  readonly migrate: (input: {
    readonly sources: readonly string[];
    readonly target: string;
    readonly active: number;
    readonly archived: number;
  }) => Promise<boolean>;
};
// WizardDeps 保留 location/endpoint/isTTY/prompts/inspectConfig/occupiedIds/inspectSessions/migrateSessions。
// inspectKeys: () => Promise<KeySnapshot> 保留。
// 删除 saveConfig(providerId, token)，新增：
// resolveCommand: () => Promise<string>
// commitSetup: (selection: CodexSetupSelection) => Promise<CodexSetupCommit>
```

`CodexConfigureResult` 保留 `integration: 'static-config'` 和迁移字段；增加可选 `authMode`、`installationId`，credential 改为 `none | placeholder | existing | agent`，取消结果无 installation。restore 入口原样绕过 auth/wizard，不新增任何鉴权选项。

- [ ] **Step 1：写向导与真实 CLI 输出测试并跑红。** 两种 mode × 有/无 Key；command 不调用 inspectKeys/key，保留分支没 Key 不询问、有一个也选择；从 V1 默认保留，从 V2 默认上次模式；在每个 prompt 取消都不调用 commitSetup/device。提示顺序必须为 Provider ID → mode → 必要 Key → migration → commit。只测行为与秘密未泄露，不快照所有文案。

```ts
function commandWizardDeps(base: WizardDeps, calls: string[]): WizardDeps {
  return {
    ...base,
    prompts: {
      ...base.prompts,
      authMode: async () => {
        calls.push('mode');
        return 'command';
      },
    },
    inspectKeys: async () => {
      throw new Error('command must not inspect proxy keys');
    },
    resolveCommand: async () => '/tmp/AIO Proxy/bin/aiop',
    commitSetup: async (selection) => {
      calls.push('commit');
      expect(selection.auth.mode).toBe('command');
      return {
        status: 'configured',
        providerId: selection.providerId,
        authMode: 'command',
        credential: 'agent',
        connection: 'ok',
        installationId: '11111111-1111-4111-8111-111111111111',
      };
    },
  };
}
```

在既有临时目录 fixture 上运行 `runCodexWizard(commandWizardDeps(base, calls))`，检查最终结果及调用顺序。再以实际 CLI 入口运行 helper：stdout 恰好 `AT + "\n"`、stderr 不含 secrets、无交互；超时/旧 ID/无凭据退出非零，不出现 banner 或成功 result JSON。

Run: `rtk proxy bun test packages/cli/src/agent/codex/wizard packages/cli/src/agent/codex/codex.test.ts packages/cli/src/main.test.ts packages/cli/src/main.rendering.test.ts packages/cli/src/agent/output`

- [ ] **Step 2：接入两种模式和文案。** 使用以下中文主文案，并同步 en/zh-Hant/ja/ko 的含义：

```json
{
  "cli.agent.codex.auth_mode": "是否保留 ChatGPT 登录相关功能？",
  "cli.agent.codex.auth_keep": "保留",
  "cli.agent.codex.auth_command": "不保留",
  "cli.agent.codex.auth_keep_explanation": "保留后，Codex 可继续使用已有 ChatGPT 登录提供的相关功能。模型请求仍通过 AIO Proxy；此选项不会自动登录 ChatGPT。",
  "cli.agent.codex.auth_command_explanation": "将使用 AIO Proxy 命令鉴权，无需选择 API Key。部分依赖 ChatGPT 登录的官方功能可能不可用；已有登录凭据不会被删除。"
}
```

默认标记由当前选择决定，不在“保留”文案中永久硬编码“默认”。删除仅服务新建 Key 的 i18n 项和错误转换；新增设备批准/到期/重新配置、未完成操作和撤销未完成提示，所有原因使用受控错误码映射，不输出 OAuth 原响应或 TOML。

```ts
const mode = await deps.prompts.authMode(inspection.authMode ?? 'keep-chatgpt');
const auth: CodexSetupSelection['auth'] =
  mode === 'command'
    ? { mode, command: await deps.resolveCommand() }
    : await (async () => {
        const keys = await deps.inspectKeys();
        const selection =
          keys.choices.length === 0 ? ({ kind: 'none' } as const) : await deps.prompts.key(keys.choices);
        return { mode, keys, selection };
      })();
// 随后沿用 migrationSelection 收集选择，全部完成后：
const commit = await deps.commitSetup({ providerId, auth });
```

配置提交成功后沿用现有 migrateSessions，失败单独返回 migration blocked；`--restore-migration` 不读取静态 Key、不定位 helper、不访问 OAuth。不要将 command 失败隐式降级为静态。

- [ ] **Step 3：注册 helper 并保证启动预算与输出协议。** 在 `agent auth codex` 分支要求 UUID 参数；两种程序别名一致。此分支跳过 update banner 和普通 agent result renderer；从入口捕获启动时间，余下预算全部传给 `writeCodexAuthToken`。更新通知不得因超时拖延该路径。

```ts
const remainingMs = Math.max(0, 4500 - (Date.now() - startedAt));
if (remainingMs === 0) throw new Error('CODEX_AUTH_TIMEOUT');
await writeCodexAuthToken({
  location,
  installationId,
  signal: AbortSignal.timeout(remainingMs),
  writeToken: (token) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(`${token}\n`, (error) => (error ? reject(error) : resolve()));
    }),
});
```

`startedAt` 在 CLI 入口记录，不能在网络步骤开始时重新计时。错误只写受控 stderr 并非零退出，尚未写 token 时 stdout 为空；stdout 回调失败仍保留新 RT。若现有主入口启动成本无法满足 5 秒，提取仅此分支需要的加载路径，而不是提高生产 timeout 掩盖问题。

- [ ] **Step 4：跑绿、生成翻译并提交。** 使用仓库既有 i18n 生成脚本，不手改生成的 Paraglide 文件；执行 CLI test:unit 让 colocated 测试通过实际包脚本发现。

```bash
rtk proxy bun run --filter @aio-proxy/i18n build
rtk proxy bun run --filter @aio-proxy/cli test:unit
rtk proxy bun run check
```

Commit subject: `feat(cli): offer ChatGPT preservation in Codex setup`，附规定 co-author footer。

## Task 7：双模式端到端验收与发布说明

**Files:** Modify `C/codex.test.ts`、相关 command-auth/lifecycle 集成测试、`packages/cli/scripts/verify-codex-command-auth.ts`、`docs/superpowers/specs/2026-09-09-codex-contract-verification.md`、`npm/aio-proxy/README.md`、`.changeset/codex-static-config.md`；发布二进制验证使用已有 `packages/cli/scripts/build-binary.ts` 和包脚本。

**Interfaces:** 产品命令为 `agent configure codex`、`agent list [--check] [--authorizations] [--json]`、`agent remove codex`、`agent auth codex --installation-id <uuid>`、`agent revoke <installation-id>` 和原 `--restore-migration`。不新增静态 Key 创建命令或登录命令。

- [ ] **Step 1：补齐实际 CLI 与服务端集成。** 在临时 AIO Proxy home/Codex home 中运行真实 device approve/refresh/revoke 和两种配置链路。用合成 provider/no-billing 服务发请求，不调用真实上游；确认 helper raw AT 被 Codex 用于 Responses，401 后重新获取 token，普通/Codex 模型目录均正确。

```text
保留：configure → list --check → remove
command：configure + device approve → auth helper → list --check → revoke → helper fails
切换：保留 → command → 保留 → remove
恢复：device approved + config write interrupted → helper refuses → configure recovery → helper succeeds
迁移：两种模式分别接受/拒绝迁移；unsupported 保留阻止；restore 无 auth/OAuth 请求
```

继续运行已有 sessions 测试，检查会话正文/模型/归档/关系不变，不因鉴权增量把 native/paginated 标为支持。command remove 时 OAuth server 离线必须留下可重试状态，重试成功后旧 ID 永远不能读取新 installation 凭据。

- [ ] **Step 2：验证发布入口和全仓检查。** 构建实际 CLI artifact，放含空格的稳定入口，通过 `aiop` 和 `aio-proxy` 执行 helper；模拟升级替换后的入口仍可运行。分别记录 cold start、并发锁等待和完整 helper 是否在 5 秒内。已有临时假 helper 的 Task 1 通过不能替代此步骤。

```bash
rtk proxy bun run --filter @aio-proxy/cli build:binary
rtk proxy bun packages/cli/scripts/verify-codex-command-auth.ts /opt/homebrew/bin/codex
rtk proxy bun run preflight
```

若 preflight 仍受基线失败影响，记录当前失败和差异，并至少执行 `bun run check` 与受影响 types/core/server/runtime/cli 的全部 unit tests。不能漏掉新测试，也不把失败标为通过。实际官方 Computer Use/插件没有测过则明确保持未验证，不因用户选择 true 宣称全部兼容。

- [ ] **Step 3：更新用户文档与复写现有 changeset。** README 解释两种模式、默认值、无 Key 占位、command 首次批准/静默刷新、退出登录含义、离线差异、迁移范围与移除/撤销。用户界面和 Provider `name` 使用 `AIO Proxy`；命令和 ID 不改。

现有 changeset 是本功能未发布说明，直接复写，不能再追加一段或为同一修订新建第二条。按最终变更包更新 frontmatter，产品与内部包同为 minor，例如：

```markdown
---
'aio-proxy': minor
'@aio-proxy/cli': minor
'@aio-proxy/types': minor
'@aio-proxy/core': minor
'@aio-proxy/server': minor
---

Add interactive Codex setup with a customizable Provider ID and a choice to retain ChatGPT login features using an existing proxy API Key, or use command authentication with AIO Proxy device authorization. Setup preserves model settings and supports optional legacy history migration; removal respects user edits and revokes command credentials.
```

如果修改 runtime 包的源码，在同一条 frontmatter 增加 `@aio-proxy/agent-provider-runtime: minor`。本任务更新既有 changeset，不运行 `changeset version/publish`。扫描 `.changeset/` 中本功能旧的创建 Key 声明，确保不会发布已经删除的行为。

- [ ] **Step 4：完成最终审查和提交。** 核查源代码、spec、plan、README、release note 对模式/默认值/不创建 Key/原始 stdout/迁移范围一致；确认没有真实 token、调试全配置输出或用户目录测试。提交 subject：`docs(cli): document Codex authentication choices`，附规定 co-author footer。向用户报告实际测试和兼容限制，不自动推送、发布或合并。

## 计划自检与验收映射

| Spec 要求                                               | 任务       |
| ------------------------------------------------------- | ---------- |
| 原生 command 与 true 不可混用、raw stdout、account 差异 | 1、6、7    |
| AIO Proxy 显示名，ID/命令不改，顶层 model 保留          | 3、6、7    |
| 只选已有 Key，无 Key 跳过，无创建/reload                | 5、6       |
| Agent target/client/persistence、原生模型目录、插件边界 | 2          |
| TOML 数组/整数、V1 兼容、归属漂移和切换字段清理         | 3、5       |
| 稳定 executable、超时、跨进程刷新、secret 输出边界      | 4、6、7    |
| 初次批准、取消、pending 恢复、撤销与离线 remove         | 4、5、6、7 |
| 两种模式共用历史迁移、独立 restore、范围不扩大          | 6、7       |
| 只读 list/check、真实 authorizations、revoke 契约       | 2、5、6    |
| 五种语言、README、复写未发布 changeset                  | 6、7       |

执行者使用本计划中的公开接口，不跨模块导入 private helpers。主 Agent 在每个任务审查阶段检查类型/模式值、任务依赖和所有创建 Key 旧说明；任务完成前不得把复选框标为完成。最终实施仍须经过全分支审查与验证。
