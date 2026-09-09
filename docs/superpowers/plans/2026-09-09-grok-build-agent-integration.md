# Grok Build Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户通过 `aio-proxy agent configure grok` 和原生 `grok login` 使用 AIO Proxy 的 installation 身份、模型和自动刷新，并能安全撤销、移除配置。

**Architecture:** Grok 使用原生 external auth command；CLI 调用已有 Agent runtime 的 device/refresh API，持久化轮换结果后只输出 AT。Codex 与 Grok 共用 CLI 内的 TOML 文本编辑模块，Grok 专属模块只负责七字段、别名及逐字段归属和事务，configure/auth/remove 共用从现有 config-file lock 提取的文件锁。公共身份支持四个目标，插件资产和升级路径继续只支持三个插件目标。

**Tech Stack:** Bun >=1.4.2、TypeScript、Commander、Zod、`@aio-proxy/agent-provider-runtime`、`toml-eslint-parser@1.0.3`、现有 SQLite Agent identity service、Bun test、编译 CLI 和真实 Grok Build。

**Spec:** [2026-09-09-grok-build-agent-integration-design.md](../specs/2026-09-09-grok-build-agent-integration-design.md)。执行前通读 spec 和本计划；本计划不改变 spec 的产品范围。

## Global Constraints

- target `grok`；client ID `aio-proxy-grok`；`auth_provider_label = "AIO Proxy"`。
- 最低已验证 Grok `1.0.24`；低版本或未知版本给警告。macOS 之外没有通过真实宿主验证前不宣称兼容。
- helper 命令固定为 `aio-proxy agent auth grok --installation-id <uuid>`，不增加 `--grok-home`、endpoint 或 token 参数。
- `GROK_HOME` 支持绝对路径和 `~/`，未设置时 `~/.grok`；其他相对路径拒绝。helper 从宿主继承，不搜索其他 installation。
- stdout 成功仅一行 `{"access_token":"...","expires_in":900}`；秒数是输出时实际剩余整数且 >0。失败为空；RT 永不输出；诊断和设备码 URL 走 stderr。
- 普通 helper 有 RT 必须经服务端 refresh；只有等待期间观察到新 revision 的并发调用可复用结果。
- `GROK_AUTH_EXPIRED=1` 只静默刷新；锁等待、网络、持久化和清理共享最多 5 秒预算；普通交互总预算最多 240 秒。
- AT 15 分钟、RT 90 天、refresh replay 30 秒，沿用服务端现有规则，不调整安全语义。
- configure 不启动 Grok/server、不签发凭据、不修改 `[models].default`；模型目录是普通 `/v1/models`，没有 Grok LKG/timer。
- 配置只管理 spec 的七个叶子；本地 `E/__grok_unavailable/managed-config` 返回 404，不新增私有 Grok 服务。
- 用户 config 保留无关字节、注释、顺序和权限；新私有目录 `0700`、文件 `0600`。不 chmod 整个 Grok 根。
- 不读取、备份、修改 `G/auth.json`，不调用 `grok logout`；不递归删除未知文件。
- remove 必须在线撤销原 endpoint 后才能清凭据和还原配置；失败保留可重试状态。endpoint 变化先 remove 再 configure。
- `integrationKind: auth-command`；`configuration: current|modified|missing|recovery_required`；catalog `host_managed`；schema `not_applicable`。
- 不依赖 Codex #327 / Claude Code #328 整体交付；复用 Codex 已提交的 TOML 编辑代码，只提取纯文本能力，不新增通用静态 Agent 框架或 adapter SDK。
- `toml-eslint-parser` 只在 CLI 共享 TOML 模块导入；Bun负责最终解析验证和新建实验配置序列化。禁止对整份用户文档执行parse后stringify。
- 新实现单文件 <500 行，接近 400 行先按职责拆分。测试 colocate；`index.ts` 只导出。代码步骤遵循 TDD；不增加只复述配置字面量的测试。
- shell 命令一律以 `rtk` 开头；本文命令默认在仓库根执行。每次提交附 `Co-authored-by: Codex <noreply@openai.com>`。
- 最终门槛：`rtk bun run preflight`、受影响 artifact/compatibility 测试和真实宿主验收；缺真实宿主不能把兼容性标成通过。

---

## 实施边界和已核实的依据

这是一个完整 Grok 接入计划。身份、文件事务和 helper 是同一用户旅程的依赖，不拆成独立产品项目。按 Task 1→2→3A→3B→4→5→6→7→8→9→10→11 执行（12个可独立审查的任务），不并行编辑这些相互依赖的模块；选择 subagent 工作流时仍逐任务提交和 review。

已检查当前源码：OAuth 请求函数已经接受 `fetch`、`signal`、`now`、`sleep` 注入；无需复制协议。现有 `packages/core/src/plugins/config-file/lock.ts` 已有 heartbeat、process-start identity、stale recovery、ownership fence，提取这个实现，不使用 DB ownership lock 或 npm install lock。`packages/cli/src/service/service.ts` 的 `resolveExec()` 已解决 stable Homebrew 路径与 Bun 开发启动器识别，提取复用并补足 npm/pnpm 入口约束。

TOML采用Codex已经使用的组合：`toml-eslint-parser@1.0.3`提供AST/source ranges，`Bun.TOML.parse()`验证编辑后的文档。Bun原生parse/stringify不提供保留原注释的文本编辑接口；因此保留一个parser依赖，不分别建设两个编辑器。parser仍仅CLI一个workspace package使用，无需因为两个模块调用它就加入root catalog。声明所需的ESLint类型按现有CLI依赖处理，不引入ESLint runtime。

复用来源是任务 **Add Codex configure target**（`01a084fa-0d23-7503-9fc9-3518b1660b51`）的已提交代码，核对到 `6c30e00ca0c22014fe75f54a2f910cf255c3b0bd`：`packages/cli/src/agent/codex/config-document/{config-document.ts,ast-edits.ts,index.ts,config-document.test.ts}`。该编辑器仍包含 `model_providers`、Provider字段集合和清理判断；不能让Grok直接调用 `editCodexDocument()`。Task3A将纯文本部分提取到同包 `agent/toml-document/`，并迁移Codex调用方；Task3B再接入Grok。

本PR已携带四文件的完整源码补丁及SHA-256校验表，见 [TOML源码基线](../references/grok-toml-baseline/README.md)。上面的commit只记录来源，不再作为必须fetch或解析的前置条件。执行Task3A时从仓库内补丁应用最小源码基线，然后完成提取、删除Codex私有重复实现并验证；不引入向导/会话迁移等整个#327功能。若执行时Codex已合入，保留执行分支的较新代码和回归测试，不覆盖。

共享模块通过显式 `tomlVersion` 选项保留两种宿主契约：Codex `1.1`，Grok `1.0`。这个选项限制源文档和最终文本，不因抽共享模块而悄悄扩大Grok支持范围。

参考：[parser API](https://github.com/ota-meshi/toml-eslint-parser)、[npm 1.0.3](https://www.npmjs.com/package/toml-eslint-parser/v/1.0.3)。宿主文档在 `$GROK_HOME/docs/user-guide/{02-authentication,11-custom-models,26-config-reference}.md`。前期黑盒证据为 `/Users/bytedance/.codex/visualizations/2026/09/09/01a0850c-aa51-7ea3-9e39-37f5becef548/grok-auth-research/REPORT.md` 和 `probe.py`；实现时将可重复的验证逻辑迁入仓库测试，不让测试依赖这个个人路径。

## 文件与职责（先确定边界）

下列花括号表示同目录下逐个文件，不表示另建通用框架。

| 文件 | 改动和唯一职责 |
| --- | --- |
| `packages/types/src/agent-integration/agent-integration.ts` | 四目标身份、client ID；新增三目标 `AgentPluginTargetSchema` / type |
| `packages/core/src/agent-identity/{identity-repository.ts,agent-identity.test.ts,identity-repository.test.ts}` | target 解码、Grok 身份持久化/刷新/撤销回归 |
| `packages/server/src/agent-authorization/{routes.ts,routes.test.ts,device-challenges.ts,device-challenges.test.ts}` | 固定client tuple、真实device flow与token认证 |
| `packages/server/src/server/{server.ts,models-routing.ts,server.models.test.ts}` | 提取现有models协商/分发；Grok AT返回普通目录，插件目标继续要求协商；认证与路由矩阵回归 |
| `packages/core/src/file-lock/{index.ts,file-lock.ts,file-lock.test.ts,abandoned-owner.ts}` | 从 config lock 移入可复用文件锁和遗留 holder 清理；显式 deadline |
| `packages/core/src/plugins/config-file/lock.ts` | 保留原 API/defaults 的薄包装；原 abandoned-owner 移走 |
| `packages/core/src/index.ts` | 导出新的文件锁公共入口，不暴露私有 fence/fs 模块 |
| `packages/cli/src/executable/{index.ts,executable.ts,executable.test.ts}` | 从 service 提取稳定已安装 CLI 入口解析 |
| `packages/cli/src/service/{service.ts,service.test.ts}` | 调用提取后的 resolver，保留服务行为测试 |
| `packages/cli/src/agent/hosts/{hosts.ts,hosts.test.ts}` | 四目标版本发现；Grok 根解析；插件 location 类型收窄 |
| `packages/cli/src/agent/grok/{index.ts,types.ts,grok.ts,grok.test.ts}` | 公共 configure/inspect/remove 和 helper 的受锁安装入口；集成行为测试 |
| `packages/cli/src/agent/toml-document/{index.ts,toml-document.ts,toml-document.test.ts}` | 唯一公开TOML文本接口、版本选择、Bun最终验证及通用行为测试 |
| `packages/cli/src/agent/toml-document/{ast-edits.ts,path-edits.ts}` | 从Codex移入的私有range patch、AST路径定位、inline/table插入删除；不导出到宿主 |
| `packages/cli/src/agent/codex/config-document/{index.ts,config-document.ts,config-document.test.ts}` | 迁移调用共享模块；保留Provider规则和原公开接口；删除旧私有ast-edits.ts |
| `packages/cli/src/agent/grok/{toml.ts,toml.test.ts}` | 调用共享文本接口，管理七字段、别名、原值/最近值及三方恢复；不实现AST/range逻辑 |
| `packages/cli/src/agent/grok/{policy.ts,policy.test.ts}` | 可见环境/requirements/managed config/MDM 的只读冲突检查 |
| `packages/cli/src/agent/grok/{files.ts,files.test.ts}` | Grok 路径归属、原子持久化、inode/内容重查、精确清理 |
| `packages/cli/src/agent/grok/{ownership.ts,ownership.test.ts}` | write-ahead field transaction、崩溃归并、三方还原 |
| `packages/cli/src/agent/grok/test-fixture.ts` | 临时根、假稳定入口、固定 clock 和可控 revoke fixture，只供测试 |
| `packages/cli/src/agent/grok-auth/{index.ts,types.ts,grok-auth.ts,grok-auth.test.ts}` | helper 编排、deadline、并发 revision、交互/静默差异 |
| `packages/cli/src/agent/grok-auth/{credential.ts,credential.test.ts,transport.ts,transport.test.ts}` | 私有凭据格式/refresh journal；安全 fetch 与 runtime 调用 |
| `packages/cli/src/agent/grok-auth/{process.test.ts,process-fixture.ts}` | 真实子进程并发、kill、stdout 断开、remove 竞争 |
| `packages/cli/src/agent/{agent.ts,agent.test.ts,output.ts,output.test.ts,index.ts}` | 新目标 dispatch、列表 union、原生命令及输出 |
| `packages/cli/src/agent/assets/{assets.ts,assets.test.ts}` | 仅插件 target，禁止虚构 Grok assets |
| `packages/cli/src/agent/managed-installation/{install.ts,inspect.ts,remove.ts,test-fixture.ts}` | 输入改为插件 location；实现行为不变 |
| `packages/cli/src/upgrade/{index.ts,detect.ts,upgrade.ts,post-upgrade-agents.ts,post-upgrade-agents.test.ts}` | capture/schema/refresh 仅三个 plugin targets；公开稳定已安装launcher解析操作 |
| `packages/cli/src/{main.ts,main.test.ts}`、`packages/cli/src/update-notify/{update-notify.ts,update-notify.test.ts}` | 注册 auth action；helper 启动流不污染 stdout、不做更新提示工作 |
| `packages/cli/src/agent/grok-compat/{index.ts,grok-compat.ts,grok-compat.test.ts,fixture.ts}` | 显式运行的真实宿主/compiled CLI 验证；loopback fixture |
| `packages/i18n/messages/{en,zh-Hans,zh-Hant,ja,ko}.json` | 同步新诊断、漂移、登录/模型提示文案 |
| `packages/cli/package.json`、`bun.lock` | runtime/parser 直接依赖和显式 compat script；不改 SDK API |
| `docs/superpowers/specs/2026-09-09-grok-build-agent-integration-design.md` | 实现后记录验收状态和证据入口 |
| `docs/superpowers/references/grok-toml-baseline/{README.md,codex-config-document.patch,SHA256SUMS}` | 随本PR发布的四文件源码基线与完整性校验；不依赖本地Git对象 |
| `docs/agent-grok.md` | 用户配置/登录/移除/冲突排查说明 |
| `.changeset/<bun-changeset-generated-name>.md` | 一条 minor release note，实际文件名由命令生成 |

公开模块只经同目录 `index.ts` 导入。`grok-auth` 不导入 `grok/files.ts` 等私有文件：所需受锁 context 和文件操作是 `grok/index.ts` 明确的公开域接口。现有 managed-installation 的 `durable.ts` 是私有，不能跨目录偷用；Grok 的共享 config 写入契约不同，使用 `grok/files.ts` 的小型域实现，沿用相同 open/sync/rename 做法，不抽取通用 storage 框架。

## Task 1: 让 Grok 身份走通现有 device/token/admin 链路

**Files:** 修改types、core identity、server authorization（上表同名文件）；修改 `packages/server/src/server/server.ts`、新建其私有 `models-routing.ts`、更新 `server.models.test.ts`；修改CLI assets/managed-installation/upgrade target类型与现有测试。

**Interfaces:**

```ts
// packages/types/src/agent-integration/agent-integration.ts
export const AgentPluginTargetSchema = z.enum(['opencode', 'pi', 'omp']);
export type AgentPluginTarget = z.infer<typeof AgentPluginTargetSchema>;
export const AgentTargetSchema = z.enum(['opencode', 'pi', 'omp', 'grok']);
export type AgentTarget = z.infer<typeof AgentTargetSchema>;
// 保留原 AGENT_CLIENT_ID，增加 grok: 'aio-proxy-grok'。
// AgentCatalogQuerySchema.agent使用AgentPluginTargetSchema：Grok不协商插件目录。
// AgentClientIdSchema 同时增加 'aio-proxy-grok'，不通过 as 绕过请求校验。
```

Consumes：现有 `createAgentIdentityService()`、`routeFixture()`、`fixture()`（各自现有测试内）；Produces：以上两个 target 类型与 schema。`AgentPluginLocation = AgentLocation & { readonly target: AgentPluginTarget }` 定义于 hosts 并导出；`resolveAgentLocation(target:AgentPluginTarget,deps:AgentHostDeps):Promise<AgentPluginLocation>` 增加overload，通用AgentTarget overload仍返回AgentLocation；插件 assets/install/remove/inspect 和 post-upgrade 输入使用它。公共 host detection 保持 `AgentTarget`。

- [ ] 在现有 identity 测试增加 Grok token 服务重建后仍可认证、client mismatch、refresh rotation、replay 与 revoke 行为。首个回归直接使用已有 fixture：

```ts
test('Grok identity persists across service instances and binds its client', () => {
  const first = fixture({ now: 1_000 });
  const issued = first.service.issueCredential({ ...INPUT, target: 'grok' });
  const next = fixture({ sqlite: first.sqlite, now: 2_000 });
  expect(next.service.authenticateAccessToken(issued.accessToken)).toMatchObject({ status: 'valid' });
  const rotated = next.service.refreshCredential({
    clientId: 'aio-proxy-grok', refreshToken: issued.refreshToken,
  });
  expect(rotated.status).toBe('success');
  expect(next.service.refreshCredential({
    clientId: 'aio-proxy-pi', refreshToken: issued.refreshToken,
  }).status).not.toBe('success');
});
```

- [ ] 在 routes 测试复制现有 device approval 行为用例的输入为 `{...DEVICE_REQUEST, agent:'grok', client_id:'aio-proxy-grok'}`，保留 Dashboard cookie/CSRF 流程；批准后获取 AT，以 AT 请求 `/v1/models` 应返回普通 `{object:'list',data:[...]}`，撤销后不再返回成功。添加未知 `agent:'grok-other'` 被 400 拒绝：

```ts
test('device endpoint accepts the Grok tuple and rejects cross-client use', async () => {
  const f = await routeFixture();
  const request = { ...DEVICE_REQUEST, agent: 'grok', client_id: 'aio-proxy-grok' };
  expect((await f.app.request('/oauth/device/code', form(request), loopbackServer)).status).toBe(200);
  expect((await f.app.request('/oauth/device/code', form({
    ...request, client_id: 'aio-proxy-pi',
  }), loopbackServer)).status).toBe(400);
  expect((await f.app.request('/oauth/device/code', form({
    ...request, agent: 'grok-other',
  }), loopbackServer)).status).toBe(400);
});
```

- [ ] 在现有 `server.models.test.ts` 的describe中声明 `let grok: IssuedAgentCredential`，在beforeEach现有identity实例上签发：`grok = identity.issueCredential({ installationId: randomUUID(), target:'grok', adapterVersion:'1.2.3' })`。添加无插件协商参数的真实handler回归，复用已有app/lockedApp/cache隔离：

```ts
test.each(['/v1/models', '/v1/models?client_version=0.146.0'])(
  'Grok installation receives ordinary models at %s', async path => {
    for (const server of [app, lockedApp]) {
      const response = await server.request(path, {
        headers: { authorization: `Bearer ${grok.accessToken}` },
      }, loopbackServer);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.object).toBe('list');
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThan(0);
      expect(body).not.toHaveProperty('schema_version');
      expect(body).not.toHaveProperty('models');
    }
  },
);
```

当前代码中任意 `agentGrant` 无 `AgentCatalogQuery` 都返回400，这是本任务必须修改的dispatch，不是只扩展身份enum即可通过。

- [ ] 运行 `rtk bun test packages/core/src/agent-identity packages/server/src/agent-authorization packages/server/src/server/server.models.test.ts`。身份扩展前记录target/schema失败；身份扩展后新的Grok models用例应明确复现400而非200，确认覆盖遗漏的分支。

- [ ] 更新身份 schema/client mapping，repository 解码用 `AgentTargetSchema.parse(value)` 替代三个手写分支。服务端继续校验 `AGENT_CLIENT_ID[agent] === client_id`。不新增 DB migration，不改 TTL、replay、family revoke。
- [ ] `server.ts` 当前497行，已包含独立的models协商职责：将 `AgentCatalogQuery`、`ModelsEnv`、`agentQueryFields`、`parseAgentCatalogNegotiation`、`listModelsHandler` 移入同目录私有 `models-routing.ts`，server.ts仅import并保持原路由中间件注册顺序。私有模块导出 `parseAgentCatalogNegotiation:MiddlewareHandler<ModelsEnv>` 与 `listModelsHandler(state:ServerState):MiddlewareHandler<ModelsEnv>`，不经server公共barrel导出。移入相关imports，避免server.ts超过500行。
- [ ] 保留已有query验证、grant/query target mismatch与插件目录协商分支；在“无query但有grant返回400”之前增加Grok分支，并置于client_version路由之前：

```ts
if (query !== null && query !== undefined) {
  if (grant === undefined) return authenticationError(context);
  if (grant.target !== query.agent) {
    return context.json({ error: { code: 'forbidden', message: 'Agent catalog target mismatch.' } }, 403);
  }
  return context.json(await agentCatalog(state, query.agent));
}
if (grant?.target === 'grok') return context.json(await listModels(state));
if (grant !== undefined) {
  return context.json({ error: { code: 'invalid_request', message: 'Invalid Agent catalog negotiation.' } }, 400);
}
if (context.req.query('client_version') !== undefined) {
  return context.json(await codexClientModels(state, { signal: context.req.raw.signal }));
}
return context.json(await listModels(state));
```

`listModels`是现有普通目录实现，不添加Grok私有schema；不能删除整个grant检查、把所有插件AT都放行到普通目录。`requireModelAuthentication`仍在分发前运行，过期/撤销AT不得因Grok分支绕过验证。

- [ ] 在同一models测试文件覆盖：三个插件AT无query仍400；合法协商仍返回schema_version1；Grok AT配插件target query仍403；`agent=grok`协商及畸形query仍400；Grok普通目录不被client_version改成Codex目录；撤销AT后不再200；匿名/static key的原有行为全部保持。保留身份fixture用于撤销调用，并复用已有service revoke方法，不制造假grant绕过认证。运行完整 `server.models.test.ts`，不只运行新增用例。
- [ ] 同一提交中切断枚举扩展对插件循环的影响：

```ts
// post-upgrade schema 与 upgrade capture 均使用这个 schema。
for (const target of AgentPluginTargetSchema.options) {
  const location = await deps.resolveLocation(target);
  const local = await deps.inspect(location, deps.now);
  // 保留原来对 managed/newer/conflict 的处理分支。
}
// assets 的公共签名收窄，不增加 grok 条目。
export async function agentFiles(
  target: AgentPluginTarget, paths: AgentAssetPaths,
): Promise<ReadonlyMap<string, Uint8Array>>;
```

这里仅改原循环的输入类型和 schema，保留循环体。此阶段通用 CLI `parseTarget()` 暂用 `AgentPluginTargetSchema.parse`，Task 9 再开放 Grok command dispatch，避免 Grok 落入 OMP 路径。通用 host 函数中 Grok 明确报“尚未接入”直到 Task 4，不能伪装成 OMP。现有 plugin fixtures/map 明确标注 `AgentPluginTarget`。
- [ ] 运行上述 identity/routes 测试与 `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent/assets packages/cli/src/agent/managed-installation packages/cli/src/upgrade/post-upgrade-agents.test.ts`，预期全部通过。用现有 post-upgrade fixture 加入捕获 target 的断言：Grok marker 存在时仍没有 Grok asset read/install 调用。
- [ ] 提交：`rtk git add packages/types/src/agent-integration packages/core/src/agent-identity packages/server/src/agent-authorization packages/server/src/server/server.ts packages/server/src/server/models-routing.ts packages/server/src/server/server.models.test.ts packages/cli/src/agent packages/cli/src/upgrade`；`rtk git commit -m "feat(agent): support Grok installation identities" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 2: 提取已有文件锁并贯穿总 deadline

**Files:** 新建 core file-lock public entry/implementation/test，移动 `plugins/config-file/abandoned-owner.ts` 到 file-lock；修改 config lock wrapper、core index。保留并运行现有 config-file fencing/recovery 测试。

**Interfaces:** Consumes 现有 `runWithRecoveryFence()`、`processStarttime()`、`processIsAlive()`、`abortableDelay()`；Produces：

```ts
export type FileLockOptions = {
  readonly deadline?: number; // 显式传入时约束整个生命周期；省略时保留旧lock时间语义
  readonly signal?: AbortSignal;
};
export type FileLock = {
  readonly owner: string;
  withOwnership<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T>;
  withOwnershipFence<T>(action: (assertOwnership: () => Promise<void>) => Promise<T>): Promise<T>;
  release(): Promise<void>;
};
export function acquireFileLock(path: string, options?: FileLockOptions): Promise<FileLock>;
// 实现参数默认 options = {}。
```

- [ ] 写真实争用用例，约束第二个 holder 遵循调用者 deadline：

```ts
test('a contending owner cannot wait past its supplied deadline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'grok-lock-'));
  const path = join(root, '.aio-proxy.lock');
  const first = await acquireFileLock(path);
  try {
    const started = Date.now();
    await expect(acquireFileLock(path, {
      deadline: started + 120, signal: AbortSignal.timeout(120),
    })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(1_000);
    await first.withOwnership(async (assertOwned) => { await assertOwned(); });
  } finally {
    await first.release();
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] `rtk bun test packages/core/src/file-lock/file-lock.test.ts` 预期 missing export 失败。
- [ ] 将现有锁实现原样移入 `file-lock.ts`，只将配置特有名称改为通用名称、将固定等待终点改为一个调用者 deadline。保留 heartbeat 10_000ms、stale 60_000ms 和 alive/starttime/fence 判断。显式传入deadline时，acquire、withOwnershipFence、release共享signal/deadline；省略时保留现有config lock的acquire等待15秒、后续fence各自15秒语义，不让提取改变旧配置操作：

```ts
// 显式budget分支：整个生命周期不重置deadline。
const lifetimeDeadline = options.deadline;
const acquireDeadline = lifetimeDeadline ?? Date.now() + 15_000;
const signal = lifetimeDeadline === undefined ? options.signal :
  AbortSignal.any([
    ...(options.signal === undefined ? [] : [options.signal]),
    AbortSignal.timeout(Math.max(0, lifetimeDeadline - Date.now())),
  ]);
// acquire fence使用acquireDeadline。
// ownership/release fence使用 lifetimeDeadline ?? Date.now() + 15_000；
// 未指定lifetimeDeadline时不把acquire专用signal传给release，保持旧API语义。
// 显式budget取消后release记录abandoned、关handle、停heartbeat，不无界争用。
```

config wrapper：`acquireConfigLock(path, signal)` 转调 `acquireFileLock(path,{signal})`，导出旧 constants/type aliases；不得借机重写 config-file、npm 或 DB 锁。
- [ ] 增加 deadline 在 fence/release 中耗尽的用例；进程仍活着但锁已被替换时旧 owner 不得写入或 unlink 新锁。用原 config fencing 测试的 race hook/进程 fixture，验收 assertOwnership 失败而新 holder 文件存在。确保“取消的异步写入”不是 Promise.race 后继续后台写入；写入边界检查 signal+fence。
- [ ] `rtk bun test packages/core/src/file-lock packages/core/src/plugins/config-file` 预期通过。Task 10 另验收跨进程 kill/recovery。
- [ ] `rtk git add packages/core/src/file-lock packages/core/src/plugins/config-file packages/core/src/index.ts`；`rtk git commit -m "refactor(core): reuse fenced file locks with deadlines" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 3A: 提取共享 TOML 文本编辑器并迁移 Codex 调用方

**Files:**

- Create: `packages/cli/src/agent/toml-document/index.ts`、`toml-document.ts`、`toml-document.test.ts`、`ast-edits.ts`、`path-edits.ts`。
- Modify: `packages/cli/src/agent/codex/config-document/config-document.ts`、`index.ts`、`config-document.test.ts`（当前执行分支不存在时，先整合下面指定的已提交四文件基线）。
- Remove after moving: `packages/cli/src/agent/codex/config-document/ast-edits.ts`。
- Modify: `packages/cli/package.json`、`bun.lock`，保持一个 `toml-eslint-parser@1.0.3` runtime dependency。

**Interfaces:** Consumes已提交的Codex `applySourceEdits`、`applyInlineOperations`、`walkKeyValues`、table/inline定位与插入逻辑，和parser AST。Produces下列唯一公共文本接口；从 `toml-document/index.ts` 导出，内部不认识Codex/Grok/Provider/installation：

```ts
export type TomlPath = readonly string[];
export type TomlScalar = string | boolean;
export type TomlSyntax = { readonly tomlVersion: '1.0' | '1.1' };
export type TomlSlot = { readonly present: false } | {
  readonly present: true; readonly value: TomlScalar; readonly raw: string;
};
export type TomlFieldEdit = {
  readonly path: TomlPath;
  readonly next: { readonly present: false } | {
    readonly present: true; readonly value: TomlScalar; readonly raw?: string;
  };
};
export type TomlEditOptions = TomlSyntax & { readonly removeEmptyTables?: readonly TomlPath[] };
export type TomlEditResult = { readonly text: string; readonly createdTables: readonly TomlPath[] };
export function readTomlField(text: string, path: TomlPath, syntax: TomlSyntax): TomlSlot;
export function inspectTomlPaths(text: string, syntax: TomlSyntax): {
  readonly fieldPaths: readonly TomlPath[]; readonly tablePaths: readonly TomlPath[];
};
export function editTomlFields(text: string, edits: readonly TomlFieldEdit[], options: TomlEditOptions): TomlEditResult;
```

`TomlScalar`只覆盖两个已知调用方使用的string/boolean。其它合法TOML值原文透传，但读取它们作为受管scalar时明确报类型错误；不为假想第三宿主扩充复杂值序列化。显式 `next.present=false` 删除精确path对应的节点；删除table subtree需要调用方明确请求该path，shared不会推断归属。`removeEmptyTables`只修剪所列的、编辑后确实为空且无子表的表头，不扫描删除用户空表。`createdTables`只记录此次新增的显式标准表头；inline容器的叶子删除不引入整表归属。

- [ ] **Step 1：从本PR携带的源码补丁建立基线。** 执行分支无Codex config-document目录时运行以下命令；补丁只新增四个文件，check失败就停止应用，不能覆盖执行分支已有代码。不需要本地来源commit对象或另一个任务的工作树：

```sh
rtk git apply --check docs/superpowers/references/grok-toml-baseline/codex-config-document.patch
rtk git apply docs/superpowers/references/grok-toml-baseline/codex-config-document.patch
rtk proxy shasum -a 256 -c docs/superpowers/references/grok-toml-baseline/SHA256SUMS
```

目录已存在则跳过补丁，以执行分支现有版本为基线。仅当CLI尚未声明parser依赖时运行 `rtk bun add --cwd packages/cli --exact toml-eslint-parser@1.0.3`；否则保留已有同版本声明。执行 `rtk bun test packages/cli/src/agent/codex/config-document` 确认原行为基线，不把基线失败当新功能RED。校验表只验证补丁的原始文件，后续提取重构不要求保留其字节hash。
- [ ] **Step 2：写能同时覆盖两种宿主形状的共享接口失败测试。** 测试不mockparser，不只比较静态常量：

```ts
import { expect, test } from 'bun:test';
import { editTomlFields, readTomlField } from './index';

test.each([
  { source: '# keep\n[auth]\nauth_provider_label = \'Cloud\' # tail\n[ui]\ntheme="dark"\n',
    path: ['auth', 'auth_provider_label'], value: 'AIO Proxy', preserved: '[ui]\ntheme="dark"\n',
    tomlVersion: '1.0' as const },
  { source: '# keep\n[model_providers."proxy.team"]\nname = \'Cloud\' # tail\n[mcp_servers.local]\ncommand="mcp"\n',
    path: ['model_providers', 'proxy.team', 'name'], value: 'aio-proxy',
    preserved: '[mcp_servers.local]\ncommand="mcp"\n', tomlVersion: '1.1' as const },
])('edits $path while preserving surrounding bytes', ({source, path, value, preserved, tomlVersion}) => {
  const syntax = { tomlVersion };
  const original = readTomlField(source, path, syntax);
  const changed = editTomlFields(source, [{ path, next: { present: true, value } }], syntax);
  expect(changed.text).toContain('# keep\n');
  expect(changed.text).toContain('# tail\n');
  expect(changed.text).toContain(preserved);
  expect(readTomlField(changed.text, path, syntax)).toMatchObject({ present: true, value });
  const restored = editTomlFields(changed.text, [{ path, next: original }], syntax);
  expect(restored.text).toBe(source);
});

test('inserts multiple leaves into one inline table without losing unrelated members', () => {
  const source = 'endpoints = { other = "keep,comma" } # tail\n';
  const result = editTomlFields(source, [
    { path: ['endpoints','models_base_url'], next: { present: true, value: 'http://127.0.0.1:9317/v1' } },
    { path: ['endpoints','models_list_url'], next: { present: true, value: 'http://127.0.0.1:9317/v1/models' } },
  ], { tomlVersion: '1.0' });
  expect(result.text).toContain('other = "keep,comma"');
  expect(result.text).toContain('# tail\n');
  expect(Bun.TOML.parse(result.text).endpoints.models_list_url.endsWith('/v1/models')).toBe(true);
});
```

- [ ] **Step 3：运行新测试确认RED。** `rtk bun test packages/cli/src/agent/toml-document/toml-document.test.ts`，预期共享模块/导出尚不存在；保留Step1原Codex测试通过的证据。
- [ ] **Step 4：移动底层操作，建立唯一AST入口。** 从Codex移入 `ast-edits.ts`，保留同offset插入合并、降序patch、inline局部合并。将 `walkKeyValues`、`inspectDocument`、`findValue/findTable/findInlineContainer` 和一般表/inline插入移入 `path-edits.ts`，移除其中 `model_providers` 字面量与Provider字段集合。共享入口负责parse/version/read/edit/最终验证；不能在Codex和Grok各自保留副本。

```ts
// toml-document.ts 私有入口；AST不对宿主export。
function parseDocument(text: string, syntax: TomlSyntax): AST.TOMLProgram {
  try { return parseTOML(text, { tomlVersion: syntax.tomlVersion }); }
  catch { throw new Error('Invalid TOML document'); }
}
function validateFinalDocument(text: string, syntax: TomlSyntax): void {
  parseDocument(text, syntax);
  try { Bun.TOML.parse(text); }
  catch { throw new Error('Edited TOML document is invalid'); }
}
```

parser异常可能带原文，不能附到公共错误里。`inspectTomlPaths`在walk时收集解码的key segments、显式表/inline容器以及dotted隐式父路径；所有path比较逐segment或JSON.stringify，不使用点号连接来标识。
- [ ] **Step 5：保留Codex已验证的patch实现并补输入边界。** 在原 `applySourceEdits(source,edits)` 入口检查整数与范围，继续使用已有同offset合并/降序应用，不另写Grok applyPatches：

```ts
for (const edit of edits) {
  if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) ||
      edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
    throw new Error('Invalid TOML edit range');
  }
}
```

多个inline成员删除可能产生交叉逗号范围：先按同一parent AST member列表把相邻删除归并，再生成互不重叠patch；不单独拼几次inlineMemberDelete后假定它们不交叉。patch测试必须覆盖一次删除前两个/后两个/全部成员，而非只有每次删一个。
- [ ] **Step 6：将path编辑泛化到已知的两类字段深度。** 已有节点仅改value.range；缺失叶子找到最近已存在父table或inline容器，按其原语法插入；没有父table时创建quoted dotted表头并记录createdTables。祖先是scalar/array或array-table歧义时明确失败。所有新增节点通过解码path和AST容器定位；不使用正则猜TOML结构。普通与inline操作统一输出SourceEdit，由原applySourceEdits应用。

精确恢复时 `next.raw` 是已保存的单值字面量：用 `readTomlField('value = '+raw,['value'],syntax)` 验证其parsed value与next.value一致，并检查该临时文档只有一个scalar赋值、raw无额外语句/注释，才允许原样替换。没有raw且parsed value未变化时保持现有字面量，不重写引号。编码新string/boolean沿用移入的encoder并通过最终双重解析验证。
- [ ] **Step 7：把空表清理限制为调用方提供的路径。** 先应用leaf edits，再解析新文本确认removeEmptyTables各path确实没有KV/子表；仅删表头对应范围，保留周围注释/空行。新增用户字段后该表不能被删。返回createdTables供Grok记录，共享层不读取ownership文件。
- [ ] **Step 8：迁移Codex适配层，保持其公共接口。** `codexProviderEdits`、`validateCodexProviderId`、`readCodexDocument`的Provider发现规则与清理许可仍留Codex。底层 `readManagedField` 转为共享读取并去掉raw，保证调用方原返回shape不变：

```ts
export function readManagedField(text: string, path: readonly string[]): ValueSlot {
  const slot = readTomlField(text, path, { tomlVersion: '1.1' });
  return slot.present ? { present: true, value: slot.value } : { present: false };
}
export function editCodexDocument(text: string, edits: readonly FieldEdit[]): string {
  const removeEmptyTables = codexCleanupPaths(text, edits);
  return editTomlFields(text, edits, { tomlVersion: '1.1', removeEmptyTables }).text;
}
```

`codexCleanupPaths(text:string,edits:readonly FieldEdit[]):readonly TomlPath[]` 是从现有providerTableCleanup判定提取的Codex私有函数：只考虑`['model_providers',id]`，显式整表删除或该表原来仅含五个已知受管字段且本轮全部删除时允许修剪；存在用户custom字段不加入列表。用 `inspectTomlPaths` 和共享read API实现判定，不再次parseAST；已有module的错误分类/Provider发现顺序继续测试。明确删除整个inline Provider的existing API仍由精确path edit处理，不扩大Grok管理范围。
- [ ] **Step 9：补语法差异与两个调用方回归。** 原Codex用例全部保留；共享测试补quoted/dotted keys、LF/CRLF、嵌套inline表、同一inline父容器下同时新增两个不同子表、连续成员删除、原raw恢复、非法raw注入、重复keys、array歧义、空表白名单和外部用户字段。Grok语法1.0拒绝TOML1.1新增语法，Codex1.1保留接受；新测试都检查用户可见结果而非配置常量。

```ts
test('prunes only caller-owned empty tables', () => {
  const source = '[auth]\nlabel="managed"\n\n[user_empty]\n';
  const result = editTomlFields(source, [{path:['auth','label'],next:{present:false}}], {
    tomlVersion: '1.0', removeEmptyTables: [['auth']],
  });
  expect(result.text).not.toContain('[auth]');
  expect(result.text).toContain('[user_empty]');
});
```

- [ ] **Step 10：运行共享与Codex测试及类型检查。** `rtk bun test packages/cli/src/agent/toml-document packages/cli/src/agent/codex/config-document`、`rtk bun run lint:types`，预期通过。执行 `rtk rg -n 'toml-eslint-parser|applySourceEdits|applyInlineOperations' packages/cli/src/agent`，确认production parser/patch实现只在共享模块，宿主不导入其私有文件。禁止通过直接引用另一工作树文件让测试通过。
- [ ] **Step 11：提交一个完整可review的提取。** 仅包含共享模块、Codex最小调用方迁移和依赖；删除旧Codex ast-edits（git add -A该路径纳入删除）。

```sh
rtk git add packages/cli/src/agent/toml-document packages/cli/package.json bun.lock
rtk git add -A packages/cli/src/agent/codex/config-document
rtk git commit -m "refactor(cli): share source-preserving TOML editing" -m "Co-authored-by: Codex <noreply@openai.com>"
```

## Task 3B: 使用共享编辑器管理 Grok 字段归属

**Files:** 新建 `packages/cli/src/agent/grok/{types.ts,toml.ts,toml.test.ts}`；CLI package/bun.lock仅补runtime直接依赖，parser已由Task3A声明。

**Interfaces:** Consumes Task3A的 `readTomlField()`、`editTomlFields()`、`inspectTomlPaths()`，全部经 `../toml-document` 导入并显式传 `{tomlVersion:'1.0'}`；不导入parser或Codex私有模块。Produces下列Grok领域纯函数（Grok内部使用）：

```ts
export type GrokPath = readonly string[];
export type LeafValue = { readonly present: false } |
  { readonly present: true; readonly value: string; readonly raw: string };
export type OwnedLeaf = {
  readonly path: GrokPath; readonly original: LeafValue; readonly written: LeafValue;
};
export type FieldChange = { readonly path: GrokPath; readonly before: LeafValue; readonly after: LeafValue };
export type TomlEdit = {
  readonly text: string; readonly leaves: readonly OwnedLeaf[];
  readonly createdTables: readonly GrokPath[]; readonly changes: readonly FieldChange[];
  readonly skipped: readonly string[];
};
export function configureGrokToml(text: string, endpoint: string, command: string,
  previous?: { readonly leaves: readonly OwnedLeaf[]; readonly createdTables: readonly GrokPath[] }): TomlEdit;
export function restoreGrokToml(text: string, leaves: readonly OwnedLeaf[],
  createdTables: readonly GrokPath[]): TomlEdit;
export function readGrokLeaf(text: string, path: GrokPath): LeafValue;
export function equalGrokLeaf(a: LeafValue, b: LeafValue): boolean;
```

`LeafValue` 只支持受管字段的 string 或 absence；受管位置是 number/array/table 时明确 `unsupported_managed_value`，不做有损转换。snapshot 的 raw 只含这个叶子值，不能存整个 table/config。比较使用 parsed string，恢复时使用原 raw；JSON 的 `undefined` 不表示 absence。

- [ ] CLI dependencies补 `@aio-proxy/agent-provider-runtime: "workspace:*"`，`rtk bun install`；保留Task3A已有parser依赖，不再添加另一个TOML库。
- [ ] 写保留字节、三方还原和漂移测试：

```ts
test('restores owned leaves but preserves later user edits and comments', () => {
  const input = '# mine\n[auth]\nauth_provider_label = \'Cloud\' # label\n[ui]\ntheme = "dark"\n';
  const first = configureGrokToml(input, 'http://127.0.0.1:9317', "'/opt/bin/aio-proxy' agent auth grok --installation-id x");
  expect(first.text).toContain('# mine\n');
  expect(first.text).toContain('# label\n[ui]\ntheme = "dark"\n');
  const edited = first.text.replace('"AIO Proxy"', '"Personal"');
  const restored = restoreGrokToml(edited, first.leaves, first.createdTables);
  expect(restored.text).toContain('auth_provider_label = "Personal"');
  expect(restored.text).not.toContain('models_base_url');
  expect(restored.skipped).toContain('auth.auth_provider_label');
  expect(restored.text).toContain('[ui]\ntheme = "dark"');
});
test('rejects ambiguous catalog aliases before producing a patch', () => {
  const text = '[endpoints]\nmodels_list_url="one"\nmodels_endpoint="two"\n';
  expect(() => configureGrokToml(text, 'http://127.0.0.1:9317', 'command')).toThrow(/alias/);
});
```

- [ ] `rtk bun test packages/cli/src/agent/grok/toml.test.ts` 预期Grok领域exports缺失失败；Task3A共享与Codex测试应仍通过。
- [ ] 用共享读取接口构造Grok snapshot；保留原raw值，不重新做AST遍历：

```ts
import { readTomlField, editTomlFields, inspectTomlPaths, type TomlFieldEdit } from '../toml-document';

function readGrokLeaf(text: string, path: GrokPath): LeafValue {
  const slot = readTomlField(text, path, { tomlVersion: '1.0' });
  if (!slot.present) return { present: false };
  if (typeof slot.value !== 'string') throw new Error(`unsupported_managed_value: ${path.join('.')}`);
  return { present: true, value: slot.value, raw: slot.raw };
}
function equalGrokLeaf(a: LeafValue, b: LeafValue): boolean {
  return a.present === b.present && (!a.present || (b.present && a.value === b.value));
}
function applyGrokChanges(text: string, changes: readonly FieldChange[], emptyTables: readonly GrokPath[]) {
  const edits: TomlFieldEdit[] = changes.map(change => ({ path: change.path, next: change.after }));
  return editTomlFields(text, edits, { tomlVersion: '1.0', removeEmptyTables: emptyTables });
}
```

`configureGrokToml`先用desired值生成不带raw的TomlFieldEdit并调用editTomlFields，再从结果读取written及其raw，构造完整FieldChange，把createdTables并入ownership。`applyGrokChanges`用于已有before/after快照的事务重试和还原，不能在新值尚未编码前虚构raw。`restoreGrokToml`传入原ownership的createdTables作为唯一允许清空表头的列表；不自行拼接/扫描文本。`inspectTomlPaths`返回解码的segment数组用于auth表/别名存在性，带点quoted key不得拆分。
- [ ] 实现七字段值表（E是canonical origin，command已shell-quoted）：

```ts
const desired = {
  endpoints: {
    models_base_url: `${endpoint}/v1`, models_list_url: `${endpoint}/v1/models`,
    cli_chat_proxy_base_url: endpoint, xai_api_base_url: `${endpoint}/v1`,
    managed_config_url: `${endpoint}/__grok_unavailable/managed-config`,
  },
  auth: { auth_provider_command: command, auth_provider_label: 'AIO Proxy' },
};
```

- [ ] 实现 alias 选择。alias 冲突按同语义叶子检测；只出现 `[grok_com_config]` 时 command/label 写在那里，否则 `[auth]`。catalog alias 单独存在则原地使用。同语义两条同时存在直接失败。写入值为spec七项，交给共享编辑器编码和验证；Grok不再有第二套字符串encoder。新写值的raw从最终文本用readGrokLeaf读取；restore传original.raw，保留原有引号写法。
- [ ] 将Grok插入/替换/删除全部交给Task3A的 `editTomlFields`。本任务仅负责判定哪个实际alias path归本安装、生成FieldChange和记录createdTables；不新增 `Patch`、`applyPatches`、`indexGrokToml`、inline逗号处理等重复实现。
- [ ] 实现 restore：逐字段只在 current==written 时还原 original，original absent 则删当前 KV；不同或被删的值原样保留并列入 skipped。只删除 `createdTables` 中现在没有 KV/子表的表头，保留附着的用户注释，不删除 config 文件。reconfigure 所有叶子先比 current==written；任一漂移则整体拒绝，不重设 original。
- [ ] 扩展同一文件参数化行为案例：无文件视作空串；LF/CRLF；quoted/dotted key；`endpoints={models_base_url="old",other=1}`；单独 alias；两 auth 表各占不同受管字段；非法 TOML；数组和非 string 受管值；user field 新增；`[models].default` 全程逐字不变。每例检查无关原始片段和 reparse 的最终有效值，不能仅 snapshot 七常量。
- [ ] `rtk bun test packages/cli/src/agent/toml-document packages/cli/src/agent/codex/config-document packages/cli/src/agent/grok/toml.test.ts` 和 `rtk bun run lint:types` 预期通过；声明类型依赖问题按本计划的依赖说明解决。
- [ ] `rtk git add packages/cli/package.json bun.lock packages/cli/src/agent/grok`；`rtk git commit -m "feat(agent): preserve Grok TOML field ownership" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 4: 定位 Grok 根和稳定入口，拒绝可见路由冲突

**Files:** hosts、executable、service、`upgrade/{index.ts,detect.ts}`，以及 `grok/{policy.ts,policy.test.ts}`。`executable/index.ts` 导出 resolver；`hosts/index.ts` 导出路径函数。

**Interfaces:** Consumes 现有 `AgentHostDeps`、`resolveExec()` 实现和 `resolveStableManagedExec()`；Produces：

```ts
export function resolveGrokRoot(env: Readonly<Record<string, string | undefined>>, home: string): string;
export function resolveAgentExecutable(
  which?: (name: string) => string | null, execPath?: string,
  realpath?: (path: string) => string, exists?: (path: string) => boolean,
): string;
// executable公开Grok严格入口；upgrade公开已安装launcher业务操作。
export function resolveGrokExecutable(): Promise<string>;
export function resolveInstalledLauncher(executable: string): Promise<string>;
// grok/policy.ts 私有；读取器不读取 auth.json。
export type GrokPolicySource = { readonly path: string; readonly text: string; readonly kind: 'toml' | 'json' };
export type GrokVisiblePolicy = {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sources: readonly GrokPolicySource[];
};
export function checkGrokPolicy(text: string, endpoint: string, command: string,
  policy: GrokVisiblePolicy): readonly string[]; // 冲突字段路径，不含值或 secret
export function readGrokPolicy(root: string,
  env: Readonly<Record<string, string | undefined>>): Promise<GrokVisiblePolicy>;
export function grokAuthCommand(executable: string, installationId: string): string;
```

- [ ] 写路径和 shell 参数实际执行测试，不只是字符串 snapshot：

```ts
test('Grok root inherits an absolute or home-expanded override', () => {
  expect(resolveGrokRoot({}, '/users/test')).toBe('/users/test/.grok');
  expect(resolveGrokRoot({ GROK_HOME: '~/work/grok' }, '/users/test')).toBe('/users/test/work/grok');
  expect(() => resolveGrokRoot({ GROK_HOME: './grok' }, '/users/test')).toThrow(/absolute/);
});
test('quoted helper command passes the exact installation id', async () => {
  const root = await mkdtemp(join(tmpdir(), "grok entry ' "));
  const exe = join(root, 'aio-proxy');
  try {
    await writeFile(exe, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const child = Bun.spawn(['/bin/sh', '-c', grokAuthCommand(exe, '11111111-1111-4111-8111-111111111111')], { stdout: 'pipe' });
    expect(await new Response(child.stdout).text()).toBe('agent\nauth\ngrok\n--installation-id\n11111111-1111-4111-8111-111111111111\n');
    expect(await child.exited).toBe(0);
  } finally { await rm(root, { recursive: true, force: true }); }
});
```

- [ ] 运行 `rtk bun test packages/cli/src/agent/hosts packages/cli/src/agent/grok/policy.test.ts packages/cli/src/executable`，预期新函数缺失。实现根规则：unset/empty→home/.grok；`~/` 显式展开；其他输入必须 `isAbsolute`（裸 `~` 也不接受）。Grok 版本只取 `grok 1.0.24 (hash) [stable]` 中 semver 段，再用现有 Bun.semver 验证；保留旧目标解析。
- [ ] 从service提取原 `resolveExec` 为同步 `resolveAgentExecutable`，service保留re-export alias，维持现有行为。在upgrade目录内增加 `resolveInstalledLauncher(executable:string):Promise<string>`，调用已有 `resolveUpgradeTargetFrom()`：binary返回target.path，包管理器返回target.bin；若只能解析到版本缓存/native package路径而不是稳定launcher，则明确失败。通过upgrade/index公开这个业务操作，executable模块不直接导入upgrade的私有detect/package-ownership文件。
- [ ] Grok专属严格resolver使用 `resolveAgentExecutable()` 找到候选，再await `resolveInstalledLauncher()`；Homebrew始终保存稳定prefix入口，npm/pnpm验证launcher归属；standalone允许稳定的绝对binary。Bun dev启动器不可保存，PATH只能回退到已有aio-proxy发布入口。用Homebrew symlink retarget、npm launcher、pnpm shim、Bun dev四种fixture验证；service resolver的已有测试保持原行为。

```ts
export async function resolveGrokExecutable(): Promise<string> {
  const candidate = resolveAgentExecutable();
  const launcher = await resolveInstalledLauncher(candidate);
  if (!isAbsolute(launcher)) throw new Error('No stable aio-proxy launcher');
  return launcher;
}
```

- [ ] 实现 POSIX quoting，适用已验证 macOS 宿主：

```ts
function grokAuthCommand(executable: string, installationId: string): string {
  if (!isAbsolute(executable) || executable.includes('\0')) throw new Error('invalid CLI entry');
  const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'";
  return [executable, 'agent', 'auth', 'grok', '--installation-id', installationId].map(quote).join(' ');
}
```

Windows 不复用 POSIX quoting；当前发布包无 Windows binary。本期兼容声明只写真实验证的平台，Linux shell 路径可测试但不能仅据此宣布 Grok Linux 验收通过。
- [ ] 实现 policy 读取：`root/managed_config.toml`、`/etc/grok/managed_config.toml`、`root/requirements.toml`、`/etc/grok/requirements.toml`；`GROK_CONFIG` inline JSON、`GROK_CONFIG_PATH` 指定 JSON/TOML。macOS 以 `defaults export ai.x.grok -` 读取可见 domain，并用 `plutil -convert json -o - -` 解析 stdin 输出；无 domain 视作 absent，存在但无法读取/解析返回可见 policy 不可验证错误。每个子进程设超时并回收，输出不进日志。不存在文件可跳过，存在但非法/不可读不能静默忽略。
- [ ] 只解释 spec 相关叶子和 model/provider endpoints，遵循宿主 documented precedence（requirements pin 对抗 env，user config 覆盖 managed user keys）。检查七字段的 `GROK_*` env 对应值；不同值产生字段冲突，同值允许。按已核实的宿主优先级检查实际冲突：per-model api_key/env_key/auth_provider以及extra_headers/env_http_headers中的Authorization覆盖高于global session，生效时报告该字段；XAI_API_KEY只是无session时fallback，OIDC低于external helper，不能仅因它们存在就拒绝。强制team/relay若与当前登录方式冲突则报具体字段，不清空环境。用户配置和可见覆盖中的 `model.*.base_url`、`model.*.api_base_url`、`model_providers.*.base_url`、`model_providers.*.api_base_url` 解析 URL，与 E 的 origin 不同或不可解析时拒绝；不递归把所有字符串当 URL。
- [ ] 添加行为测试：env 外部 URL、相同 origin 值、alias requirements、无关 UI/MCP 设置、显式外部模型、自定义同 origin 模型、不可读 policy。断言返回字段名并且输入 config 未变；不要把外部 API Key 或完整 policy 放进错误。
- [ ] `rtk bun test packages/cli/src/agent/hosts packages/cli/src/agent/grok/policy.test.ts packages/cli/src/executable packages/cli/src/service/service.test.ts` 预期通过。
- [ ] `rtk git add packages/cli/src/executable packages/cli/src/service packages/cli/src/upgrade/index.ts packages/cli/src/upgrade/detect.ts packages/cli/src/agent/hosts packages/cli/src/agent/grok/policy.ts packages/cli/src/agent/grok/policy.test.ts`；`rtk git commit -m "feat(agent): resolve safe Grok configuration and helper entry" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 5: 安全文件写入与可恢复 configure 事务

**Files:** `grok/{index.ts,types.ts,files.ts,files.test.ts,ownership.ts,ownership.test.ts,grok.ts,grok.test.ts,test-fixture.ts}`。

**Interfaces:** Consumes Tasks 2–4；Produces 下列稳定域接口，`GrokContext` 经 public index 暴露给 helper，文件实现仍私有。

```ts
export type GrokMarker = AgentManagedMarker & { readonly agent: 'grok' };
export type GrokDeadline = { readonly deadline: number; readonly signal: AbortSignal };
export type GrokTransaction = {
  readonly operation: 'configure' | 'remove';
  readonly changes: readonly FieldChange[];
  readonly nextLeaves: readonly OwnedLeaf[];
  readonly nextCreatedTables: readonly GrokPath[];
};
export type GrokOwnership = {
  readonly format: 1; readonly agent: 'grok'; readonly installationId: string; readonly endpoint: string;
  readonly status: 'active' | 'removing'; readonly leaves: readonly OwnedLeaf[];
  readonly createdTables: readonly GrokPath[]; readonly pending?: GrokTransaction;
  readonly cleanupComplete?: true; // 只允许status=removing且pending不存在，已撤销且还原完成
};
export type GrokConfigureInput = {
  readonly root: string; readonly endpoint: string; readonly executable: string; readonly adapterVersion: string;
};
export type GrokDeps = {
  readonly now: () => number; readonly randomUUID: () => string;
  readonly policy: (root: string) => Promise<GrokVisiblePolicy>;
  readonly revoke: (endpoint: string, installationId: string) => Promise<AgentRevokeStatus>;
};
export type GrokInspection = {
  readonly integrationKind: 'auth-command';
  readonly integration: 'absent' | 'managed' | 'conflict' | 'newer';
  readonly marker?: GrokMarker;
  readonly configuration: 'current' | 'modified' | 'missing' | 'recovery_required';
  readonly fields: readonly string[];
};
export type GrokContext = {
  readonly marker: GrokMarker; readonly root: string; readonly budget: GrokDeadline;
  readonly assertOwnership: () => Promise<void>;
  readCredential(): Promise<unknown | undefined>;
  writeCredential(value: unknown): Promise<void>;
  clearCredential(): Promise<void>;
};
export function configureGrok(input: GrokConfigureInput, deps: GrokDeps): Promise<{
  readonly marker: GrokMarker; readonly status: 'installed' | 'updated' | 'newer';
}>;
export function inspectGrok(root: string, adapterVersion: string): Promise<GrokInspection>;
export function withGrokInstallation<T>(input: {
  readonly root: string; readonly installationId: string; readonly adapterVersion: string;
  readonly budget: GrokDeadline;
}, action: (context: GrokContext) => Promise<T>): Promise<T>;
```

`withGrokInstallation` 用于 auth：拿锁→重读→校验身份和版本→恢复 ownership transaction→要求 active/current→调用 action；不允许配置漂移时认证。remove 的内部路径允许 modified 状态，但使用相同恢复和锁。list 仅 `inspectGrok`，绝不调用恢复函数。

私有文件接口：

```ts
type GrokFileSnapshot = { readonly text: string; readonly dev: number; readonly ino: number; readonly mode: number };
function readGrokFile(path: string): Promise<GrokFileSnapshot | undefined>;
function replaceGrokFile(path: string, text: string, expected: GrokFileSnapshot | undefined,
  budget: GrokDeadline, assertOwnership: () => Promise<void>): Promise<void>;
function recoverGrokOwnership(text: string, ownership: GrokOwnership): {
  readonly ownership: GrokOwnership; readonly conflicts: readonly string[];
};
```

- [ ] 在 test-fixture 定义一个真正临时的集成 fixture：

```ts
export async function grokFixture() {
  const root = await mkdtemp(join(tmpdir(), 'aio-grok-'));
  const revoked: Array<{ endpoint: string; installationId: string }> = [];
  let now = Date.now();
  const deps: GrokDeps = {
    now: () => now,
    randomUUID: () => '11111111-1111-4111-8111-111111111111',
    policy: async () => ({ env: {}, sources: [] }),
    revoke: async (endpoint, installationId) => { revoked.push({ endpoint, installationId }); return 'revoked'; },
  };
  const input: GrokConfigureInput = {
    root, endpoint: 'http://127.0.0.1:9317', executable: '/opt/bin/aio-proxy', adapterVersion: '0.21.0',
  };
  return { root, deps, input, revoked, setNow: (value: number) => { now = value; },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
```

fixture executable 是 configure 输入已解析的 stable entry；Task 4 独立验证 resolver，Task 11 artifact 验证真实入口。每个测试 finally cleanup，避免清理用户根。
- [ ] 写重复 configure 和 drift 用例：

```ts
test('configure preserves the first baseline and refuses user drift', async () => {
  const f = await grokFixture();
  try {
    const config = join(f.root, 'config.toml');
    await writeFile(config, '[ui]\ntheme="dark"\n', { mode: 0o640 });
    const first = await configureGrok(f.input, f.deps);
    const second = await configureGrok(f.input, f.deps);
    expect(second.marker.installationId).toBe(first.marker.installationId);
    expect((await stat(config)).mode & 0o777).toBe(0o640);
    const owned = await readFile(config, 'utf8');
    await writeFile(config, owned.replace('"AIO Proxy"', '"Mine"'));
    await expect(configureGrok(f.input, f.deps)).rejects.toThrow(/modified/);
    expect((await inspectGrok(f.root, f.input.adapterVersion)).marker?.installationId).toBe(first.marker.installationId);
    expect(await readFile(config, 'utf8')).toContain('"Mine"');
  } finally { await f.cleanup(); }
});
```

- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent/grok` 预期未实现的新入口失败。
- [ ] 实现 files：lstat 检查 root、private dir、各受管文件；拒绝 symlink/non-regular/hardlink（nlink!=1）、非当前用户拥有的 private 路径和 group/world writable private 文件；config 已有权限保留。读取用 `open(O_RDONLY|O_NOFOLLOW)`，fstat 对照 lstat；不存在和空文件区别保留。写 tmp `wx/0600`，write+sync+close，写前再比较原 inode/content，已存在 config 的 mode 复制到 tmp；拿 fence 最后重查并 rename，同目录 fsync。新建 root 不 chmod 已有 root；private dir 创建 0700。

```ts
// replaceGrokFile 中每次正式 rename 前的关键检查。
budget.signal.throwIfAborted();
await assertOwnership();
const current = await readGrokFile(path);
const unchanged = expected === undefined ? current === undefined :
  current !== undefined && current.dev === expected.dev && current.ino === expected.ino &&
  current.text === expected.text && current.mode === expected.mode;
if (!unchanged) throw new Error('Grok file changed during update');
budget.signal.throwIfAborted();
await rename(temporaryPath, path);
```

`temporaryPath` 是该次调用用 `path + '.aio-' + crypto.randomUUID()` 创建的独占同目录文件；finally 仅清自己记录 identity 的 tmp。不要对用户目录执行递归 rm。使用 Node file handles 因为需要 O_NOFOLLOW/fsync/identity，不能用 Bun.write 代替这些安全边界。
- [ ] 定义并校验 marker/ownership 的 Zod strict schemas；未知 format/adapterVersion 标为 newer，不降级；endpoint 必须 canonical loopback origin，无 path/query/userinfo。不可信值错误不输出原内容。已有 private dir 无有效 marker 拒绝接管；首次 configure 在内存预检 TOML/policy 完成后才创建私有目录。
- [ ] 首次安装初始化策略：在本次独占创建的 private dir 内，先 durable ownership（含 configure pending），再 durable marker，最后碰 config；任一步失败只清自己创建且 identity 仍匹配的文件。若崩溃留下无 marker 目录，后续只报 conflict，不接管。这个阶段 config 尚未修改，人工删除残留前必须确认目录归属；不要用缺 marker 作为自动删除理由。
- [ ] 实现 configure write-ahead 顺序：锁→读取/恢复→校验 endpoint/版本/current→计算 edit→写 `pending`（before/after,nextLeaves,nextCreatedTables）→按文件 snapshot 写 config→写 committed ownership→更新 marker adapterVersion。同 endpoint 重配保留 ID、credential 和 original；无变化不重写。marker 更新失败可重试，owned fields 仍可通过 ownership 识别。任何冲突先停止，不部分应用“无冲突的几个字段”。
- [ ] 实现恢复的纯分类代码，不能从 pending 恢复整个 config：

```ts
function classifyChange(current: LeafValue, change: FieldChange): 'before' | 'after' | 'conflict' {
  if (equalGrokLeaf(current, change.after)) return 'after';
  if (equalGrokLeaf(current, change.before)) return 'before';
  return 'conflict';
}
```

对每个 pending 叶子，after→采用 nextLeaves 记录，before→保留旧 ownership；第三值→保留原始字段并让 `recovery_required` 带冲突字段。after/before 混合时只固化确定归属，然后重新从最新文档计算下一事务；不得把 before 的字段标成已写。pending 含相同 before/after 时无需单独 mutation。remove pending 的完成也用这些比较，但成功删除的 leaf 不重新接管。
- [ ] 添加每个写入边界崩溃恢复测试、外部改写测试。测试使用 files 私有的可注入 `beforeRename?: () => Promise<void>` hook（只在同目录测试调用，public index 不导出 test API）。写入前 hook 改 config 后，必须报 changed 并保留外部内容。列出 unknown format、endpoint 改变、symlink/hardlink、unknown file、权限、ID mismatch、missing owned field 的行为用例。
- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent/grok` 预期通过；确认测试没有创建/读取 `~/.grok`。文案明确“请在 Grok 不同时保存设置时配置”，不能宣称最后检查与 rename 对不合作 writer 是原子 CAS。
- [ ] `rtk git add packages/cli/src/agent/grok`；`rtk git commit -m "feat(agent): make Grok configuration recoverable" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 6: 凭据文件、刷新 journal 与同源 OAuth transport

**Files:** `grok-auth/{types.ts,credential.ts,credential.test.ts,transport.ts,transport.test.ts}`；只有确实需要公开服务端 replay 常量时修改 core identity export（下述方案不需要）。

**Interfaces:** Consumes `GrokContext`、现有 runtime 三个 OAuth 函数和 `AgentRuntimeError`；Produces：

```ts
export type GrokCredential = {
  readonly format: 1; readonly agent: 'grok'; readonly installationId: string; readonly endpoint: string;
  readonly revision: number; readonly accessToken: string; readonly refreshToken: string;
  readonly accessExpiresAt: number;
  readonly status: 'ready' | 'refreshing' | 'needs_login';
  readonly refreshStartedAt?: number;
};
export function parseGrokCredential(raw: unknown, marker: GrokMarker): GrokCredential;
export function saveGrokToken(context: GrokContext, previous: GrokCredential | undefined,
  token: AgentTokenResponse, requestStartedAt: number): Promise<GrokCredential>;
export function beginGrokRefresh(context: GrokContext, credential: GrokCredential,
  now: number): Promise<GrokCredential>;
export function grokRefreshRecoverable(credential: GrokCredential, now: number): boolean;
export type GrokTransport = {
  device(marker: GrokMarker): Promise<AgentDeviceCodeResponse>;
  poll(marker: GrokMarker, device: AgentDeviceCodeResponse): Promise<AgentTokenResponse>;
  refresh(marker: GrokMarker, refreshToken: string): Promise<AgentTokenResponse>;
};
export function createGrokTransport(marker: GrokMarker, budget: GrokDeadline,
  options?: { readonly fetch?: typeof globalThis.fetch; readonly now?: () => number }): GrokTransport;
```

状态规则：`ready` 不带 startedAt；`refreshing` 必须带有限正 startedAt；`needs_login` 清空 AT/RT，expiry=0，并保持 revision。缺 credential 表示从未登录；损坏/绑定不符/未知 format 拒绝读取和任何网络请求，不将其当空文件重新授权。

- [ ] 写真实 storage-before-return 测试及 replay deadline 测试：

```ts
test('refresh replay is bounded by the first attempt, not each restart', () => {
  const state: GrokCredential = {
    format: 1, agent: 'grok', installationId: '11111111-1111-4111-8111-111111111111',
    endpoint: 'http://127.0.0.1:9317', revision: 2,
    accessToken: 'fake-at', refreshToken: 'fake-rt', accessExpiresAt: 901_000,
    status: 'refreshing', refreshStartedAt: 1_000,
  };
  expect(grokRefreshRecoverable(state, 30_999)).toBe(true);
  expect(grokRefreshRecoverable(state, 31_000)).toBe(false);
  expect(grokRefreshRecoverable(state, 999)).toBe(false);
});
```

- [ ] 加 redirect 测试：fake fetch 第一次响应 307 Location=https://outside.invalid/oauth/token；refresh 必须失败且 fetch 只调用一次、`redirect:'manual'`，永不请求 outside。无效 device verification URL 由 runtime 拒绝。运行 `rtk bun test packages/cli/src/agent/grok-auth/credential.test.ts packages/cli/src/agent/grok-auth/transport.test.ts`，预期 exports 缺失失败。
- [ ] 实现 credential strict schema（revision 是非负安全整数；ready token 非空；expiry finite；marker 三项完全相等）。持久化 refresh-in-flight 保留原 token/expiry/revision，仅将 status+first startedAt 改为 refreshing；已有 refreshing 不能重置 startedAt。save 新 token 只在前一 revision 上 +1，先写再 return：

```ts
async function saveGrokToken(context: GrokContext, previous: GrokCredential | undefined,
  token: AgentTokenResponse, requestStartedAt: number): Promise<GrokCredential> {
  const saved: GrokCredential = {
    format: 1, agent: 'grok', installationId: context.marker.installationId, endpoint: context.marker.endpoint,
    revision: (previous?.revision ?? 0) + 1, status: 'ready',
    accessToken: token.access_token, refreshToken: token.refresh_token,
    accessExpiresAt: requestStartedAt + token.expires_in * 1_000,
  };
  await context.writeCredential(saved);
  return saved;
}
function grokRefreshRecoverable(credential: GrokCredential, now: number): boolean {
  const started = credential.refreshStartedAt;
  return credential.status === 'refreshing' && started !== undefined && now >= started && now - started < 30_000;
}
```

30_000 是现有协议 replay 窗口的客户端保守上限，测试同时引用 core 行为用例确保一致；不是新增服务端可配置项。请求开始时间比服务端签发早，expiry 估算保守，避免把网络耗时当额外寿命。重放结果携带旧的 expires_in 时使用 first refreshStartedAt，不能把 replay 当新签发计算。
- [ ] 实现 transport wrapper，拒绝所有 redirect（比只拒绝跨 origin 更保守，不需要自写 redirect engine）：

```ts
const safeFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== new URL(marker.endpoint).origin || url.username !== '' || url.password !== '') {
    throw new Error('OAuth destination rejected');
  }
  budget.signal.throwIfAborted();
  const response = await (options.fetch ?? globalThis.fetch)(input, {
    ...init, redirect: 'manual', signal: budget.signal,
  });
  if (response.status >= 300 && response.status < 400) throw new Error('OAuth redirect rejected');
  return response;
};
```

创建一个完整 runtime options 对象 `{fetch:safeFetch,signal:budget.signal,now,sleep}`，sleep 通过 `node:timers/promises.setTimeout(ms,undefined,{signal})` 实现可取消等待；三个 transport 方法仅转调公共 runtime 函数。不重新编写 form、poll interval、slow_down、device URL 校验。HTTP5xx/network/invalid_response 保留 RT 与 refreshing 状态；只有 runtime 的 `invalid_grant` 才进入 needs_login。
- [ ] 测试 storage 写失败不返回新 token、token binding mismatch 无网络、invalid_grant 与 500 区别、取消中的 polling sleep 及时结束。`rtk bun test packages/cli/src/agent/grok-auth/credential.test.ts packages/cli/src/agent/grok-auth/transport.test.ts packages/agent-provider/runtime` 预期通过。
- [ ] `rtk git add packages/cli/src/agent/grok-auth`；`rtk git commit -m "feat(agent): persist Grok refresh credentials safely" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 7: 薄 helper 编排、并发 revision 和 stdout 契约

**Files:** `grok-auth/{index.ts,grok-auth.ts,grok-auth.test.ts,types.ts}`；`grok/{index.ts,grok.ts,files.ts}` 增加只读 revision 入口。

**Interfaces:** Consumes Tasks 5–6；Produces：

```ts
export function readGrokRevision(root: string, installationId: string): Promise<number | undefined>;
export type GrokAuthInput = {
  readonly root: string; readonly installationId: string; readonly adapterVersion: string;
  readonly expired: boolean;
};
export type GrokAuthDeps = {
  readonly now: () => number;
  readonly readRevision?: typeof readGrokRevision; // 注入同一只读实现用于进程barrier测试
  readonly transport: (marker: GrokMarker, budget: GrokDeadline) => GrokTransport;
  readonly stdout: (line: string) => Promise<void>;
  readonly stderr: (line: string) => void;
};
export function grokAuth(input: GrokAuthInput, deps: GrokAuthDeps): Promise<void>;
function grokTokenLine(credential: GrokCredential, now: number): string;
```

生产 deps 用 `Date.now`、`createGrokTransport`、`process.stdout.write` callback Promise 和 stderr；不做 browser open/stdin read。`readGrokRevision` 经 grok public index 导出：安全读取文件，只返回绑定 installation 的 revision，校验 format/agent/ID/revision；不刷新或写入。

- [ ] 在 helper 测试内定义 `authFixture()`：调用 Task 5 `grokFixture()`、`configureGrok()`，返回它们和如下 input/deps/counters。fake token/device 使用 runtime schema 验证完整字段。

```ts
const calls = { device: 0, poll: 0, refresh: 0 };
const stdout: string[] = [];
const stderr: string[] = [];
const input: GrokAuthInput = {
  root: f.root, installationId: configured.marker.installationId,
  adapterVersion: f.input.adapterVersion, expired: false,
};
const deps: GrokAuthDeps = {
  now: Date.now, stdout: async (line) => { stdout.push(line); },
  stderr: (line) => { stderr.push(line); },
  transport: () => ({
    device: async () => { calls.device++; return device; },
    poll: async () => { calls.poll++; return tokens; },
    refresh: async () => { calls.refresh++; return tokens; },
  }),
};
```

fixture在上面代码前声明真实协议形状：

```ts
const device = AgentDeviceCodeResponseSchema.parse({
  device_code: 'e'.repeat(43), user_code: 'ABCD-EFGH',
  verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
  verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
  expires_in: 600, interval: 5,
});
const tokens = AgentTokenResponseSchema.parse({
  token_type: 'Bearer', access_token: `aio_agent_at_v1_${'a'.repeat(43)}`,
  refresh_token: `aio_agent_rt_v1_${'b'.repeat(43)}`, expires_in: 900,
});
```

fixture返回 `{...f,input,deps,calls,stdout,stderr}`；生产协议device TTL600/interval5不改，helper交互240秒预算更短。
- [ ] 写两个核心行为用例：

```ts
test('silent auth never starts device flow when credentials are missing', async () => {
  const f = await authFixture();
  try {
    await expect(grokAuth({ ...f.input, expired: true }, f.deps)).rejects.toThrow(/login/);
    expect(f.calls).toEqual({ device: 0, poll: 0, refresh: 0 });
    expect(f.stdout).toEqual([]);
  } finally { await f.cleanup(); }
});
test('normal login validates apparently unexpired credentials through refresh', async () => {
  const f = await authFixture();
  try {
    await grokAuth(f.input, f.deps);
    await grokAuth(f.input, f.deps);
    expect(f.calls).toEqual({ device: 1, poll: 1, refresh: 1 });
    expect(Object.keys(JSON.parse(f.stdout[1]!))).toEqual(['access_token', 'expires_in']);
    expect(f.stdout.every(line => line.endsWith('\n'))).toBe(true);
  } finally { await f.cleanup(); }
});
```

- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent/grok-auth/grok-auth.test.ts` 预期 helper 缺失失败。
- [ ] 在 helper 入口创建总 budget，读等待前 revision 后锁内重读。不能锁外拿 RT 发请求。核心编排：

```ts
async function grokAuth(input: GrokAuthInput, deps: GrokAuthDeps): Promise<void> {
  const started = deps.now();
  const duration = input.expired ? 5_000 : 240_000;
  const budget: GrokDeadline = { deadline: started + duration, signal: AbortSignal.timeout(duration) };
  const observed = await (deps.readRevision ?? readGrokRevision)(input.root, input.installationId);
  const credential = await withGrokInstallation({ ...input, budget }, async context => {
    const raw = await context.readCredential();
    const current = raw === undefined ? undefined : parseGrokCredential(raw, context.marker);
    if (current?.status === 'ready' && current.revision > (observed ?? 0) &&
        current.accessExpiresAt - deps.now() >= 1_000) return current;
    return acquireGrokToken(context, current, input.expired, deps);
  });
  budget.signal.throwIfAborted();
  await deps.stdout(grokTokenLine(credential, deps.now()));
}
function grokTokenLine(credential: GrokCredential, now: number): string {
  const expiresIn = Math.floor((credential.accessExpiresAt - now) / 1_000);
  if (credential.status !== 'ready' || expiresIn <= 0) throw new Error('Grok login required');
  return JSON.stringify({ access_token: credential.accessToken, expires_in: expiresIn }) + '\n';
}
```

`acquireGrokToken(context:GrokContext,current:GrokCredential|undefined,expired:boolean,deps:GrokAuthDeps):Promise<GrokCredential>` 是本 task 的私有状态机，下三步定义所有分支。Task 11 测量 compiled 进程启动在内的用时；网络 deadline 比总 deadline 提前250ms，给文件释放和输出留余量。不能5秒per-request叠加。依赖 await 的文件操作不能被 Promise.race 丢到后台继续写。
- [ ] 用下面的状态机落实重放与交互分支；`GrokAuthError`按下文定义，transport为Task6公开接口：

```ts
async function acquireGrokToken(context: GrokContext, current: GrokCredential | undefined,
  expired: boolean, deps: GrokAuthDeps): Promise<GrokCredential> {
  const transport = deps.transport(context.marker, context.budget);
  let state = current;
  const invalidate = async (): Promise<void> => {
    if (state === undefined) return;
    state = {
      format: 1, agent: 'grok', installationId: state.installationId, endpoint: state.endpoint,
      revision: state.revision, status: 'needs_login', accessToken: '', refreshToken: '', accessExpiresAt: 0,
    };
    await context.writeCredential(state);
  };
  if (state?.status === 'refreshing' && !grokRefreshRecoverable(state, deps.now())) await invalidate();
  if (state !== undefined && state.status !== 'needs_login' && state.refreshToken !== '') {
    const inFlight = await beginGrokRefresh(context, state, deps.now());
    state = inFlight;
    let token: AgentTokenResponse;
    try {
      token = await transport.refresh(context.marker, inFlight.refreshToken);
    } catch (error) {
      if (!(error instanceof AgentRuntimeError) || error.code !== 'invalid_grant') throw error;
      await invalidate();
      if (expired) throw new GrokAuthError('login_required');
      return loginGrokToken(context, state, transport, deps);
    }
    return saveGrokToken(context, inFlight, token, inFlight.refreshStartedAt!);
  }
  if (expired) throw new GrokAuthError('login_required');
  return loginGrokToken(context, state, transport, deps);
}
async function loginGrokToken(context: GrokContext, previous: GrokCredential | undefined,
  transport: GrokTransport, deps: GrokAuthDeps): Promise<GrokCredential> {
  const device = await transport.device(context.marker);
  deps.stderr(device.verification_uri_complete + '\n');
  const startedAt = deps.now();
  const token = await transport.poll(context.marker, device);
  return saveGrokToken(context, previous, token, startedAt);
}
```

`saveGrokToken`放在refresh catch外面：磁盘写入失败不能被当作invalid_grant或触发第二次登录。生产入口把runtime网络/拒绝错误映射为简短stderr，不打印error对象。重放journal无startedAt是schema错误，不能凭非空断言跳过验证。
- [ ] 有 RT：ready→`beginGrokRefresh`→transport.refresh→saveGrokToken；refreshing 且 recoverable→同一 RT/first startedAt 重试一次；refreshing 超窗或时钟倒退→持久化 needs_login，静默报错、普通进入 device flow。ready 不允许直接返回缓存 AT。临时失败保留 refreshing/RT并退出；`invalid_grant` 清 token为 needs_login，再按 expired决定是否进入device。
- [ ] 普通缺 RT/needs_login：requestDeviceAuthorization 后仅 stderr 输出验证过的 `verification_uri_complete`；poll 受 total budget/device expires/cancel限制。保守记录 polling开始时间作为 requestStartedAt；成功先save再return；access_denied/expired_token不输出token。轮询期间保持安装锁heartbeat。
- [ ] 静默缺 RT/needs_login：立即抛结构化 `GrokAuthError`，其构造函数为 `(code:'login_required'|'deadline'|'configuration'|'temporary')`，message不附原始server body/token。值严格等于 `'1'` 的 `GROK_AUTH_EXPIRED` 才选silent。任何异常不得 stringify credential或完整response。
- [ ] 补测试：普通 invalid_grant→device；普通 network/500→无device且RT保留；silent invalid_grant→无device；silent不回传旧AT；等待revision变化复用新AT；不足1秒无stdout；stdout callback失败后RT已保存；device拒绝/取消/超时无token。用barrier控制真实两个Promise对安装锁争用，不能只mock“并发成功”。Task 10再验跨进程。
- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent/grok-auth packages/cli/src/agent/grok` 预期通过。
- [ ] `rtk git add packages/cli/src/agent/grok packages/cli/src/agent/grok-auth`；`rtk git commit -m "feat(agent): add Grok external auth helper" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 8: 在线撤销后逐字段还原，失败可重试

**Files:** `grok/{grok.ts,grok.test.ts,ownership.ts,ownership.test.ts,files.ts,files.test.ts,index.ts}`。

**Interfaces:** Consumes `GrokDeps.revoke`、Task3B restore、Task5 lock/files/transaction；Produces：

```ts
export function removeGrok(root: string, adapterVersion: string, deps: GrokDeps): Promise<{
  readonly installationId: string; readonly revokeStatus: AgentRevokeStatus;
  readonly skippedFields: readonly string[]; readonly retainedFiles: readonly string[];
}>;
```

`retainedFiles` 仅文件相对名。revoke使用当前3秒timeout；remove总budget15秒，不与helper5秒混淆。

- [ ] 写离线失败可重试、removing阻止auth的测试：

```ts
test('failed revoke keeps retryable state and prevents helper use', async () => {
  const f = await grokFixture();
  try {
    const installed = await configureGrok(f.input, f.deps);
    await expect(removeGrok(f.root, f.input.adapterVersion, {
      ...f.deps, revoke: async () => { throw new Error('offline'); },
    })).rejects.toThrow('offline');
    const local = await inspectGrok(f.root, f.input.adapterVersion);
    expect(local.marker?.installationId).toBe(installed.marker.installationId);
    expect(local.configuration).toBe('recovery_required');
    await expect(withGrokInstallation({
      root: f.root, installationId: installed.marker.installationId,
      adapterVersion: f.input.adapterVersion,
      budget: { deadline: Date.now() + 1_000, signal: AbortSignal.timeout(1_000) },
    }, async () => 'must not run')).rejects.toThrow(/remov/);
    await removeGrok(f.root, f.input.adapterVersion, f.deps);
    expect(f.revoked[0]?.endpoint).toBe(f.input.endpoint);
  } finally { await f.cleanup(); }
});
```

- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent/grok/grok.test.ts`，预期missing remove失败。
- [ ] 同一锁内先写removing，然后在线revoke原endpoint，再清凭据和还原：

```ts
await saveOwnership({ ...ownership, status: 'removing' });
const revokeStatus = await deps.revoke(marker.endpoint, marker.installationId);
await context.clearCredential();
const edit = restoreGrokToml(currentConfig?.text ?? '', ownership.leaves, ownership.createdTables);
await commitGrokEdit('remove', edit);
```

私有函数 `saveOwnership(next:GrokOwnership):Promise<void>` 用Task5原子写；`commitGrokEdit(operation:'configure'|'remove',edit:TomlEdit):Promise<void>` 是Task5 write-ahead→config→committed的域内封装，闭包持有marker/ownership/currentConfig/budget/fence。将configure原顺序提取到同目录私有函数，不导出泛型transaction engine。完全不存在的config用空串计算，但remove不因此创建空文件。
- [ ] 沿用当前 `AgentRevokeStatus` 的 `'revoked'|'expired'|'missing'` 成功响应定义；撤销失败保留credential/marker/removing，不回退active。清凭据后崩溃时重试revoke幂等继续。逐字段漂移保留并报告skippedFields。
- [ ] 最终清理采用ownership完成记录：成功撤销、清credential、完成逐字段恢复后，原子写 `status:'removing', cleanupComplete:true` 并清pending。先清自己确认归属的tmp，再删marker，最后删ownership，目录仅空时rmdir。未知文件保留并报告retainedFiles；不递归rm。
- [ ] marker已删但ownership尚在时，remove可走窄恢复入口：验证目录/文件归属、ownership format/agent/ID/endpoint、`status==='removing' && cleanupComplete===true && pending===undefined`，且credential不存在。此入口只清这一已完成记录及空目录，不再次修改config，不重新授权；configure/auth仍拒绝。记录证明撤销和恢复已成功，不靠“当前值是否等于managed值”判断，因为用户original可能本来相等。无marker且无完成记录的目录仍是conflict，不能自动接管或删掉。
- [ ] auth.json哨兵测试：内容/mode/inode/mtime不变，并用文件操作spy确认从未read/open它；元数据不变本身不能证明未读取。再测原endpoint撤销、只撤销本安装、未登录installation的missing revoke、每阶段crash、unknown文件保留。
- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent/grok packages/cli/src/agent/grok-auth` 预期通过。
- [ ] `rtk git add packages/cli/src/agent/grok`；`rtk git commit -m "feat(agent): revoke and remove Grok ownership safely" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 9: 公共命令、只读 list、升级边界和 i18n

**Files:** CLI agent/main/output/update-notify/upgrade、五语言 messages（文件地图列出精确路径）。若 agent.ts 达400行，将 `agentList` 与 snapshot mapping 移到私有 `agent/list.ts`；agent.ts 保留 configure/remove/revoke；不把逻辑放index。

**Interfaces:** Consumes `configureGrok`、`inspectGrok`、`removeGrok`、`grokAuth`；Produces 保持原 actions 签名并扩展结果：

```ts
export type GrokAgentListTargetResult = {
  readonly target: 'grok'; readonly host: AgentHost;
  readonly integrationKind: 'auth-command';
  readonly integration: GrokInspection['integration'] | 'unresolved';
  readonly configuration: GrokInspection['configuration'];
  readonly marker?: GrokMarker; readonly fields: readonly string[];
  readonly authorization: 'not_checked' | AgentInstallationSummary['authorization'] | 'missing';
  readonly catalog: 'host_managed'; readonly schemaCompatibility: 'not_applicable';
  readonly endpointMatches?: boolean;
};
export type AgentListTargetResult = PluginAgentListTargetResult | GrokAgentListTargetResult;
```

`PluginAgentListTargetResult` 是现有结果union重命名，target收窄为AgentPluginTarget，原字段保持。`AgentConfigureResult.loginCommand` 增加 `'grok login'`；remove结果增加可选skippedFields/retainedFiles。`AgentCommandDeps` 保留原插件deps，增加：

```ts
readonly grok: {
  readonly configure: typeof configureGrok; readonly inspect: typeof inspectGrok;
  readonly remove: typeof removeGrok; readonly deps: GrokDeps;
  readonly resolveExecutable: () => Promise<string>;
};
```

`AgentCliActions` 增加 `auth:(target:string,options:{installationId:string})=>Promise<void>`。默认deps构造不启动server。

- [ ] 现有 output fixture 增加 `authCalls:Array<{target:string;installationId:string}>`，auth action push参数；实际 parse 并确认不经通用print输出：

```ts
await program.parseAsync(['agent', 'auth', 'grok', '--installation-id', id], { from: 'user' });
expect(authCalls).toEqual([{ target: 'grok', installationId: id }]);
expect(printed).toEqual([]);
```

增加configure提示和modified list仍保留marker/revoke入口的行为用例。
- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent/output.test.ts packages/cli/src/agent/agent.test.ts packages/cli/src/main.test.ts`，预期command/dispatch缺失失败。
- [ ] 公共parseTarget切回AgentTargetSchema，Grok在plugin location/assets之前分支：

```ts
if (target === 'grok') {
  const host = await requireDetectedHost(target, deps);
  const location = await deps.resolveLocation(target);
  const endpoint = await deps.resolveEndpoint();
  const installed = await deps.grok.configure({
    root: location.hostRoot, endpoint,
    executable: await deps.grok.resolveExecutable(), adapterVersion: deps.adapterVersion,
  }, deps.grok.deps);
  const snapshot = await deps.readSnapshot(endpoint).catch(() => undefined);
  return {
    target, host, installed: true, status: installed.status,
    server: snapshot === undefined ? 'unreachable' : 'reachable',
    ...(snapshot === undefined ? {} : { deviceAuthorization: snapshot.deviceAuthorization }),
    loginCommand: 'grok login', reloadRequired: true,
  };
}
```

原host版本warning继续；Grok remove先进入受锁 `removeGrok`，不能复用原先lock外revoke流程。
- [ ] list遍历四目标：Grok根不依赖可执行文件存在，卸载宿主后也能inspect已有marker。offline list只读、不修pending、不签发/刷新、不访问network。`--check/--authorizations`沿用admin snapshot；本机身份键为installationId:target，不依赖configuration==current。modified不变成orphan，marker有效即保留。catalog呈现host_managed，不套plugin fresh/stale。
- [ ] output注册面向宿主命令：

```ts
agent.command('auth <target>')
  .requiredOption('--installation-id <uuid>')
  .action(async (target, options) => {
    if (target !== 'grok') throw new Error('Unsupported auth command target');
    const installationId = z.uuid().parse(options.installationId);
    await actions.auth(target, { installationId });
  });
```

生产auth action绑定 `resolveGrokRoot(process.env,homedir())`、`expired:process.env.GROK_AUTH_EXPIRED==='1'` 和helper；不额外执行Grok版本命令/admin snapshot。preAction通过Commander parent chain判断agent/auth并跳过banner，不能只用argv含auth。main catch/Commander error都走stderr。stdout writer包装callback，write失败reject，持久化不回滚。
- [ ] 同步五语言keys：`cli.agent.grok_login`、`grok_models`、`configuration_modified`、`configuration_missing`、`recovery_required`、`host_managed_catalog`、`grok_close_settings`、`grok_login_required`、`grok_policy_conflict`、`grok_retained_files`（每项均使用完整 `cli.agent.` prefix）。grok_models文案包含 `grok models` 和 `grok -m <model-id>`；AIO Proxy不翻译。错误只插值路径/字段名。
- [ ] `rtk bun run i18n:compile`。测试JSON不含token；offline list文件hash不变；pending只报告；modified marker不丢失；Grok已配置后post-upgrade仍不写其config、不取其assets。invalidUUID/missing option/bad target stdout空且非零；缓存update提示也不干扰helper。
- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts packages/cli/src/agent packages/cli/src/main.test.ts packages/cli/src/update-notify packages/cli/src/upgrade/post-upgrade-agents.test.ts` 和 `rtk bun run check` 预期通过。
- [ ] `rtk git add packages/cli/src/agent packages/cli/src/main.ts packages/cli/src/main.test.ts packages/cli/src/update-notify packages/cli/src/upgrade packages/i18n/messages`；`rtk git commit -m "feat(cli): expose Grok configure auth list and remove" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 10: 真实进程的轮换、崩溃与 remove 竞争

**Files:** `grok-auth/{process.test.ts,process-fixture.ts}`；必要修复限于前述grok/lock/credential模块，不增加测试专用生产CLI flags。

**Interfaces:** Consumes公开helper/installation接口；Produces测试fixture API：

```ts
// process-fixture.ts 仅测试调用，不从任何product barrel导出。
export type HelperChild = {
  readonly process: ReturnType<typeof Bun.spawn>;
  readonly stdout: Promise<string>; readonly stderr: Promise<string>;
  readonly exit: Promise<number>;
};
export function spawnHelperForTest(input: GrokAuthInput, options?: {
  readonly gate?: 'before-refresh-response' | 'after-credential-save' | 'before-stdout';
}): HelperChild;
```

fixture模块作为Bun子进程入口时读取argv JSON，调用真实 `grokAuth`。测试通过loopback HTTP服务gate控制refresh response；通过注入stdout callback设置after-save/before-stdout gate（文件sentinel或Bun IPC，明确ready消息才kill）。不要生产 `GROK_TEST_*` 绕过身份逻辑。父进程finally kill/reap所有孩子和server、删临时根。

- [ ] 首先写真正两个进程争用。首进程进入refresh handler后冻结response；启动第二个并等到它报告revision已读，然后放开第一响应。验证仅一次rotation，两份输出同一新AT，credential.revision仅+1：

```ts
const first = spawnHelperForTest(input);
await refreshEntered;
const second = spawnHelperForTest(input);
await secondObservedRevision;
releaseRefresh();
const [a, b] = await Promise.all([first.stdout, second.stdout]);
expect(JSON.parse(a).access_token).toBe(JSON.parse(b).access_token);
expect(rotationCount).toBe(1);
expect(await first.exit).toBe(0);
expect(await second.exit).toBe(0);
```

`refreshEntered`/`releaseRefresh` 是loopback handler中的Promise resolver；`secondObservedRevision` 由test入口使用自己的read-only revision读取后向父进程发送ready，再调用helper。为准确锁住helper内部observed时点，使用Task7已定义的可选依赖 `readRevision?:typeof readGrokRevision`（默认真实函数），测试wrapper真实读取后发送ready。不是读取完就伪造revision。
- [ ] `rtk bun test --preload ./packages/cli/__tests__/setup.ts --timeout 20000 packages/cli/src/agent/grok-auth/process.test.ts`；若首次已经通过则保留有效回归，不人为破坏实现来制造RED。后续发现失败按systematic-debugging修复。
- [ ] 检查refresh响应丢失：server记录已经轮换后关闭socket，credential保持refreshing；同RT在30秒内重放获得同新family结果。用测试clock越过30秒再重启helper，确认静默不发旧RT、普通可进入device。不得修改journal startedAt获得新窗口。
- [ ] kill场景分成三个可确定边界：写refreshing后/response到达前；server已签发/credential rename前；credential已durable/stdout前。前两者保留replay能力，最后者下一helper拿到新RT，不恢复旧RT。stdout pipe提前关闭不回滚credential。测试observer只记录revision和请求次数，不将完整凭据写入输出报告。
- [ ] holder活着的设备轮询阻塞另一silent helper，后者总时限≤5秒（给CI计时误差单独报告，不把7秒宿主上限当产品预算）。kill holder后新进程靠process identity恢复锁；故意替换inode后旧owner无法unlink新锁。配置写前external改写必须检测，不测试无法保证的最终rename极短窗口为“无竞态”。
- [ ] remove与refresh/login竞争：remove先拿锁→写removing后，随后helper绝不签发；helper先拿锁→完成credential，remove随后撤销其family并清凭据。revoke已完成后旧helper参数不能用于新installation；新configure必须新UUID。
- [ ] 测试最终cleanup断点：restored journal durable后、marker删除后、ownership删除前各重跑remove，验证只清该installation记录并保留unknown文件。unknown format不能进入这种恢复路径。
- [ ] 保留所有修复的最小回归后，运行上述process tests、`rtk bun test packages/core/src/file-lock packages/core/src/plugins/config-file`，预期通过。不能用mock-only单元测试替代真实子进程互斥证据。
- [ ] `rtk git add packages/cli/src/agent/grok packages/cli/src/agent/grok-auth packages/core/src/file-lock`；`rtk git commit -m "test(agent): cover Grok process races and crash recovery" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Task 11: 编译产物、真实 Grok 兼容验收和发布文档

**Files:** `grok-compat/{index.ts,grok-compat.ts,grok-compat.test.ts,fixture.ts}`、CLI package scripts、`docs/agent-grok.md`、spec验收记录、由bun changeset生成的单条note。

**Interfaces:** Consumes真实compiled CLI、真实Grok、现有server/device approval API、测试loopback模型；Produces显式验证入口：

```ts
export type GrokCompatOptions = {
  readonly grokBinary: string; readonly cliBinary: string; readonly expectedVersion: string;
  readonly reportPath: string;
};
export type GrokCompatReport = {
  readonly grokVersion: string; readonly cliVersion: string; readonly platform: string;
  readonly cases: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[];
};
export function runGrokCompatibility(options: GrokCompatOptions): Promise<GrokCompatReport>;
```

入口 `index.ts` 只export；脚本主入口放 `grok-compat.ts` 的 `if(import.meta.main)`，读取 `--grok-bin`、`--cli-bin`、`--expected-version`、`--report`（仅测试脚本参数，不是产品CLI）。无binary/版本不符→非零，不能静默skip并声称兼容通过。`grok-compat.test.ts`测harness结果判定、脱敏和失败传播，不在普通unit运行下载/启动用户宿主。

- [ ] 把前期probe的ACP收发、loopback mock和隔离home逻辑迁入fixture，删除改写真实宿主状态的路径。生产helper绝不读auth.json；仅compat fixture可以操作其自己新建的临时Grok auth文件，用于已明确标注的宿主时间戳测试，不读取用户auth.json。
- [ ] 定义fixture `createGrokCompatFixture(options:GrokCompatOptions):Promise<{root:string;env:Record<string,string>;run:(argv:readonly string[])=>Promise<{exitCode:number;stdout:string;stderr:string}>;close:()=>Promise<void>}>`。每次临时HOME/GROK_HOME/AIO_PROXY_HOME；禁用Claude/Codex/Cursor自动导入hooks，测试配置：

```toml
[compat.claude]
hooks = false
mcps = false
agents = false
rules = false
skills = false
[compat.codex]
hooks = false
[compat.cursor]
hooks = false
```

fixture在localhost随机端口启动真实aio-proxy server和假模型上游，Dashboard设置临时密码；禁止真实模型费用。macOS用前期已验证的sandbox-exec策略禁止非loopback网络，HTTP recorder记录路径/同源/仅token指纹。其它平台必须具备等价的网络隔离才能声称通过token目的地验收。
- [ ] 先写harness失败传播测试：fake Grok executable报告不符版本→runGrokCompatibility reject且未调用login；fake child非零→case failed且脚本非零；report不含AT/RT/user_code。运行 `rtk bun test packages/cli/src/agent/grok-compat/grok-compat.test.ts` 预期新harness缺失失败，然后实现runner的spawn/timeout/cleanup/report写入。
- [ ] 编译当前平台CLI：先 `rtk bun run build`，再 `rtk bun run --filter @aio-proxy/cli build:binary`。脚本会生成 `npm/cli-darwin-arm64/bin/aio-proxy` 等产物；也可用已存在的单目标脚本 `rtk bun packages/cli/scripts/build-binary.ts darwin-arm64 /tmp/aio-proxy-grok-compat/bin/aio-proxy`，只在build依赖已完成后执行。实际平台使用对应suffix，不用模拟host binary代替发布产物。
- [ ] 增加CLI package script：

```json
{
  "test:compat:grok": "bun src/agent/grok-compat/grok-compat.ts"
}
```

真实执行（先通过读取版本确定当前binary，不把symlink目标假定固定版本）：

```sh
rtk proxy /Users/bytedance/.grok/bin/grok --version
rtk bun run --filter @aio-proxy/cli test:compat:grok --grok-bin /Users/bytedance/.grok/bin/grok --cli-bin /tmp/aio-proxy-grok-compat/bin/aio-proxy --expected-version 1.0.24 --report /tmp/aio-proxy-grok-compat/baseline.json
```

如果安装的当前版本已不是1.0.24，用固定版本可执行文件跑baseline，再以实际版本跑current。缺固定binary就如实记录该门槛未通过；不更新用户Grok安装来凑测试。baseline/current相同也记录是同一binary，不伪造两版本验证。
- [ ] 实现基本旅程：compiled configure→真实grok login触发helper→harness从helper stderr提取device URL→通过真实Dashboard login/CSRF/approve路径批准→grok models→选fixture模型→流式文本→一次工具调用。fixture上游第一次请求返回函数调用，第二次含工具结果后返回文本；工具只允许临时目录内的无副作用命令。保持未实现辅助URL返回真实404，确认不阻断旅程且没有云端fallback。
- [ ] 验证compiled helper stdout/stderr：保存原始stdout只在内存JSON.parse，Object.keys必须恰为access_token/expires_in；RT只能在CLI私有文件中；stderr含登录URL不含token。稳定入口包含空格/单引号，模拟symlink升级后原config仍可调用新compiled binary。GROK_HOME默认/custom、错误ID、Bun dev launcher拒绝用例均运行发布产物。
- [ ] 同一ACP进程跨过期：host-only fixture用8秒假AT实际等9秒验证宿主再次调用helper；端到端另跑真实服务15分钟AT的长期用例，不降低生产TTL。runner周期性输出脱敏case进度，不能超过60秒无进展更新。较早签发AT的401触发helper；fresh401用例记录原生跳过refresh并本轮失败，不伪造签发时间绕过。修改临时宿主时间戳的测试必须标注为host-only，不能当自然过期证据。
- [ ] 对两个Grok进程共享installation的轮换：一个refresh使另一AT失效，观察后者的原生refresh或fresh-token限制；只要求原生重试/重新登录路径可用，不承诺所有401无感恢复。
- [ ] egress断言覆盖模型发现、推理、辅助请求：每个实际带AT的请求origin均为E；RT仅去E/oauth/token。外部model/provider或有效环境覆盖先configure失败，config逐字未改。sandbox拒绝的外部无token遥测与带token请求分别报告；不能仅凭没有收到请求就声称没有外泄尝试。
- [ ] 运行身份服务重启、revoke→普通grok login重新授权、silent不得自批、remove只影响该installation、auth.json用户原文件未触碰、匿名/server.apiKeys模式回归。再跑 `rtk bun test packages/agent-provider/opencode/artifact.test.ts packages/agent-provider/pi/artifact.test.ts`，`rtk bun run --filter @aio-proxy/pi-provider test:compat`（覆盖Pi/OMP）和 `rtk bun run --filter @aio-proxy/opencode-provider test:compat`。plugin升级流程必须不安装Grok脚本。
- [ ] 写 `docs/agent-grok.md`：最短旅程、继承GROK_HOME、无需手工API Key、登录由Grok触发、如何选模型、list漂移解释、在线remove/保留用户改动、fresh401限制和已验证平台版本。文档不指导用户粘贴RT，不承诺恢复旧云端会话。
- [ ] `rtk bun changeset` 创建一条minor note，选产品 `aio-proxy` 和实际改动的 `@aio-proxy/cli`、`@aio-proxy/core`、`@aio-proxy/server`、`@aio-proxy/types`、`@aio-proxy/i18n`；仅使用runtime而未修改它时不选runtime；未改SDK不选SDK。body一段：`Add Grok Build integration with native AIO Proxy login, automatic credential refresh, installation revocation, and safe configuration removal.` 检查已有未发布note是否提到旧Grok行为，修改同一note而非追加历史。
- [ ] `rtk bun run preflight`，`rtk bun run test:artifact`（若preflight已包含且无后续变更，不重复），显式Grokcompat及旧host兼容入口通过后，spec状态改为已实现并链接脱敏报告。缺宿主/平台/长周期验证时标明未通过的具体项，不写全量完成。
- [ ] `rtk git diff --check`；`rtk git add packages/cli/src/agent/grok-compat packages/cli/package.json docs/agent-grok.md docs/superpowers/specs/2026-09-09-grok-build-agent-integration-design.md .changeset`；`rtk git commit -m "feat(agent): validate and document Grok Build integration" -m "Co-authored-by: Codex <noreply@openai.com>"`。

## Spec 覆盖与交接自检

Task3拆为3A（共享编辑器及Codex迁移）和3B（Grok归属规则）；其余编号保留，文中Tasks2–4包含这两个子任务。共12个可独立验证和提交的任务。

| Spec | 实施与证据 |
| --- | --- |
| §1 独立Grok范围，无Codex/Claude依赖 | Tasks1/3A/9/11；仅复用已提交TOML代码，无#327整体功能依赖 |
| §2 真实host基线、fresh401限制 | Task11 baseline/current、ACP expiry/fresh401报告 |
| §3 CLI、离线configure、stdout契约 | Tasks7/9/11；compiled helper输出检查 |
| §4 根/稳定入口/私有路径 | Tasks4/5/11；路径链接/权限/升级实验 |
| §5 七字段/别名/外部模型/policy/egress | Tasks3A/3B/4/11；共享编辑器、AST roundtrip、无token外部请求 |
| §6 幂等/逐字段三方恢复/崩溃 | Tasks3B/5/8/10；每个提交阶段断点 |
| §7 普通/静默/总预算/revision/replay | Tasks2/6/7/10；真实子进程而非仅mock |
| §8 身份/普通models/revoke/remove | Tasks1/8/9/11；真实device批准、Grok普通models分发/插件协商回归及服务重启 |
| §9 list/upgrade/module边界 | Tasks1/3A/5/9；共享编辑入口、modified身份可见、plugin循环收窄 |
| §10 验收/发布 | Tasks10/11；preflight+artifact+compat+minor changeset |
| §11 不采用的替代方案 | 全局约束；不发RT给Grok、不复制OAuth、不恢复全文件 |

执行者每个task先确认RED是目标行为失败，PASS后再提交；代码块给定核心实现和接口，标准imports从该task的Files/Interfaces取，不为代码片段另建示例实现。每个勾选动作只做所述的一项修改或验证；一个矩阵的用例逐项添加，每项以2–5分钟的小步推进。实现偏离本计划只在证据要求时进行，并同步修改调用方和测试，不能留下前后不一致的契约。

计划交接时只提交本文和spec的模块复用说明，不运行以上产品实现命令。下一步由用户选择 subagent-driven（推荐）或当前会话 executing-plans；选择之前不开始实现。
