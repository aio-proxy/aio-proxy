# LogTape 进程诊断日志设计

日期：2026-07-19  
状态：设计评审中

## 与既有设计的关系

本文不修改 `2026-07-12-dashboard-request-logs-design.md` 所定义的 **Dashboard / SQLite request log**。  
那一层继续只记录终端请求的固定业务结构（outcome、provider、usage、attempts 等）。

本文解决的是另一层：**进程诊断日志**（level、module/category、自由字段、堆栈、中间态），用于排障。

现有相关能力：

- `ServerLogSink` / `ServerLog`（`packages/server/src/server-log.ts`）：少量 typed 服务端事件
- `PluginLogSink`（`packages/core/src/plugins/diagnostic.ts`）：插件诊断错误 + `redactPluginError`
- 默认实现：`console.error(JSON.stringify(entry))`（`createServerState`）
- `packages/core/src/paths.ts` 已有 `logPath()` → `{AIO_PROXY_HOME}/aio-proxy.log`（单文件；本文**不**把它改造成诊断日志权威路径）

## 背景

Dashboard request log 结构固定，无法承载上游中间态、堆栈细节、按模块开关噪等排障信息。  
进程侧虽有 typed sink，但缺少完整 logger（level / child / 自由字段），插件 `definePlugin` 的 `PluginApi` 也没有 logger。

调研对照：

| | Rsbuild | OpenCode | 本文选择 |
| --- | --- | --- | --- |
| 插件如何拿 logger | `api.logger`（实例绑定） | `PluginInput` **无** logger | **`api.logger`** |
| 出口配置 | 宿主 `customLogger` / `logLevel` | 宿主自管；插件易污染 TUI | 宿主 configure |
| 形态 | rslog（偏 CLI 文案） | console / Effect | LogTape 结构化日志 |

## 目标

- 引入 **LogTape**（`@logtape/logtape` + `@logtape/file`），经新建包 `@aio-proxy/logger` 统一进程诊断日志。
- 插件通过 **`api.logger`**（Rsbuild 风格）获得已绑定插件身份、且带精确 secret 脱敏的 logger 实例。
- 保留 `ServerLogSink` / `PluginLogSink` 类型契约，默认实现桥接到 logger；`ServerLog` 用显式 severity 映射。
- 支持 stderr 输出；可选按日落盘与保留天数（由 `@logtape/file` 的 `getTimeRotatingFileSink` 承担）。
- 对外 Logger 同时支持「普通 message + properties」与 LogTape `{placeholder}` 写法。
- 修正启动顺序，保证 `configureLogging` 发生在任何默认 server 初始化诊断输出之前。

## 非目标

- 不替换、不扩展 Dashboard / SQLite request log 字段。
- 不记录完整 request/response body、headers、API keys。
- 不引入 Winston / Pino。
- 不做远程 log shipper；stderr/file 即可被外部采集。
- 不提供 `LOG_LEVEL` 等环境变量覆盖（级别只来自 config）。
- 不自研按日轮转 / retention 清理逻辑（交给 `@logtape/file`）。
- 不把 `@aio-proxy/logger` 依赖 `@aio-proxy/core`（避免依赖环）。
- 不改写无生产调用方的 `logPath()` 去充当诊断日志路径；诊断目录由 CLI 传入。
- 第一版不要求现有内置插件大规模补日志点；提供能力与接线即可。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 库 | LogTape + `@logtape/file` |
| 包边界 | `@aio-proxy/logger` 只依赖 LogTape 包；**不**依赖 core |
| Logger 类型位置 | **窄接口定义在 `plugin-sdk`**；logger 包实现该接口 |
| 插件 API | `PluginApi.logger` 为**必有**字段 |
| `PLUGIN_API_VERSION` | **升到 `2`**（见下节兼容性） |
| 消息风格 | 同时支持 `(properties, message)` 与 LogTape 占位符 message |
| 既有 sink | **保留**；默认实现桥接 logger |
| ServerLog 级别 | **显式 map/switch**，禁止用 event 名字符串猜测 |
| 输出 | stderr **始终**有；磁盘由 `server.logging.enabled` 控制 |
| 级别 | 仅 `server.logging.level`；无 env 覆盖 |
| 磁盘 | `@logtape/file` `getTimeRotatingFileSink`：`interval: "daily"` + `filename` + `maxAgeMs` |
| 默认目录 | CLI 用 `aioHome()` 算出 `{AIO_PROXY_HOME}/logs` 后传入 `configureLogging` |
| 保留 | `retentionDays` → `maxAgeMs = retentionDays * 86400000`；默认 `14` |
| 插件脱敏 | 宿主注入的 `api.logger` **必须**绑定 loader 已收集的 `secretValues` 精确值脱敏 |
| 启动顺序 | 去掉 server 模块 import-time `createServerState`，或 CLI 在 configure 后动态 import server |
| Dashboard request log | 不变 |

## 兼容性：`PLUGIN_API_VERSION = 2`

`api.logger` 是 setup 期**必有**字段。若保持 v1：

- 旧插件 + 新宿主：通常仍可运行（不访问 logger）
- **新插件 + 旧宿主**：旧宿主只注入 `oauth`，却因 `apiVersion === 1` 仍接受插件 → setup 访问 `api.logger` **崩溃**

因此：

1. `PLUGIN_API_VERSION` 从 `1` 升到 `2`。
2. 宿主拒绝加载 `apiVersion !== 2` 的插件（或按既有策略：不兼容则标记 `PLUGIN_API_INCOMPATIBLE`，不进入 setup）。
3. 仓库内全部内置插件 / fixture 描述符升级到 v2。
4. 不采用「logger 可选 + 插件探测」方案：那会削弱 Rsbuild 风格的一致性，且仍无法阻止新插件在旧宿主上半加载后炸。

## 架构

```text
CLI serve
  ├─ resolve logging.dir default = join(aioHome(), "logs")   // core paths, only in CLI
  ├─ await configureLogging({ ...logging, dir })             // @aio-proxy/logger
  │    ├─ stderr sink (always)
  │    └─ getTimeRotatingFileSink (optional)
  └─ import/createServer (after configure; no import-time server state)
       ├─ ServerLogSink  ──explicit severity──► logger["aio-proxy","server"]
       ├─ PluginLogSink  ──redact then──► logger["aio-proxy","plugin",…]
       └─ plugin setup(api)  // apiVersion === 2
            └─ api.logger  (category + secretValues redaction)

Dashboard/SQLite request_log  ← 独立，不经过 LogTape
```

### 依赖方向（禁止环）

```text
plugin-sdk  (defines Logger interface)
    ↑
logger      (implements Logger; depends on @logtape/* only)
    ↑
server / cli / core consumers

core → plugin-sdk          (existing)
cli  → core (aioHome) + logger + server
logger ✗→ core             (forbidden)
plugin-sdk ✗→ logger       (forbidden; only interface lives in sdk)
```

### 包职责

| 包 | 职责 |
| --- | --- |
| `@aio-proxy/plugin-sdk` | 定义 `Logger` 窄接口；`PluginApi.logger`；`PLUGIN_API_VERSION = 2` |
| `@aio-proxy/logger` | LogTape `configure`；实现 `Logger`；stderr + `@logtape/file` 按日文件；secret redaction helper（可复用/抽离精确值替换） |
| `@aio-proxy/server` | 默认 sink 桥接；加载插件时注入带脱敏的 `api.logger`；**移除**模块顶层 `createServerState` |
| `@aio-proxy/cli` | 解析默认 `dir`；`configureLogging`；再加载/创建 server |
| `@aio-proxy/types` | `ServerConfigSchema.logging` |
| `@aio-proxy/core` | 继续提供 `aioHome()`；**可不**新增 `logsDir`/`dailyLogPath`（目录由 CLI 传入）。`logPath()` 保持原义或另议，不作为本设计落点 |

## `@aio-proxy/plugin-sdk` Logger 接口（概念）

```ts
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogBindings = Readonly<Record<string, unknown>>;

export type Logger = {
  readonly debug: (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;
  readonly info: (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;
  readonly warn: (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;
  readonly error: (messageOrProps: string | LogBindings, propsOrMessage?: string | LogBindings) => void;
  readonly child: (bindings: LogBindings) => Logger;
};

export type PluginApi = {
  readonly oauth: { readonly register: ... };
  readonly logger: Logger;
};
```

`@aio-proxy/logger` 导出 `configureLogging` / `createLogger`，返回值满足上述 `Logger`。

调用约定（两种都支持）：

```ts
logger.warn({ providerId, statusCode }, "upstream rate limited");
logger.warn("upstream rate limited: {providerId} status={statusCode}", { providerId, statusCode });
```

Category 约定：

| Category | 用途 |
| --- | --- |
| `["aio-proxy"]` | 根 |
| `["aio-proxy", "server"]` | 服务端 / `ServerLogSink` |
| `["aio-proxy", "server", "pipeline"]` | 请求管线自由日志（可选） |
| `["aio-proxy", "plugin", "<packageName>"]` | 插件 `api.logger` / `PluginLogSink` |
| `["aio-proxy", "cli"]` | CLI |

## 配置

扩展 `ServerConfigSchema`：

```ts
logging: z
  .object({
    enabled: z.boolean().default(false).describe("Write diagnostic logs to daily files under dir."),
    dir: z.string().min(1).optional().describe("Log directory; default {AIO_PROXY_HOME}/logs."),
    retentionDays: z.number().int().min(1).max(365).default(14).describe("Days of daily log files to keep."),
    level: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level."),
  })
  .prefault({})
  .optional();
```

磁盘（`@logtape/file`）：

```ts
getTimeRotatingFileSink({
  directory: dir, // default resolved by CLI: join(aioHome(), "logs")
  interval: "daily",
  filename: (date) => `aio-proxy-${date.toISOString().slice(0, 10)}.log`,
  maxAgeMs: retentionDays * 24 * 60 * 60 * 1000,
});
```

示例文件：`~/.aio-proxy/logs/aio-proxy-2026-07-19.log`

行为：

1. **stderr**：`configureLogging` 之后始终输出（TTY 可读；非 TTY JSON lines）。
2. **disk**：仅 `logging.enabled === true` 时挂 file sink。
3. **retention**：`maxAgeMs` 由 `@logtape/file` 清理；不自研扫目录逻辑。
4. **级别**：只读 `logging.level`。
5. **config reload**：第一版 logging 变更**需重启生效**（实现 plan 写死，避免半热更新复杂度）。

## 启动顺序

问题：`packages/cli/src/main.ts` 静态 import `@aio-proxy/server`，而 `packages/server/src/server.ts` 在模块求值时执行：

```ts
const routes = createRoutes(await createServerState({ config: defaultConfig }));
```

这会使 `configureLogging` 来不及覆盖最早的诊断输出。

**要求（二选一，实现选更小改动）：**

1. **优选**：删除 server 模块的 import-time `createServerState` / 默认 `app` 热路径副作用；测试与类型导出改为显式工厂或 lazy。  
2. **备选**：CLI 在 `await configureLogging(...)` 之后再 `await import("@aio-proxy/server")`。

无论哪种，验收标准是：进程里第一条经 logger/sink 发出的诊断日志，都发生在 `configureLogging` resolve 之后。

## 接线

### CLI

1. 读 config（含 bootstrap）
2. `dir = config.server.logging?.dir ?? join(aioHome(), "logs")`
3. `await configureLogging({ ...config.server.logging, dir })`
4. 再创建 server / `Bun.serve`（遵守上一节启动顺序）

### ServerLog 显式级别

禁止 `event.includes("failed")`。对封闭 union 使用穷尽映射，例如：

```ts
const serverLogLevel: Record<ServerLog["event"], LogLevel> = {
  "config.reload_failed": "error",
  "request.failed": "error",
  "request.recorder_persistence_failed": "error",
  "request.rejected": "warn",
  "request.recorder_invariant": "warn",
  "request.feature_downgraded": "info",
};
```

新增 `ServerLog` 变体时 TypeScript 必须迫使更新该表。

### PluginLogSink 桥接

保持先 `redactPluginError`（或等价），再写入 logger。

### 插件 `api.logger` 与脱敏

加载并 `setup` 时：

```ts
const api: PluginApi = {
  oauth: { register },
  logger: createLogger(["aio-proxy", "plugin", packageName], {
    redactSecretValues: secretValuesFromLoader, // 精确字符串替换为 [REDACTED]
  }),
};
```

要求：

1. `secretValues` 来自现有 loader / options 解析已收集的机密值（与 `collectSecretStrings` / plugin secrets 同源）。
2. 对 message 与 properties 的字符串叶子做精确值脱敏（可复用 `redactPluginError` 的文本替换策略，或抽成共享 helper）。
3. **回归测试**：插件在 setup 中 `api.logger.info({ options }, "boot")` 且 options 含 secret 时，stderr/file **不得**出现明文 secret。

运行时（login / createRuntime）若需更细上下文，后续可用 `logger.child({ providerId })`；**第一版最小要求是 setup 期 `api.logger`**。

## 敏感数据（总则）

- `PluginLogSink` 与 `api.logger` 都必须经过 secret 精确值脱敏。
- Logger 不做「猜字段名」式全局脱敏为唯一防线。
- 自由日志仍禁止主动写入 token / authorization code / refresh token / 完整 cookie；脱敏是失败安全网，不是放行许可。

## 测试

| 层 | 覆盖 |
| --- | --- |
| `@aio-proxy/logger` | level 过滤；child；双写法 message；enabled 时 file sink；`maxAgeMs`/轮转配置接线；secretValues 脱敏 |
| `@aio-proxy/types` | `server.logging` schema 默认值与边界 |
| `@aio-proxy/plugin-sdk` | `PLUGIN_API_VERSION === 2`；`PluginApi.logger` 必有 |
| `@aio-proxy/core` / server loader | 旧 apiVersion 插件被拒绝或标为不兼容 |
| `@aio-proxy/server` | ServerLog 显式 level map；默认 sink 桥接；**无** import-time createServerState 副作用（或等价证明） |
| `@aio-proxy/cli` | configure 先于 server 初始化的顺序测试 |
| 插件脱敏回归 | setup 日志不泄漏 secret options |
| 不做 | Dashboard E2E；远程 shipper；全量插件补点；自研 retention 扫盘 |

## 成功标准

1. `serve` 后 stderr 出现结构化诊断日志，且发生在 `configureLogging` 完成之后。
2. `server.logging.enabled: true` 时，在默认或配置目录生成 `aio-proxy-YYYY-MM-DD.log`（经 `@logtape/file`）。
3. `retentionDays` 映射为 `maxAgeMs` 并交给 file sink。
4. 仅 `apiVersion === 2` 的插件进入 setup；内置插件均已升级。
5. 插件 `api.logger` 可用，且 secret options 不会明文出现在日志中。
6. `ServerLog` 各级别由显式映射决定。
7. Dashboard request log 行为与数据不变。
8. 依赖图无 `logger → core → plugin-sdk → logger` 环。

## 实现分期建议

1. `plugin-sdk`：`Logger` 接口 + `PLUGIN_API_VERSION = 2`；内置插件/测试夹具升级
2. `@aio-proxy/logger`：configure + stderr + `@logtape/file` + redaction；types `logging`
3. 启动顺序修复（去 import-time state 或动态 import）+ CLI configure
4. server sink 桥接（显式 level map）+ 插件 `api.logger` 注入与脱敏回归
5.（可选）关键排障点补 `debug/info`

## 审查回应摘要

| 审查项 | 设计修订 |
| --- | --- |
| P1 API 版本 | 升至 v2；logger 必有 |
| P1 插件脱敏 | `api.logger` 绑定 `secretValues` + 回归测试 |
| P1 configure 太晚 | 去除 import-time server state 或动态 import |
| P2 依赖环 | Logger 接口在 sdk；logger 不依赖 core；CLI 传入 dir |
| P2 轮转 | 使用 `@logtape/file` `getTimeRotatingFileSink` |
| P2 event 猜 level | 改为穷尽 `Record<ServerLog["event"], LogLevel>` |

## 参考

- LogTape：https://logtape.org / https://github.com/dahlia/logtape
- `@logtape/file` time rotating sink：https://logtape.org/manual/sinks（`getTimeRotatingFileSink`）
- Rsbuild `api.logger`：https://rsbuild.rs/plugins/dev/core
- OpenCode `PluginInput`（无 logger）：`packages/plugin/src/index.ts` @ anomalyco/opencode
