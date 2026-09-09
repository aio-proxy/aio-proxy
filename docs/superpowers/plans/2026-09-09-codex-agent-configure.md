# Codex Agent Configure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 `aiop agent configure codex` 交互向导：自定义 Provider ID、选择或创建代理 Key、可选历史会话迁移，并提供准确的 list/remove 行为。

**Architecture:** 在 CLI 内为 Codex 建立独立的 static-config 分支，继续复用现有 loopback 地址解析、原子代理配置写入和 reload。Codex TOML 使用源码范围编辑与字段归属记录，会话迁移使用独立的预览、执行、恢复边界。现有插件 Agent 的 schema、device-code、安装资产、升级和撤销协议不扩展。

**Tech Stack:** Bun >=1.4.2、TypeScript、`bun:test`、`bun:sqlite`、`@inquirer/prompts`、Zod、已有 `es-toolkit`；新增仅 CLI 使用的 `toml-eslint-parser@1.0.3`，用于 Bun TOML 对象 API 不提供的源码范围和注释保留。

**Spec:** `docs/superpowers/specs/2026-09-09-codex-agent-configure-design.md`。以该文件和本轮用户确认的流程为准，不照搬 #327 原文的顶层 `model` 要求。

## Global Constraints

- 首次 Provider ID 默认 `aio-proxy`，用户可以自定义；重复配置沿用受管 ID。
- 不写、删除或恢复顶层 `model`；不新增模型选择步骤。
- 设置 `requires_openai_auth = true`，直接写 `experimental_bearer_token`。
- 无代理 Key 时跳过 Key 提问，使用固定非秘密 token `aio-proxy-local`，不启用代理认证。
- 默认全局 `~/.codex/config.toml`，遵守有效的 `CODEX_HOME`，不管理项目内 `.codex/config.toml`。
- 受管配置固定 Responses 协议，默认 `http://127.0.0.1:9317/v1`，端口复用现有解析。
- 提示期间取消零写入；迁移问题前先解释 Provider 筛选并展示来源及数量。
- 只使用代理 Key；明文不进入日志、list/JSON 输出、错误消息或快照。
- 新建私有目录 `0700`，包含凭据的文件 `0600`。
- 迁移保留会话 ID、正文、模型、工作目录、标题、父子关系、归档状态和时间顺序。
- 配置移除不撤销共享 Key，不自动反向迁移历史。
- 新实现文件少于 500 行，达到 400 行评估拆分；测试与同名模块放入同名目录。
- 不引用其他模块的私有协作者；`index.ts` 仅导出。
- 所有 shell 命令以 `rtk` 开头。提交信息附带 `Co-authored-by: Codex <noreply@openai.com>`。
- 不实施 Codex 安装、升级或自动启动功能。隔离兼容实验可以启动专用测试进程，不使用真实用户数据。

## 执行边界与依赖

这是一个产品交付，按可独立验收的模块拆任务。任务 1 是实际兼容性验证，不得用源码推断代替通过结果。任务 2–4 可以在迁移实验遇到问题时继续；任务 5 的实际写入必须等任务 1 给出已验证的存储契约。

顺序：`1 → 2 → 3 → 4 → 5 → 6 → 7`。这里不自动授权创建子 Agent；执行方式在计划交接时选择。

本计划不会捏造 Codex 最低支持版本。任务 1 必须记录真实测试的版本、schema 和历史格式。未知格式预览为不支持并零写入；若当前目标版本的迁移未通过，不能靠跳过所有会话宣称 #327 完成。

## 文件与职责

新增文件均位于 `packages/cli/src/agent/codex/`，除特别标注外：

| 文件                                                                                                        | 职责                                        |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `index.ts`                                                                                                  | 对外仅导出 configure/list/remove 及结果类型 |
| `contracts.ts`                                                                                              | Codex 私有领域接口，不扩展插件 wire types   |
| `location/location.ts`, `location/index.ts`, `location/location.test.ts`                                    | 全局位置、可执行文件及版本探测              |
| `config-document/config-document.ts`, `config-document/index.ts`, `config-document/config-document.test.ts` | TOML 解析、源码范围编辑、Provider 冲突      |
| `config-document/ast-edits.ts`                                                                              | 私有 AST 键路径与区间处理                   |
| `managed-config/managed-config.ts`, `managed-config/index.ts`, `managed-config/managed-config.test.ts`      | 字段归属、configure/remove 事务和恢复       |
| `managed-config/journal.ts`                                                                                 | 私有受管配置日志 schema 与落盘              |
| `credentials/credentials.ts`, `credentials/index.ts`, `credentials/credentials.test.ts`                     | 本机 Key 选择快照、创建、验证               |
| `sessions/sessions.ts`, `sessions/index.ts`, `sessions/sessions.test.ts`                                    | 迁移预览、执行与恢复                        |
| `sessions/legacy-rollout.ts`                                                                                | 私有 legacy JSONL 元数据定位与修改          |
| `sessions/state-index.ts`                                                                                   | 私有 Codex SQLite schema 检查与定向更新     |
| `sessions/journal.ts`                                                                                       | 私有迁移日志与中断恢复                      |
| `sessions/fixtures/`                                                                                        | 合成持久化格式夹具，不包含用户数据          |
| `wizard/wizard.ts`, `wizard/index.ts`, `wizard/wizard.test.ts`                                              | 收集选择、提交顺序、取消与部分成功          |
| `codex.ts`, `codex.test.ts`                                                                                 | 生产依赖装配及三个操作的入口                |
| `output.ts`                                                                                                 | static-config 输出分支与国际化映射          |

其他文件：

- `packages/cli/src/agent/agent.ts`：只增加 Codex 委派及结果联合类型，现有插件实现保持原路。
- `packages/cli/src/agent/output.ts`：命令帮助加入 codex，按结果 `target` 分流渲染。
- `packages/cli/src/agent/agent.test.ts`、`output.test.ts`、`packages/cli/src/main.test.ts`：命令与旧行为回归。
- `packages/cli/package.json`、`bun.lock`：CLI 的 TOML parser 依赖。
- `packages/cli/scripts/verify-codex-contract.ts`：显式运行的隔离实验，不加入常规单元测试。
- `docs/superpowers/specs/2026-09-09-codex-contract-verification.md`：真实兼容验证结果，任务 1 执行时创建。
- `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json`、`README.md`、`.changeset/`：产品文案与发布说明。

不修改 `packages/types/src/agent-integration/agent-integration.ts`、插件 Provider 包或 post-upgrade 的目标数组。默认不增加服务端代码。

## Task 1：验证 Codex 认证、列表与迁移持久化契约

**Files:**

- Create: `packages/cli/scripts/verify-codex-contract.ts`
- Create: `docs/superpowers/specs/2026-09-09-codex-contract-verification.md`
- Create: `packages/cli/src/agent/codex/sessions/fixtures/` 内已验证格式的合成夹具。

**Interfaces:** 此任务产出实验报告和夹具，不增加生产调用接口。报告必须包含 executable 版本、上游 revision、全局配置字段、数据库解析规则、可迁移格式、拒绝格式，以及每个用例的实际结果。

- [ ] **Step 1：记录当前宿主与接口，而不是读取真实会话。**

```bash
rtk proxy codex --version
rtk proxy codex app-server --help
rtk proxy bun --version
```

按本机 help 支持的 schema 导出命令获取 `thread/start`、`thread/resume`、`thread/list`、`thread/metadata/update` 类型，输出到临时目录。不要把未知版本标记为支持；不要把旧会话 Provider ID 缺省自动解释成 `openai`，除非该版本解析契约如此定义。

- [ ] **Step 2：建立强制隔离的实验入口。**

脚本接收唯一显式参数 Codex 可执行文件；没有参数即失败。只使用合成假登录凭据。最小进程框架：

```ts
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const executable = process.argv[2];
if (!executable) throw new Error('Pass the Codex executable explicitly');
const root = await mkdtemp(join(tmpdir(), 'aio-codex-contract-'));
const codexHome = join(root, 'codex');
const requestHeaders: Headers[] = [];
let requestArrived!: () => void;
const inferenceRequest = new Promise<void>((resolve) => { requestArrived = resolve; });
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    requestHeaders.push(new Headers(request.headers));
    // Catalog is enough for an auth probe; inference receives a deliberate error.
    if (new URL(request.url).pathname === '/v1/models') {
      return Response.json({ models: [] });
    }
    requestArrived();
    return Response.json({ error: { message: 'contract probe' } }, { status: 503 });
  },
});
await mkdir(codexHome, { mode: 0o700 });
await Bun.write(join(codexHome, 'config.toml'), Bun.TOML.stringify({
  model: 'contract-model', model_provider: 'contract-proxy',
  cli_auth_credentials_store: 'file',
  model_providers: { 'contract-proxy': {
    name: 'contract-proxy', base_url: `http://127.0.0.1:${server.port}/v1`,
    wire_api: 'responses', requires_openai_auth: true,
    experimental_bearer_token: 'aio-proxy-local', request_max_retries: 0,
  } },
}));
let proc: ReturnType<typeof Bun.spawn> | undefined;
try {
  const child = Bun.spawn([executable, 'app-server'], {
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: codexHome },
    cwd: root,
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  proc = child;
  const waiters = new Map<number, (packet: { result?: unknown; error?: unknown }) => void>();
  let nextId = 0;
  const consume = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (!line.trim()) continue;
          const packet = JSON.parse(line);
          if (typeof packet.id === 'number') waiters.get(packet.id)?.(packet);
        }
      }
    } finally { reader.releaseLock(); }
  })();
  const stderr = new Response(child.stderr).text();
  const call = (method: string, params: unknown): Promise<unknown> => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(id); reject(new Error(`${method}: timeout`)); }, 10_000);
      waiters.set(id, (packet) => {
        clearTimeout(timeout); waiters.delete(id);
        if (packet.error) reject(new Error(`${method}: rejected`));
        else resolve(packet.result);
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      child.stdin.flush();
    });
  };
  await call('initialize', { clientInfo: { name: 'aio-proxy-contract', version: '1' } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  child.stdin.flush();
  const started = await call('thread/start', { cwd: root, model: 'contract-model' }) as { thread: { id: string } };
  await call('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'auth probe' }] });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([inferenceRequest, new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error('No model request observed')), 10_000);
    })]);
  } finally { clearTimeout(deadline); }
  if (!requestHeaders.every((headers) => headers.get('authorization') === 'Bearer aio-proxy-local')) {
    throw new Error('Unexpected provider credential');
  }
  child.kill();
  await child.exited;
  await consume;
  await stderr;
} finally {
  if (proc) { proc.kill(); await proc.exited; }
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
```

以上是无登录、无代理 Key 的完整探测路径；按 Step 1 导出的当前 schema 校正必填协议字段再运行。将配置 token 参数化为 `test-proxy-key`/`aio-proxy-local`，把是否写入合成 auth.json 参数化，形成下一步四个用例。503 是预期的模型失败，不记录原始 header；仅断言 Authorization 等于测试 token。不得继承进程中的任何真实登录/API Key 环境变量。脚本发生失败必须写入实验报告，不能删除断言使实验“通过”。

- [ ] **Step 3：运行四种认证组合。**

已登录/未登录 × 代理 Key/固定占位 token；全部 `requires_openai_auth = true`。使用该版本支持的文件认证存储模式，以合成 auth.json 模拟登录，不能使用 OS Keychain。断言实际模型请求的 bearer 等于 `test-proxy-key` 或 `aio-proxy-local`，不等于合成登录 token；记录 CLI 首次登录提示行为，不声称 app-server 测试等于完整 TUI 功能验证。

- [ ] **Step 4：验证迁移是真正持久化的。**

创建来源 `source-proxy`、目标 `aio-proxy` 两个测试 Provider。创建包含两轮、工具记录、一个子会话和一个归档会话的合成历史。先尝试原生 `thread/resume` 的 `modelProvider` 覆盖及已导出 schema 提供的元数据接口：检查按目标 Provider 列表、关闭进程、重开、再次列出并恢复。没有公开 Provider 更新接口时记录“不支持”，不能向接口塞未声明字段并把无报错当成功。

**分支决策：** 原生接口仅在保留 ID、正文、模型、时间、归档与父子关系且重启后仍有效时采用。否则实施任务 5 的离线路径。原生分支通过时，保持任务 5 的公共接口不变，以该已验证方法替换离线写入并删除不需要的 codec；不要同时维护两套生产实现。

- [ ] **Step 5：锁定离线格式与数据库定位。**

记录 SQLite 中 `threads` 的实际字段及 `history_mode`、rollout 内容和索引重建行为。实验涵盖 legacy 和当前可生成的 paginated 格式；数据库位置以实际 Codex 解析规则为准，包含可能的 sqlite_home 设置。不能以“最新修改的 state_*.sqlite”猜测活跃库。当前计划已知 legacy 的 `session_meta.payload.model_provider` 与 `threads.model_provider`，其他格式仅在实验确认写入契约后支持。

来源信息无法一致定位、缺失 ID、未知格式或运行中写入者均应可识别并拒绝。恢复过程中验证只改索引会被 JSONL 回填覆盖的问题。输出去除敏感路径、只包含合成 ID 的夹具。

- [ ] **Step 6：报告结论并提交实验。**

报告列出每个用例的 PASS/FAIL 和命令，而非模板空表。若没有任何目标版本完成真实迁移，任务 5 不进入持久化实施；仍可推进任务 2–4，但不得将整个 issue 作为完成。

```bash
rtk git add packages/cli/scripts/verify-codex-contract.ts packages/cli/src/agent/codex/sessions/fixtures docs/superpowers/specs/2026-09-09-codex-contract-verification.md
rtk git commit -m 'test(cli): verify Codex static configuration contracts' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

## Task 2：实现按键路径修改 TOML 的纯模块

**Files:** Create `config-document/{index.ts,config-document.ts,ast-edits.ts,config-document.test.ts}`；Modify `packages/cli/package.json`、`bun.lock`。

**Interfaces:** 本任务导出下列接口，其他模块只从 `config-document/index.ts` 导入：

```ts
export type ManagedValue = string | boolean;
export type ValueSlot = { present: false } | { present: true; value: ManagedValue };
export type FieldEdit = { path: readonly string[]; next: ValueSlot };
export type CodexDocument = {
  text: string;
  activeProviderId: string;
  providerIds: readonly string[];
};
export function readCodexDocument(text: string): CodexDocument;
export function readManagedField(text: string, path: readonly string[]): ValueSlot;
export function editCodexDocument(text: string, edits: readonly FieldEdit[]): string;
export function codexProviderEdits(providerId: string, baseUrl: string, token: string): readonly FieldEdit[];
export function validateCodexProviderId(value: string): string;
```

`readManagedField` 若目标字段存在但不是 string/boolean，抛出不含原值的结构错误，不将其视为不存在。新 ID trim 后不能为空，不允许控制字符；拒绝该版本的内建保留 ID（官方已列出 `openai`、`ollama`、`lmstudio`，当前还要排除 `amazon-bedrock`）。点号或非 ASCII 合法 ID 用带引号的 TOML 键完整编码，不拆成多个路径段。

- [ ] **Step 1：编写保护用户配置的失败测试。**

```ts
import { expect, test } from 'bun:test';
import { codexProviderEdits, editCodexDocument } from './config-document';

test('switches Provider without rewriting model, comments or MCP', () => {
  const original = '# chosen by user\nmodel = "keep-model"\n'
    + 'approval_policy = "never"\n\n[mcp_servers.local]\ncommand = "local-mcp"\n';
  const actual = editCodexDocument(original,
    codexProviderEdits('proxy.team', 'http://127.0.0.1:9317/v1', 'test-key'));
  const parsed = Bun.TOML.parse(actual);
  expect(parsed.model).toBe('keep-model');
  expect(parsed.model_provider).toBe('proxy.team');
  expect(actual).toContain('# chosen by user\nmodel = "keep-model"');
  expect(actual).toContain('[mcp_servers.local]\ncommand = "local-mcp"');
  expect(parsed.model_providers).toEqual({
    'proxy.team': {
      name: 'aio-proxy', base_url: 'http://127.0.0.1:9317/v1',
      wire_api: 'responses', requires_openai_auth: true,
      experimental_bearer_token: 'test-key',
    },
  });
  expect(editCodexDocument(actual,
    codexProviderEdits('proxy.team', 'http://127.0.0.1:9317/v1', 'test-key'))).toBe(actual);
});
```

再添加具体夹具：顶层 `model_providers = { other = { name = 'keep' } }`；`[model_providers]` 下内联 Provider；已有 dotted key；含逗号字符串；多行字符串；CRLF；注释在值后；删除第一个/中间/最后一个内联成员；目标字段类型错误；重复 TOML 键。原始文本中不受影响的区间必须保持原样。

- [ ] **Step 2：运行失败测试。**

```bash
rtk proxy bun test ./packages/cli/src/agent/codex/config-document/config-document.test.ts
```

预期仅因模块/实现缺失而失败，不能忽略解析/环境失败。

- [ ] **Step 3：添加范围解析依赖并实现编辑。**

```bash
rtk proxy bun add --cwd packages/cli --exact toml-eslint-parser@1.0.3
```

使用 `parseTOML(text, { tomlVersion: '1.1' })` 获取 AST。键路径由 `TOMLTable.resolvedKey`、`TOMLKey.keys` 的 bare `name`/quoted `value` 组合；递归进入 `TOMLInlineTable.body`，不递归字符串文本。不引入 ESLint 本体。Bun 负责最终语义解析验证，不把 `Bun.TOML.stringify(Bun.TOML.parse(text))` 用在整份用户文档上。

字段内容如下，`env_key`/`auth` 互斥检查由受管层负责：

```ts
export function codexProviderEdits(id: string, baseUrl: string, token: string): readonly FieldEdit[] {
  const fields = {
    name: 'aio-proxy', base_url: baseUrl, wire_api: 'responses',
    requires_openai_auth: true, experimental_bearer_token: token,
  } as const;
  return [
    { path: ['model_provider'], next: { present: true, value: id } },
    ...Object.entries(fields).map(([key, value]) => ({
      path: ['model_providers', id, key], next: { present: true as const, value },
    })),
  ];
}
```

私有编辑器把修改归并成不重叠的 `[start,end)` 区间。已有值只替换 `value.range`；缺失顶层 scalar 在第一个表之前插入；新 Provider 表使用带引号 ID；已有内联结构在其括号内插入/删除并处理逗号，不能再声明同路径标准表。多个修改落在同一内联表时先在该区域内合并，再生成一个外层 patch。按 start 降序应用，最后再解析验证。只删除由受管层指明可删除的空表，不扫描删除用户空表。

- [ ] **Step 4：通过测试与 CLI 编译检查。**

运行本任务测试；记录 Bun 下 parser 工作且不依赖 Node-only native addon。`bun run check` 留在最终任务统一执行。

- [ ] **Step 5：提交。**

```bash
rtk git add packages/cli/src/agent/codex/config-document packages/cli/package.json bun.lock
rtk git commit -m 'feat(cli): preserve Codex config while editing provider fields' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

## Task 3：实现全局位置与字段归属生命周期

**Files:** Create `location/`、`managed-config/` 上表文件和 `contracts.ts`。

**Interfaces:**

```ts
export type CodexLocation = {
  home: string; configPath: string; managedRoot: string; markerPath: string;
};
export type OwnedField = {
  path: readonly string[]; before: ValueSlot; applied: ValueSlot;
};
export type CodexMarker = {
  format: 1; managedBy: 'aio-proxy'; configPath: string; providerId: string;
  fields: readonly OwnedField[]; createdTables: readonly (readonly string[])[];
};
export type ConfigInspection = {
  status: 'absent' | 'managed' | 'modified' | 'conflict';
  providerId?: string; activeProviderId: string; baseUrl?: string;
  changedPaths: readonly (readonly string[])[];
};
export type ConfigCommit = { status: 'configured' | 'unchanged'; providerId: string };
export type ConfigRemoval = { status: 'removed' | 'partial' | 'absent'; preservedPaths: readonly (readonly string[])[] };
export function resolveCodexLocation(home: string, env: Readonly<Record<string, string | undefined>>): CodexLocation;
export function inspectCodexConfig(location: CodexLocation): Promise<ConfigInspection>;
export function configureCodexConfig(input: {
  location: CodexLocation; providerId: string; baseUrl: string; token: string;
}): Promise<ConfigCommit>;
export function removeCodexConfig(location: CodexLocation): Promise<ConfigRemoval>;
```

公共结果不包含 marker、fields 的值或 token。`ValueSlot`/`CodexMarker` 只在 Codex 私有模块间使用。`location.home` 是实际 Codex home；`managedRoot = <home>/.aio-proxy`；`markerPath = <managedRoot>/codex-config.json`，避免依赖可被删除的 TOML 注释，也避免切换 `AIO_PROXY_HOME` 丢失归属。

- [ ] **Step 1：添加真实文件 round-trip 与后续编辑测试。**

```ts
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexLocation } from '../location';
import { configureCodexConfig, removeCodexConfig } from './managed-config';

test('remove restores managed fields and retains a later model choice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-config-'));
  try {
    const location = resolveCodexLocation(root, {});
    await mkdir(location.home, { recursive: true });
    await Bun.write(location.configPath, 'model = "before"\nmodel_provider = "openai"\n');
    await configureCodexConfig({ location, providerId: 'aio-proxy',
      baseUrl: 'http://127.0.0.1:9317/v1', token: 'test-key' });
    const configured = await Bun.file(location.configPath).text();
    await Bun.write(location.configPath, configured.replace('model = "before"', 'model = "after"'));
    await removeCodexConfig(location);
    const result = Bun.TOML.parse(await Bun.file(location.configPath).text());
    expect(result.model).toBe('after');
    expect(result.model_provider).toBe('openai');
    expect(result.model_providers).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

补充：用户后来改 `base_url` 保留该字段；宿主重排相邻键仍可移除；未标记同名 Provider 拒绝；失效 marker 不接管；重复 configure 不刷新原始 before；Provider ID 重命名只清理仍受管的旧字段；marker 含 path 越界拒绝；写入中断/两个 CLI 竞争/配置内容变更可恢复；退出后再次 list 不暴露 secret。

- [ ] **Step 2：运行失败测试。**

```bash
rtk proxy bun test ./packages/cli/src/agent/codex/location ./packages/cli/src/agent/codex/managed-config
```

- [ ] **Step 3：实现位置、marker 与字段比较。**

`CODEX_HOME` 空值使用默认；绝对路径和 `~/` 按已验证宿主语义处理，不把相对路径解释成当前项目。只探测 `codex --version`，无安装时 configure 报安装缺失；list/remove 仍可读取/清理已知全局配置。版本解析支持实际 `codex-cli X.Y.Z` 输出，不复用只处理 `target/version` 的插件解析器。

Zod strict schema 验证 marker，字段路径仅允许 `model_provider` 和该受管 Provider 的六个配置字段；对 `createdTables` 同样限定。恢复规则：

```ts
const restoreEdits = marker.fields.flatMap((field) => {
  const now = readManagedField(text, field.path);
  const equal = now.present === field.applied.present
    && (!now.present || (field.applied.present && now.value === field.applied.value));
  return equal ? [{ path: field.path, next: field.before }] : [];
});
```

发生漂移时 configure 不静默覆盖；返回字段路径冲突，用户可先恢复原状态或换 ID。若用户添加 `env_key`、`auth`、`aws`、会影响认证的 header 到受管 Provider，拒绝更新并解释冲突，不能悄悄删除这些用户字段。

- [ ] **Step 4：实现日志先行的配置提交与恢复。**

不要把 `AtomicConfigFile` 指向 TOML：它只支持 JSON/JSONC/YAML。可把它用于 `<managedRoot>/config-operation.json` 作为两个 aio-proxy 操作的协调锁与日志容器，不导入 core 私有 lock 模块。日志记录操作类型、旧 marker、目标 marker、原文件存在性、前后内容指纹和阶段；必须在改 TOML 前落盘。

TOML 同目录临时文件 `open('wx', 0600)` →写入→fsync→再次检查原内容与文件身份→rename→更新 marker→清除 pending 日志。存在更宽松权限的凭据配置在提交时收紧至 0600。持久化目录 fsync 使用仓库支持平台的已有模式。检测到符号链接目标或路径身份变化时拒绝而不是替换未知文件。

恢复按磁盘实际指纹/字段值判断 old/applied/changed，不只信日志阶段；未知状态保留 pending 并输出无秘密诊断。不存在文件时的回滚不能删除后来由用户创建的文件。aio-proxy 的锁只协调本工具，不能声称防住 Codex 并发重写；检测到活动 Codex 写入者时配置提交要求其停止，正文快照检查补充防护。

- [ ] **Step 5：运行测试并提交。**

```bash
rtk proxy bun test ./packages/cli/src/agent/codex/location ./packages/cli/src/agent/codex/managed-config
rtk git add packages/cli/src/agent/codex/location packages/cli/src/agent/codex/managed-config packages/cli/src/agent/codex/contracts.ts
rtk git commit -m 'feat(cli): track and restore managed Codex configuration' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

## Task 4：选择、创建并验证代理 Key

**Files:** Create `credentials/{index.ts,credentials.ts,credentials.test.ts}`；共享类型加入 `contracts.ts`。

**Interfaces:**

```ts
export type KeyChoice = { id: string; label: string };
export type KeySelection = { kind: 'none' } | { kind: 'existing'; id: string } | { kind: 'new' };
export type KeySnapshot = {
  choices: readonly KeyChoice[];
  resolve: (selection: KeySelection, providerId: string) => Promise<ResolvedCredential>;
};
export type ResolvedCredential = {
  token: string; kind: 'placeholder' | 'existing' | 'created'; label?: string;
  verified: boolean;
};
export type CredentialDeps = {
  file: AtomicConfigFile; endpoint: string;
  loadEnvironment: () => void;
  readEnvironment: () => Readonly<Record<string, string | undefined>>;
  randomKey: () => string;
  reload: () => Promise<void>;
  check: (token: string) => Promise<'ok' | 'offline' | 'unauthorized' | 'invalid_response'>;
};
export function inspectProxyKeys(deps: CredentialDeps): Promise<KeySnapshot>;
```

`KeySnapshot` 的 secret 捕获在 resolve 闭包中，不放进可被 JSON.stringify 的数据对象。`ResolvedCredential` 仅供 wizard 内部消费，不成为 AgentConfigureResult 的成员。已有 Key 的 opaque id 必须能检测原条目改变，不能在交互结束后直接信旧数组下标。

- [ ] **Step 1：无认证分支失败测试。**

```ts
import { expect, test } from 'bun:test';
import { AtomicConfigFile } from '@aio-proxy/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectProxyKeys } from './credentials';

test('keyless proxy stays keyless and uses a non-secret explicit token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aio-codex-key-'));
  const path = join(root, 'config.json');
  const before = '{"providers":{},"server":{"apiKeys":[]}}';
  try {
    await Bun.write(path, before);
    const snapshot = await inspectProxyKeys({
      file: new AtomicConfigFile(path), endpoint: 'http://127.0.0.1:9317',
      loadEnvironment() {}, readEnvironment: () => ({}),
      randomKey: () => { throw new Error('must not generate'); },
      reload: async () => { throw new Error('must not reload'); },
      check: async () => 'ok',
    });
    expect(snapshot.choices).toEqual([]);
    expect(await snapshot.resolve({ kind: 'none' }, 'aio-proxy')).toMatchObject({
      token: 'aio-proxy-local', kind: 'placeholder', verified: true,
    });
    expect(await Bun.file(path).text()).toBe(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

另写已有模板 Key 正确解析、创建 Key 保留模板/标签、旧选择被重排/删除拒绝、无效配置不是无认证、生成过程中认证被关闭不自动重启认证、reload 拒绝与 commit 不确定状态，以及错误输出不含 token 的行为测试。

- [ ] **Step 2：运行失败测试。**

```bash
rtk proxy bun test ./packages/cli/src/agent/codex/credentials
```

- [ ] **Step 3：实现本地读取与 Key 创建。**

生产装配复用 `configPath()`、`loadServiceEnv(configPath)`、`parseRuntimeConfig(raw, env)`；整个解析过程失败必须返回稳定诊断 code，不能把带 secret 的 Zod error/模板值拼入输出。检测环境变量模板缺值，禁止把空解析值当作有效 Key。

随机 Key 使用 `node:crypto` 已有 CSPRNG 模式；固定前缀不得落入 Agent token 的保留前缀：

```ts
import { randomBytes } from 'node:crypto';
const randomKey = () => `sk-${randomBytes(32).toString('hex')}`;
```

新增 Key 使用 `file.transaction`：锁内重新读取并解析当前 authored 配置，确认 apiKeys 仍启用、选中快照未改变；追加 `{key, label: 'Codex: ' + providerId}`。保留原 `server` 字段与 apiKeys 原始条目，不把解析后的完整配置重新保存，否则会固化其他环境变量模板。

```ts
const next = {
  ...current,
  server: { ...server, apiKeys: [...authoredKeys, { key, label }] },
};
```

`current` 来自 transaction 参数；`server` 用 `isPlainObject` 验证；`authoredKeys` 是该 server 中验证过的原数组；`key` 只生成一次，`label` 为上述名称。任务不引入新的服务端密钥读取接口。

- [ ] **Step 4：处理 reload/验证与部分提交。**

Key 写入前探测代理健康，在线时 transaction 的 verify 调用 `reloadCommand` 后检查带新 Key 的 `/v1/models`。拒绝响应抛错使 `AtomicConfigFile` 恢复原文件，随后尝试 reload 原配置。网络不确定与 `AtomicConfigCommitUncertainError` 必须重新读取核对本次 Key，不无条件再次追加。Key 已存在则复用本次结果。

代理开始就离线：允许持久保存 Key，返回 `verified:false`。在线变离线导致结果不确定：不报告 Key 可用、不盲目删除 Key，报告恢复结果。GET `/v1/models` 的 401 和网络离线是不同结果；不得只测 `/health` 就说凭据有效。测试只使用假 token。

- [ ] **Step 5：通过测试并提交。**

```bash
rtk proxy bun test ./packages/cli/src/agent/codex/credentials
rtk git add packages/cli/src/agent/codex/credentials packages/cli/src/agent/codex/contracts.ts
rtk git commit -m 'feat(cli): select and provision proxy credentials for Codex' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

## Task 5：实现历史会话预览、迁移与恢复

**Files:** Create `sessions/{index.ts,sessions.ts,sessions.test.ts,legacy-rollout.ts,state-index.ts,journal.ts}`；使用任务 1 的合成 fixtures；更新 `contracts.ts`。

**Interfaces:** 对向导隐藏 schema 和文件细节。

```ts
export type SessionGroup = { providerId: string; active: number; archived: number };
export type MigrationPreview = {
  groups: readonly SessionGroup[];
  targets: readonly MigrationTarget[];
  blocked: readonly { id: string; reason: string }[];
};
export type MigrationTarget = {
  id: string; sourceProviderId: string; archived: boolean;
  storage: 'legacy' | 'native'; revision: string;
};
export type MigrationResult = {
  status: 'completed' | 'partial' | 'blocked';
  migrated: number; skipped: number; conflicts: number;
  operationId?: string; recoveryPath?: string;
};
export function inspectCodexSessions(location: CodexLocation): Promise<MigrationPreview>;
export function migrateCodexSessions(input: {
  location: CodexLocation; targets: readonly MigrationTarget[]; targetProviderId: string;
}): Promise<MigrationResult>;
export function restoreCodexMigration(location: CodexLocation, operationId: string): Promise<MigrationResult>;
```

`MigrationTarget` 不接受调用者提供任意路径，实际路径从经过验证的索引按 ID 重新解析。`revision` 仅是操作内一致性 token，不暴露对话正文。原生分支仅在任务 1 通过时选择；离线 schema 精确执行以下算法，不默认支持未验证的 paginated 格式。

- [ ] **Step 1：添加元数据定向修改与正文保持测试。**

私有 `rewriteLegacyProvider(bytes, id, source, target)` 返回新 bytes，并在 ID/来源不匹配、多个相互冲突 session_meta、未知结构时拒绝。测试与 sessions 模块放在 `sessions.test.ts`，不另建 `legacy-rollout.test.ts` 破坏同名目录规则。

```ts
import { expect, test } from 'bun:test';
import { rewriteLegacyProvider } from './legacy-rollout';

test('changes only session Provider metadata, never matching conversation text', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const header = JSON.stringify({ type: 'session_meta', payload: { id, model_provider: 'old' } });
  const tail = '\n' + JSON.stringify({ type: 'response_item', payload: { text: 'old', model: 'keep' } }) + '\n';
  const result = new TextDecoder().decode(rewriteLegacyProvider(
    new TextEncoder().encode(header + tail), id, 'old', 'aio-proxy'));
  expect(JSON.parse(result.split('\n')[0]!).payload.model_provider).toBe('aio-proxy');
  expect(result.slice(result.indexOf('\n'))).toBe(tail);
});
```

测试还需以任务 1 的完整真实 schema 夹具覆盖：两个来源、已经迁移的目标、归档、父子会话、没有索引、索引与日志不一致、非标准历史文件名、未知格式、目录越界和符号链接。不假定元数据永远是第一行；根据确认的格式定位唯一权威 session_meta，严格保留其余 bytes。

- [ ] **Step 2：运行失败测试。**

```bash
rtk proxy bun test ./packages/cli/src/agent/codex/sessions
```

- [ ] **Step 3：实现只读预览。**

使用 `new Database(path, { readonly:true, strict:true })` 读取任务 1 确定的活跃索引，不创建缺失数据库，不在预览阶段做回填或 Codex 初始化。只选所需元数据列，避免载入全部正文。SQLite 不存在但该版本确认支持纯 legacy 时扫描 `sessions` 与 `archived_sessions`；否则返回明确 blocked。

Provider 来源聚合包含归档；当前目标 ID 下的会话可计数但不加入待迁移集合。排除其他远程环境的存储，不对任意文件名通配“猜库”。schema 和 metadata 不一致时以 blocked 返回并展示数量，不悄悄跳过后报告全部成功。

- [ ] **Step 4：实现离线事务与中断恢复。**

离线前置条件：用户已在向导中获知需退出 Codex；探测存在相关进程/打开文件即拒绝，探测不可用返回 `offline_check_unavailable`。macOS/Linux 使用只读进程/文件占用探测，不能 kill 用户进程。两个 aio-proxy 迁移由私有操作锁协调；不声称该锁会阻止 Codex。

操作目录 `<managedRoot>/migrations/<UUID>/`，日志记录 config/home 身份、目标 ID、每条会话的原 Provider、原/新日志指纹、索引旧值和进度。UUID 由工具生成，恢复入口只接受 UUID，不能用它拼出目录穿越路径。

全量预检成功后，先持久化日志和必要的受影响文件备份，再开始变更。SQLite 使用 `BEGIN IMMEDIATE`，在同一连接上执行带来源条件的更新：

```ts
const update = db.query(
  'UPDATE threads SET model_provider = ? WHERE id = ? AND model_provider = ?',
);
db.exec('BEGIN IMMEDIATE');
try {
  for (const target of targets) {
    const result = update.run(targetProviderId, target.id, target.sourceProviderId);
    if (result.changes !== 1) throw new Error('session_changed');
  }
  // Write precomputed, backed-up JSONL replacements while transaction remains open.
  // Recheck each original identity/revision immediately before atomic rename.
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
```

实际异步文件 IO 用显式 BEGIN/COMMIT，不把 async callback 传入 `db.transaction()`。只更新 `model_provider`，不更新 timestamp/model/title。文件层复用本模块私有的写临时文件/fsync/rename流程，先从备份构建新内容，不能边读边覆盖原 JSONL。

捕获失败后恢复已经改写且仍匹配 applied 指纹的文件；进程崩溃后 SQLite 会回滚未提交事务，下次依据磁盘/索引实值协调恢复。COMMIT 已完成但日志未标记时不能再写一遍。恢复只定向撤回 Provider 元数据并保留新增正文，不能用整份旧 DB 或 JSONL 覆盖迁移后历史。遇到第三种 Provider 或冲突内容时保留并报告 conflicts。

- [ ] **Step 5：添加故障注入与可恢复性测试。**

通过私有测试 deps 在“日志已写”“第一个 JSONL 替换后”“SQLite COMMIT 前”“COMMIT 后进度未更新”四个位置注入异常/模拟重启。每个场景重新打开数据库验证：成功则文件与索引均为目标；失败则均恢复来源，或存在明确待恢复日志，不能返回 completed。向恢复后的会话追加新正文，再运行 restore，断言正文保留。

断言重复 migrate 不产生新会话，未选 Provider/归档状态/标题/模型/父子关系不变。对未知 paginated 格式断言一字节不写。调用任务 1 的真实宿主测试验证列表与重新恢复结果，不能只依赖自建 SQLite 表通过。

- [ ] **Step 6：交付恢复入口与提交。**

内部 restore 通过 configure 检测 pending 日志后的“恢复上次未完成的迁移”提示调用；正常向导仍只有用户确认的三阶段。为完成后的迁移提供显式恢复入口 `aiop agent configure codex --restore-migration <operation-id>`：只恢复该日志涉及的历史归属，不改全局 Provider、Key 或模型，不重新运行配置向导。这样用户可以撤销迁移，而无需重新接管旧的非受管 Provider 配置。不要在 remove 中隐式恢复或给缺少依据的历史做整体反向覆盖。

```bash
rtk proxy bun test ./packages/cli/src/agent/codex/sessions
rtk git add packages/cli/src/agent/codex/sessions packages/cli/src/agent/codex/contracts.ts
rtk git commit -m 'feat(cli): migrate Codex session provider ownership safely' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

## Task 6：接入交互向导、命令分流与结果展示

**Files:** Create `wizard/`、`codex.ts`、`codex.test.ts`、`index.ts`、`output.ts`；Modify `agent.ts`、现有 `output.ts` 与相关测试、`contracts.ts`、五个 locale 文件。

**Interfaces:**

```ts
export type CodexConfigureResult = {
  target: 'codex'; integration: 'static-config';
  status: 'configured' | 'unchanged' | 'cancelled';
  providerId?: string; configPath: string;
  connection: 'ok' | 'offline' | 'not_checked';
  credential: 'none' | 'placeholder' | 'existing' | 'created';
  migration: MigrationResult | { status: 'declined' | 'empty' | 'not_requested' };
  migrationAction?: 'restore';
};
export type CodexListResult = {
  target: 'codex'; integration: 'static-config'; configPath: string;
  providerId?: string; activeProviderId: string; baseUrl?: string;
  status: ConfigInspection['status'];
  connection: 'ok' | 'offline' | 'unauthorized' | 'invalid_response' | 'not_checked';
  changedPaths: readonly (readonly string[])[];
};
export type CodexRemoveResult = ConfigRemoval & {
  target: 'codex'; integration: 'static-config'; configPath: string; keysRetained: true;
};
export type CodexPrompts = {
  providerId: (defaultId: string, occupied: readonly string[]) => Promise<string>;
  key: (choices: readonly KeyChoice[]) => Promise<KeySelection>;
  sources: (groups: readonly SessionGroup[], previous: string) => Promise<readonly string[]>;
  migrate: (input: { sources: readonly string[]; target: string; active: number; archived: number }) => Promise<boolean>;
};
export type WizardDeps = {
  location: CodexLocation; endpoint: string; isTTY: boolean;
  prompts: CodexPrompts;
  inspectConfig: () => Promise<ConfigInspection>;
  occupiedIds: () => Promise<readonly string[]>;
  inspectKeys: () => Promise<KeySnapshot>;
  inspectSessions: () => Promise<MigrationPreview>;
  saveConfig: (providerId: string, token: string) => Promise<ConfigCommit>;
  migrateSessions: (targets: readonly MigrationTarget[], providerId: string) => Promise<MigrationResult>;
};
export function runCodexWizard(deps: WizardDeps): Promise<CodexConfigureResult>;
```

生产入口 `configureCodexAgent(options?: { restoreMigration?: string }): Promise<CodexConfigureResult>`、`listCodexAgent(check: boolean): Promise<CodexListResult>`、`removeCodexAgent(): Promise<CodexRemoveResult>`。三个函数由 `codex/index.ts` 导出，私有的 journals、token、SQL 类型不导出到 agent 层。恢复模式返回 `status:'unchanged'`（全局配置未改变）、`credential:'none'`、`connection:'not_checked'`、`migrationAction:'restore'` 和实际迁移恢复结果。

- [ ] **Step 1：编写无 Key、拒绝迁移的完整向导测试。**

```ts
import { expect, test } from 'bun:test';
import { runCodexWizard } from './wizard';

test('skips Key prompt and leaves history when migration is declined', async () => {
  const events: string[] = [];
  const result = await runCodexWizard({
    location: { home: '/tmp/codex-test', configPath: '/tmp/codex-test/config.toml',
      managedRoot: '/tmp/codex-test/.aio-proxy', markerPath: '/tmp/codex-test/.aio-proxy/codex-config.json' },
    endpoint: 'http://127.0.0.1:9317', isTTY: true,
    prompts: {
      providerId: async (value) => { expect(value).toBe('aio-proxy'); return 'custom'; },
      key: async () => { throw new Error('unexpected Key prompt'); },
      sources: async () => ['openai'],
      migrate: async () => { events.push('migration-question'); return false; },
    },
    inspectConfig: async () => ({ status: 'absent', activeProviderId: 'openai', changedPaths: [] }),
    occupiedIds: async () => [],
    inspectKeys: async () => ({ choices: [], resolve: async () => {
      events.push('resolve-key'); return { token: 'aio-proxy-local', kind: 'placeholder', verified: true };
    } }),
    inspectSessions: async () => ({
      groups: [{ providerId: 'openai', active: 1, archived: 0 }], blocked: [],
      targets: [{ id: 'test-id', sourceProviderId: 'openai', archived: false, storage: 'legacy', revision: 'r1' }],
    }),
    saveConfig: async (id, token) => {
      expect(token).toBe('aio-proxy-local'); events.push('save');
      return { status: 'configured', providerId: id };
    },
    migrateSessions: async () => { throw new Error('unexpected migration'); },
  });
  expect(events).toEqual(['migration-question', 'resolve-key', 'save']);
  expect(result).toMatchObject({ target: 'codex', providerId: 'custom', migration: { status: 'declined' } });
  expect(JSON.stringify(result)).not.toContain('aio-proxy-local');
});
```

再覆盖 Key 选择/创建、没有历史不提问、多个来源默认原 Provider、取消于每一阶段零 save/resolve/new key、非 TTY 无写入、迁移部分成功、配置失败不迁移、Key 提交但配置失败、原有登录提示不被伪装成插件 `/login`。

- [ ] **Step 2：运行失败测试。**

```bash
rtk proxy bun test ./packages/cli/src/agent/codex/wizard ./packages/cli/src/agent/codex/codex.test.ts
```

- [ ] **Step 3：实现先收集后提交的 orchestration。**

顺序精确如下：

```text
检查 TTY / Codex 版本 / 路径 / pending 恢复
读取当前受管配置与 activeProviderId
输入并校验目标 Provider ID
读取 Key 选项；有 Key 才提问（不在此刻生成/提交）
读取迁移元数据；选择来源（默认前一个 Provider）
展示筛选说明、活动与归档计数；询问是否迁移
resolve 已选择 Key（必要时创建 + reload + 验证）
saveConfig
若接受迁移则 migrateSessions
返回不含凭据的分阶段结果
```

`@inquirer/prompts` 的 input/select/checkbox/confirm 封装成 `CodexPrompts`；确认迁移默认否。只有多来源需要范围选择，单来源不额外问。校验冲突在 input 的 validate 中反馈；终端 Ctrl+C/AbortPromptError 转 cancelled，无堆栈。正常 configure 不添加第二个“确认所有操作”问题。

向导运行中代理配置可能变化，所以 `resolve`、`saveConfig`、`migrateSessions` 均再次校验快照。部分失败输出准确分阶段结果，不把 credential 的对象或 cause 直接传给渲染器。非 TTY 明确要求交互终端，本期不新增一组无人值守参数替代用户要求的向导。

- [ ] **Step 4：分流现有 agent 命令而不污染插件协议。**

在 `AgentCommandDeps` 增加嵌套可注入 `codex` 操作依赖，在现有测试 fixture 中显式提供 stub，避免旧测试意外访问真实 HOME。`agentConfigure` 和 `agentRemove` 在 `AgentTargetSchema.parse` 之前分流字符串 `'codex'`；所有其他目标继续由旧 schema 验证。

```ts
if (target === 'codex') return resolved.codex.configure();
const parsed = parseTarget(target);
```

将原结果类型分别命名为 `PluginAgentConfigureResult`、`PluginAgentRemoveResult`，对外联合对应 Codex 结果。list 保持原插件 snapshot 运算的数组类型，完成原 applySnapshot/authorizationItems 后才加入 Codex 行，避免凭空给 Codex 补 device-code 字段。`--check` 独立检查 Codex 目标，即便插件 admin snapshot 不可达也保留 Codex 的真实检查结果。

`output.ts` renderer 先检查 `result.target === 'codex'` 调用 Codex 输出；命令帮助改 `<opencode|pi|omp|codex>`。给 configure 注册可选 `--restore-migration <operation-id>`，动作签名改为 `configure(target, options?)`，main 原样转交选项；其他目标收到该参数明确拒绝。恢复选项必须先通过 UUID 校验，再进入离线恢复，且不调用 Key 生成/配置保存；其输出使用“历史归属已恢复”，不显示“配置已保存”。main 的依赖装配使用 `createAgentCommandDeps`，不在 main 复制向导步骤。list/remove 不强制 Codex executable 已安装；正常 configure 才需要探测版本。

- [ ] **Step 5：补齐五种语言和行为测试。**

新增 key 统一使用 `cli.agent.codex.*`，对应：路径/端点、Provider ID、冲突、Key 选择/生成/跳过、来源选择、Provider 筛选解释、活动与归档计数、是否迁移、迁移完成/部分失败/需离线/不支持格式、配置完成/离线未验证、移除保留字段和 Key、取消/非交互。

只在受影响语言文件增加实际翻译，不修改生成的 `m.ts`。用 locale parity 测试验证占位参数一致。没有定义安装最低版本时输出“版本兼容性未验证”，不编造 supported。主命令测试断言 Codex 输出没有 installationId、loginCommand、revokeStatus、token。

- [ ] **Step 6：验证并提交。**

```bash
rtk proxy bun run i18n:compile
rtk proxy bun run --filter @aio-proxy/cli test:unit
rtk proxy bun run --filter @aio-proxy/i18n test:unit
rtk git add packages/cli/src/agent packages/cli/src/main.test.ts packages/i18n/messages
rtk git commit -m 'feat(cli): add interactive Codex agent configuration' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

## Task 7：端到端验收、文档与发布说明

**Files:** Modify `README.md` 与任务 1 的兼容报告；Create 一个 changeset；必要的 CLI artifact 行为测试放在 `codex/codex.test.ts`，不向 legacy `__tests__/` 增添文件。

**Interfaces:** 产品命令保持 `aiop agent configure codex`、`agent list [--check] [--json]`、`agent remove codex`。不新增 `agent revoke codex`。

- [ ] **Step 1：补充 README 与恢复说明。**

在 Agent integrations 中区分 plugin 与 static-config 两类。实际可复制示例：

```bash
aiop agent configure codex
aiop agent list --check
aiop agent remove codex
```

说明默认/自定义 ID、不改模型、有 Key 选择或创建、无 Key 跳过、全局目录、保留原生登录、重开生效；迁移文案说明筛选而非删除或安全隔离。记录实际已验证 Codex 版本/格式。解释移除不会撤销 Key 或反向迁移，并说明 pending 操作恢复入口与备份目录。不承诺未经验证的 Codex 官方功能。

- [ ] **Step 2：隔离验收完整旅程。**

使用任务 1 的测试进程与 fake upstream、临时 HOME/CODEX_HOME/AIO_PROXY_HOME。场景至少为无 Key/选已有 Key/生成 Key × 接受/拒绝迁移；检查 `list --check` 的凭据状态，配置移除后恢复原 Provider，而顶层 model 和用户后改字段不变。重启 Codex 后验证 migrated IDs 可见且下一轮请求到本地 fake endpoint。

用真实 CLI 参数分发和 mock prompts 验证交互顺序，再运行一次 TTY 手工 smoke。所有 smoke 限测试目录，不调用当前用户真实登录/历史。重复执行与中断恢复都需要一次跨进程验证，不能只 mock journals。

- [ ] **Step 3：验证编译产物可加载新 parser。**

先运行现有 CLI binary artifact tests；若它们没有覆盖新增静态 import，增加一个调用 `readCodexDocument` 的临时 `bun build --compile` smoke，运行后删除二进制，产物不提交。新依赖必须打包进独立 binary，不依赖用户机器上 node_modules。

- [ ] **Step 4：编写 changeset 并清理旧说明。**

```bash
rtk proxy rg -n 'Codex|codex|static.config' .changeset
rtk proxy bun changeset
```

通过 Changesets 交互选择 `aio-proxy` 与 `@aio-proxy/cli` 的 minor（新增用户功能）；若实际改动新增其他内部包，同时选择对应包同级 bump。仅一段用户说明，最多 5 行，不使用 Conventional Commit 前缀。建议正文：

> Add an interactive Codex setup wizard with a customizable Provider ID, proxy API key selection or creation, and optional history migration. Codex settings are merged without changing the selected model, and removing the integration preserves unrelated settings.

如任务 1 导致迁移未交付，不能保留上述宣称迁移的发布说明，也不能关闭本 issue。不要执行 changeset version/publish。

- [ ] **Step 5：完成仓库检查。**

```bash
rtk proxy bun run preflight
rtk git diff --check
rtk git status --short
```

记录真实通过/失败结果。若环境导致无法跑完整 preflight，至少 `bun run check`、CLI unit tests 和受影响的 i18n tests，明确报告缺少的 artifact 检查；不凭局部通过称全部通过。

- [ ] **Step 6：提交发布文档并交接审阅。**

```bash
rtk git add README.md .changeset docs/superpowers/specs/2026-09-09-codex-contract-verification.md
rtk git commit -m 'docs(cli): document Codex setup and migration' -m 'Co-authored-by: Codex <noreply@openai.com>'
```

提交前只 stage 本任务文件。最终总结写出真实支持的 Codex 版本、迁移数量/恢复验证、Key 选择行为、检查结果与限制。创建 PR 时标题使用 `feat(cli): add interactive Codex agent configuration`，issue 关联 #327，明确设计已按用户确认不写顶层 model。

## 计划自检

- [x] Spec 覆盖：交互与取消→任务 6；Provider/模型/认证→任务 1–3；Key 选择/创建/保留→任务 4；归属/list/remove→任务 3、6；会话迁移/恢复→任务 1、5；兼容、文案、changeset、preflight→任务 7。
- [x] 术语与接口：`providerId` 只用于 Codex 配置 ID；`targetProviderId` 用于会话迁移；`MigrationTarget.sourceProviderId` 对应预览来源；结果不含 token。
- [x] 私有边界：AST、SQL、journal 只能被各自目录内实现引用；codex 对外仅三个入口与结果类型。
- [x] 真实验证：任务 1 报告完成前不能声称存储 schema 或最低版本受支持；单元测试通过不能替代真实 Codex 重启验证。
- [x] 安全恢复：不覆盖用户后改字段/新增历史，不静默开启认证，不自动撤销共享 Key，不把登录 token 发给代理。

## 调研引用

- [Bun TOML](https://bun.com/docs/runtime/toml.md)：解析、序列化以及源码信息缺失的边界。
- [Bun SQLite](https://bun.com/docs/runtime/sqlite.md)：只读打开、事务和显式 SQL。
- [toml-eslint-parser](https://github.com/ota-meshi/toml-eslint-parser)：`parseTOML`、`TOMLTable.resolvedKey`、`range`、内联表 AST；本计划选择已发布 1.0.3。
- Codex 官方契约和源码 revision 见 Spec 的调研依据；版本声明以任务 1 的真实实验为准。
