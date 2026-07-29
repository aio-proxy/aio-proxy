# Hono HTTP 访问日志接入设计

日期：2026-07-29
状态：待批准

参考：[LogTape Hono 集成文档](https://logtape.org/manual/integrations#hono)

## 与既有设计的关系

本文不修改以下两层：

- `2026-07-19-logtape-process-logging-design.md` 定义的 **进程诊断日志**（`@aio-proxy/logger` / LogTape / stderr + 按日文件），以及 `ServerLog` 结构化领域事件（`request.inbound_snapshot` / `request.upstream_result` / `request.rejected` 等，桥接到 category `["aio-proxy","server"]`）。
- `2026-07-12-dashboard-request-logs-design.md` 定义的 Dashboard / SQLite request log。

本文只**新增一层**：`@logtape/hono` 提供的 **HTTP 访问日志中间件**（每请求 `method` / `path` / `status` / `responseTime` 等），叠加在现有日志之上。领域事件体系与 Dashboard log 均不动。

## 背景

现状：

- 代理路由（`/v1/*`、`/v1beta/*`）只发结构化领域事件；body 仅在 debug 下记录。
- `/health`、`/v1/models`、`/dashboard/*` 无任何访问日志——缺少「谁在什么时候打了哪个 endpoint、状态码、耗时」这一层运维信号。
- `requestId` 已由 `request-tracing` 的 trace recorder 在 `begin()` 中用 `crypto.randomUUID()` 自铸，写入 OTel span 与 trace DB，并经 `withRequestLogContext` 供领域日志关联。
- LogTape 当前**未**配置 `contextLocalStorage`。

`@logtape/hono` 的中间件正好补齐访问日志这一层，且其 `context` 能力可与现有 `requestId` 统一关联。

调研对照 —— 参考实现 **CLIProxyAPI**（Go，`internal/logging/gin_logger.go` / `requestid.go`）：

|                | CLIProxyAPI                          | 本文选择                         |
| -------------- | ------------------------------------ | -------------------------------- |
| requestId 来源 | 始终服务端自铸（`crypto/rand`），**不读**入站 header | **对齐**：始终自铸，不信任入站 header |
| 响应头回写     | **不回写**（全仓 grep 零命中），仅内部关联 | **对齐**：`responseHeader:false` |
| id 用途        | 内部日志行 + context + 管理接口       | 内部日志行 + OTel span + trace DB + 领域日志 |
| 路径范围       | 仅 AI API 路径附 id，其余记 `--------` | 全局记访问日志，跳过 health/dashboard |

## 目标

- 引入 `@logtape/hono` 中间件，在 `createRoutes` 中于路由注册前全局 `app.use`，为所有非跳过路由产出结构化访问日志行。
- 访问日志与领域日志、OTel span、trace DB **共享同一 `requestId`**（真正统一，含中间件自铸的情形）。
- 访问日志落入现有 console + file sink（`configureLogging` 已配置的输出），无需新增 sink/level。
- `requestId` 始终服务端自铸、格式保持 UUID、不信任入站 header、不回写响应头（对齐 CLIProxyAPI 的内部关联模型）。

## 非目标

- 不替换、不修改 `ServerLog` 领域事件与 Dashboard/SQLite request log。
- 不记录完整 body / headers / API keys（访问日志只含 `structured-combined` 的元字段）。
- 不信任、不读取入站 `x-request-id`（`headerNames: []`）。
- 不向客户端回写 `x-request-id` 响应头（`responseHeader: false`）。
- 不引入新 sink、不新增 `LOG_LEVEL` 类 env 覆盖、不新增 catalog 依赖（`@logtape/hono` 仅 server 使用）。
- 不改动访问日志的级别/格式为可配置项（第一版写死）。

## 核心决策

| 决策点            | 结论                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| 定位              | 新增访问日志层，叠加于现有领域日志之上，两者不互相替换                                          |
| 中间件挂载        | `createRoutes`（`server/server.ts`）中路由注册**前**全局 `app.use(honoLogger(...))`            |
| 路由范围          | 全部路由，`skip` 掉 `/health` 与整个 `/dashboard/*`；代理路由与 `/v1/models` 记录              |
| LogTape category  | `["aio-proxy","server","http"]`（继承现有 console+file sink；与领域事件 `["aio-proxy","server"]` 区分） |
| 级别              | `info`                                                                                        |
| 格式              | `structured-combined`（file sink 已用 `jsonLinesFormatter`，保持机器可解析）                   |
| requestId 来源    | 服务端自铸；不读入站 header（`context.requestId.headerNames: []`）。id 由外层中间件铸造，honoLogger 通过 `generate` 复用它（见下），保证访问日志行与 trace/领域日志同 id |
| requestId 格式    | UUID（`crypto.randomUUID`，与现有 OTel/trace DB 一致） |
| 响应头            | `context.requestId.responseHeader: false`，不回写（对齐 CLIProxyAPI 内部关联） |
| context include   | 仅 `["requestId"]`（`method`/`path`/`status` 已由访问日志行本身携带） |
| contextLocalStorage | 在 `configureLogging` 的 `configure()` 调用中新增 `contextLocalStorage: new AsyncLocalStorage()`（implicit context 传播的必需前提；否则下游日志继承不到 id 且每请求触发 `[logtape,meta]` 告警） |
| 统一读回封装      | LogTape **无公开读回 API**（`getImplicitContext` 非公开导出，官方 implicit context 只写不读，核实见下）。故读回自建：`@aio-proxy/logger` 用**自有 `AsyncLocalStorage`** 提供并导出 `withRequestId(id, fn)` + `currentRequestId()`；`withRequestId` 内部同时调用公开的 `withContext({requestId})` 让日志记录带上 id。server 只依赖此封装，不直读 LogTape 内部 |
| 统一注入点        | 路由前一个极小中间件 `withRequestId(crypto.randomUUID(), next)` 包裹整条链（唯一铸造点）；honoLogger context 配 `generate: () => currentRequestId() ?? crypto.randomUUID()` 复用该 id；trace recorder `begin()` 改为 `currentRequestId() ?? crypto.randomUUID()`。三者同 id |
| honoLogger context | **启用**，配 `{ requestId: { headerNames: [], responseHeader: false, generate: () => currentRequestId() ?? crypto.randomUUID() }, include: ["requestId"] }`：不读入站、不回写、复用外层 id、仅把 requestId 注入访问日志行 |
| 依赖版本          | 升级 `@logtape/logtape` + `@logtape/file` **2.1.1 → 2.2.4**（`@logtape/hono` `context` API 及 peer 需 `^2.2.x`；核实见下）；`@logtape/hono@2.2.4` 加入 `packages/server/package.json`，精确 pin |

## 架构

```text
Hono app (createRoutes)
  ├─ app.use(async (c, next) => withRequestId(crypto.randomUUID(), next))  // 路由前，唯一铸造点
  │      │  自有 ALS 存 requestId + 公开 withContext({requestId}) 包裹整条链
  ├─ app.use(honoLogger({                       // 紧随其后
  │      category: ["aio-proxy","server","http"],
  │      level: "info",
  │      format: "structured-combined",
  │      context: { requestId: { headerNames: [], responseHeader: false,
  │                              generate: () => currentRequestId() ?? crypto.randomUUID() },
  │                 include: ["requestId"] },
  │      skip: c => c.req.path === "/health" || c.req.path.startsWith("/dashboard/"),
  │  }))
  │      │  generate 复用外层 id → 访问日志行 requestId 与链内一致
  │      ▼
  ├─ 代理路由 handleProtocolRequest
  │      └─ requestRecorder.begin()
  │            requestId = currentRequestId() ?? crypto.randomUUID()   // 读回外层 id
  │            → OTel span / trace DB / withRequestLogContext / 领域事件  (全部统一)
  ├─ /v1/models、/health、/dashboard/*  (health & dashboard 被 skip，不记访问日志)
  └─ 访问日志行 → logger["aio-proxy","server","http"] → console + file sink

configureLogging(configure({ ..., contextLocalStorage: new AsyncLocalStorage() }))  // implicit context 传播前提
```

依赖方向（沿用既有分层，禁止环）：

```text
@logtape/logtape (withContext) ← @aio-proxy/logger (自有 ALS: withRequestId / currentRequestId)
                                       ↑
@aio-proxy/server (honoLogger 中间件 + withRequestId 中间件 + trace recorder 读回)
server ✗→ @logtape/logtape 内部符号   (禁止；读回只经 logger 封装的自有 ALS)
```

## 接线

### `@aio-proxy/logger`

1. `package.json`：`@logtape/logtape` + `@logtape/file` 由 `2.1.1` 升到 `2.2.4`（精确 pin）。
2. `configure/configure.ts`：`configure({...})` 参数新增 `contextLocalStorage: new AsyncLocalStorage()`（`import { AsyncLocalStorage } from "node:async_hooks"`）。不改 sink/level/category 现状。
3. 新增 `request-context/` 模块并从包入口导出：
   - `withRequestId(id: string, fn: () => T): T` —— 用自有 `AsyncLocalStorage` 存 `id`，同时 `withContext({ requestId: id }, fn)`。
   - `currentRequestId(): string | undefined` —— 读自有 ALS，非空 string 才返回。

### `@aio-proxy/server`

1. `package.json` 新增 `"@logtape/hono": "2.2.4"`。
2. `server/server.ts` `createRoutes`：`new Hono()` 后、路由注册前先 `app.use(withRequestId 包裹中间件)`，再 `app.use(honoLogger({...}))`，配置见上表/架构。
3. `request-tracing/.../request-trace-recorder.ts` `begin()`：`const requestId = currentRequestId() ?? crypto.randomUUID();`，其余 OTel/trace DB/completion 逻辑不变。

## 验收

属永久性 feature，测试于实现完成并冒烟通过后于收尾阶段补齐。仓库已移除 changesets，改用 conventional commits，无需 changeset。

冒烟：

1. 起服务，打一个 `/v1/*` 请求 → console/file sink 出现 `["aio-proxy","server","http"]` 的 `structured-combined` 访问日志行；同一请求的领域事件（`request.inbound_snapshot` 等）与该访问日志行 **共享同一 `requestId`**。
2. `/health`、`/dashboard/*` 请求 → **无**访问日志行。
3. 全程**无** `[logtape,meta]` "Context-local storage is not configured" 告警。
4. 响应中**无** `x-request-id` 头；即使请求带入站 `x-request-id`，服务端仍使用自铸 id（不被入站值覆盖）。

自动化测试：

1. 访问日志层行为测试：命中路由产出访问日志行、`/health` 与 `/dashboard/*` 被 skip、格式为 `structured-combined`。
2. `withRequestId` / `currentRequestId` 封装：在 `withRequestId(id, fn)` 作用域内 `currentRequestId()` 返回 `id`，作用域外返回 `undefined`；嵌套/异步续体正确继承。
3. 统一回归：trace recorder `begin()` 在 `withRequestId` 作用域内复用该 id、作用域外回退 UUID；断言访问日志 id 与领域日志/trace 的 `requestId` 一致。

## 核实结论（tarball + 官方文档）

- `@logtape/hono` 的 `context`（`headerNames`/`responseHeader`/`generate`/`include`）**仅 ≥2.2.0** 存在；`2.1.1`/`2.1.2` 无此 API。每个 `2.2.x` 的 peer 要求 `@logtape/logtape ^2.2.x`，故必须把 logtape 栈由 `2.1.1` 升到 `2.2.4`。
- `@logtape/logtape@2.2.4` 的公开导出（`dist/mod.d.ts`）只有 `withContext` / `withCategoryPrefix` / `ContextLocalStorage`。**无** `getImplicitContext`（内部 `getImplicitContextIfAny` 明确"intentionally not exported"，`exports` 仅 `.` 与 `./package.json`）。官方文档 implicit context **只写不读**。→ 读回 requestId 只能自建 `AsyncLocalStorage`（本设计的 `withRequestId`/`currentRequestId`）。
- `@logtape/file@2.2.4` 保留 `getTimeRotatingFileSink`；logtape 2.2.4 保留 `jsonLinesFormatter`/`ansiColorFormatter`/`getConsoleSink`，现有 `configure.ts` 用法不变。
