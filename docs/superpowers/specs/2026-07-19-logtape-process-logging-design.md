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
- `packages/core/src/paths.ts` 已有 `logPath()` → `{AIO_PROXY_HOME}/aio-proxy.log`（单文件；本文将演进为按日文件目录布局）

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

- 引入 **LogTape**，经新建包 `@aio-proxy/logger` 统一进程诊断日志。
- 插件通过 **`api.logger`**（Rsbuild 风格）获得已绑定插件身份的 logger 实例。
- 保留 `ServerLogSink` / `PluginLogSink` 类型契约，默认实现桥接到 logger。
- 支持 stderr 输出；可选按日落盘，并可配置保留天数。
- 对外 Logger 同时支持「普通 message + properties」与 LogTape `{placeholder}` 写法。

## 非目标

- 不替换、不扩展 Dashboard / SQLite request log 字段。
- 不记录完整 request/response body、headers、API keys。
- 不引入 Winston / Pino。
- 不做远程 log shipper（Datadog、Loki 等）；stderr/file 即可被外部采集。
- 不提供 `LOG_LEVEL` 等环境变量覆盖（级别只来自 config）。
- 第一版不要求现有内置插件大规模补日志点；提供能力与接线即可。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 库 | LogTape（`@logtape/logtape`） |
| 包边界 | 新建 `@aio-proxy/logger`；插件/SDK 不直接依赖 `@logtape/logtape` |
| 插件 API | `PluginApi.logger`（必有）；setup 注入，仿 Rsbuild |
| 消息风格 | 同时支持 `(properties, message)` 与 LogTape 占位符 message |
| 既有 sink | **保留**；默认实现改为桥接 logger |
| 输出 | stderr **始终**有；磁盘由 `server.logging.enabled` 控制 |
| 级别 | 仅 `server.logging.level`；无 env 覆盖 |
| 磁盘路径 | 默认目录 `{AIO_PROXY_HOME}/logs`；文件 `aio-proxy-YYYY-MM-DD.log` |
| 保留 | `retentionDays`，默认 `14` |
| 敏感信息 | 继续以现有 `redactPluginError` / secret 收集为真相来源 |
| `PLUGIN_API_VERSION` | 保持 `1`；`logger` 为宿主注入字段，对旧插件源码兼容（不使用即可） |
| Dashboard request log | 不变 |

## 架构

```text
CLI serve
  └─ configureLogging(config.server.logging)     // @aio-proxy/logger
       ├─ stderr sink (always)
       └─ daily file sink (optional)
  └─ createServer(...)
       ├─ ServerLogSink  ──bridge──► logger["aio-proxy","server"]
       ├─ PluginLogSink  ──bridge──► logger["aio-proxy","plugin",…]
       └─ plugin setup(api)
            └─ api.logger  (child / category 已含 plugin name)

Dashboard/SQLite request_log  ← 独立，不经过 LogTape
```

### 包职责

| 包 | 职责 |
| --- | --- |
| `@aio-proxy/logger` | LogTape `configure`；`Logger` 窄接口；`createLogger` / `child`；stderr + 可选按日文件；retention 清理 |
| `@aio-proxy/plugin-sdk` | `PluginApi` 增加 `logger: Logger`（类型可从 logger 包导入或 re-export） |
| `@aio-proxy/server` | 默认 sink 桥接；加载插件时注入 `api.logger` |
| `@aio-proxy/cli` | `serve` 启动时根据 config 调用 `configureLogging` |
| `@aio-proxy/types` | `ServerConfigSchema` 增加 `logging` |
| `@aio-proxy/core` | 演进 `paths`：新增 `logsDir()` / `dailyLogPath()`；`logPath()` 改写为当天按日文件 |

## `@aio-proxy/logger` 公共 API（概念）

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

export type LoggingConfig = {
  readonly enabled?: boolean; // disk; default false
  readonly dir?: string; // default logsDir() → {AIO_PROXY_HOME}/logs
  readonly retentionDays?: number; // default 14
  readonly level?: LogLevel; // default "info"
};

export function configureLogging(config?: LoggingConfig): Promise<void>;
export function createLogger(category: readonly string[], bindings?: LogBindings): Logger;
```

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

磁盘文件名：

```text
{dir}/aio-proxy-{yyyy}-{MM}-{DD}.log
```

示例：`~/.aio-proxy/logs/aio-proxy-2026-07-19.log`

行为：

1. **stderr**：进程启动并 `configureLogging` 后始终输出结构化日志（TTY 下可用可读 formatter；非 TTY 用 JSON lines）。
2. **disk**：仅当 `logging.enabled === true` 时写入按日文件；目录不存在则创建。
3. **retention**：在 configure 时以及跨日滚动时删除 `dir` 下匹配 `aio-proxy-*.log` 且早于 `retentionDays` 的文件。
4. **级别**：只读 `logging.level`；不引入 `LOG_LEVEL` 环境变量。
5. **config reload**：若 serve 支持热更新 config，logging 的 level/enabled/dir/retentionDays 是否热更新由实现 plan 决定；第一版允许「需重启生效」，但须在实现 plan 写明。

### 与现有 `logPath()` 的关系

当前 `logPath()` 指向单文件 `{AIO_PROXY_HOME}/aio-proxy.log`，与按日目录布局冲突。仓库内尚无生产调用方（仅 paths 导出与单测）。

本文要求：

- 新增 `logsDir()` → `join(aioHome(), "logs")`
- 新增 `dailyLogPath(date = today)` → `join(logsDir(), "aio-proxy-YYYY-MM-DD.log")`
- **改写** `logPath()` 为当天的 `dailyLogPath()`（不再指向根目录单文件），并更新 `paths` 单测
- 权威落点是 `logsDir()` 下的按日文件；根目录 `aio-proxy.log` 不再作为诊断日志路径

## 接线

### CLI

`aio-proxy serve` 在 `createServer` 之前：

1. 读 config（含 bootstrap）
2. `await configureLogging(config.server.logging)`
3. 再创建 server / `Bun.serve`

### Server sink 桥接

```ts
const serverLogger = createLogger(["aio-proxy", "server"]);

const defaultLogger: ServerLogSink = (entry) => {
  const level = entry.event.includes("failed") || entry.event.endsWith(".failed") ? "error" : "info";
  serverLogger[level](entry, entry.event);
};

const defaultPluginLogger: PluginLogSink = (entry) => {
  createLogger(["aio-proxy", "plugin", entry.context.plugin ?? "unknown"], entry.context).error(
    entry,
    entry.event,
  );
};
```

`logServerEvent` 的 try/catch 吞错行为保持不变。

### 插件 `api.logger`

加载并执行 `descriptor.setup(api, options)` 时，宿主构造：

```ts
const api: PluginApi = {
  oauth: { register },
  logger: createLogger(["aio-proxy", "plugin", packageName]),
};
```

插件示例：

```ts
definePlugin((api) => {
  api.logger.info("plugin setup");
  api.oauth.register(adapter);
});
```

运行时（login / createRuntime / catalog）若需要更细上下文，可由宿主在后续迭代把 `logger.child({ providerId })` 放进既有 context；**第一版最小要求是 setup 期 `api.logger`**。

## 敏感数据

- `PluginLogSink` 路径继续先 `redactPluginError` 再写入 logger。
- Logger 本身不做「猜字段」式全局脱敏为唯一防线。
- 自由日志调用方不得写入 token、authorization code、refresh token、完整 cookie 等；规范与 code review 约束。

## 测试

| 层 | 覆盖 |
| --- | --- |
| `@aio-proxy/logger` | level 过滤；child bindings；双写法 message；enabled 文件写入；retention 删除过期 `aio-proxy-*.log` |
| `@aio-proxy/types` | `server.logging` schema 默认值与边界 |
| `@aio-proxy/core` paths | `logsDir` / `dailyLogPath`；`logPath` 等于当天文件 |
| `@aio-proxy/server` | 默认 sink 桥接冒烟（可用 memory/test sink） |
| `@aio-proxy/plugin-sdk` | `PluginApi` 类型含 `logger` |
| 不做 | Dashboard E2E；远程 shipper；全量插件补点 |

## 成功标准

1. `serve` 后 stderr 出现结构化诊断日志。
2. `server.logging.enabled: true` 时，在默认或配置目录生成 `aio-proxy-YYYY-MM-DD.log`。
3. 超过 `retentionDays` 的按日文件会被清理。
4. 插件可在 `setup` 使用 `api.logger`。
5. 现有 `ServerLog` / `PluginLogSink` 调用点无需改签名即可输出到新后端。
6. Dashboard request log 行为与数据不变。

## 实现分期建议

实现 plan 可拆为：

1. `@aio-proxy/logger` + types `logging` + paths 演进
2. CLI configure + server sink 桥接
3. plugin-sdk `api.logger` + 宿主注入
4.（可选）关键排障点补 `debug/info`（pipeline / reload）

## 参考

- LogTape：https://logtape.org / https://github.com/dahlia/logtape
- Rsbuild `api.logger`：https://rsbuild.rs/plugins/dev/core
- OpenCode `PluginInput`（无 logger）：`packages/plugin/src/index.ts` @ anomalyco/opencode
