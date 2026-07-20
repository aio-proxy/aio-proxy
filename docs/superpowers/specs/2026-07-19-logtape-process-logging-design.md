# LogTape 进程诊断日志设计

日期：2026-07-19  
状态：已批准

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

|                   | Rsbuild                          | OpenCode                    | 本文选择           |
| ----------------- | -------------------------------- | --------------------------- | ------------------ |
| 插件如何拿 logger | `api.logger`（实例绑定）         | `PluginInput` **无** logger | **`api.logger`**   |
| 出口配置          | 宿主 `customLogger` / `logLevel` | 宿主自管；插件易污染 TUI    | 宿主 configure     |
| 形态              | rslog（偏 CLI 文案）             | console / Effect            | LogTape 结构化日志 |

## 目标

- 引入 **LogTape**（`@logtape/logtape` + `@logtape/file`），经新建包 `@aio-proxy/logger` 统一进程诊断日志。
- 插件通过 **`api.logger`**（Rsbuild 风格）获得已绑定插件身份、且带精确 secret 脱敏的 logger 实例。
- 保留 `ServerLogSink` / `PluginLogSink` 类型契约，默认实现桥接到 logger；`ServerLog` 用显式 severity 映射。
- 支持 stderr 输出；可选按日落盘与保留天数（`@logtape/file` `getTimeRotatingFileSink` + 默认文件名 + `maxAgeMs`）。
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

| 决策点                | 结论                                                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 库                    | LogTape + `@logtape/file`                                                                                               |
| 包边界                | `@aio-proxy/logger` 只依赖 LogTape 包；**不**依赖 core                                                                  |
| Logger 类型位置       | **窄接口定义在 `plugin-sdk`**；logger 包实现该接口                                                                      |
| 插件 API              | v2 `PluginApi.logger` 为**必有**字段；新宿主对 v1 也注入同形状                                                          |
| `PLUGIN_API_VERSION`  | SDK 常量 **`2`**；宿主 **兼容加载 1 与 2**（见下节）                                                                    |
| 消息风格              | 同时支持 `(properties, message)` 与 LogTape 占位符 message                                                              |
| 既有 sink             | **保留**；默认实现桥接 logger                                                                                           |
| ServerLog 级别        | **显式 map/switch**，禁止用 event 名字符串猜测                                                                          |
| 输出                  | stderr **始终**有；磁盘由 `server.logging.enabled` 控制                                                                 |
| 级别                  | 仅 `server.logging.level`；无 env 覆盖                                                                                  |
| 磁盘                  | `@logtape/file` `getTimeRotatingFileSink`：默认 daily/文件名 + `maxAgeMs`；记录用 JSON Lines                            |
| 文件名                | **使用库默认** `YYYY-MM-DD.log`（由 `dir` 隔离命名空间）；**禁止**自定义 `aio-proxy-` 前缀，否则内置 retention 无法识别 |
| 时区                  | 跨日与文件名均跟随 `@logtape/file` 本地日界，不使用 `toISOString()`（UTC）生成文件名                                    |
| 默认目录              | CLI 用 `aioHome()` 算出 `{AIO_PROXY_HOME}/logs` 后传入 `configureLogging`                                               |
| 保留                  | `retentionDays` → `maxAgeMs = retentionDays * 86400000`；默认 `14`                                                      |
| 对外 level 名         | config / `Logger.warn` 使用 `"warn"`；configure LogTape 时映射为 `"warning"`                                            |
| 插件脱敏              | 宿主注入的 `api.logger` **必须**绑定 loader 已收集的 `secretValues` 精确值脱敏；遍历规则见专节                          |
| 启动顺序              | 去掉 server 模块 import-time `createServerState`，或 CLI 在 configure 后动态 import server                              |
| Plugin API 兼容       | **新宿主同时接受 v1 与 v2**；仅旧宿主会拒绝 v2（见兼容性专节）                                                          |
| Dashboard request log | 不变                                                                                                                    |

## 兼容性：`PLUGIN_API_VERSION` v1 / v2 并存

问题本质是**双向**兼容：

| 组合                 | 风险                                              |
| -------------------- | ------------------------------------------------- |
| 旧插件 (v1) + 新宿主 | 应继续可跑；旧插件不访问 `logger`                 |
| 新插件 (v2) + 旧宿主 | 旧宿主若仍当 v1 接受 → setup 读 `api.logger` 崩溃 |

**选定：兼容方案（非一刀切破坏性升级）。**

1. **SDK / 内置插件**：当前 `PLUGIN_API_VERSION` 常量改为 `2`；仓库内描述符与夹具发 v2。
2. **新宿主加载规则**：
   - 接受 `apiVersion === 1` 或 `2`；其它值 → `PLUGIN_API_INCOMPATIBLE`，不进入 setup。
   - **无论 v1/v2**，新宿主注入的运行时 `api` 都包含 `oauth` + `logger`（v1 插件忽略 `logger` 即可）。
   - TypeScript 上：v2 的 `PluginApi` 将 `logger` 标为必有；宿主实现对 v1 描述符仍注入同一形状。
3. **旧宿主**：只认识 v1，会拒绝 v2 描述符 → **防止**「新插件在旧宿主半加载后崩溃」。这是升 v2 的主要目的。
4. **文档措辞**：不再写「新宿主拒绝所有非 v2」；明确「新宿主兼容 v1/v2；旧宿主拒绝 v2」。
5. 不采用「logger 可选 + 插件探测」作为主方案：新插件应直接依赖 `api.logger`；靠 apiVersion=2 把旧宿主挡在门外。

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
       └─ plugin setup(api)  // host accepts apiVersion 1|2
            └─ api.logger  (category + secretValues redaction; v1 ignores)

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

| 包                      | 职责                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `@aio-proxy/plugin-sdk` | 定义 `Logger` 窄接口；`PluginApi.logger`；`PLUGIN_API_VERSION = 2`                                                           |
| `@aio-proxy/logger`     | LogTape `configure`；实现 `Logger`；stderr + `@logtape/file` 按日文件；secret redaction helper（可复用/抽离精确值替换）      |
| `@aio-proxy/server`     | 默认 sink 桥接；加载插件时注入带脱敏的 `api.logger`；**移除**模块顶层 `createServerState`                                    |
| `@aio-proxy/cli`        | 解析默认 `dir`；`configureLogging`；再加载/创建 server                                                                       |
| `@aio-proxy/types`      | `ServerConfigSchema.logging`                                                                                                 |
| `@aio-proxy/core`       | 继续提供 `aioHome()`；**可不**新增 `logsDir`/`dailyLogPath`（目录由 CLI 传入）。`logPath()` 保持原义或另议，不作为本设计落点 |

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

| Category                                   | 用途                                |
| ------------------------------------------ | ----------------------------------- |
| `["aio-proxy"]`                            | 根                                  |
| `["aio-proxy", "server"]`                  | 服务端 / `ServerLogSink`            |
| `["aio-proxy", "server", "pipeline"]`      | 请求管线自由日志（可选）            |
| `["aio-proxy", "plugin", "<packageName>"]` | 插件 `api.logger` / `PluginLogSink` |
| `["aio-proxy", "cli"]`                     | CLI                                 |

## 配置

扩展 `ServerConfigSchema`：

```ts
logging: z.object({
  enabled: z.boolean().default(false).describe("Write diagnostic logs to daily files under dir."),
  dir: z.string().min(1).optional().describe("Log directory; default {AIO_PROXY_HOME}/logs."),
  retentionDays: z.number().int().min(1).max(365).default(14).describe("Days of daily log files to keep."),
  level: z.enum(["debug", "info", "warn", "error"]).default("info").describe("Minimum log level."),
})
  .prefault({})
  .optional();
```

磁盘（继承 `@logtape/file` 管理机制，不自研轮转/清理/命名）：

```ts
getTimeRotatingFileSink({
  directory: dir, // CLI 默认 join(aioHome(), "logs")
  formatter: jsonLinesFormatter,
  maxAgeMs: retentionDays * 24 * 60 * 60 * 1000,
  // 不传 interval / filename：使用库默认 daily + YYYY-MM-DD.log
});
```

原则：

1. **轮转、默认文件名、过期删除全部交给 `@logtape/file`**。
2. 轮转相关只配置 `directory` 与由 `retentionDays` 导出的 `maxAgeMs`；`formatter` 使用 LogTape 内置 `jsonLinesFormatter`，保留结构化 properties。
3. **禁止**自定义 filename / 自研扫盘 retention；前缀命名空间用目录隔离（`{AIO_PROXY_HOME}/logs`）。

示例文件：`~/.aio-proxy/logs/2026-07-19.log`

行为：

1. **stderr**：`configureLogging` 之后始终输出（TTY 可读；非 TTY JSON lines）。
2. **disk**：仅 `logging.enabled === true` 时挂 file sink；内容为 JSON Lines，保留结构化 properties。
3. **retention**：仅依赖 `@logtape/file` 对默认文件名的 `maxAgeMs` 清理。
4. **级别**：config 使用 `"debug"|"info"|"warn"|"error"`；调用 LogTape `lowestLevel` / sink 配置时将 `"warn"` **映射为** `"warning"`。`Logger.warn` 方法名保持 `warn`。
5. **config reload**：第一版 logging 变更**需重启生效**（实现 plan 写死）。

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

加载并 `setup` 时（v1/v2 描述符在新宿主上均注入）：

```ts
const api = {
  oauth: { register },
  logger: createLogger(["aio-proxy", "plugin", packageName], {
    redactSecretValues: secretValuesFromLoader, // 精确字符串替换为 [REDACTED]
  }),
};
```

要求：

1. `secretValues` 来自现有 loader / options 解析已收集的机密值（与 `collectSecretStrings` / plugin secrets 同源）。
2. 对 message 与 properties 做精确值脱敏；遍历规则见下一节。
3. **回归测试**：
   - setup 中 `api.logger.info({ options }, "boot")` 且 options 含 secret → 无明文；
   - properties 含 `Error`（message/stack 嵌 secret）→ 无明文；
   - properties 含循环引用对象 → **不抛错**，且不输出未脱敏原文。

运行时（login / createRuntime）若需更细上下文，后续可用 `logger.child({ providerId })`；**第一版最小要求是 setup 期 `api.logger`**。

## 脱敏遍历规则

精确值替换（已知 secret 字符串 → `[REDACTED]`），不是字段名猜测。

实现必须：

1. **永不因脱敏抛错到调用方**；脱敏失败时该条日志降级为安全占位（例如只保留 level/category/message=`"log redaction failed"`），**禁止**回退输出原始 properties。
2. 覆盖：`string`、普通对象、数组、`Error` 的 `name`/`message`/`stack`。
3. **不**盲目触发 getter / Proxy 陷阱；优先读取自有数据属性（可对齐现有 `collectSecretStrings` / `redactPluginError` 的保守策略）。
4. 遇到 `Map`/`Set`：尽力脱敏其可枚举内容；失败则省略该分支并记安全占位，不得抛错。
5. 循环引用：用 `WeakSet`/`Set` 去重，跳过已访问对象。
6. 与 `PluginLogSink` 路径共享同一 helper，避免两套语义漂移。

## 敏感数据（总则）

- `PluginLogSink` 与 `api.logger` 都必须经过 secret 精确值脱敏。
- Logger 不做「猜字段名」式全局脱敏为唯一防线。
- 自由日志仍禁止主动写入 token / authorization code / refresh token / 完整 cookie；脱敏是失败安全网，不是放行许可。

## 测试

| 层                                | 覆盖                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| `@aio-proxy/logger`               | level 过滤；child；双写法 message；enabled 时 file sink；`maxAgeMs`/轮转配置接线；secretValues 脱敏 |
| `@aio-proxy/types`                | `server.logging` schema 默认值与边界                                                                |
| `@aio-proxy/plugin-sdk`           | 当前常量 `PLUGIN_API_VERSION === 2`；`PluginApi.logger` 必有                                        |
| `@aio-proxy/core` / server loader | 新宿主接受 v1+v2；其它 version → 不兼容；旧宿主行为由版本门禁覆盖                                   |
| `@aio-proxy/server`               | ServerLog 显式 level map；默认 sink 桥接；**无** import-time createServerState 副作用（或等价证明） |
| `@aio-proxy/cli`                  | configure 先于 server 初始化的顺序测试                                                              |
| 插件脱敏回归                      | secret options；Error message/stack；循环引用不抛错且不泄密                                         |
| 不做                              | Dashboard E2E；远程 shipper；全量插件补点；自研 retention 扫盘；自定义带前缀文件名                  |

## 成功标准

1. `serve` 后 stderr 出现结构化诊断日志，且发生在 `configureLogging` 完成之后。
2. `server.logging.enabled: true` 时，在默认或配置目录生成库默认名 `YYYY-MM-DD.log`（经 `@logtape/file`）。
3. `retentionDays` 映射为 `maxAgeMs`；因使用默认文件名，过期文件可被库清理。
4. 新宿主接受 v1 与 v2；内置插件发 v2；旧宿主会拒绝 v2。
5. 插件 `api.logger` 可用，且 secret options / Error / 循环对象场景不会明文泄漏或抛垮进程。
6. `ServerLog` 各级别由显式映射决定。
7. Dashboard request log 行为与数据不变。
8. 依赖图无 `logger → core → plugin-sdk → logger` 环。

## 实现分期建议

1. `plugin-sdk`：`Logger` 接口 + 常量 v2；内置插件/夹具升级；**loader 接受 v1|v2**
2. `@aio-proxy/logger`：configure + stderr + `@logtape/file`（默认 `YYYY-MM-DD.log` + `maxAgeMs`）+ `warn→warning` + 安全脱敏；types `logging`
3. 启动顺序修复（去 import-time state 或动态 import）+ CLI 解析 dir 并 configure
4. server sink 桥接（显式 level map）+ `api.logger` 注入（v1/v2）与脱敏回归5.（可选）关键排障点补 `debug/info`

## 审查回应摘要

| 审查项            | 设计修订                                                 |
| ----------------- | -------------------------------------------------------- |
| P1 API 版本       | SDK 常量升 v2；**新宿主兼容 v1+v2**；旧宿主拒 v2         |
| P1 插件脱敏       | `api.logger` 绑定 `secretValues` + 安全遍历 + 回归测试   |
| P1 configure 太晚 | 去除 import-time server state 或动态 import              |
| P2 依赖环         | Logger 接口在 sdk；logger 不依赖 core；CLI 传入 dir      |
| P2 轮转           | `@logtape/file` + **默认** `YYYY-MM-DD.log` + `maxAgeMs` |
| P2 event 猜 level | 穷尽 `Record<ServerLog["event"], LogLevel>`              |
| P2 warn 映射      | 对外 `warn`；LogTape configure 用 `warning`              |

## 参考

- LogTape：https://logtape.org / https://github.com/dahlia/logtape
- `@logtape/file` time rotating sink：https://logtape.org/manual/sinks（`getTimeRotatingFileSink`）
- Rsbuild `api.logger`：https://rsbuild.rs/plugins/dev/core
- OpenCode `PluginInput`（无 logger）：`packages/plugin/src/index.ts` @ anomalyco/opencode
