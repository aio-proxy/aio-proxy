# CLI 构建管线修订

日期：2026-07-04
状态：已实现

## 背景

`aio-proxy` 的用户交付物是 Bun `--compile` 生成的自包含二进制。`packages/cli` 是应用入口和二进制构建包，不是可发布的 library package。

现有实现里：

- `packages/cli/scripts/build-binary.ts` 通过 `Bun.spawnSync([process.execPath, "build", "--compile", ...])` 调 Bun CLI。
- `packages/cli/scripts/generate-compiled-entry.ts` 写入临时 `src/main.compiled.gen.ts`，构建后删除。
- `packages/cli` 仍保留 `rslib` 的 `build` / `dev` / `rslib.config.ts`。

这些都能工作，但比需要的多一层。

## 决策

### 1. `build:binary` 使用 `Bun.build`

`build-binary.ts` 直接调用 Bun JS API：

```ts
await Bun.build({
  entrypoints: [entry],
  compile: {
    target,
    outfile,
  },
});
```

不再 spawn `bun build` 子进程。失败处理以 `BuildOutput.success/logs` 或异常为准，保留当前单目标参数和四平台默认矩阵。

### 2. 编译入口使用 `Bun.build({ files })`

Dashboard dist 仍在构建期扫描，仍渲染含 `import ... with { type: "file" }` 的入口源码，但不再写入 `src/main.compiled.gen.ts`。

使用 Bun 的虚拟文件输入：

```ts
await Bun.build({
  entrypoints: [entry],
  files: {
    [entry]: renderCompiledEntry(assetPaths),
  },
  compile: {
    target,
    outfile,
  },
});
```

这样保留 Bun compile 对静态 import 的 asset embedding，同时删除临时文件写入和 `finally rmSync(entry)`。

不使用 runtime plugin。Plugin 适合扩展 import resolve/load 规则；这里没有新文件类型或解析规则，只有一个构建期虚拟入口，`files` 更小。

### 3. `packages/cli` 移除 rslib

`packages/cli` 不产出 library dist，不发布 `@aio-proxy/cli`。二进制构建直接写入 npm 平台包的 `npm/cli-<platform>-<arch>/bin/aio-proxy`，不再先落到 `packages/cli/dist-bin` 再复制。

因此移除：

- `packages/cli/rslib.config.ts`
- `packages/cli/package.json` 中的 `@rslib/core`
- `packages/cli/package.json` 中的 `dev: rslib --watch --no-clean`

`build` 不应再指向 `rslib`，也不应转发到 `build:binary`。CLI 不需要普通 `build` 脚本；类型检查由 root `bun run check` 的 `tsc -b` 覆盖，二进制构建由显式 `build:binary` 覆盖。

CLI 的 `scripts/*.ts` 不属于 `packages/cli/src`，必须有独立 `packages/cli/scripts/tsconfig.json` 并被 root `tsconfig.json` references 纳入 `tsc -b`。该 tsconfig 使用 `noEmit: true`，避免 TypeScript 把 `.js/.d.ts` 输出到 `scripts/` 或 `src/`。

## 非目标

- 不改变发布包结构：npm 主包和四个平台包仍按发布形态设计执行。
- 不改变 dashboard 资源嵌入模型：仍由 Bun compile 内嵌静态资源。
- 不引入 bundler/runtime plugin。
- 不把内部包改成可发布库。
- 不保留自定义 npm 发布脚本；版本与发布由 changesets 负责。

## 验收

- `bun run --filter @aio-proxy/cli build:binary darwin-arm64` 产出 `npm/cli-darwin-arm64/bin/aio-proxy`。
- 构建后不存在 `packages/cli/src/main.compiled.gen.ts`。
- `packages/cli/dist` 不再作为 CLI 发布或构建链路的一部分。
- `scripts/publish-npm.ts` 不存在；release workflow 使用 `bunx changeset publish`。
- `bun run check` 不依赖 `packages/cli/rslib.config.ts`。
- `bun run check` 覆盖 `packages/cli/scripts/*.ts` 且不产生脚本 emit 文件。
