# CLI `upgrade` 命令实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `aio-proxy upgrade`，自动识别当前二进制归属的安装渠道（brew/bun/npm/pnpm/binary）并调用对应渠道升级到最新版。

**Architecture:** 检测与升级动作解耦。`detect.ts` 用 `Bun.which` 反查当前 `aio-proxy` 落在哪个包管理器的全局 bin 目录，产出纯数据 `UpgradeTarget`；`upgrade.ts` 消费它做版本比较与编排；`methods.ts` 构造各包管理器 arg；`binary.ts` 负责 GitHub 资产的下载/原子替换/回滚/备份清扫。全部用户可见文案走 `@aio-proxy/i18n`。

**Tech Stack:** Bun（`Bun.which` / `Bun.semver` / `Bun.spawn` / `Bun.$`）、commander、`@aio-proxy/i18n`（paraglide）、Node `fs`/`path`。

## Global Constraints

- 渠道识别用反向查找，用 `Bun.which('aio-proxy')` 解析 PATH 实际路径，**不用** `process.execPath`（编译二进制指向自身、npm launcher 指向 node，均不可靠）。
- 目标版本来源固定为官方 npm registry 常量 `https://registry.npmjs.org/`；该 origin 在版本检查与 bun/npm/pnpm 安装步骤用 `--registry` 一并钉住，防镜像滞后。
- 渠道优先级：**brew → bun → npm → pnpm → binary**；都不命中判定为 binary。
- 版本比较用 `Bun.semver.order`（AGENTS.md：Bun 环境优先 Bun API），**不引入** `semver` 依赖（`packages/cli` 未声明它）。
- binary 下载 URL 固定 `https://github.com/aio-proxy/aio-proxy/releases/download/v<v>/aio-proxy-<os>-<arch>`；不修 `install.sh` 的 `baranwang` 遗留标识。
- 单个手写非测试文件 ≤ 300 行，达到 240 行评估拆分；按职责拆分到 `upgrade/` 目录。
- 优先 `es-toolkit` 窄导入，不手写已有等价工具；不新增无业务含义的工具依赖。
- 命令注册在 `packages/cli/src/main.ts` 的 `buildProgram(deps)`；所有描述用 `m.cli_upgrade_*()`。
- i18n 消息 en 与 zh-Hans 必须同步新增同一组 key；改完 message JSON 后运行 `bun run --filter @aio-proxy/i18n build` 重新生成 `m.*` 访问器。
- 沙箱禁止 `rm -f` 类命令；清理临时/备份文件用 `fs.promises.unlink` / `fs.promises.rm`，不用 shell `rm`。
- colocated 命令模式：`upgrade/index.ts`（仅导出）、`upgrade/upgrade.ts`（编排）、`upgrade/upgrade.test.ts`（测试）；不写进 legacy `__tests__/`。
- 提交 footer 追加 `Co-authored-by: Codex <noreply@openai.com>`；分支前缀 `codex/`。
- 完成前跑 `bun run preflight`（= `lint:types` + `format:check` + `test`）。

---

## File Structure

- `packages/cli/src/upgrade/constants.ts` — 常量：`NPM_REGISTRY`、`PACKAGE`（`aio-proxy`）、`HOMEBREW_FORMULA`（`aio-proxy/tap/aio-proxy`）、`GITHUB_REPO`（`aio-proxy/aio-proxy`）、超时值。仅常量，无逻辑。
- `packages/cli/src/upgrade/detect.ts` — `resolveUpgradeTarget()` 反查渠道，导出纯函数 `resolveUpgradeMethod()` 与路径归属判定 `isPathInDirectory()`（词法 + realpath）供单测。产出 `UpgradeTarget`。
- `packages/cli/src/upgrade/methods.ts` — 各包管理器 arg 构造纯函数：`buildBunInstallArgs` / `buildNpmInstallArgs` / `buildPnpmInstallArgs` / `buildHomebrewUpdateArgs`，以及执行封装 `runPackageManagerUpgrade()`。
- `packages/cli/src/upgrade/binary.ts` — `updateViaBinary()`：下载资产 → `replaceBinaryForUpdate()` 原子替换/回滚 → `sweepStaleBackups()`。导出 `replaceBinaryForUpdate` / `sweepStaleBackups` 供单测。
- `packages/cli/src/upgrade/registry.ts` — `fetchLatestVersion(registry)` 查 npm registry `/<pkg>/latest`。
- `packages/cli/src/upgrade/upgrade.ts` — `runUpgradeCommand(options, print?)` 编排：解析 target → 查最新版 → `Bun.semver.order` 比较 → 分发到 methods/binary → 守护进程提示/重启。导出 `UpgradeOptions`。
- `packages/cli/src/upgrade/index.ts` — 仅导出 `{ runUpgradeCommand, type UpgradeOptions }`。
- `packages/cli/src/upgrade/upgrade.test.ts` — 覆盖：`isPathInDirectory`（含 realpath 软链）、`resolveUpgradeMethod` 优先级、各渠道 arg 构造、`replaceBinaryForUpdate` 回滚、版本比较分支。
- `packages/cli/src/main.ts`（修改）— import `runUpgradeCommand` 并注册 `upgrade` 命令 + 4 个选项。
- `packages/i18n/messages/en.json` / `zh-Hans.json`（修改）— 新增 14 个 `cli_upgrade_*` key。

---

## Task 1: 常量与类型骨架

**Files:**
- Create: `packages/cli/src/upgrade/constants.ts`
- Create: `packages/cli/src/upgrade/index.ts`

**Interfaces:**
- Produces: `NPM_REGISTRY: string`、`PACKAGE = 'aio-proxy'`、`HOMEBREW_FORMULA = 'aio-proxy/tap/aio-proxy'`、`GITHUB_REPO = 'aio-proxy/aio-proxy'`、`RELEASE_METADATA_TIMEOUT_MS`、`BINARY_DOWNLOAD_TIMEOUT_MS`；`UpgradeMethod = 'brew' | 'bun' | 'npm' | 'pnpm' | 'binary'`；`UpgradeTarget = { method: Exclude<UpgradeMethod,'binary'> } | { method: 'binary'; path: string }`。

- [ ] **Step 1: 写常量与类型**

```ts
// packages/cli/src/upgrade/constants.ts
export const NPM_REGISTRY = 'https://registry.npmjs.org/';
export const PACKAGE = 'aio-proxy';
export const HOMEBREW_FORMULA = 'aio-proxy/tap/aio-proxy';
export const GITHUB_REPO = 'aio-proxy/aio-proxy';
export const RELEASE_METADATA_TIMEOUT_MS = 30_000;
export const BINARY_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export type UpgradeMethod = 'brew' | 'bun' | 'npm' | 'pnpm' | 'binary';
export type UpgradeTarget = { readonly method: Exclude<UpgradeMethod, 'binary'> } | { readonly method: 'binary'; readonly path: string };
```

- [ ] **Step 2: index.ts 占位导出**（Task 6 完成后补 `runUpgradeCommand`）

```ts
// packages/cli/src/upgrade/index.ts
export type { UpgradeMethod, UpgradeTarget } from './constants';
```

- [ ] **Step 3: 类型检查**

Run: `bun run --filter @aio-proxy/cli lint:types`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/upgrade/constants.ts packages/cli/src/upgrade/index.ts
git commit -m "feat(cli): add upgrade constants and target types"
```

---

## Task 2: 渠道识别（detect.ts）

**Files:**
- Create: `packages/cli/src/upgrade/detect.ts`
- Test: `packages/cli/src/upgrade/upgrade.test.ts`（本任务新建，后续任务追加）

**Interfaces:**
- Consumes: `UpgradeTarget` / `UpgradeMethod`（Task 1）。
- Produces: `isPathInDirectory(filePath: string, dir: string): boolean`；`resolveUpgradeMethod(binPath: string, dirs: { brew?: string; bun?: string; npm?: string; pnpm?: string }): UpgradeMethod`；`resolveUpgradeTarget(): Promise<UpgradeTarget>`。

- [ ] **Step 1: 写失败测试（路径归属 + 优先级）**

```ts
// packages/cli/src/upgrade/upgrade.test.ts
import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPathInDirectory, resolveUpgradeMethod } from './detect';

test('isPathInDirectory: lexical match', () => {
  expect(isPathInDirectory('/opt/bun/bin/aio-proxy', '/opt/bun/bin')).toBe(true);
  expect(isPathInDirectory('/usr/local/bin/aio-proxy', '/opt/bun/bin')).toBe(false);
});

test('isPathInDirectory: resolves symlinked binary (Homebrew Cellar)', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-brew-'));
  const cellarBin = join(root, 'Cellar/aio-proxy/1.0.0/bin');
  const optBin = join(root, 'opt/aio-proxy/bin');
  mkdirSync(cellarBin, { recursive: true });
  mkdirSync(join(root, 'opt/aio-proxy'), { recursive: true });
  writeFileSync(join(cellarBin, 'aio-proxy'), '#!/bin/sh\n');
  symlinkSync(cellarBin, optBin);
  // PATH 解析到 opt 软链目录，词法不落在 Cellar，realpath 兜底应判 true
  expect(isPathInDirectory(join(optBin, 'aio-proxy'), cellarBin)).toBe(true);
});

test('resolveUpgradeMethod: priority brew > bun > npm > pnpm', () => {
  const dirs = { brew: '/brew/bin', bun: '/bun/bin', npm: '/npm/bin', pnpm: '/pnpm/bin' };
  expect(resolveUpgradeMethod('/brew/bin/aio-proxy', dirs)).toBe('brew');
  expect(resolveUpgradeMethod('/bun/bin/aio-proxy', { bun: '/bun/bin', npm: '/npm/bin' })).toBe('bun');
  expect(resolveUpgradeMethod('/npm/bin/aio-proxy', { npm: '/npm/bin', pnpm: '/pnpm/bin' })).toBe('npm');
  expect(resolveUpgradeMethod('/pnpm/bin/aio-proxy', { pnpm: '/pnpm/bin' })).toBe('pnpm');
  expect(resolveUpgradeMethod('/home/u/.local/bin/aio-proxy', dirs)).toBe('binary');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: FAIL（`./detect` 未定义）

- [ ] **Step 3: 实现 detect.ts**

```ts
// packages/cli/src/upgrade/detect.ts
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { UpgradeMethod, UpgradeTarget } from './constants';
import { HOMEBREW_FORMULA, PACKAGE } from './constants';

const tryRealpath = (p: string): string | undefined => {
  try {
    return realpathSync.native(p);
  } catch {
    return undefined;
  }
};

const isInsideLexical = (filePath: string, dir: string): boolean => {
  const rel = relative(resolve(dir), resolve(filePath));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export const isPathInDirectory = (filePath: string, dir: string): boolean => {
  if (isInsideLexical(filePath, dir)) return true;
  const dirReal = tryRealpath(resolve(dir));
  if (dirReal === undefined) return false;
  const fileReal = tryRealpath(resolve(filePath));
  if (fileReal !== undefined && isInsideLexical(fileReal, dirReal)) return true;
  const parentReal = tryRealpath(dirname(resolve(filePath)));
  if (parentReal === undefined) return false;
  return isInsideLexical(join(parentReal, basename(filePath)), dirReal);
};

export const resolveUpgradeMethod = (
  binPath: string,
  dirs: { readonly brew?: string; readonly bun?: string; readonly npm?: string; readonly pnpm?: string },
): UpgradeMethod => {
  if (dirs.brew !== undefined && isPathInDirectory(binPath, dirs.brew)) return 'brew';
  if (dirs.bun !== undefined && isPathInDirectory(binPath, dirs.bun)) return 'bun';
  if (dirs.npm !== undefined && isPathInDirectory(binPath, dirs.npm)) return 'npm';
  if (dirs.pnpm !== undefined && isPathInDirectory(binPath, dirs.pnpm)) return 'pnpm';
  return 'binary';
};

const runCapture = async (cmd: string[]): Promise<string | undefined> => {
  if (Bun.which(cmd[0]) === null) return undefined;
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) return undefined;
  const trimmed = out.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const brewBinDir = async (): Promise<string | undefined> => {
  for (const formula of [HOMEBREW_FORMULA, PACKAGE]) {
    const prefix = await runCapture(['brew', '--prefix', formula]);
    if (prefix !== undefined) return join(prefix, 'bin');
  }
  return undefined;
};

const npmBinDir = async (): Promise<string | undefined> => {
  const prefix = await runCapture(['npm', 'prefix', '-g']);
  if (prefix === undefined) return undefined;
  return process.platform === 'win32' ? prefix : join(prefix, 'bin');
};

export const resolveUpgradeTarget = async (): Promise<UpgradeTarget> => {
  const binPath = Bun.which(PACKAGE);
  if (binPath === null) throw new Error(`cannot locate ${PACKAGE} in PATH`);
  const [brew, bun, npm, pnpm] = await Promise.all([
    brewBinDir(),
    runCapture(['bun', 'pm', 'bin', '-g']),
    npmBinDir(),
    runCapture(['pnpm', 'bin', '-g']),
  ]);
  const method = resolveUpgradeMethod(binPath, { brew, bun, npm, pnpm });
  return method === 'binary' ? { method, path: binPath } : { method };
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade/detect.ts packages/cli/src/upgrade/upgrade.test.ts
git commit -m "feat(cli): detect upgrade channel via reverse PATH lookup"
```

---

## Task 3: 各渠道 arg 构造与执行（methods.ts）

> **与 spec 的一处对齐**：spec 决策表把 pnpm 写作 `pnpm add -g aio-proxy@<v>`（未带 `--registry`），但 spec 正文明确「bun/npm/pnpm 安装步骤用 `--registry` 一并钉住」。二者矛盾，本 plan 采纳正文——pnpm 也 pin registry，与 bun/npm 一致，消除镜像滞后风险。

**Files:**
- Create: `packages/cli/src/upgrade/methods.ts`
- Test: `packages/cli/src/upgrade/upgrade.test.ts`（追加）

**Interfaces:**
- Consumes: `PACKAGE` / `HOMEBREW_FORMULA`（Task 1）。registry 不在此引用常量，由调用方（Task 6）经 `opts.registry` 注入。
- Produces: `buildBunInstallArgs(v, registry)`、`buildNpmInstallArgs(v, registry)`、`buildPnpmInstallArgs(v, registry)`、`buildHomebrewUpdateArgs(force)`（均 `string[]`）；`runPackageManagerUpgrade(method, version, opts): Promise<void>`。

- [ ] **Step 1: 写失败测试（arg 构造）**

```ts
// append to upgrade.test.ts
import { buildBunInstallArgs, buildHomebrewUpdateArgs, buildNpmInstallArgs, buildPnpmInstallArgs } from './methods';
import { NPM_REGISTRY } from './constants';

test('buildBunInstallArgs pins registry and version', () => {
  expect(buildBunInstallArgs('1.2.3', NPM_REGISTRY)).toEqual(['add', '-g', `--registry=${NPM_REGISTRY}`, 'aio-proxy@1.2.3']);
});
test('buildNpmInstallArgs pins registry and version', () => {
  expect(buildNpmInstallArgs('1.2.3', NPM_REGISTRY)).toEqual(['install', '-g', `--registry=${NPM_REGISTRY}`, 'aio-proxy@1.2.3']);
});
test('buildPnpmInstallArgs pins registry and version', () => {
  expect(buildPnpmInstallArgs('1.2.3', NPM_REGISTRY)).toEqual(['add', '-g', `--registry=${NPM_REGISTRY}`, 'aio-proxy@1.2.3']);
});
test('buildHomebrewUpdateArgs switches on force', () => {
  expect(buildHomebrewUpdateArgs(false)).toEqual(['upgrade', 'aio-proxy/tap/aio-proxy']);
  expect(buildHomebrewUpdateArgs(true)).toEqual(['reinstall', 'aio-proxy/tap/aio-proxy']);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: FAIL（`./methods` 未定义）

- [ ] **Step 3: 实现 methods.ts**

```ts
// packages/cli/src/upgrade/methods.ts
import { HOMEBREW_FORMULA, PACKAGE, type UpgradeMethod } from './constants';

export const buildBunInstallArgs = (version: string, registry: string): string[] => ['add', '-g', `--registry=${registry}`, `${PACKAGE}@${version}`];
export const buildNpmInstallArgs = (version: string, registry: string): string[] => ['install', '-g', `--registry=${registry}`, `${PACKAGE}@${version}`];
export const buildPnpmInstallArgs = (version: string, registry: string): string[] => ['add', '-g', `--registry=${registry}`, `${PACKAGE}@${version}`];
export const buildHomebrewUpdateArgs = (force: boolean): string[] => [force ? 'reinstall' : 'upgrade', HOMEBREW_FORMULA];

const exec = async (cmd: string[]): Promise<void> => {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`${cmd[0]} exited with ${await proc.exited}`);
};

export const runPackageManagerUpgrade = async (
  method: Exclude<UpgradeMethod, 'binary'>,
  version: string,
  opts: { readonly registry: string; readonly force: boolean },
): Promise<void> => {
  switch (method) {
    case 'bun':
      return exec(['bun', ...buildBunInstallArgs(version, opts.registry)]);
    case 'npm':
      return exec(['npm', ...buildNpmInstallArgs(version, opts.registry)]);
    case 'pnpm':
      return exec(['pnpm', ...buildPnpmInstallArgs(version, opts.registry)]);
    case 'brew':
      await exec(['brew', 'update']);
      return exec(['brew', ...buildHomebrewUpdateArgs(opts.force)]);
  }
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade/methods.ts packages/cli/src/upgrade/upgrade.test.ts
git commit -m "feat(cli): build per-channel upgrade args pinned to registry"
```

---

## Task 4: binary 渠道原子替换（binary.ts）

**Files:**
- Create: `packages/cli/src/upgrade/binary.ts`
- Test: `packages/cli/src/upgrade/upgrade.test.ts`（追加）

**Interfaces:**
- Consumes: `GITHUB_REPO` / `BINARY_DOWNLOAD_TIMEOUT_MS`（Task 1）。
- Produces: `binaryAssetName(): string`（`aio-proxy-<os>-<arch>`）；`replaceBinaryForUpdate(opts): Promise<{ ok: boolean; actual?: string }>`；`sweepStaleBackups(targetPath): Promise<void>`；`updateViaBinary(path, version): Promise<void>`。`replaceBinaryForUpdate` 参数：`{ targetPath, tempPath, backupPath, expectedVersion, verify }`，`verify: (v) => Promise<{ ok: boolean; actual?: string }>`。

- [ ] **Step 1: 写失败测试（回滚 + 备份清扫）**

```ts
// append to upgrade.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { replaceBinaryForUpdate, sweepStaleBackups } from './binary';

test('replaceBinaryForUpdate rolls back when verify fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-'));
  const target = join(root, 'aio-proxy');
  const temp = join(root, 'aio-proxy.new');
  const backup = join(root, 'aio-proxy.1.2.bak');
  writeFileSync(target, 'OLD');
  writeFileSync(temp, 'NEW');
  const res = await replaceBinaryForUpdate({ targetPath: target, tempPath: temp, backupPath: backup, expectedVersion: '9.9.9', verify: async () => ({ ok: false }) });
  expect(res.ok).toBe(false);
  expect(readFileSync(target, 'utf8')).toBe('OLD'); // 回滚到旧二进制
  expect(existsSync(temp)).toBe(false);
});

test('replaceBinaryForUpdate swaps in new binary when verify ok', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-bin-'));
  const target = join(root, 'aio-proxy');
  const temp = join(root, 'aio-proxy.new');
  writeFileSync(target, 'OLD');
  writeFileSync(temp, 'NEW');
  const res = await replaceBinaryForUpdate({ targetPath: target, tempPath: temp, backupPath: join(root, 'aio-proxy.1.2.bak'), expectedVersion: '1.0.0', verify: async () => ({ ok: true, actual: '1.0.0' }) });
  expect(res.ok).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe('NEW');
});

test('sweepStaleBackups removes only timestamped .bak siblings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-sweep-'));
  const target = join(root, 'aio-proxy');
  writeFileSync(target, 'x');
  writeFileSync(join(root, 'aio-proxy.123.456.bak'), 'x');
  writeFileSync(join(root, 'aio-proxy.unrelated.txt'), 'x');
  await sweepStaleBackups(target);
  expect(existsSync(join(root, 'aio-proxy.123.456.bak'))).toBe(false);
  expect(existsSync(join(root, 'aio-proxy.unrelated.txt'))).toBe(true);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: FAIL（`./binary` 未定义）

- [ ] **Step 3: 实现 binary.ts**

```ts
// packages/cli/src/upgrade/binary.ts
import { createWriteStream, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { BINARY_DOWNLOAD_TIMEOUT_MS, GITHUB_REPO } from './constants';

type Verification = { readonly ok: boolean; readonly actual?: string };
type ReplaceOptions = {
  readonly targetPath: string;
  readonly tempPath: string;
  readonly backupPath: string;
  readonly expectedVersion: string;
  readonly verify: (expected: string) => Promise<Verification>;
};

export const binaryAssetName = (): string => `aio-proxy-${process.platform}-${process.arch}`;

const unlinkIfExists = async (p: string): Promise<void> => {
  await fs.unlink(p).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
};

// 返回契约：
// - 交换成功且 verify 通过 → 返回 verify 的 { ok:true, actual }。
// - verify 未通过 → 回滚到旧二进制、清理 temp，返回 { ok:false }（不抛，交由调用方决定报错文案）。
// - 下载/rename 等系统级错误（在 verify 之前发生）→ 尽力回滚后 rethrow，让调用方看到真实 IO 失败。
export const replaceBinaryForUpdate = async (options: ReplaceOptions): Promise<Verification> => {
  // 阶段一：把旧二进制挪到备份、把新二进制换入。此处任何失败都是系统级错误 → 回滚并 rethrow。
  let backupReady = false;
  try {
    await fs.rename(options.targetPath, options.backupPath);
    backupReady = true;
    await fs.rename(options.tempPath, options.targetPath);
  } catch (err) {
    if (backupReady) {
      await unlinkIfExists(options.targetPath);
      await fs.rename(options.backupPath, options.targetPath);
    }
    await unlinkIfExists(options.tempPath);
    throw err;
  }

  // 阶段二：校验换入的新二进制。未通过 → 回滚并返回 { ok:false }（正常业务失败，不 rethrow）。
  const verification = await options.verify(options.expectedVersion);
  if (!verification.ok) {
    await unlinkIfExists(options.targetPath);
    await fs.rename(options.backupPath, options.targetPath);
    return { ok: false, ...(verification.actual === undefined ? {} : { actual: verification.actual }) };
  }

  // 成功：清理本次备份后返回。
  await unlinkIfExists(options.backupPath);
  return verification;
};

export const sweepStaleBackups = async (targetPath: string): Promise<void> => {
  const dir = dirname(targetPath);
  const base = basename(targetPath);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.startsWith(`${base}.`) || !entry.endsWith('.bak')) continue;
    const middle = entry.slice(base.length + 1, entry.length - '.bak'.length);
    if (middle.length > 0 && !/^\d+(\.\d+)*$/.test(middle)) continue;
    await unlinkIfExists(join(dir, entry));
  }
};

const verifyInstalledVersion = async (binPath: string, expected: string): Promise<Verification> => {
  const proc = Bun.spawn([binPath, '--version'], { stdout: 'pipe', stderr: 'ignore' });
  const out = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0) return { ok: false };
  const actual = out.match(/(\d+\.\d+\.\d+)/)?.[1];
  return { ok: actual === expected, actual };
};

export const updateViaBinary = async (targetPath: string, version: string): Promise<void> => {
  const url = `https://github.com/${GITHUB_REPO}/releases/download/v${version}/${binaryAssetName()}`;
  const tempPath = `${targetPath}.new`;
  const backupPath = `${targetPath}.${Date.now()}.${process.pid}.bak`;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(BINARY_DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || res.body === null) throw new Error(`binary asset unavailable (${res.status}); reinstall via install.sh`);
  await pipeline(res.body, createWriteStream(tempPath, { mode: 0o755 }));
  const verification = await replaceBinaryForUpdate({
    targetPath,
    tempPath,
    backupPath,
    expectedVersion: version,
    verify: (expected) => verifyInstalledVersion(targetPath, expected),
  });
  if (!verification.ok) throw new Error(`upgraded binary failed version check; restored previous binary`);
  await sweepStaleBackups(targetPath);
};
```

> 注：`replaceBinaryForUpdate` 的返回契约已在上面定稿——verify 未通过是正常业务失败，回滚后返回 `{ ok:false }`；只有 verify 之前的下载/rename 系统级错误才 rethrow。测试用非空 `expectedVersion` + `verify: async () => ({ ok:false })` 断言回滚与返回值，不依赖抛异常。照此实现即可，无需再收敛。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade/binary.ts packages/cli/src/upgrade/upgrade.test.ts
git commit -m "feat(cli): atomic binary self-replace with rollback and backup sweep"
```

---

## Task 5: 最新版查询（registry.ts）

**Files:**
- Create: `packages/cli/src/upgrade/registry.ts`
- Test: `packages/cli/src/upgrade/upgrade.test.ts`（追加）

**Interfaces:**
- Consumes: `RELEASE_METADATA_TIMEOUT_MS` / `PACKAGE`（Task 1）。
- Produces: `fetchLatestVersion(registry: string, fetchImpl?: typeof fetch): Promise<string>`。

- [ ] **Step 1: 写失败测试（注入 fetch）**

```ts
// append to upgrade.test.ts
import { fetchLatestVersion } from './registry';

test('fetchLatestVersion reads version from registry /latest', async () => {
  const fake = (async () => Response.json({ version: '2.3.4' })) as unknown as typeof fetch;
  expect(await fetchLatestVersion(NPM_REGISTRY, fake)).toBe('2.3.4');
});

test('fetchLatestVersion throws on non-ok', async () => {
  const fake = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch;
  await expect(fetchLatestVersion(NPM_REGISTRY, fake)).rejects.toThrow();
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: FAIL（`./registry` 未定义）

- [ ] **Step 3: 实现 registry.ts**

```ts
// packages/cli/src/upgrade/registry.ts
import { PACKAGE, RELEASE_METADATA_TIMEOUT_MS } from './constants';

export const fetchLatestVersion = async (registry: string, fetchImpl: typeof fetch = fetch): Promise<string> => {
  const base = registry.endsWith('/') ? registry : `${registry}/`;
  const res = await fetchImpl(`${base}${PACKAGE}/latest`, { signal: AbortSignal.timeout(RELEASE_METADATA_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`failed to fetch latest version: ${res.status}`);
  const data = (await res.json()) as { version?: string };
  if (typeof data.version !== 'string') throw new Error('registry response missing version');
  return data.version;
};
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/upgrade/registry.ts packages/cli/src/upgrade/upgrade.test.ts
git commit -m "feat(cli): fetch latest version from npm registry"
```

---

## Task 6: 编排 + 版本比较（upgrade.ts）

**Files:**
- Create: `packages/cli/src/upgrade/upgrade.ts`
- Modify: `packages/cli/src/upgrade/index.ts`
- Test: `packages/cli/src/upgrade/upgrade.test.ts`（追加）

**Interfaces:**
- Consumes: 前五个任务的导出；`m.cli_upgrade_*`（Task 7）；`probeHealth` / `controlBaseUrl` / `resolveControlAddress`（`../control-plane`）；`serviceRestart`（`../service`）。
- Produces: `type UpgradeOptions = { check?: boolean; force?: boolean; restart?: boolean; registry?: string }`；`runUpgradeCommand(options?, print?): Promise<void>`。
- 依赖注入：`runUpgradeCommand` 第三参数 `deps?`（`{ resolveTarget; fetchLatest; currentVersion }`）用于单测，默认取真实实现。

- [ ] **Step 1: 写失败测试（版本比较分支，注入 deps）**

```ts
// append to upgrade.test.ts
import { runUpgradeCommand } from './upgrade';

test('--check reports up-to-date without installing', async () => {
  const lines: string[] = [];
  await runUpgradeCommand(
    { check: true },
    (l) => lines.push(l),
    { resolveTarget: async () => ({ method: 'bun' }), fetchLatest: async () => '1.0.0', currentVersion: '1.0.0' },
  );
  expect(lines.join('\n')).toContain('1.0.0');
});

test('--check reports a newer version when available', async () => {
  const lines: string[] = [];
  await runUpgradeCommand(
    { check: true },
    (l) => lines.push(l),
    { resolveTarget: async () => ({ method: 'bun' }), fetchLatest: async () => '2.0.0', currentVersion: '1.0.0' },
  );
  expect(lines.join('\n')).toContain('2.0.0');
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: FAIL（`./upgrade` 未定义）

- [ ] **Step 3: 实现 upgrade.ts**

```ts
// packages/cli/src/upgrade/upgrade.ts
import { m } from '@aio-proxy/i18n';
import packageJson from '../../package.json' with { type: 'json' };
import { controlBaseUrl, probeHealth, resolveControlAddress } from '../control-plane';
import { serviceRestart } from '../service';
import { NPM_REGISTRY, type UpgradeTarget } from './constants';
import { resolveUpgradeTarget } from './detect';
import { updateViaBinary } from './binary';
import { runPackageManagerUpgrade } from './methods';
import { fetchLatestVersion } from './registry';

export type UpgradeOptions = {
  readonly check?: boolean;
  readonly force?: boolean;
  readonly restart?: boolean;
  readonly registry?: string;
};

type UpgradeDeps = {
  readonly resolveTarget: () => Promise<UpgradeTarget>;
  readonly fetchLatest: (registry: string) => Promise<string>;
  readonly currentVersion: string;
};

const defaultDeps: UpgradeDeps = {
  resolveTarget: resolveUpgradeTarget,
  fetchLatest: (registry) => fetchLatestVersion(registry),
  currentVersion: packageJson.version,
};

export const runUpgradeCommand = async (
  options: UpgradeOptions = {},
  print: (line: string) => void = console.log,
  deps: UpgradeDeps = defaultDeps,
): Promise<void> => {
  const registry = options.registry ?? NPM_REGISTRY;
  const target = await deps.resolveTarget();
  const latest = await deps.fetchLatest(registry);
  const current = deps.currentVersion;
  print(m.cli_upgrade_current_version({ version: current }));

  const cmp = Bun.semver.order(latest, current);
  if (cmp <= 0 && options.force !== true) {
    print(m.cli_upgrade_up_to_date({ version: current }));
    return;
  }
  if (cmp > 0) print(m.cli_upgrade_new_version({ version: latest }));
  if (options.check === true) return;
  if (cmp <= 0 && options.force === true) print(m.cli_upgrade_forcing({ version: latest }));

  print(m.cli_upgrade_via({ method: target.method }));
  if (target.method === 'binary') await updateViaBinary(target.path, latest);
  else await runPackageManagerUpgrade(target.method, latest, { registry, force: options.force === true });
  print(m.cli_upgrade_success({ version: latest }));

  const { host, port } = await resolveControlAddress({});
  const url = controlBaseUrl(host, port);
  if ((await probeHealth(url)) !== null) {
    if (options.restart === true) {
      print(m.cli_upgrade_restarting());
      await serviceRestart();
    } else {
      print(m.cli_upgrade_daemon_running_hint());
    }
  }
};
```

- [ ] **Step 4: 更新 index.ts 导出**

```ts
// packages/cli/src/upgrade/index.ts
export { runUpgradeCommand, type UpgradeOptions } from './upgrade';
export type { UpgradeMethod, UpgradeTarget } from './constants';
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: PASS
> **顺序依赖（重要）**：`upgrade.ts` 在运行期 import `m.cli_upgrade_*`。`lint:types` 会忽略 `*.test.ts`，但 `bun test` 会真正加载 `upgrade.ts`，若 `m.cli_upgrade_*` 访问器尚不存在则运行期抛错。因此 **Task 7（新增 message + `bun run --filter @aio-proxy/i18n build` 生成访问器）必须先于本步执行**。执行顺序建议：Task 1→2→3→4→5→**7**→6→8→9。（Task 7 无代码依赖，可在任意早点做；这里前置只为让 Task 6 的测试可运行。）

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/upgrade/upgrade.ts packages/cli/src/upgrade/index.ts packages/cli/src/upgrade/upgrade.test.ts
git commit -m "feat(cli): orchestrate upgrade with semver compare and daemon hint"
```

---

## Task 7: i18n 文案（14 key）

> **执行顺序**：本任务无代码依赖，且是 Task 6 测试可运行的前置（`upgrade.ts` 运行期引用 `m.cli_upgrade_*`）。请在 Task 6 之前完成本任务的 message 新增与 `bun run --filter @aio-proxy/i18n build`。

**Files:**
- Modify: `packages/i18n/messages/en.json`
- Modify: `packages/i18n/messages/zh-Hans.json`

**Interfaces:**
- Produces（14 key，en/zh-Hans 同步，插入在 `cli_completion_unsupported_shell` 之后）：
  `cli_upgrade_description`、`cli_upgrade_option_check_description`、`cli_upgrade_option_force_description`、`cli_upgrade_option_restart_description`、`cli_upgrade_option_registry_description`、`cli_upgrade_current_version`（`{version}`）、`cli_upgrade_check_failed`、`cli_upgrade_up_to_date`（`{version}`）、`cli_upgrade_new_version`（`{version}`）、`cli_upgrade_forcing`（`{version}`）、`cli_upgrade_via`（`{method}`）、`cli_upgrade_success`（`{version}`）、`cli_upgrade_daemon_running_hint`、`cli_upgrade_restarting`。

- [ ] **Step 1: 在 en.json 追加 14 key**（占位符用 `{version}` / `{method}`，值为英文文案）

- [ ] **Step 2: 在 zh-Hans.json 追加同名 14 key**（中文文案，占位符一致）

- [ ] **Step 3: 重新编译 i18n 生成 `m.*` 访问器**

Run: `bun run --filter @aio-proxy/i18n build`
Expected: PASS（编译成功，`packages/i18n/src/paraglide/messages/` 出现 `cli_upgrade_*`）

- [ ] **Step 4: 校验 en/zh key 集合一致**

Run: `bun -e "const a=Object.keys(require('./packages/i18n/messages/en.json')).filter(k=>k.startsWith('cli_upgrade_'));const b=Object.keys(require('./packages/i18n/messages/zh-Hans.json')).filter(k=>k.startsWith('cli_upgrade_'));if(a.length!==14||JSON.stringify(a.sort())!==JSON.stringify(b.sort()))throw new Error('key mismatch');console.log('ok',a.length)"`
Expected: `ok 14`

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/messages/en.json packages/i18n/messages/zh-Hans.json
git commit -m "feat(i18n): add cli_upgrade_* messages (en + zh-Hans)"
```

---

## Task 8: 命令注册（main.ts）

**Files:**
- Modify: `packages/cli/src/main.ts:16`（import 区）与 `buildProgram` 内 `completion` 注册之后。

**Interfaces:**
- Consumes: `runUpgradeCommand`（Task 6）、`m.cli_upgrade_*`（Task 7）。

- [ ] **Step 1: 加 import**

```ts
import { runUpgradeCommand } from './upgrade';
```

- [ ] **Step 2: 在 `completion` 命令注册后追加 upgrade 命令**

```ts
  program
    .command('upgrade')
    .description(m.cli_upgrade_description())
    .option('--check', m.cli_upgrade_option_check_description())
    .option('--force', m.cli_upgrade_option_force_description())
    .option('--restart', m.cli_upgrade_option_restart_description())
    .option('--registry <url>', m.cli_upgrade_option_registry_description())
    .action((options) => runUpgradeCommand(options));
```

- [ ] **Step 3: 类型检查 + 手动烟测**

Run: `bun run --filter @aio-proxy/cli lint:types` 然后 `bun packages/cli/src/main.ts upgrade --help`
Expected: 类型 PASS；`--help` 打印 upgrade 描述与四个选项

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/main.ts
git commit -m "feat(cli): register upgrade command"
```

---

## Task 9: 收尾校验

- [ ] **Step 1: 跑 upgrade 单测**

Run: `bun test packages/cli/src/upgrade/upgrade.test.ts`
Expected: 全 PASS

- [ ] **Step 2: preflight**

Run: `bun run preflight`
Expected: lint:types + format:check + test 通过（已知与本改动无关的 i18n `tree-shake-spike` 联网 flaky、CLI 健康端口并发 flaky 若出现，单独隔离复跑确认无关）

- [ ] **Step 3: 若 format:check 失败，跑 `bun run format` 后复查并补提交**

---

## Self-Review

**1. Spec coverage**（逐条对照 spec）：
- 反查识别（Bun.which，非 execPath）→ Task 2 ✅
- 优先级 brew→bun→npm→pnpm→binary → Task 2 `resolveUpgradeMethod` ✅
- registry pin（版本查询 + 安装）→ Task 3/5 ✅
- 各渠道命令（bun/npm/pnpm/brew）→ Task 3 ✅
- binary 下载/原子替换/校验/回滚/备份清扫 → Task 4 ✅
- 守护进程探测 + `--restart` → Task 6 ✅
- 选项 `--check/--force/--restart/--registry` → Task 6/8 ✅
- 14 个 i18n key en/zh 同步 → Task 7 ✅
- 代码结构 6 文件 colocated → File Structure ✅
- 失败处理（registry 不可达、已最新、包管理器非零、binary 回滚、资产缺失、无法定位路径）→ Task 4/5/6 覆盖，实现阶段确保错误消息走 i18n / `CliExit`
- 非目标（不修 install.sh、不补 release 资产、不加后台自动升级）→ 未纳入任务 ✅

**2. Placeholder scan**：无 TBD / "handle errors" 等占位；每个 code step 均有可运行代码。Task 4 的 `replaceBinaryForUpdate` 返回契约已在 plan 中定稿（verify 失败回滚并返回 `{ok:false}`；verify 之前的系统级 IO 错误 rethrow），非留待实现者收敛。

**3. Type consistency**：`UpgradeTarget`/`UpgradeMethod`（Task 1）在 detect/methods/upgrade 一致；`runPackageManagerUpgrade` 只接受 `Exclude<UpgradeMethod,'binary'>`，binary 分支在 upgrade.ts 走 `updateViaBinary`；`fetchLatestVersion(registry, fetchImpl?)` 签名在 Task 5 定义、Task 6 注入；`verify` 回调返回 `{ok, actual?}` 与 `verifyInstalledVersion` 一致。

## 已知前置依赖（阻塞项，来自 spec）

- **GitHub Release 目前不附二进制资产**：binary 渠道升级会在资产就位前以「请用 install.sh 重装」提示失败（Task 4 已实现该失败路径）。bun/npm/pnpm/brew 渠道不受影响，可立即可用。
- 该前置由 release 流程补齐（`scripts/release.ts` 的 `gh release create` 传 asset），属本设计非目标，仅记录。

## Execution Handoff

计划已保存。**按用户此前指示：写完 plan 在此停下，等用户评审 / 干预后再进入实现。** 待用户确认后，二选一：

1. **Subagent-Driven（推荐）**：每个 Task 派新 subagent，任务间两段式复核。
2. **Inline Execution**：本会话内分批执行 + 检查点复核。
