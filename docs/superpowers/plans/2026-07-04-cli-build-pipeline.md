# CLI 构建管线修订实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 简化 `packages/cli` 的二进制构建链路：使用 `Bun.build({ compile })`，用虚拟入口替代临时 `main.compiled.gen.ts` 文件，移除 CLI 包上的 rslib，并让二进制直接生成到 npm 平台包目录。

**Architecture:** CLI 是应用/二进制包，不是 library package。Dashboard dist 仍通过静态 `import ... with { type: "file" }` 被 Bun compile 嵌入；区别是入口源码由 `Bun.build({ files })` 提供，不落盘。CLI 不提供普通 `build` 脚本；root `bun run check` 负责类型检查，显式 `build:binary` 才产出二进制。二进制直接写入 `npm/cli-*/bin/aio-proxy`，发布由 changesets 负责。

**Tech Stack:** Bun 1.3.14 `Bun.build` compile API、Bun virtual `files`、TypeScript、Biome。

设计规格：`docs/superpowers/specs/2026-07-04-cli-build-pipeline.md`

## Global Constraints

- 不引入 Bun runtime/bundler plugin；本改动只用 `Bun.build({ files, compile })`。
- 不恢复或保留 `packages/cli/dist` 或 `packages/cli/dist-bin` 作为有意义产物；CLI 真产物只有 `npm/cli-*/bin/aio-proxy`。
- 不改变 npm/curl/brew 发布包结构。
- 不保留 `scripts/publish-npm.ts`；不重复实现 changesets 已有的发布、跳过已发布版本、access public 等能力。
- 不改变 dashboard asset embedding 模型：仍必须通过静态 `import ... with { type: "file" }` 让 Bun compile 嵌入文件。
- `turbo build` 不应默认编四个平台二进制；二进制构建只由 `build:binary` 或发布流程显式触发。
- 不删除 root catalog 里的 `@rslib/core`，其他 library packages 仍使用 rslib。
- `packages/cli/scripts/*.ts` 必须被 root `tsc -b` 检查；用独立 `packages/cli/scripts/tsconfig.json`，并设置 `noEmit: true` 防止生成 `.js/.d.ts`。

---

### Task 1: 把 compiled entry 生成器改成纯虚拟入口 helper

删除 `generateCompiledEntry()` 的落盘行为，保留资产扫描和源码渲染，新增虚拟入口 helper 给 `build-binary.ts` 使用。

**Files:**

- Modify: `packages/cli/scripts/generate-compiled-entry.ts`
- Modify: `packages/cli/_test/generate-compiled-entry.test.ts`

**Interfaces:**

- Keep:
  - `listAssetPaths(distDir: string): string[]`
  - `renderCompiledEntry(assetPaths: readonly string[]): string`
- Add:
  - `compiledEntryPath(): string`
  - `dashboardDistDir(): string`
  - `virtualCompiledEntry(): { readonly entrypoint: string; readonly files: Record<string, string> }`
- Remove:
  - `generateCompiledEntry(): string`
  - any `writeFileSync` import/use

- [x] **Step 1: Update tests for virtual entry**

Modify `packages/cli/_test/generate-compiled-entry.test.ts`:

- Keep the existing `listAssetPaths` test unchanged.
- Keep the existing `renderCompiledEntry` assertions unchanged.
- Add a test for `virtualCompiledEntry` that only verifies shape and no filesystem write:
  - `entrypoint` ends with `packages/cli/src/main.compiled.gen.ts`
  - `Object.keys(files)` equals `[entrypoint]`
  - `files[entrypoint]` contains `await main({ dashboardAssets: () => embeddedDashboardAssets(files) });`

Do not assert exact full generated source beyond the existing `renderCompiledEntry` test.

- [x] **Step 2: Run the targeted test and confirm failure**

Run:

```bash
cd packages/cli && bun test _test/generate-compiled-entry.test.ts
```

Expected: FAIL because `virtualCompiledEntry` is not exported yet.

- [x] **Step 3: Implement helper without writing files**

Modify `packages/cli/scripts/generate-compiled-entry.ts`:

- Remove `writeFileSync`.
- Keep `listAssetPaths` and `renderCompiledEntry`.
- Add:

```ts
export const dashboardDistDir = (): string =>
  join(fileURLToPath(import.meta.resolve("@aio-proxy/dashboard/dist/index.html")), "..");

export const compiledEntryPath = (): string => join(import.meta.dir, "..", "src", "main.compiled.gen.ts");

export const virtualCompiledEntry = () => {
  const entrypoint = compiledEntryPath();
  return {
    entrypoint,
    files: {
      [entrypoint]: renderCompiledEntry(listAssetPaths(dashboardDistDir())),
    },
  };
};
```

Keep the `if (import.meta.main)` block only if useful for debugging, and make it print `virtualCompiledEntry().entrypoint`; it must not write `src/main.compiled.gen.ts`.

- [x] **Step 4: Confirm targeted test passes**

Run:

```bash
cd packages/cli && bun test _test/generate-compiled-entry.test.ts
```

Expected: PASS.

---

### Task 2: Change `build-binary.ts` to `Bun.build({ compile, files })`

Replace the subprocess call to `bun build --compile` with Bun's JS API.

**Files:**

- Modify: `packages/cli/scripts/build-binary.ts`

**Interfaces:**

- Input behavior remains:
  - `bun run build:binary` builds all four targets.
  - `bun run build:binary darwin-arm64` builds only that target.
  - unknown suffix exits non-zero and prints valid suffixes.
- Output becomes:
  - `npm/cli-<suffix>/bin/aio-proxy`

- [x] **Step 1: Replace `generateCompiledEntry` import**

Change:

```ts
import { generateCompiledEntry } from "./generate-compiled-entry";
```

to:

```ts
import { virtualCompiledEntry } from "./generate-compiled-entry";
```

Remove `rmSync` from `node:fs`.

- [x] **Step 2: Build via Bun API**

Call `const entry = virtualCompiledEntry();` once.

Inside the target loop:

- Create `npm/cli-<suffix>/bin`.
- Set `outfile` to `npm/cli-<suffix>/bin/aio-proxy`.

```ts
const build = await Bun.build({
  entrypoints: [entry.entrypoint],
  files: entry.files,
  compile: {
    target,
    outfile,
  },
});
```

If `build.success` is false:

- Print every `build.logs` item with `console.error(log)`.
- Print `bun build --compile failed for ${target}`.
- Exit with code `1`.

Do not keep a `finally` cleanup block; there is no generated file.

- [x] **Step 3: Run one-platform binary build**

Run from repo root:

```bash
bun run build:dashboard
cd packages/cli && rm -f src/main.compiled.gen.ts && bun run build:binary darwin-arm64
```

Expected:

- command exits 0
- `npm/cli-darwin-arm64/bin/aio-proxy` exists
- `packages/cli/src/main.compiled.gen.ts` does not exist

- [x] **Step 4: Smoke the binary surface**

Run:

```bash
./npm/cli-darwin-arm64/bin/aio-proxy --version
```

Expected: prints the version from `packages/cli/package.json` and exits 0.

---

### Task 3: Remove rslib and ordinary `build` from `packages/cli`

CLI no longer builds a library `dist`; rslib remains only for actual internal library packages.

**Files:**

- Modify: `packages/cli/package.json`
- Delete: `packages/cli/rslib.config.ts`
- Create: `packages/cli/scripts/tsconfig.json`
- Modify: `tsconfig.json`

**Package script decisions:**

- Delete:

```json
"build": "rslib"
```

- Delete:

```json
"dev": "rslib --watch --no-clean"
```

- Delete `@rslib/core` from `packages/cli/devDependencies`.
- Keep `@aio-proxy/infra`, `@types/bun`, and `typescript`.
- Add `packages/cli/scripts/tsconfig.json` extending `@aio-proxy/infra/tsconfig/base.json`, with `noEmit: true`, `types: ["bun"]`, and `include: ["*.ts"]`.
- Add `./packages/cli/scripts` to root `tsconfig.json` references so `bun run check` covers CLI scripts.

- [x] **Step 1: Update package metadata**

Apply the package.json changes above.

- [x] **Step 2: Delete CLI rslib config**

Delete `packages/cli/rslib.config.ts`.

Do not delete rslib config files in other packages.

- [x] **Step 3: Verify references are gone**

Run:

```bash
rg -n "rslib|generateCompiledEntry|main\\.compiled\\.gen" packages/cli package.json turbo.json
```

Expected:

- no `rslib` hits under `packages/cli`
- no ordinary `build` script under `packages/cli`
- no `generateCompiledEntry` hits
- `main.compiled.gen` may appear only as a virtual entry path string in `generate-compiled-entry.ts`, never as an existing file
- `git ls-files --others --exclude-standard packages/cli/src packages/cli/scripts` lists only the new `packages/cli/scripts/tsconfig.json`, with no `.js`, `.d.ts`, or `.map` emit files

---

### Task 4: Full verification

Run the smallest checks that prove the changed surface works.

- [x] **Step 1: Format/lint/typecheck**

Run from repo root:

```bash
bun run check
```

Expected: exits 0.

- [x] **Step 2: CLI unit tests**

Run:

```bash
cd packages/cli && bun test _test
```

Expected: exits 0.

- [x] **Step 3: Binary build smoke**

Run:

```bash
bun run build:dashboard
rm -f packages/cli/src/main.compiled.gen.ts
bun run --filter @aio-proxy/cli build:binary darwin-arm64
test -x npm/cli-darwin-arm64/bin/aio-proxy
test ! -e packages/cli/src/main.compiled.gen.ts
./npm/cli-darwin-arm64/bin/aio-proxy --version
```

Expected: all commands exit 0; version output equals `packages/cli/package.json` version.

- [x] **Step 4: Worktree sanity**

Run:

```bash
git status --short
```

Expected changed files are limited to:

- `.changeset/README.md`
- `.github/workflows/release.yml`
- `.gitignore`
- `bun.lock`
- `npm/aio-proxy/package.json`
- `packages/cli/scripts/generate-compiled-entry.ts`
- `packages/cli/scripts/build-binary.ts`
- `packages/cli/scripts/tsconfig.json`
- `packages/cli/_test/generate-compiled-entry.test.ts`
- `packages/cli/package.json`
- `packages/cli/rslib.config.ts` deleted
- `scripts/publish-npm.ts` deleted
- `tsconfig.json`
- `docs/superpowers/specs/2026-07-04-cli-build-pipeline.md`
- `docs/superpowers/plans/2026-07-04-cli-build-pipeline.md`

Generated `npm/cli-*/bin/aio-proxy` files may exist locally after smoke testing but should not be committed.
