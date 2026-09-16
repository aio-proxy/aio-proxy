# Canary 发布通道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让维护者能在 GitHub UI 上对任意分支手动派发一次发布，把全部 8 个可发布包以 `X.Y.(Z+1)-canary.<run_number>.<sha7>` 发到 npm 的 `canary` dist-tag，供「改动大、本地不好验证」的变更做真实安装验证。

**Architecture:** 复用现有 `.github/workflows/release.yml` 文件名（npm trusted publishing 按 workflow 文件名匹配，复用即 OIDC 零配置）与 `scripts/release.ts` 脚本。canary 与正式发布在同一 job 内按 `github.event_name` 分叉：canary 路径在 `bun update` 之前把 canary 版本写进全部 manifest，然后走完全相同的 build → `bun pm pack` → `npm publish` 链路，只多一个 `--tag canary`。版本计算抽成独立纯函数单测覆盖。

**Tech Stack:** Bun 1.4.2（`Bun.semver`、`Bun.Glob`、`Bun.$`）、`bun:test`、GitHub Actions、Changesets 3.0.2（canary 路径完全不参与）、npm OIDC trusted publishing。

设计依据：`docs/superpowers/specs/2026-09-15-canary-release-design.md`。

## Global Constraints

- 版本格式固定为 `X.Y.(Z+1)-canary.<run_number>.<sha7>`，base 取当前锁步版本的 patch + 1。示例：`0.23.0` → `0.23.1-canary.4213.a1b2c3d`。
- 必须满足 `0.23.0 < 0.23.1-canary.* < 0.23.1 < 0.24.0`（用 `Bun.semver.order` 判定）。
- `run_number` 与 `sha7` 都是 semver prerelease 标识符；数字标识符**不得有前导零**。
- canary 路径下 `npm publish` 必须带 `--tag canary`；正式路径必须**不带** `--tag`（沿用默认 `latest`）。
- canary 路径不得产生 git commit、git tag、GitHub Release、Docker 镜像、Homebrew 通知或 GH Release 附件。
- canary 路径必须改写**全部**包的版本，包括私有包——版本会被编译进 CLI 二进制与各插件的 `*_PLUGIN_VERSION`，且 `scripts/release.ts` 有全仓库锁步断言。
- 本次改动不需要 changeset（发布工具链改动，不改变已发布产品行为）。
- `scripts/` 下 `noPropertyAccessFromIndexSignature` 生效：读环境变量用 `process.env['X']` 下标形式。
- `scripts/release.ts` 当前 277 行，改完须仍在 500 行以内。

---

### Task 1: 版本计算纯函数

把 canary 版本计算抽成独立、可单测的纯函数。这是整个方案唯一有分支逻辑的部分，也是唯一值得单测的部分。

**Files:**
- Create: `scripts/canary-version/index.ts`
- Create: `scripts/canary-version/canary-version.ts`
- Test: `scripts/canary-version/canary-version.test.ts`

目录布局照 `scripts/homebrew-checksums/` 的既有约定（`index.ts` 只做 re-export，实现放同名文件，测试与实现同目录）。根 `test:unit` 里的 `bun test ./scripts` 会自动收到这个测试文件，**不需要改任何 script 字段**。

**Interfaces:**
- Consumes: 无（本 Task 是叶子）
- Produces: `canaryVersion({ base, runNumber, sha }: { base: string; runNumber: string; sha: string }): string`，从 `scripts/canary-version/index.ts` 导出。Task 2 会 `import { canaryVersion } from './canary-version'`（相对 `scripts/release.ts` 的路径）。非法输入抛 `Error`。

- [x] **Step 1: 写失败测试**

创建 `scripts/canary-version/canary-version.test.ts`：

```ts
import { expect, test } from 'bun:test';

import { canaryVersion } from './canary-version';

const sha = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const canary = canaryVersion({ base: '0.23.0', runNumber: '4213', sha });

test('canary 排在 base 之上、下一个正式版之下', () => {
  // 若 canary 排在 base 之下，`aio-proxy@canary` 会显得比 latest 旧，
  // update-notify 会反过来劝 canary 用户"升级"到已发布的 base。
  expect(Bun.semver.order(canary, '0.23.0')).toBe(1);
  expect(Bun.semver.order(canary, '0.23.1')).toBe(-1);
  expect(Bun.semver.order(canary, '0.24.0')).toBe(-1);
});

test('同一 base 下 run number 递增则版本递增', () => {
  const earlier = canaryVersion({ base: '0.23.0', runNumber: '9', sha });
  const later = canaryVersion({ base: '0.23.0', runNumber: '10', sha });
  expect(Bun.semver.order(later, earlier)).toBe(1);
});

test('sha 截断到 7 位并保留在版本里以便追溯', () => {
  expect(canary).toContain('a1b2c3d');
  expect(canary).not.toContain(sha);
});

test('数字标识符不带前导零', () => {
  // semver 规定数字型 prerelease 标识符不得有前导零，否则版本非法。
  expect(canaryVersion({ base: '0.23.0', runNumber: '007', sha })).toContain('.7.');
});

test('拒绝非法 base、run number 与 sha', () => {
  expect(() => canaryVersion({ base: '0.23', runNumber: '1', sha })).toThrow();
  expect(() => canaryVersion({ base: '0.23.0-canary.1.abc1234', runNumber: '1', sha })).toThrow();
  expect(() => canaryVersion({ base: '0.23.0', runNumber: '', sha })).toThrow();
  expect(() => canaryVersion({ base: '0.23.0', runNumber: 'abc', sha })).toThrow();
  expect(() => canaryVersion({ base: '0.23.0', runNumber: '1', sha: 'nothex' })).toThrow();
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `bun test scripts/canary-version`
Expected: FAIL — `Cannot find module './canary-version'`。

- [x] **Step 3: 写最小实现**

创建 `scripts/canary-version/canary-version.ts`：

```ts
const BASE = /^(\d+)\.(\d+)\.(\d+)$/;

/**
 * canary 版本 = base 的 patch + 1 加上 prerelease 后缀，因此排在 base 之上、
 * 下一个正式版之下：0.23.0 < 0.23.1-canary.4213.a1b2c3d < 0.23.1 < 0.24.0。
 * 用 base 自身做 prerelease（0.23.0-canary.*）会排在 0.23.0 之下，令 canary
 * 用户被 update-notify 劝回已发布版本。
 */
export function canaryVersion({
  base,
  runNumber,
  sha,
}: {
  base: string;
  runNumber: string;
  sha: string;
}): string {
  const parsed = BASE.exec(base);
  if (!parsed) throw new Error(`Invalid base version: ${base}`);
  if (!/^\d+$/.test(runNumber)) throw new Error(`Invalid run number: ${runNumber}`);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`Invalid commit sha: ${sha}`);

  const [, major, minor, patch] = parsed;
  // Number() 去掉前导零：semver 的数字型 prerelease 标识符不允许前导零。
  return `${major}.${minor}.${Number(patch) + 1}-canary.${Number(runNumber)}.${sha.slice(0, 7)}`;
}
```

创建 `scripts/canary-version/index.ts`：

```ts
export { canaryVersion } from './canary-version';
```

- [x] **Step 4: 跑测试确认通过**

Run: `bun test scripts/canary-version`
Expected: PASS，5 个 test 全绿。

- [x] **Step 5: 跑格式与 lint**

Run: `bun run check`
Expected: 通过。（若 oxfmt 报格式差异，跑 `bun run format` 后重跑。）

- [x] **Step 6: 提交**

```bash
git add scripts/canary-version
git commit -m "feat(scripts): add canary version calculation"
```

---

### Task 2: `scripts/release.ts` 的 `--canary` 模式

给发布脚本加一条 canary 分支：改写全部 manifest 的版本、publish 时带 `--tag canary`。其余链路（`bun update` + lock splice、build、`bun pm pack`、tarball 校验、已发布跳过）完全复用。

**Files:**
- Modify: `scripts/release.ts`（4 处：第 44 行附近、第 100-104 行、第 214-224 行的 publish 循环、顶部注释块）

**Interfaces:**
- Consumes: Task 1 的 `canaryVersion({ base, runNumber, sha }): string`，从 `scripts/canary-version` 导入。
- Produces: 命令行开关 `--canary`。Task 3 的 workflow 步骤会调用 `bun run scripts/release.ts --canary`。

**本 Task 无新增单测。** `release.ts` 是自顶向下的副作用脚本，import 即执行，无法单测；有分支逻辑的部分已在 Task 1 抽走并覆盖。验证靠 Step 6 的 `--dry-run` 实跑。

- [x] **Step 1: 加 `--canary` 开关与 import**

第 44 行现为：

```ts
const DRY_RUN = process.argv.includes('--dry-run');
```

改成：

```ts
const DRY_RUN = process.argv.includes('--dry-run');
// canary：对任意分支手动派发时，把全部包改成一个 prerelease 版本并发到 npm 的
// `canary` dist-tag。不写 changelog、不打 tag、不建 Release——见
// docs/superpowers/specs/2026-09-15-canary-release-design.md。
const CANARY = process.argv.includes('--canary');
```

同时在第 42 行 `import { $ } from 'bun';` 之后补一行本地 import（与既有 import 分组之间空一行）：

```ts
import { canaryVersion } from './canary-version';
```

- [x] **Step 2: 在锁步断言之后改写版本**

第 100-104 行现为：

```ts
const versions = new Set(allPackages.map((p) => p.json.version));
if (versions.size !== 1) {
  throw new Error(`Workspace versions are not in lockstep: ${[...versions].sort().join(', ')}`);
}
const version = [...versions][0]!;
```

改成（注意 `const` → `let`）：

```ts
const versions = new Set(allPackages.map((p) => p.json.version));
if (versions.size !== 1) {
  throw new Error(`Workspace versions are not in lockstep: ${[...versions].sort().join(', ')}`);
}
let version = [...versions][0]!;

// canary 版本必须在 `bun update` 之前写进 manifest：只有这样 bun.lock 的
// `workspaces` 块才会刷新成 canary 版本，`bun pm pack` 才能把 launcher 的
// `workspace:*` optionalDeps 和 plugin-sdk 的 `catalog:` 解析成 canary 版本。
// 私有包也要改——版本被编译进 CLI 二进制与各插件的 *_PLUGIN_VERSION，且上面的
// 锁步断言要求全仓库一致。
if (CANARY) {
  version = canaryVersion({
    base: version,
    runNumber: process.env['GITHUB_RUN_NUMBER'] ?? '',
    sha: process.env['GITHUB_SHA'] ?? '',
  });
  // 定点文本替换而非 JSON.stringify 重写整个文件：保留原格式不产生漂移。
  // 正则锚定顶层字段的两空格缩进（全部 manifest 均为该格式，嵌套字段缩进更深
  // 不会误命中）。未命中即抛，避免静默发出一个未改版本的包。
  for (const { path } of allPackages) {
    const raw = await Bun.file(path).text();
    const rewritten = raw.replace(/^ {2}"version": "[^"]+"/m, `  "version": "${version}"`);
    if (rewritten === raw) throw new Error(`Could not rewrite the version field in ${path}`);
    await Bun.write(path, rewritten);
  }
}
```

- [x] **Step 3: 加双向断言并给 publish 带上 dist-tag**

第 214-224 行的 publish 循环现为：

```ts
for (const { json } of publishable) {
  const name = json.name;
  const tgz = tarballs.get(name)!;
  const existing = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet();
  if (existing.exitCode === 0 && existing.text().trim() === version) {
    console.log(`\nSkipping ${name}@${version}: already published`);
    continue;
  }
  console.log(`\nPublishing ${tgz}`);
  await $`npm publish ${tgz} --provenance --access public`;
}
```

改成：

```ts
// `--tag canary` 是唯一阻止 canary 覆盖 `latest` 的东西，所以双向断言模式与
// 版本形态一致：canary 必须是 prerelease，正式发布必须不是。这条断言真正拦住的
// 是「传了 --canary 但版本改写被跳过」——那会把一个正常版本推上 latest。
if (CANARY !== version.includes('-canary.')) {
  throw new Error(`--canary=${CANARY} does not match version ${version}; refusing to publish`);
}
const distTag = CANARY ? ['--tag', 'canary'] : [];

for (const { json } of publishable) {
  const name = json.name;
  const tgz = tarballs.get(name)!;
  const existing = await $`npm view ${`${name}@${version}`} version`.nothrow().quiet();
  if (existing.exitCode === 0 && existing.text().trim() === version) {
    console.log(`\nSkipping ${name}@${version}: already published`);
    continue;
  }
  console.log(`\nPublishing ${tgz}`);
  await $`npm publish ${tgz} --provenance --access public ${distTag}`;
}
```

Bun shell 会把插值的数组展开成多个独立参数，空数组展开成零个参数，所以正式路径的命令行与改动前完全一致。

- [x] **Step 4: 更新顶部注释块**

第 24 行 `// Two public products publish at one lockstep version:` 之前插入一段，说明第二种运行模式：

```ts
// Two run modes:
//   - default (push to main, driven by changesets/action): publish the version the
//     merged Version PR wrote, to the `latest` dist-tag, and tag + Release it.
//   - `--canary` (workflow_dispatch on any branch): rewrite every manifest to
//     `X.Y.(Z+1)-canary.<run_number>.<sha7>` and publish to the `canary` dist-tag.
//     No changelog, no commit, no git tag, no GitHub Release, no Docker/Homebrew.
```

- [x] **Step 5: 确认文件仍在 500 行以内**

Run: `wc -l scripts/release.ts`
Expected: 约 310 行，明显低于 500。

- [x] **Step 6: `--dry-run` 实跑验证两条路径**

canary 路径（`--dry-run` 会在 publish 前退出，所以不会真发包；但它**会**改写工作区的 manifest 和 bun.lock，跑完必须还原）：

```bash
GITHUB_RUN_NUMBER=4213 GITHUB_SHA=a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0 \
  bun run scripts/release.ts --canary --dry-run
```

Expected: 首行打印 `Publishing 8 package(s) at v0.23.1-canary.4213.a1b2c3d  [dry-run]`（版本随当前锁步版本变化），列出 8 个包且 4 个 `cli-*` 标注 `(platform binary)`，8 个 pack 步骤全部成功、tarball 校验不抛错，最后打印 `[dry-run] Would publish 8 tarball(s)`。

若 tarball 校验抛 `stale workspace resolution`，说明版本改写没跑在 `bun update` 之前——回到 Step 2 检查插入位置。

跑完还原工作区：

```bash
git checkout -- packages npm bun.lock
git status --short   # 应只剩本 Task 对 scripts/release.ts 的改动
```

正式路径回归（确认没把 `--tag` 漏进默认路径）：

```bash
bun run scripts/release.ts --dry-run
git checkout -- packages npm bun.lock
```

Expected: 打印当前锁步版本（不含 `-canary.`），同样走完 8 个 pack 并在 dry-run 处停下。

- [x] **Step 7: 跑 lint 与格式**

Run: `bun run check && bun test ./scripts`
Expected: 全部通过。

- [x] **Step 8: 提交**

```bash
git add scripts/release.ts
git commit -m "feat(scripts): add canary publish mode to the release script"
```

---

### Task 3: workflow 手动派发入口与文档

给 `release.yml` 加 `workflow_dispatch` 触发，并按 `github.event_name` 把 canary 与正式发布分叉。同一个文件名是有意的：npm trusted publishing 按 org/repo + **workflow 文件名** 匹配，复用 `release.yml` 意味着 8 个包的 trusted publisher 配置一行不用改。

**Files:**
- Modify: `.github/workflows/release.yml`（第 16-22 行的 `on`/`concurrency`、第 44 行步骤、第 69 行步骤、第 69 行步骤之后新增一步）
- Modify: `CONTRIBUTING.md`（`## Changesets` 小节之后新增一节）

**Interfaces:**
- Consumes: Task 2 的 `bun run scripts/release.ts --canary`
- Produces: 无后续 Task 依赖。本 Task 完成即整个特性可用。

- [x] **Step 1: 加 `workflow_dispatch` 触发并按 ref 拆分并发组**

第 16-22 行现为：

```yaml
on:
  push:
    branches: [main]

concurrency:
  group: release
  cancel-in-progress: false
```

改成：

```yaml
on:
  push:
    branches: [main]
  # canary: dispatch this same workflow file from any branch. Reusing the file
  # name keeps npm OIDC working — trusted publishing matches on org/repo +
  # workflow filename, not on the git ref.
  workflow_dispatch:

concurrency:
  # Per-ref: a canary on a branch must not queue behind (or block) main's release.
  group: release-${{ github.ref }}
  cancel-in-progress: false
```

- [x] **Step 2: 把资产目录与 changesets 两步限定在 push 路径**

第 44 行的步骤加 `if`（注释保留不动）：

```yaml
      - name: Set release assets directory
        if: github.event_name == 'push'
        run: |
```

第 69-70 行的步骤同样加 `if`（放在 `id` 之后、`uses` 之前）：

```yaml
      - name: Changesets — maintain Version PR or publish
        id: changesets
        if: github.event_name == 'push'
        uses: changesets/action@8488615a623b1b9c987934bb89eae8af6a946ac1 # v2.1.1
```

这两个 `if` 顺带让下游全部自动跳过，**不需要再改任何东西**：

- `Upload platform tarballs and SHA256SUMS` 与 `docker`、`homebrew` 两个 job 都 gate 在 `steps.changesets.outputs.published == 'true'`；步骤被跳过时该 output 是空字符串，条件为假。
- `scripts/release.ts` 里暂存 GH 资产的 `if (assetDirectory)` 依赖 `RELEASE_ASSETS_DIR`，该变量只由上面那步写入 `$GITHUB_ENV`，canary 路径下不存在。
- 脚本尾部打 tag / 判 CHANGELOG / 写 NDJSON 的整块依赖 `CHANGESETS_OUTPUT`，该变量只由 changesets/action 注入。

- [x] **Step 3: 新增 canary 发布步骤**

在 Step 2 改过的 changesets 步骤之后（即原第 92 行 `NODE_AUTH_TOKEN` 那行之后、`# Changesets has already published npm...` 注释之前）插入：

```yaml
      # canary: the manual-dispatch counterpart of the step above. Publishes every
      # package at X.Y.(Z+1)-canary.<run_number>.<sha7> to the `canary` dist-tag and
      # stops there — no version commit, no tag, no Release, no Docker, no Homebrew.
      # See docs/superpowers/specs/2026-09-15-canary-release-design.md.
      - name: Publish canary
        if: github.event_name == 'workflow_dispatch'
        run: bun run scripts/release.ts --canary
        env:
          # Same fallback as the changesets step: OIDC is the intended path, the
          # token only matters while the NPM_TOKEN secret still exists.
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`GITHUB_RUN_NUMBER` 和 `GITHUB_SHA` 由 Actions runner 默认注入，不需要在 `env` 里声明。

- [x] **Step 4: 本地校验 workflow 语法**

Run: `bun -e "console.log(Bun.YAML.parse(await Bun.file('.github/workflows/release.yml').text()).on)"`
Expected: 打印出同时包含 `push` 与 `workflow_dispatch` 的对象（`workflow_dispatch` 的值为 `null`，因为没有 inputs）。

若本机装了 `actionlint`，再跑一次 `actionlint .github/workflows/release.yml`；没装则跳过，不要为此新增依赖。

- [x] **Step 5: 写文档**

`CONTRIBUTING.md` 中 `## Changesets` 小节的最后一行是：

```markdown
You do not run `changeset version` or publish by hand. On merge to `main`, CI maintains a standing `chore: release` Version PR that consumes the accumulated changesets; merging that PR is what cuts a release.
```

在这一行之后追加一节（下面是要写入 `CONTRIBUTING.md` 的原文，外层四反引号只是本计划的转义）：

````markdown
## Canary releases

For a change that is large or hard to verify locally, publish a canary build and install it for real. Run the **Release** workflow manually (Actions → Release → Run workflow) and pick your branch. It publishes every package at `X.Y.(Z+1)-canary.<run_number>.<sha7>` to the npm `canary` dist-tag. Nothing else moves: no version commit, no git tag, no GitHub Release, no Docker image, no Homebrew notification, and the `latest` dist-tag is untouched.

```bash
# try it once
bunx aio-proxy@canary

# switch an existing install over
aio-proxy upgrade --version 0.23.1-canary.4213.a1b2c3d

# go back to the stable line
aio-proxy upgrade --force
```

A canary sorts above the last release and below the next one, so canary users are not prompted to "upgrade" backwards, and the next real release takes over on its own. Canary versions stay on npm permanently — that is expected, the `canary` dist-tag is just a pointer to the most recent one.
````

- [x] **Step 6: 跑格式检查**

Run: `bun run check`
Expected: 通过。（oxfmt 不处理 `.md` / `.yml`，此步是确认没有误伤到其他文件。）

- [x] **Step 7: 提交**

```bash
git add .github/workflows/release.yml CONTRIBUTING.md
git commit -m "feat(ci): publish canary builds from a manual workflow dispatch"
```

- [ ] **Step 8: 合并后首次真跑（人工验收，不在自动化范围内）**

这个特性有一条只能在真实环境验证的假设：**OIDC trusted publishing 在 `workflow_dispatch` 下是否放行。** npm 文档指出 dispatch / call 场景校验的是「调用方 workflow 名」；直接派发 `release.yml` 自身时该名称即 `release.yml`，与现有配置一致——但只有跑一次才能确认。

改动合入 `main` 后（`workflow_dispatch` 必须先存在于默认分支才会出现在 Actions UI 里），派发一次并逐条核对：

1. `npm view aio-proxy dist-tags` → `latest` 仍是改动前的版本，新增 `canary` 指向 canary 版本。
2. `npm view aio-proxy@canary version` → 形如 `X.Y.Z-canary.<n>.<sha7>`。
3. 该次 run 的 `docker` 与 `homebrew` 两个 job 显示为 skipped。
4. 仓库没有新增 git tag，没有新增 GitHub Release，没有新增 commit。
5. `bunx aio-proxy@canary --version` 打印出 canary 版本（这同时验证了 4 个平台包发布正确、launcher 的 optionalDeps 解析到了精确版本）。

若第 1 步发现 `latest` 被移动，立刻 `npm dist-tag add aio-proxy@<上一个正式版> latest` 修复，再回查 Task 2 Step 3 的断言为何没拦住。
若 OIDC 被拒，确认 `NPM_TOKEN` secret 是否仍存在；若已删除，则需要在 npmjs.com 上给 8 个包各加一条 trusted publisher（每包上限 10 条，容量充足），或临时恢复 token。
