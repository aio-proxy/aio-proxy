# aio-proxy 发布形态实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 aio-proxy 变成可通过 curl / npm 分发的 Bun 自包含单二进制，用户无需安装 bun/node，主包名 `aio-proxy`。

**Architecture:** dashboard 静态资源在编译期 embed 进二进制；server 的静态目录参数抽象成资产提供函数；CLI 增加四平台 compile 管线；npm 侧是 esbuild 模式（主包 + os/cpu 平台包 + node launcher）；changesets fixed 组同步全部包版本，GitHub Actions 负责 Version PR 与发布。

**Tech Stack:** Bun `--compile`（含 `import ... with { type: "file" }` 资源嵌入）、Hono、changesets、GitHub Actions。

设计规格：`docs/superpowers/specs/2026-07-04-distribution-design.md`

## Global Constraints

- 主包名 `aio-proxy`，二进制命令名 `aio-proxy`；平台包 `@aio-proxy/cli-<platform>-<arch>`
- 首发平台矩阵（仅此四个）：darwin-arm64、darwin-x64、linux-x64、linux-arm64
- GitHub 仓库：`baranwang/aio-proxy`
- Bun 版本：1.3.14（与 root package.json `packageManager` 一致）
- 所有 `packages/*` 内部包保持/改为 `private: true`，永不发布；只发布 `aio-proxy` 主包 + 4 个平台包
- npm publish 必须用 `bun publish`（要靠它把 `workspace:*` 重写成精确版本）；发布顺序：先 4 个平台包，后主包
- changesets 只管 version bump/changelog，不用它的 publish
- 仓库代码风格：biome，2 空格缩进，双引号；tsconfig 开了 `exactOptionalPropertyTypes` / `noUncheckedIndexedAccess`，写代码时注意
- 每个任务的测试命令在对应 package 目录下用 `bun test _test/<file>` 运行

---

### Task 1: server 侧 DashboardAssets 抽象

把 `CreateServerOptions.dashboardStaticDir: string` 替换为资产提供函数 `dashboardAssets`，并提供文件系统实现 `directoryDashboardAssets`。

**Files:**

- Create: `packages/server/src/dashboard-assets.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/index.ts`
- Test: `packages/server/_test/dashboard-assets.test.ts`（新增）
- Test: `packages/server/_test/dashboard-static.test.ts`（改造）

**Interfaces:**

- Produces（后续任务依赖，签名必须一字不差）:
  - `type DashboardAssets = (path: string) => Response | null | Promise<Response | null>`——`path` 是相对路径、无前导斜杠（如 `"index.html"`、`"static/js/app.js"`），返回 `null` 表示 404
  - `const directoryDashboardAssets: (dir: string) => DashboardAssets`
  - `CreateServerOptions.dashboardAssets?: DashboardAssets`（替换原 `dashboardStaticDir?: string`）
  - 以上全部从 `@aio-proxy/server` 包根导出

- [ ] **Step 1: 写 directoryDashboardAssets 的失败测试**

创建 `packages/server/_test/dashboard-assets.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryDashboardAssets } from "@aio-proxy/server";

describe("directoryDashboardAssets", () => {
  test("Given a dist dir When known and unknown paths are requested Then files are served and misses return null", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-assets-"));
    mkdirSync(join(dir, "static"));
    writeFileSync(join(dir, "index.html"), "<html>ok</html>");
    writeFileSync(join(dir, "static", "app.js"), "console.log(1);");
    const assets = directoryDashboardAssets(dir);

    try {
      const index = await assets("index.html");
      expect(index).not.toBeNull();
      expect(await index?.text()).toContain("ok");
      expect(index?.headers.get("content-type")).toContain("text/html");

      const nested = await assets("static/app.js");
      expect(nested).not.toBeNull();

      expect(await assets("missing.js")).toBeNull();
      expect(await assets("../secret.txt")).toBeNull();
      expect(await assets("static/../../secret.txt")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/server && bun test _test/dashboard-assets.test.ts`
Expected: FAIL——`directoryDashboardAssets` 未从 `@aio-proxy/server` 导出。

- [ ] **Step 3: 实现 dashboard-assets.ts**

创建 `packages/server/src/dashboard-assets.ts`：

```ts
import { join, normalize, sep } from "node:path";

export type DashboardAssets = (path: string) => Response | null | Promise<Response | null>;

export const directoryDashboardAssets =
  (dir: string): DashboardAssets =>
  async (path) => {
    const root = normalize(dir);
    const full = normalize(join(root, path));
    if (full !== root && !full.startsWith(`${root}${sep}`)) {
      return null;
    }
    const file = Bun.file(full);
    return (await file.exists()) ? new Response(file) : null;
  };
```

说明：`Bun.file` 会按扩展名自动设置 `Content-Type`；`startsWith` 守卫拦截 `..` 越界。

在 `packages/server/src/index.ts` 追加导出：

```ts
export { directoryDashboardAssets } from "./dashboard-assets";
export type { DashboardAssets } from "./dashboard-assets";
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/server && bun test _test/dashboard-assets.test.ts`
Expected: PASS

- [ ] **Step 5: 改造 dashboard-static.test.ts 为新接口（失败测试）**

修改 `packages/server/_test/dashboard-static.test.ts` 第 16 行的 `createServer` 调用：

```ts
import { directoryDashboardAssets } from "@aio-proxy/server";
// ...
const app = createServer({ config, dashboardAssets: directoryDashboardAssets(dir) });
```

其余断言全部不动（该测试完整覆盖 `/dashboard`、`/dashboard/`、静态资产、SPA fallback、API 404 分离等行为，是本次改造的回归保障）。

Run: `cd packages/server && bun test _test/dashboard-static.test.ts`
Expected: FAIL——`createServer` 还不认识 `dashboardAssets` 选项（TS 报错或路由 404）。

- [ ] **Step 6: 改造 server.ts**

修改 `packages/server/src/server.ts`：

1. 删除第 3 行 `import { serveStatic } from "hono/bun";`，追加 `import type { DashboardAssets } from "./dashboard-assets";`
2. `CreateServerOptions` 中 `readonly dashboardStaticDir?: string;` 改为 `readonly dashboardAssets?: DashboardAssets;`
3. `createRoutes` 第三个参数 `dashboardStaticDir?: string` 改为 `dashboardAssets?: DashboardAssets`
4. 第 86-105 行的静态路由块整体替换为：

```ts
  if (dashboardAssets !== undefined) {
    const dashboardIndex = async (context: Context) => (await dashboardAssets("index.html")) ?? context.notFound();
    routes
      .get("/dashboard", dashboardIndex)
      .get("/dashboard/", dashboardIndex)
      .get(
        "/dashboard/static/*",
        async (context) => (await dashboardAssets(context.req.path.replace(/^\/dashboard\//u, ""))) ?? context.notFound(),
      )
      .all("/dashboard/static/*", (context) => context.notFound())
      .all("/dashboard/api", (context) => context.notFound())
      .all("/dashboard/api/*", (context) => context.notFound())
      .get("/dashboard/*", dashboardIndex);
  }
```

需要 `import type { Context } from "hono";`。

5. `createServer` 里第 132 行 `options.dashboardStaticDir` 改为 `options.dashboardAssets`

- [ ] **Step 7: 运行 server 全部测试**

Run: `cd packages/server && bun test _test`
Expected: 全部 PASS（含 dashboard-events / server-reload / server 等既有测试）

- [ ] **Step 8: 类型检查**

Run: `cd /Volumes/ExternalSSD/workspace/aio-proxy && bun run check`
Expected: 此时 `packages/cli/src/main.ts` 会报错（还在传 `dashboardStaticDir`）——这是预期内的，Task 2 修。只需确认 server 包自身无类型错误。若想拿到干净信号：`cd packages/server && bunx tsc -b --pretty false`。

- [ ] **Step 9: Commit**

```bash
git add packages/server
git commit -m "feat(server): replace dashboardStaticDir with DashboardAssets provider"
```

---

### Task 2: CLI 移除运行时构建，注入资产提供函数

删除 `ensureDashboardStaticDir`（含 `dirname(dirname(...))` hack 和运行时 spawn build），dev 模式改为通过 export map 解析 dashboard dist 目录 + `directoryDashboardAssets`；`buildProgram`/`main` 支持依赖注入，为 Task 3 的编译入口留接缝。

**Files:**

- Create: `packages/cli/src/dashboard-assets.ts`
- Modify: `packages/cli/src/main.ts`
- Test: `packages/cli/_test/dashboard-assets.test.ts`（新增）

**Interfaces:**

- Consumes: Task 1 的 `DashboardAssets` / `directoryDashboardAssets`（来自 `@aio-proxy/server`）
- Produces（Task 3 依赖）:
  - `type CliDeps = { readonly dashboardAssets: () => DashboardAssets }`（`packages/cli/src/dashboard-assets.ts`）
  - `const embeddedDashboardAssets: (files: Readonly<Record<string, string>>) => DashboardAssets`（同上，key 是相对路径如 `"static/js/x.js"`，value 是 `with { type: "file" }` import 得到的路径）
  - `const defaultCliDeps: CliDeps`（dev 模式 FS 实现）
  - `main.ts` 导出 `main(deps?: CliDeps)`、`buildProgram(deps?: CliDeps)`

- [ ] **Step 1: 写失败测试**

创建 `packages/cli/_test/dashboard-assets.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { devDashboardStaticDir, embeddedDashboardAssets } from "../src/dashboard-assets";

describe("devDashboardStaticDir", () => {
  test("Given built dashboard When resolving Then returns dir containing index.html", async () => {
    const dir = devDashboardStaticDir();
    expect(await Bun.file(`${dir}/index.html`).exists()).toBe(true);
  });
});

describe("embeddedDashboardAssets", () => {
  test("Given a file map When hit and miss Then serves file or returns null", async () => {
    const tmp = `${import.meta.dir}/dashboard-assets.test.ts`;
    const assets = embeddedDashboardAssets({ "index.html": tmp });
    const hit = await assets("index.html");
    expect(hit).not.toBeNull();
    expect(await hit?.text()).toContain("embeddedDashboardAssets");
    expect(await assets("missing.js")).toBeNull();
  });
});
```

（`devDashboardStaticDir` 测试依赖 dashboard 已构建；turbo 的 `test:unit` `dependsOn: ["^build"]` 保证了这一点，本地先跑一次 `bun run build:dashboard`。）

- [ ] **Step 2: 运行确认失败**

Run: `cd /Volumes/ExternalSSD/workspace/aio-proxy && bun run build:dashboard && cd packages/cli && bun test _test/dashboard-assets.test.ts`
Expected: FAIL——模块 `../src/dashboard-assets` 不存在。

- [ ] **Step 3: 实现 dashboard-assets.ts**

创建 `packages/cli/src/dashboard-assets.ts`：

```ts
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { type DashboardAssets, directoryDashboardAssets } from "@aio-proxy/server";

export type CliDeps = {
  readonly dashboardAssets: () => DashboardAssets;
};

export const devDashboardStaticDir = (): string => {
  const indexPath = fileURLToPath(import.meta.resolve("@aio-proxy/dashboard/dist/index.html"));
  if (!existsSync(indexPath)) {
    throw new Error(`Dashboard assets not found at ${indexPath}. Run \`bun run build:dashboard\` first.`);
  }
  return dirname(indexPath);
};

export const embeddedDashboardAssets =
  (files: Readonly<Record<string, string>>): DashboardAssets =>
  (path) => {
    const embedded = files[path];
    return embedded === undefined ? null : new Response(Bun.file(embedded));
  };

export const defaultCliDeps: CliDeps = {
  dashboardAssets: () => directoryDashboardAssets(devDashboardStaticDir()),
};
```

- [ ] **Step 4: 运行确认通过**

Run: `cd packages/cli && bun test _test/dashboard-assets.test.ts`
Expected: PASS

- [ ] **Step 5: 改造 main.ts**

修改 `packages/cli/src/main.ts`：

1. 删除 `dashboardPackageDir`（第 75 行）和 `ensureDashboardStaticDir`（第 77-94 行）两个函数，删除随之不再使用的 import（`fileURLToPath`；`dirname`/`join` 若仍被 `defaultConfigPath` 等使用则保留——`join` 保留，`dirname` 保留给 `readOrBootstrapConfig`，`fileURLToPath` 删除）
2. 顶部追加 `import { type CliDeps, defaultCliDeps } from "./dashboard-assets";`
3. `serve` 改为柯里化注入：

```ts
const serve = (deps: CliDeps) => async (options: ServeOptions) => {
  const configPath = resolveConfigPath(options.config);
  const host = options.host ?? "127.0.0.1";
  const port = parsePort(options.port, DEFAULT_CONFIG.server.port);
  const apiUrl = `http://${host}:${port}`;
  const dashboardUrl = `${apiUrl}/dashboard`;
  assertPortAvailable(host, port);
  const config = await readOrBootstrapConfig(configPath, dashboardUrl);
  const dashboardAssets = deps.dashboardAssets();
  const app = createServer({
    config,
    configPath,
    dashboardAssets,
    host,
    port,
  });
  const server = Bun.serve({ hostname: host, port, fetch: app.fetch });
  console.log(
    m.cli_serve_started({
      apiUrl: `http://${server.hostname}:${server.port}`,
      dashboardUrl: `http://${server.hostname}:${server.port}/dashboard`,
    }),
  );
};
```

4. `buildProgram` 与 `main` 接收 deps（默认值保持现有行为）：

```ts
export const buildProgram = (deps: CliDeps = defaultCliDeps) => {
```

serve 子命令的 `.action(serve)` 改为 `.action(serve(deps))`。

```ts
export const main = async (deps: CliDeps = defaultCliDeps) => {
```

`main` 函数体内部不变；文件末尾 `if (import.meta.main) { await main(); }` 不变。

- [ ] **Step 6: 全量验证**

Run: `cd /Volumes/ExternalSSD/workspace/aio-proxy && bun run check && cd packages/cli && bun test _test`
Expected: 类型检查通过（Task 1 遗留的 cli 报错在此消除）、cli 测试全 PASS。

再做一次手动冒烟确认 dev 链路没断：

Run: `cd packages/cli && bun src/main.ts serve --config ../../aio-proxy.json &`，然后 `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:22078/dashboard`
Expected: `200`。完成后 kill 进程。

- [ ] **Step 7: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): inject dashboard assets provider, drop runtime dashboard build"
```

---

### Task 3: 编译入口生成器

构建期扫描 dashboard dist，生成带 `with { type: "file" }` 导入的编译入口 `src/main.compiled.gen.ts`。该文件只在 `bun build --compile` 的瞬间存在（构建完删除），不进 git、不进 tsc、不进 rslib。

**Files:**

- Create: `packages/cli/scripts/generate-compiled-entry.ts`
- Modify: `packages/dashboard/package.json`（exports 加 `"./dist/*": "./dist/*"`）
- Modify: `packages/cli/tsconfig.json`（exclude gen 文件）
- Modify: `.gitignore`
- Test: `packages/cli/_test/generate-compiled-entry.test.ts`（新增）

**Interfaces:**

- Consumes: Task 2 的 `embeddedDashboardAssets`、`main(deps)`
- Produces（Task 4 依赖）:
  - `listAssetPaths(distDir: string): string[]`——递归列出 dist 下所有文件的相对路径（`/` 分隔、排序）
  - `renderCompiledEntry(assetPaths: readonly string[]): string`——渲染编译入口源码
  - `generateCompiledEntry(): string`——组合两者，写入 `packages/cli/src/main.compiled.gen.ts` 并返回该绝对路径（`import.meta.main` 时执行）

- [ ] **Step 1: 写失败测试**

创建 `packages/cli/_test/generate-compiled-entry.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAssetPaths, renderCompiledEntry } from "../scripts/generate-compiled-entry";

describe("listAssetPaths", () => {
  test("Given nested dist When listing Then returns sorted slash-separated relative paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-gen-"));
    mkdirSync(join(dir, "static", "js"), { recursive: true });
    writeFileSync(join(dir, "index.html"), "x");
    writeFileSync(join(dir, "static", "js", "app.js"), "x");
    try {
      expect(listAssetPaths(dir)).toEqual(["index.html", "static/js/app.js"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("renderCompiledEntry", () => {
  test("Given asset paths When rendering Then emits file-type imports and the asset map", () => {
    const code = renderCompiledEntry(["index.html", "static/js/app.js"]);
    expect(code).toContain('import asset0 from "@aio-proxy/dashboard/dist/index.html" with { type: "file" };');
    expect(code).toContain('import asset1 from "@aio-proxy/dashboard/dist/static/js/app.js" with { type: "file" };');
    expect(code).toContain('"static/js/app.js": asset1,');
    expect(code).toContain('import { embeddedDashboardAssets } from "./dashboard-assets";');
    expect(code).toContain('import { main } from "./main";');
    expect(code).toContain("await main({ dashboardAssets: () => embeddedDashboardAssets(files) });");
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd packages/cli && bun test _test/generate-compiled-entry.test.ts`
Expected: FAIL——脚本不存在。

- [ ] **Step 3: 实现生成器**

创建 `packages/cli/scripts/generate-compiled-entry.ts`：

```ts
import { readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const listAssetPaths = (distDir: string): string[] =>
  readdirSync(distDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(distDir, join(entry.parentPath, entry.name)).split(sep).join("/"))
    .sort();

export const renderCompiledEntry = (assetPaths: readonly string[]): string => {
  const imports = assetPaths
    .map((path, index) => `import asset${index} from "@aio-proxy/dashboard/dist/${path}" with { type: "file" };`)
    .join("\n");
  const entries = assetPaths.map((path, index) => `  "${path}": asset${index},`).join("\n");
  return `// Generated by scripts/generate-compiled-entry.ts — do not edit, do not commit.
${imports}
import { embeddedDashboardAssets } from "./dashboard-assets";
import { main } from "./main";

const files: Readonly<Record<string, string>> = {
${entries}
};

await main({ dashboardAssets: () => embeddedDashboardAssets(files) });
`;
};

export const generateCompiledEntry = (): string => {
  const distDir = join(fileURLToPath(import.meta.resolve("@aio-proxy/dashboard/dist/index.html")), "..");
  const outFile = join(import.meta.dir, "..", "src", "main.compiled.gen.ts");
  writeFileSync(outFile, renderCompiledEntry(listAssetPaths(distDir)));
  return outFile;
};

if (import.meta.main) {
  console.log(generateCompiledEntry());
}
```

- [ ] **Step 4: 修改 dashboard exports**

`packages/dashboard/package.json` 的 `exports` 改为：

```json
  "exports": {
    ".": "./src/index.tsx",
    "./dist/index.html": "./dist/index.html",
    "./dist/*": "./dist/*"
  },
```

（保留 `./dist/index.html` 显式条目，Task 2 的 `import.meta.resolve` 依赖它；`./dist/*` 供生成的逐文件 import 解析。）

- [ ] **Step 5: 隔离 gen 文件**

`packages/cli/tsconfig.json` 追加：

```json
  "exclude": ["src/**/*.gen.ts"]
```

`.gitignore` 追加两行：

```
packages/cli/src/main.compiled.gen.ts
packages/cli/dist-bin/
```

（`dist-bin/` 是 Task 4 的产物目录，顺手一起加。）

- [ ] **Step 6: 运行确认通过**

Run: `cd packages/cli && bun test _test/generate-compiled-entry.test.ts`
Expected: PASS

再验证真实生成 + 清理：

Run: `cd packages/cli && bun scripts/generate-compiled-entry.ts && head -3 src/main.compiled.gen.ts && rm src/main.compiled.gen.ts`
Expected: 打印生成路径 + 文件头部含 `import asset0 from "@aio-proxy/dashboard/dist/index.html"`。

Run: `cd /Volumes/ExternalSSD/workspace/aio-proxy && bun run check`
Expected: PASS（gen 文件已删除且被 exclude，双保险）。

- [ ] **Step 7: Commit**

```bash
git add packages/cli packages/dashboard/package.json .gitignore
git commit -m "feat(cli): add compiled-entry generator embedding dashboard assets"
```

---

### Task 4: build:binary 四平台编译管线

**Files:**

- Create: `packages/cli/scripts/build-binary.ts`
- Modify: `packages/cli/package.json`（加 `build:binary` script）

**Interfaces:**

- Consumes: Task 3 的 `generateCompiledEntry()`
- Produces（Task 5、Task 8 依赖）: `packages/cli/dist-bin/aio-proxy-<suffix>`，suffix ∈ {`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`}。命令 `bun run build:binary [suffix]`，无参编全部，带参只编一个。

- [ ] **Step 1: 实现 build-binary.ts**

创建 `packages/cli/scripts/build-binary.ts`：

```ts
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { generateCompiledEntry } from "./generate-compiled-entry";

const targets = [
  { suffix: "darwin-arm64", target: "bun-darwin-arm64" },
  { suffix: "darwin-x64", target: "bun-darwin-x64" },
  { suffix: "linux-x64", target: "bun-linux-x64" },
  { suffix: "linux-arm64", target: "bun-linux-arm64" },
] as const;

const only = process.argv[2];
const selected = only === undefined ? targets : targets.filter((t) => t.suffix === only);
if (selected.length === 0) {
  console.error(`Unknown target "${only}". Valid: ${targets.map((t) => t.suffix).join(", ")}`);
  process.exit(1);
}

const packageDir = join(import.meta.dir, "..");
const outDir = join(packageDir, "dist-bin");
mkdirSync(outDir, { recursive: true });

const entry = generateCompiledEntry();
try {
  for (const { suffix, target } of selected) {
    const outfile = join(outDir, `aio-proxy-${suffix}`);
    const build = Bun.spawnSync(
      [process.execPath, "build", "--compile", `--target=${target}`, entry, `--outfile=${outfile}`],
      { cwd: packageDir, stderr: "inherit", stdout: "inherit" },
    );
    if (build.exitCode !== 0) {
      console.error(`bun build --compile failed for ${target}`);
      process.exit(build.exitCode ?? 1);
    }
    console.log(outfile);
  }
} finally {
  rmSync(entry, { force: true });
}
```

`packages/cli/package.json` 的 `scripts` 追加：

```json
    "build:binary": "bun scripts/build-binary.ts",
```

- [ ] **Step 2: 本机单平台编译验证**

Run: `cd /Volumes/ExternalSSD/workspace/aio-proxy && bun run build:dashboard && cd packages/cli && bun run build:binary darwin-arm64`
Expected: 输出 `dist-bin/aio-proxy-darwin-arm64` 路径，退出码 0，且 `src/main.compiled.gen.ts` 已被清理（`ls src/*.gen.ts` 无结果）。

- [ ] **Step 3: 二进制功能冒烟**

```bash
cd packages/cli
./dist-bin/aio-proxy-darwin-arm64 --version
TMP_HOME=$(mktemp -d)
HOME="$TMP_HOME" ./dist-bin/aio-proxy-darwin-arm64 serve --port 23111 &
sleep 1
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:23111/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:23111/dashboard
curl -s http://127.0.0.1:23111/dashboard | grep -o '/dashboard/static/js/[^"]*' | head -1
kill %1
```

Expected: 版本打印 `0.0.0`；两个 curl 均 `200`；grep 能提取出一个静态 JS 路径。再取该路径 curl 一次应为 200（证明嵌入资源真的被 serve 出来了，这是本任务的核心验证）。

- [ ] **Step 4: 交叉编译验证**

Run: `cd packages/cli && bun run build:binary && ls -la dist-bin/`
Expected: 四个产物齐全，linux 两个无法本机运行但 `file dist-bin/aio-proxy-linux-x64` 显示 ELF。

- [ ] **Step 5: Commit**

```bash
git add packages/cli/scripts/build-binary.ts packages/cli/package.json
git commit -m "feat(cli): add four-platform bun compile pipeline"
```

---

### Task 5: npm 包结构（主包 + 平台包 + launcher）

**Files:**

- Create: `npm/aio-proxy/package.json`、`npm/aio-proxy/bin/aio-proxy.js`、`npm/aio-proxy/README.md`
- Create: `npm/cli-darwin-arm64/package.json`、`npm/cli-darwin-x64/package.json`、`npm/cli-linux-x64/package.json`、`npm/cli-linux-arm64/package.json`
- Modify: 根 `package.json`（workspaces 加 `npm/*`）
- Modify: `.gitignore`（加 `npm/cli-*/bin/`）

**Interfaces:**

- Produces（Task 7、8 依赖）:
  - 主包 `aio-proxy`，bin 名 `aio-proxy` → `bin/aio-proxy.js`
  - 平台包 `@aio-proxy/cli-<platform>-<arch>`，二进制放 `bin/aio-proxy`（发布前由 Task 8 的脚本从 `dist-bin` 拷入）
  - 主包 `optionalDependencies` 用 `workspace:*`，由 `bun publish` 在发布时重写为精确版本

- [ ] **Step 1: 平台包（四份，仅 name/os/cpu 不同）**

`npm/cli-darwin-arm64/package.json`：

```json
{
  "name": "@aio-proxy/cli-darwin-arm64",
  "version": "0.0.0",
  "description": "aio-proxy binary for darwin-arm64",
  "repository": "github:baranwang/aio-proxy",
  "os": ["darwin"],
  "cpu": ["arm64"],
  "files": ["bin"],
  "publishConfig": {
    "access": "public"
  }
}
```

其余三份把 name/description 中的平台后缀与 `os`/`cpu` 对应替换：`cli-darwin-x64` → `["darwin"]`/`["x64"]`；`cli-linux-x64` → `["linux"]`/`["x64"]`；`cli-linux-arm64` → `["linux"]`/`["arm64"]`。

- [ ] **Step 2: 主包与 launcher**

`npm/aio-proxy/package.json`：

```json
{
  "name": "aio-proxy",
  "version": "0.0.0",
  "description": "All-in-one LLM API proxy with a local dashboard",
  "repository": "github:baranwang/aio-proxy",
  "bin": {
    "aio-proxy": "bin/aio-proxy.js"
  },
  "files": ["bin"],
  "optionalDependencies": {
    "@aio-proxy/cli-darwin-arm64": "workspace:*",
    "@aio-proxy/cli-darwin-x64": "workspace:*",
    "@aio-proxy/cli-linux-arm64": "workspace:*",
    "@aio-proxy/cli-linux-x64": "workspace:*"
  }
}
```

`npm/aio-proxy/bin/aio-proxy.js`（CommonJS，主包无 `"type": "module"`）：

```js
#!/usr/bin/env node
"use strict";
const { spawnSync } = require("node:child_process");

const pkg = `@aio-proxy/cli-${process.platform}-${process.arch}`;
let binary;
try {
  binary = require.resolve(`${pkg}/bin/aio-proxy`);
} catch {
  console.error(
    `aio-proxy: no prebuilt binary for ${process.platform}-${process.arch}.\n` +
      `Expected optional dependency ${pkg} to be installed.`,
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: "inherit" });
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
```

注意：`require.resolve` 对无扩展名文件需要该文件真实存在才能解析——平台包 `files: ["bin"]` 已保证发布产物里有 `bin/aio-proxy`。

`npm/aio-proxy/README.md`：

```markdown
# aio-proxy

All-in-one LLM API proxy with a local dashboard.

## Install

- npm: `npm install -g aio-proxy`
- curl: `curl -fsSL https://raw.githubusercontent.com/baranwang/aio-proxy/main/install.sh | sh`

Then run `aio-proxy serve`.
```

- [ ] **Step 3: workspaces 与 gitignore**

根 `package.json` 的 workspaces：

```json
  "workspaces": {
    "packages": [
      "packages/*",
      "npm/*"
    ],
```

`.gitignore` 追加：

```
npm/cli-*/bin/
```

- [ ] **Step 4: 验证**

```bash
cd /Volumes/ExternalSSD/workspace/aio-proxy
bun install
mkdir -p npm/cli-darwin-arm64/bin
cp packages/cli/dist-bin/aio-proxy-darwin-arm64 npm/cli-darwin-arm64/bin/aio-proxy
node npm/aio-proxy/bin/aio-proxy.js --version
node npm/aio-proxy/bin/aio-proxy.js --help
```

Expected: `bun install` 正常完成（workspace 链接不受 os/cpu 影响）；launcher 打出 `0.0.0` 和帮助文本，退出码 0。

Run: `bun run check`
Expected: PASS（biome 的 check 范围不含 npm/，tsc 不受影响）。

- [ ] **Step 5: Commit**

```bash
git add npm package.json bun.lock .gitignore
git commit -m "feat(repo): add npm distribution packages and launcher"
```

---

### Task 6: install.sh（curl 渠道）

**Files:**

- Create: `install.sh`（仓库根）

**Interfaces:**

- Consumes: GitHub Releases 产物命名 `aio-proxy-<os>-<arch>`（Task 8 发布时上传）
- Produces: `curl -fsSL https://raw.githubusercontent.com/baranwang/aio-proxy/main/install.sh | sh`

- [ ] **Step 1: 写脚本**

```sh
#!/bin/sh
set -eu

REPO="baranwang/aio-proxy"
INSTALL_DIR="${AIO_PROXY_INSTALL_DIR:-$HOME/.local/bin}"

os="$(uname -s)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *)
    echo "aio-proxy: unsupported OS: $os (supported: macOS, Linux)" >&2
    exit 1
    ;;
esac

arch="$(uname -m)"
case "$arch" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *)
    echo "aio-proxy: unsupported architecture: $arch (supported: arm64, x64)" >&2
    exit 1
    ;;
esac

asset="aio-proxy-${os}-${arch}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

mkdir -p "$INSTALL_DIR"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

echo "Downloading ${url} ..."
curl -fSL --progress-bar -o "$tmp" "$url"
chmod +x "$tmp"
mv "$tmp" "$INSTALL_DIR/aio-proxy"
trap - EXIT

echo "Installed aio-proxy to $INSTALL_DIR/aio-proxy"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "Note: $INSTALL_DIR is not in your PATH. Add it with:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac
```

- [ ] **Step 2: 验证**

```bash
chmod +x install.sh
sh -n install.sh
shellcheck install.sh || true
```

Expected: `sh -n` 语法通过；有 shellcheck 就修掉报错（没装则跳过）。下载路径在首个 Release 前无法端到端验证——用本地文件模拟验证探测逻辑：

```bash
sh -c '. /dev/stdin <<"EOF"
os="$(uname -s)"; arch="$(uname -m)"
echo "$os-$arch"
EOF'
```

（确认本机输出 `Darwin-arm64` → 映射为 `darwin-arm64`，与产物命名一致即可。）

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat(repo): add curl install script"
```

---

### Task 7: changesets 接入（fixed 全包同步）

**Files:**

- Create: `.changeset/config.json`、`.changeset/README.md`
- Modify: 根 `package.json`（devDependencies + script）
- Modify: `packages/{cli,server,core,types,i18n,auth-flows}/package.json`（补 `private: true` 与 `version`）
- Modify: `packages/{dashboard,infra}/package.json`（补 `version`）

**Interfaces:**

- Produces（Task 8 依赖）: `bunx changeset version` 后，全部 workspace 包（含 npm/* 5 个可发布包）版本同步 bump；发布版本号以 `npm/aio-proxy/package.json` 的 `version` 为准。

- [ ] **Step 1: 安装与配置**

```bash
cd /Volumes/ExternalSSD/workspace/aio-proxy
bun add -d @changesets/cli
```

创建 `.changeset/config.json`：

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.1.1/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "fixed": [["aio-proxy", "@aio-proxy/*"]],
  "privatePackages": {
    "version": true,
    "tag": false
  },
  "ignore": []
}
```

创建 `.changeset/README.md`：

```markdown
# Changesets

版本管理用 changesets，所有包版本通过 `fixed` 组同步。发布不走 `changeset publish`，由 `.github/workflows/release.yml` 按序（先平台包后主包）用 `bun publish` 完成。
```

根 `package.json` scripts 追加：

```json
    "changeset": "changeset",
```

- [ ] **Step 2: 补齐 private 与 version 字段**

以下包的 `package.json` 在 `"name"` 之后插入 `"version": "0.0.0",` 和 `"private": true,`（已有的字段不重复加）：

- `packages/cli`：已有 version，**补 `"private": true`**（关键修复：cli 是源码包，产品是二进制，绝不能发布）
- `packages/server`、`packages/core`、`packages/types`、`packages/i18n`、`packages/auth-flows`：补 `"version": "0.0.0"` 和 `"private": true`
- `packages/dashboard`、`packages/infra`：已有 private，补 `"version": "0.0.0"`

- [ ] **Step 3: 验证版本同步**

```bash
cd /Volumes/ExternalSSD/workspace/aio-proxy
bun install
cat > .changeset/test-sync.md <<'EOF'
---
"aio-proxy": patch
---

Test version sync.
EOF
bunx changeset version
grep '"version"' npm/aio-proxy/package.json npm/cli-darwin-arm64/package.json packages/cli/package.json packages/server/package.json
```

Expected: 四个文件全部显示 `"version": "0.0.1"`（fixed 组同步生效）。然后回滚试验产物：

```bash
git checkout -- packages npm && git clean -fd .changeset npm packages 2>/dev/null; git status --short
```

Expected: 工作区只剩本任务的有意变更（config.json、README、package.json 字段、bun.lock）。

Run: `bun run check && bun run test:unit`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add .changeset package.json bun.lock packages/*/package.json
git commit -m "chore(repo): adopt changesets with fixed version group"
```

---

### Task 8: 发布脚本与 GitHub Actions

**Files:**

- Create: `scripts/publish-npm.ts`（仓库根）
- Create: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: Task 4 的 `dist-bin/aio-proxy-<suffix>`、Task 5 的 npm 包结构、Task 7 的版本机制
- Produces: push main → changesets Version PR；Version PR 合并 → 编译 → 三平台冒烟 → GitHub Release（tag `v<version>` + 4 个二进制）→ npm 发布（平台包 → 主包）
- 前置人工配置：仓库 Secrets 需要 `NPM_TOKEN`（npm automation token，对 `aio-proxy` 与 `@aio-proxy` scope 有发布权）；`@aio-proxy` scope 需在 npm 上已创建

- [ ] **Step 1: 发布脚本**

创建 `scripts/publish-npm.ts`：

```ts
import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const rootDir = join(import.meta.dir, "..");
const distBin = join(rootDir, "packages", "cli", "dist-bin");

const platformPackages = ["cli-darwin-arm64", "cli-darwin-x64", "cli-linux-x64", "cli-linux-arm64"] as const;

const readPackage = async (dir: string) => {
  const pkg = (await Bun.file(join(dir, "package.json")).json()) as { name: string; version: string };
  return pkg;
};

const isPublished = (name: string, version: string): boolean => {
  const view = Bun.spawnSync(["npm", "view", `${name}@${version}`, "version"], { stderr: "ignore", stdout: "ignore" });
  return view.exitCode === 0;
};

const publish = (dir: string) => {
  const result = Bun.spawnSync([process.execPath, "publish", "--access", "public"], {
    cwd: dir,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    console.error(`bun publish failed in ${dir}`);
    process.exit(result.exitCode ?? 1);
  }
};

for (const suffix of platformPackages) {
  const binary = join(distBin, `aio-proxy-${suffix.replace(/^cli-/u, "")}`);
  if (!existsSync(binary)) {
    console.error(`Missing binary: ${binary}. Run build:binary first.`);
    process.exit(1);
  }
  const binDir = join(rootDir, "npm", suffix, "bin");
  mkdirSync(binDir, { recursive: true });
  const target = join(binDir, "aio-proxy");
  copyFileSync(binary, target);
  chmodSync(target, 0o755);
}

const dirs = [...platformPackages.map((p) => join(rootDir, "npm", p)), join(rootDir, "npm", "aio-proxy")];
for (const dir of dirs) {
  const pkg = await readPackage(dir);
  if (isPublished(pkg.name, pkg.version)) {
    console.log(`skip ${pkg.name}@${pkg.version} (already published)`);
    continue;
  }
  console.log(`publish ${pkg.name}@${pkg.version}`);
  publish(dir);
}
```

（顺序数组保证平台包先于主包；`isPublished` 让重跑幂等。）

- [ ] **Step 2: release workflow**

创建 `.github/workflows/release.yml`：

```yaml
name: Release

on:
  push:
    branches: [main]

concurrency: release-${{ github.ref }}

permissions:
  contents: write
  pull-requests: write

jobs:
  version-pr:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"
      - run: bun install --frozen-lockfile
      - uses: changesets/action@v1
        with:
          version: bunx changeset version
          commit: "chore(release): version packages"
          title: "chore(release): version packages"
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  check:
    runs-on: ubuntu-latest
    outputs:
      version: ${{ steps.meta.outputs.version }}
      needs-release: ${{ steps.meta.outputs.needs-release }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: meta
        run: |
          version="$(jq -r .version npm/aio-proxy/package.json)"
          echo "version=$version" >> "$GITHUB_OUTPUT"
          if git rev-parse "v$version" >/dev/null 2>&1; then
            echo "needs-release=false" >> "$GITHUB_OUTPUT"
          else
            echo "needs-release=true" >> "$GITHUB_OUTPUT"
          fi

  build:
    needs: check
    if: needs.check.outputs.needs-release == 'true'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"
      - run: bun install --frozen-lockfile
      - run: bun run i18n:compile
      - run: bun run build:dashboard
      - run: bun run --filter @aio-proxy/cli build:binary
      - uses: actions/upload-artifact@v4
        with:
          name: binaries
          path: packages/cli/dist-bin/
          if-no-files-found: error

  smoke:
    needs: build
    strategy:
      matrix:
        include:
          - runner: ubuntu-latest
            binary: aio-proxy-linux-x64
          - runner: ubuntu-24.04-arm
            binary: aio-proxy-linux-arm64
          - runner: macos-latest
            binary: aio-proxy-darwin-arm64
          - runner: macos-latest
            binary: aio-proxy-darwin-x64
    runs-on: ${{ matrix.runner }}
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: binaries
      - run: |
          chmod +x "${{ matrix.binary }}"
          "./${{ matrix.binary }}" --version

  publish:
    needs: [check, smoke]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.14"
      - run: bun install --frozen-lockfile
      - uses: actions/download-artifact@v4
        with:
          name: binaries
          path: packages/cli/dist-bin/
      - name: Create GitHub Release
        run: |
          gh release create "v${{ needs.check.outputs.version }}" \
            packages/cli/dist-bin/aio-proxy-* \
            --title "v${{ needs.check.outputs.version }}" \
            --notes-file npm/aio-proxy/CHANGELOG.md
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Publish to npm
        run: bun scripts/publish-npm.ts
        env:
          NPM_CONFIG_TOKEN: ${{ secrets.NPM_TOKEN }}
```

说明：

- `darwin-x64` 冒烟跑在 arm 的 macos-latest 上，靠 Rosetta 2（GitHub runner 预装）。若实际运行发现 Rosetta 不可用，把该矩阵项降级为 `chmod +x && test -x`
- Version PR 未合并时：`check` 发现 tag 已存在（版本没 bump）→ 后续 job 全部跳过，只有 `version-pr` 在维护 PR
- Version PR 合并后：版本已 bump、无 tag → 走完 build → smoke → publish；tag 由 `gh release create` 创建
- `--notes-file` 用主包 CHANGELOG（changesets 生成）；若首个版本没有 CHANGELOG.md，临时替换为 `--generate-notes`

- [ ] **Step 3: 本地验证**

```bash
cd /Volumes/ExternalSSD/workspace/aio-proxy
bunx actionlint .github/workflows/release.yml 2>/dev/null || bun x actionlint .github/workflows/release.yml 2>/dev/null || echo "actionlint unavailable, skip"
bun run check
```

publish 脚本 dry 验证（不真发布，验证前半段拷贝逻辑）：

```bash
cd packages/cli && bun run build:binary darwin-arm64 && cd ../..
# 临时把 publish-npm.ts 里 dirs 循环前加 process.exit(0) 跑一次拷贝段，或直接：
bun -e '
import { existsSync } from "node:fs";
console.log(existsSync("packages/cli/dist-bin/aio-proxy-darwin-arm64"));
'
bun scripts/publish-npm.ts || true
ls -la npm/cli-darwin-arm64/bin/
```

Expected: `npm/cli-darwin-arm64/bin/aio-proxy` 存在且可执行；脚本在缺失其余三个平台二进制处报 `Missing binary` 退出（这正是拷贝逻辑与守卫都工作的证据）。清理：`rm -rf npm/cli-*/bin packages/cli/dist-bin`。

- [ ] **Step 4: Commit**

```bash
git add scripts/publish-npm.ts .github/workflows/release.yml
git commit -m "ci: add release pipeline (binaries, GitHub Release, npm publish)"
```

- [ ] **Step 5: 端到端演练（人工，最后执行）**

首次真实发布前的检查单（写给操作者，不是自动步骤）：

1. npm 上创建 `@aio-proxy` org/scope；生成 automation token 存入仓库 Secret `NPM_TOKEN`
2. 合并本计划全部任务到 main，添加首个 changeset（`bunx changeset add`，patch 即可）
3. 等 Version PR 出现 → 合并 → 观察 Release workflow 全绿
4. 验证：`npm install -g aio-proxy && aio-proxy --version`；另一台机器跑 `curl -fsSL https://raw.githubusercontent.com/baranwang/aio-proxy/main/install.sh | sh`

---

## Self-Review 记录

- **Spec 覆盖**：spec §1 产物与包结构 → Task 4/5/6；§2 代码改动 1-4 → Task 2/3/1/4，改动 5（provider install 不动）无需任务；§3 版本与流水线 → Task 7/8；§4 暂缓项无任务（符合预期）。无缺口。
- **占位符**：无 TBD/TODO；所有代码步骤给出完整代码。
- **类型一致性**：`DashboardAssets` 签名在 Task 1 定义、Task 2/3 消费处一致；`generateCompiledEntry` 返回值在 Task 4 消费处一致；产物命名 `aio-proxy-<suffix>` 在 Task 4/5/6/8 一致；`workspace:*` → `bun publish` 重写在 Task 5/8 一致。
