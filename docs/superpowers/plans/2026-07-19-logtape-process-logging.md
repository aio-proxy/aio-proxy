# LogTape Process Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship process diagnostic logging via `@aio-proxy/logger` (LogTape), bridge existing sinks, inject redacted `api.logger` into plugins, and optionally write daily files under `{AIO_PROXY_HOME}/logs`.

**Architecture:** Define a narrow `Logger` interface in `plugin-sdk`. Implement it in a new `@aio-proxy/logger` package that depends only on `@logtape/logtape` and `@logtape/file` (no dependency on `core`). CLI resolves the default log directory with `aioHome()`, calls `configureLogging` before any server initialization, then creates the server. Plugin loader accepts API versions `1` and `2`; SDK constant becomes `2`. Host always injects `api.logger` with secret-value redaction.

**Tech Stack:** Bun ≥1.3.14, TypeScript, LogTape (`@logtape/logtape`, `@logtape/file`), Zod config in `@aio-proxy/types`, Bun test.

**Spec:** `docs/superpowers/specs/2026-07-19-logtape-process-logging-design.md`

## Global Constraints

- Dashboard / SQLite request logs are out of scope; do not change their schema or UI.
- `@aio-proxy/logger` must not depend on `@aio-proxy/core` or `@aio-proxy/plugin-sdk` (sdk defines the interface only; logger implements a structurally compatible type, or depends on a tiny shared types-only path if unavoidable — prefer structural typing / duplicate the tiny interface in logger and have sdk own the canonical export).
- Prefer: `plugin-sdk` exports `Logger`; `@aio-proxy/logger` depends on `plugin-sdk` **only if that does not create a cycle**. Today `plugin-sdk` does not depend on logger or core, so `logger → plugin-sdk` is allowed. `plugin-sdk → logger` is forbidden.
- Disk logging uses `@logtape/file` `getTimeRotatingFileSink` with **library defaults** for interval/filename (`daily`, `YYYY-MM-DD.log`). Pass only `directory` + `maxAgeMs`.
- No custom filename prefix; no hand-rolled retention scanner.
- No `LOG_LEVEL` env override; level comes from `server.logging.level`.
- Map config/`Logger` level `"warn"` → LogTape `"warning"` at configure boundaries.
- `ServerLog` severity uses an exhaustive map; never `event.includes("failed")`.
- Plugin logger redaction must not throw; on failure emit a safe placeholder record, never raw input.
- Logging config changes require process restart (v1).
- First release does not require mass instrumentation of every pipeline path.
- Run package-local `bun test` for touched packages; do not expand into unrelated refactors.

## File Map

| Path | Responsibility |
| --- | --- |
| `packages/plugin-sdk/src/logger.ts` (new) | `LogLevel`, `LogBindings`, `Logger` types |
| `packages/plugin-sdk/src/plugin.ts` | `PLUGIN_API_VERSION = 2`; `PluginApi.logger`; `isPluginDescriptor` accepts 1\|2 |
| `packages/logger/` (new package) | `configureLogging`, `createLogger`, redaction, LogTape sinks |
| `packages/types/src/config.ts` | `server.logging` schema |
| `packages/core/src/plugins/loader/descriptor.ts` | Accept apiVersion 1\|2 |
| `packages/core/src/plugins/registry.ts` | Inject `api.logger` in `stage()` |
| `packages/server/src/server.ts` | Remove import-time `createServerState` |
| `packages/server/src/server-log.ts` / bridge helper | Exhaustive `ServerLog` level map + sink adapters |
| `packages/server/src/server-state/index.ts` | Default sinks → logger bridge |
| `packages/cli/src/main.ts` | Resolve dir, `configureLogging`, then create server |
| Root `package.json` workspaces | Include `packages/logger` if needed (already `packages/*`) |

---

### Task 1: Plugin SDK Logger interface + API v2 (compat load 1\|2)

**Files:**
- Create: `packages/plugin-sdk/src/logger.ts`
- Modify: `packages/plugin-sdk/src/plugin.ts`
- Modify: `packages/plugin-sdk/src/index.ts`
- Modify: `packages/plugin-sdk/_test/descriptor.test.ts` (or create if patterns live elsewhere)
- Modify: `packages/core/src/plugins/loader/descriptor.ts`
- Modify: `packages/core/src/plugins/loader/descriptor.test.ts`

**Interfaces:**
- Produces:
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
  export const PLUGIN_API_VERSION = 2;
  export const PLUGIN_API_VERSIONS_SUPPORTED = [1, 2] as const;
  export type PluginApi = {
    readonly oauth: { readonly register: <Options, Credential>(adapter: OAuthAdapter<Options, Credential>) => void };
    readonly logger: Logger;
  };
  ```
- Consumes later: registry injects `logger`; loader accepts versions in `PLUGIN_API_VERSIONS_SUPPORTED`.

- [ ] **Step 1: Write failing descriptor compatibility tests**

In `packages/core/src/plugins/loader/descriptor.test.ts`, replace/extend the existing “future apiVersion 2 incompatible” case:

```ts
test("apiVersion 1 remains loadable after host supports v2", async () => {
  const descriptor = {
    [PLUGIN_DESCRIPTOR_BRAND]: true,
    apiVersion: 1,
    metadata: {},
    setup() {},
  };
  expect(validateDescriptor(descriptor).apiVersion).toBe(1);
});

test("apiVersion 2 is loadable", async () => {
  const descriptor = definePlugin(() => {});
  expect(descriptor.apiVersion).toBe(2);
  expect(validateDescriptor(descriptor).apiVersion).toBe(2);
});

test("apiVersion 3 fails with incompatibility", async () => {
  const descriptor = { ...definePlugin(() => {}), apiVersion: 3 };
  expect(() => validateDescriptor(descriptor)).toThrow(PluginHostError);
  try {
    validateDescriptor(descriptor);
  } catch (error) {
    expect(error).toMatchObject({ code: "PLUGIN_API_INCOMPATIBLE" });
  }
});
```

- [ ] **Step 2: Run tests — expect fail**

Run: `bun test packages/core/src/plugins/loader/descriptor.test.ts`  
Expected: fail because `PLUGIN_API_VERSION` is still `1` and/or v2 is rejected.

- [ ] **Step 3: Implement SDK + loader changes**

`packages/plugin-sdk/src/logger.ts` — export types above.

`packages/plugin-sdk/src/plugin.ts`:
- set `PLUGIN_API_VERSION = 2`
- export `PLUGIN_API_VERSIONS_SUPPORTED = [1, 2] as const`
- add `logger: Logger` to `PluginApi`
- change `isPluginDescriptor` to accept `apiVersion === 1 || apiVersion === 2` (do not require equality only to constant `2`, or v1 third-party descriptors fail brand checks)

`packages/core/src/plugins/loader/descriptor.ts`:
```ts
import { PLUGIN_API_VERSIONS_SUPPORTED, ... } from "@aio-proxy/plugin-sdk";

const supported = new Set<number>(PLUGIN_API_VERSIONS_SUPPORTED);
// in validateDescriptor:
if (Number.isInteger(apiVersion) && !supported.has(apiVersion as number)) {
  throw new PluginHostError("PLUGIN_API_INCOMPATIBLE");
}
```

Keep `definePlugin` stamping `apiVersion: PLUGIN_API_VERSION` (now 2).

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test packages/core/src/plugins/loader/descriptor.test.ts`  
Also: `bun run --filter @aio-proxy/plugin-sdk test:unit`

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-sdk packages/core/src/plugins/loader
git commit -m "feat(plugin-sdk): add Logger API and accept plugin versions 1-2"
```

---

### Task 2: Create `@aio-proxy/logger` with configure, dual message styles, warn mapping

**Files:**
- Create: `packages/logger/package.json`
- Create: `packages/logger/tsconfig.json`
- Create: `packages/logger/src/index.ts`
- Create: `packages/logger/src/configure.ts`
- Create: `packages/logger/src/create-logger.ts`
- Create: `packages/logger/src/levels.ts`
- Create: `packages/logger/src/redact.ts`
- Create: `packages/logger/_test/create-logger.test.ts`
- Create: `packages/logger/_test/configure.test.ts`
- Modify: root workspace if needed (already `packages/*`)
- Modify: `bun.lock` via `bun install`

**Interfaces:**
- Produces:
  ```ts
  import type { LogBindings, LogLevel, Logger } from "@aio-proxy/plugin-sdk";

  export type LoggingConfig = {
    readonly enabled?: boolean;
    readonly dir: string; // required at configure boundary after CLI defaulting
    readonly retentionDays?: number; // default 14
    readonly level?: LogLevel; // default "info"
  };

  export function toLogTapeLevel(level: LogLevel): "debug" | "info" | "warning" | "error";
  export function configureLogging(config: LoggingConfig): Promise<void>;
  export function createLogger(
    category: readonly string[],
    options?: { readonly bindings?: LogBindings; readonly redactSecretValues?: readonly string[] },
  ): Logger;
  ```
- Consumes: `@logtape/logtape`, `@logtape/file`, `@aio-proxy/plugin-sdk` types.

- [ ] **Step 1: Scaffold package + failing unit tests**

`packages/logger/package.json`:
```json
{
  "name": "@aio-proxy/logger",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "bun run test:unit",
    "test:unit": "bun test"
  },
  "dependencies": {
    "@aio-proxy/plugin-sdk": "workspace:*",
    "@logtape/file": "^1.0.0",
    "@logtape/logtape": "^1.0.0"
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:"
  }
}
```

Pin exact LogTape versions after `bun add` resolves current 2.x lines used in the spec (`@logtape/logtape` / `@logtape/file` compatible with `getTimeRotatingFileSink`). Prefer the latest 2.1.x that provides time rotating sinks.

`_test/create-logger.test.ts` (message styles + level filter via memory sink if LogTape allows reset/configure in tests):

```ts
import { describe, expect, test } from "bun:test";
import { configure, getConsoleSink, reset } from "@logtape/logtape";
import { configureLogging, createLogger } from "../src";

// Prefer a capturing sink in tests; if using configureLogging, reset between tests.
```

Minimum assertions:
1. `logger.info({ a: 1 }, "hello")` emits properties `{ a: 1 }` and message `hello`.
2. `logger.info("hello {a}", { a: 1 })` works (placeholder style).
3. `logger.warn(...)` is recorded (after warn→warning mapping).
4. With `redactSecretValues: ["sekrit"]`, logging `{ token: "sekrit" }` does not contain `sekrit`.

- [ ] **Step 2: Run tests — expect fail**

Run: `cd packages/logger && bun test`  
Expected: fail (module missing).

- [ ] **Step 3: Implement logger package**

`levels.ts`:
```ts
import type { LogLevel } from "@aio-proxy/plugin-sdk";
export function toLogTapeLevel(level: LogLevel) {
  return level === "warn" ? "warning" : level;
}
```

`configure.ts`:
```ts
import { configure, getConsoleSink } from "@logtape/logtape";
import { getTimeRotatingFileSink } from "@logtape/file";
import { toLogTapeLevel } from "./levels";

export async function configureLogging(config: {
  enabled?: boolean;
  dir: string;
  retentionDays?: number;
  level?: "debug" | "info" | "warn" | "error";
}) {
  const level = toLogTapeLevel(config.level ?? "info");
  const retentionDays = config.retentionDays ?? 14;
  const sinks: Record<string, unknown> = {
    console: getConsoleSink(), // JSON/pretty policy per LogTape defaults + TTY if available
  };
  const sinkIds = ["console"];
  if (config.enabled === true) {
    sinks.file = getTimeRotatingFileSink({
      directory: config.dir,
      maxAgeMs: retentionDays * 24 * 60 * 60 * 1000,
    });
    sinkIds.push("file");
  }
  await configure({
    sinks: sinks as never,
    loggers: [{ category: ["aio-proxy"], lowestLevel: level, sinks: sinkIds }],
  });
}
```

`create-logger.ts`: wrap `getLogger(category)` from LogTape; normalize `(props, msg)` vs `(msg, props)`; apply redaction before emit; `child` merges bindings.

- [ ] **Step 4: Run tests — expect pass**

Run: `bun test` in `packages/logger`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/logger package.json bun.lock
git commit -m "feat(logger): add LogTape-backed @aio-proxy/logger package"
```

---

### Task 3: Safe secret redaction helper + regression tests

**Files:**
- Modify: `packages/logger/src/redact.ts`
- Modify: `packages/logger/_test/redact.test.ts` (create)
- Optional share: extract pure string replace from `packages/core/src/plugins/diagnostic.ts` only if it does not force `logger → core`. Prefer reimplementing the small exact-value replacer inside logger, or move a tiny pure helper into `plugin-sdk` / `types` later — **do not** add `logger → core`.

**Interfaces:**
- Produces: `redactLogValue(value: unknown, secretValues: readonly string[]): unknown`  
  and/or `redactLogText(text: string, secretValues: readonly string[]): string`

- [ ] **Step 1: Write failing redaction tests**

```ts
test("redacts secret strings in plain objects", () => {
  expect(redactLogValue({ token: "abc" }, ["abc"])).toEqual({ token: "[REDACTED]" });
});

test("redacts Error message and stack without throwing", () => {
  const error = new Error("boom abc");
  error.stack = "Error: boom abc\n    at x";
  const out = redactLogValue(error, ["abc"]) as { message: string; stack?: string };
  expect(out.message.includes("abc")).toBe(false);
  expect(out.stack?.includes("abc")).toBe(false);
});

test("circular objects do not throw and do not leak secrets", () => {
  const obj: Record<string, unknown> = { token: "abc" };
  obj.self = obj;
  expect(() => redactLogValue(obj, ["abc"])).not.toThrow();
  const json = JSON.stringify(redactLogValue(obj, ["abc"]));
  expect(json.includes("abc")).toBe(false);
});

test("redaction failure yields safe placeholder rather than raw input", () => {
  // Use a throwing getter proxy; implementation must catch and return safe placeholder
});
```

- [ ] **Step 2: Run — expect fail / implement / pass**

Implement conservative walk:
- track seen objects with `WeakSet`
- handle string, array, plain object, `Error`
- do not invoke arbitrary getters (own enumerable data props only, matching core’s cautious style)
- on any throw → return `{ message: "log redaction failed" }` (or equivalent safe structure)

Wire `createLogger` so every emit runs redaction when `redactSecretValues` non-empty.

- [ ] **Step 3: Commit**

```bash
git add packages/logger
git commit -m "feat(logger): harden secret redaction for plugin logs"
```

---

### Task 4: Config schema `server.logging`

**Files:**
- Modify: `packages/types/src/config.ts`
- Modify: `packages/types/src/*.test.ts` or `_test` covering ConfigSchema
- Rebuild types package as required by workspace

**Interfaces:**
- Produces `ServerConfig.logging?: { enabled: boolean; dir?: string; retentionDays: number; level: LogLevel }` with defaults `enabled:false`, `retentionDays:14`, `level:"info"`.

- [ ] **Step 1: Failing schema tests** for defaults and rejection of `level: "verbose"`, `retentionDays: 0`.

- [ ] **Step 2: Implement schema**

```ts
const ServerLoggingSchema = z.object({
  enabled: z.boolean().default(false),
  dir: z.string().min(1).optional(),
  retentionDays: z.number().int().min(1).max(365).default(14),
  level: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const ServerConfigSchema = z.object({
  host: ...,
  port: ...,
  logging: ServerLoggingSchema.prefault({}).optional(),
});
```

- [ ] **Step 3: `bun test` in types + commit**

```bash
git commit -m "feat(types): add server.logging config schema"
```

---

### Task 5: Remove import-time server state + CLI configure ordering

**Files:**
- Modify: `packages/server/src/server.ts` (remove top-level `createRoutes(await createServerState(...))` side effect; keep `createServer` factory; adjust `app` / `AppType` exports for tests)
- Modify any imports that relied on default `app` at import time (search `from "@aio-proxy/server"` / `bunServer`)
- Modify: `packages/cli/src/main.ts`
- Create: `packages/cli/_test/logging-boot-order.test.ts` (or extend `main.test.ts`)

**Interfaces:**
- Produces: CLI boot sequence `configureLogging → createServer`
- Produces: server module import has **no** `createServerState` await at top level

- [ ] **Step 1: Write failing boot-order test**

Spy/mock approach:
1. Instrument `configureLogging` and `createServerState` call order with counters.
2. Assert configure resolves before `createServerState` runs when invoking serve path.

If hard to hook through CLI, unit-test a extracted `bootServer(deps)` helper:

```ts
export async function bootProxyServer(deps: {
  config: Config;
  configureLogging: (input: LoggingConfig) => Promise<void>;
  createServer: typeof createServer;
  aioHome: () => string;
}) {
  const logging = deps.config.server.logging ?? {};
  const dir = logging.dir ?? join(deps.aioHome(), "logs");
  await deps.configureLogging({
    enabled: logging.enabled,
    dir,
    retentionDays: logging.retentionDays,
    level: logging.level,
  });
  return deps.createServer({ config: deps.config, ... });
}
```

- [ ] **Step 2: Remove import-time state in `server.ts`**

Replace:
```ts
const routes = createRoutes(await createServerState({ config: defaultConfig }));
export const app = routes;
```
with a lazy/test-only pattern that does **not** run on CLI import. Prefer exporting `createServer` only for production, and construct `AppType` via `ReturnType`/`Awaited` without executing state init. Update type tests accordingly.

- [ ] **Step 3: Wire CLI**

```ts
import { aioHome } from "@aio-proxy/core";
import { configureLogging } from "@aio-proxy/logger";
import { join } from "node:path";

// inside serve(), after config parse:
const logging = config.server.logging ?? {};
await configureLogging({
  enabled: logging.enabled,
  dir: logging.dir ?? join(aioHome(), "logs"),
  retentionDays: logging.retentionDays,
  level: logging.level,
});
const app = await createServer({ config, configPath, dashboardAssets, host, port });
```

Add `@aio-proxy/logger` dependency to `packages/cli/package.json` and `packages/server/package.json` as needed.

- [ ] **Step 4: Tests pass + commit**

```bash
git commit -m "fix(server): configure logging before server initialization"
```

---

### Task 6: Bridge ServerLogSink / PluginLogSink + exhaustive levels

**Files:**
- Create: `packages/server/src/logging/bridge.ts`
- Create: `packages/server/src/logging/bridge.test.ts`
- Modify: `packages/server/src/server-state/index.ts` (replace `defaultLogger` / `defaultPluginLogger`)
- Modify: `packages/server/src/server-log.ts` only if exporting level helper helps

**Interfaces:**
- Produces:
  ```ts
  export const SERVER_LOG_LEVEL: { readonly [E in ServerLog["event"]]: LogLevel };
  export function createServerLogSink(logger: Logger): ServerLogSink;
  export function createPluginLogSink(create: (context) => Logger): PluginLogSink;
  ```

- [ ] **Step 1: Failing tests for level map**

```ts
test("maps request.rejected to warn and request.failed to error", () => {
  expect(SERVER_LOG_LEVEL["request.rejected"]).toBe("warn");
  expect(SERVER_LOG_LEVEL["request.failed"]).toBe("error");
  expect(SERVER_LOG_LEVEL["request.recorder_invariant"]).toBe("warn");
  expect(SERVER_LOG_LEVEL["request.feature_downgraded"]).toBe("info");
});
```

Use a fake `Logger` capturing calls to assert sink bridging.

- [ ] **Step 2: Implement map + bridges; wire defaults in `createServerState`**

```ts
import { createLogger } from "@aio-proxy/logger";

const defaultLogger = createServerLogSink(createLogger(["aio-proxy", "server"]));
const defaultPluginLogger = createPluginLogSink((context) =>
  createLogger(["aio-proxy", "plugin", context.plugin ?? "unknown"], {
    bindings: context,
  }),
);
```

Plugin sink must still receive already-redacted errors from callers; do not undo existing `redactPluginError` call sites.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(server): bridge typed log sinks to LogTape logger"
```

---

### Task 7: Inject redacted `api.logger` in plugin registry staging

**Files:**
- Modify: `packages/core/src/plugins/registry.ts`
- Modify: `packages/core/src/plugins/loader/index.ts` (pass secret values into stage if needed)
- Modify: `packages/core/src/plugins/loader/options-and-secrets.test.ts` / new `registry-logger.test.ts`
- Modify: `packages/core/package.json` to depend on `@aio-proxy/logger`

**Interfaces:**
- Change `createPluginRegistryHost` / `stage(plugin)` to accept secret values provider:
  ```ts
  stage(plugin: string, options?: { redactSecretValues?: readonly string[] })
  ```
  or close over secrets known at load time.

- [ ] **Step 1: Failing test — setup logger redacts plugin options secrets**

```ts
test("api.logger redacts secret option values during setup", async () => {
  const lines: unknown[] = [];
  // configure test sink OR inject createLogger factory
  const host = createPluginRegistryHost(pluginLogSink, {
    createPluginLogger: (plugin, secrets) => /* capturing logger with redact */,
  });
  const staging = host.stage("@example/oauth", { redactSecretValues: ["super-secret"] });
  staging.api.logger.info({ token: "super-secret" }, "boot");
  expect(JSON.stringify(lines).includes("super-secret")).toBe(false);
  expect(staging.api.logger).toBeDefined();
});
```

- [ ] **Step 2: Implement injection**

In `stage()`:
```ts
api: {
  oauth: { register(value) { ... } },
  logger: createLogger(["aio-proxy", "plugin", plugin], {
    redactSecretValues: options?.redactSecretValues ?? [],
  }),
}
```

Thread secret values from loader (where plugin options/secrets are parsed) into `stage(...)`.

- [ ] **Step 3: Tests pass + commit**

```bash
git commit -m "feat(core): inject redacted api.logger into plugin setup"
```

---

### Task 8: Smoke verification + docs touch-up

**Files:**
- Optional: short note in `npm/aio-proxy/README.md` or CLI help — only if repo already documents config keys nearby
- Modify: design status line to `已批准` if process requires (optional)

- [ ] **Step 1: Run focused verification**

```bash
bun test packages/logger
bun test packages/core/src/plugins/loader/descriptor.test.ts
bun test packages/server/src/logging/bridge.test.ts
bun run --filter @aio-proxy/types test:unit
```

Manual smoke (local):
1. `aio-proxy serve` → stderr shows JSON/structured logs after boot
2. config `server.logging.enabled: true` → file `~/.aio-proxy/logs/YYYY-MM-DD.log` appears
3. Plugin setup can call `api.logger.info("hi")`

- [ ] **Step 2: Commit any leftover fixes**

```bash
git commit -m "test: verify LogTape process logging integration"
```

---

## Self-Review vs Spec

| Spec requirement | Task |
| --- | --- |
| `@aio-proxy/logger` + LogTape | Task 2 |
| Logger interface in plugin-sdk; no logger→core cycle | Task 1–2 |
| `PLUGIN_API_VERSION` 2 + host accepts 1\|2 | Task 1 |
| `api.logger` required on v2 PluginApi; injected for v1 too | Task 1, 7 |
| Dual message styles | Task 2 |
| `warn` → LogTape `warning` | Task 2 |
| `@logtape/file` defaults only (`directory` + `maxAgeMs`) | Task 2, 5 |
| `server.logging` config | Task 4 |
| configure before server init / no import-time state | Task 5 |
| ServerLog exhaustive levels + sink bridge | Task 6 |
| Plugin logger secret redaction + safe traversal | Task 3, 7 |
| Dashboard request log untouched | Global constraint |
| Restart for logging config | Global constraint / Task 5 |

No intentional placeholders remain in task steps.
