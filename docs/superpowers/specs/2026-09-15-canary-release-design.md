# Canary 发布通道设计

- 日期：2026-09-15
- 状态：设计已确认，进入实现计划阶段；尚未开始实现
- 基线：aio-proxy `bad8e645`，锁步版本 `0.23.0`

## 1. 决策与范围

为「改动大、本地不好验证」的变更提供一条预发布通道：在 GitHub UI 上对任意分支手动派发一次 workflow，把全部 8 个可发布包以 `X.Y.(Z+1)-canary.<run_number>.g<sha7>` 的版本发到 npm 的 `canary` dist-tag。使用者通过 `bunx aio-proxy@canary` 或 `aio-proxy upgrade --version <canary 版本>` 装上验证，验证完 `aio-proxy upgrade --force` 回到稳定线。

复用现有的 `.github/workflows/release.yml` 文件与 `scripts/release.ts` 脚本，不新建 workflow 文件。canary 路径与正式发布路径在同一个 job 内按 `github.event_name` 分叉。

**非目标**：Docker 镜像、Homebrew tap、GitHub Release 与其附件、changesets 的 pre 模式、canary 版本的自动清理、CLI 侧任何新增命令或 channel 概念。

## 2. 关键约束（已查实）

| 约束 | 结论 |
| --- | --- |
| npm trusted publishing 的匹配维度 | org/repo + workflow **文件名**（+ 可选 environment），**不锁 git ref**。每包最多 10 个 trusted publisher。 |
| 新建 `canary.yml` 的代价 | 需要在 npmjs.com 上给 8 个包逐个补 trusted publisher，否则只能退回 `NPM_TOKEN`。 |
| CLI 升级路径的包来源 | `packages/cli/src/upgrade/binary.ts` 的 `binaryTarballUrl` 直接拼 `<registry>/@aio-proxy/cli-<target>/-/cli-<target>-<version>.tgz`。canary 只要进 registry 就可安装，**不需要 GitHub Release 附件**。 |
| launcher 的平台包依赖 | `npm/aio-proxy/package.json` 的 `optionalDependencies` 是 `workspace:*`，pack 时解析成精确版本。canary 必须同时发布 4 个 `cli-*` 包。 |
| 锁步断言 | `scripts/release.ts` 要求全仓库（含私有包）版本一致。canary 改版本时必须改全部包。 |

因此选择复用 `release.yml` 文件名：OIDC 零配置改动。

## 3. 版本号方案

```
0.23.0  →  0.23.1-canary.4213.ga1b2c3d
```

base 取 npm 上已发布 `latest` 版本的 **patch + 1**，而不是分支 manifest 里的版本。手动派发允许任意分支，本地版本不一定与稳定线一致：落后的分支（本地 0.23.0、`latest` 已是 0.23.1）会算出排在用户已装版本之下的 canary，令 `upgrade --version` 成为空操作；Version PR 分支（本地 0.24.0）会算出 0.24.1-canary，把待发布的 0.24.0 挡在下面。锚定 `latest` 两种情形都成立。

不用 `0.23.0-canary.x`：prerelease 排在同版本正式版**之下**，`aio-proxy@canary` 会显得比 `latest` 旧，`update-notify`（`packages/cli/src/update-notify/update-notify.ts` 用 `Bun.semver.order`）会反过来提示 canary 用户"升级"到已发布的 0.23.0。patch+1 后满足：

```
0.23.0  <  0.23.1-canary.*  <  0.23.1  <  0.24.0
```

canary 用户在下一个正式版发布前不会被提示，正式版一出则自然接管。若 pending 的 Version PR 会把版本推到 0.24.0，上述不等式同样成立。

`run_number` 是纯数字标识符，semver 按数值比较，保证同一分支先后两次 canary 有确定顺序；`sha7` 用于追溯来源 commit。

已评估并否决 `changeset version --snapshot canary`：它要求存在 pending changeset 才产出版本，且 base 固定为 `0.0.0`，丢失发布线信息。

## 4. workflow 改动（`.github/workflows/release.yml`）

```yaml
on:
  push:
    branches: [main]
  workflow_dispatch:          # canary：在 UI 中选择任意分支

concurrency:
  # 分支 canary 不与 main 的正式发布互相排队；但所有 canary 派发共用一个组——
  # 它们都移动同一个全局 `canary` dist-tag，并发会让慢的那次把 tag 拉回旧版本。
  group: release-${{ github.event_name == 'workflow_dispatch' && 'canary' || github.ref }}
  cancel-in-progress: false
```

1. `Set release assets directory` 步骤加 `if: github.event_name == 'push'`。canary 路径下 `RELEASE_ASSETS_DIR` 不存在，`release.ts` 中 `if (assetDirectory)` 的 GH 资产暂存块自然跳过——**此处不需要改代码**。
2. 现有 `Changesets — maintain Version PR or publish` 步骤加 `if: github.event_name == 'push'`。
3. 新增步骤，`if: github.event_name == 'workflow_dispatch'`，执行 `bun run scripts/release.ts --canary`，env 与 changesets 步骤一致（`NPM_TOKEN` / `NODE_AUTH_TOKEN`，作为 OIDC 失败时的兜底）。
4. `docker` 与 `homebrew` 两个 job **不改动**：二者 gate 在 `needs.release.outputs.published == 'true'`，canary 路径下 changesets 步骤被跳过、该 output 为空字符串，job 自动跳过。
5. 同理，`Upload platform tarballs and SHA256SUMS` 步骤的 `if: steps.changesets.outputs.published == 'true'` 在 canary 路径下为假，无需改动。

job 级 `permissions` 保持不变；canary 路径用不到 `contents: write` / `pull-requests: write`，但为收窄权限而拆 job 不值得。

## 5. `scripts/release.ts` 改动

新增 `const CANARY = process.argv.includes('--canary');`。

在锁步断言算出 `version` 之后、`bun update` + lock splice 之前插入版本改写：

```ts
if (CANARY) {
  version = canaryVersion(version, Bun.env.GITHUB_RUN_NUMBER, Bun.env.GITHUB_SHA);
  // 私有包也要改：版本被编译进 CLI 二进制与各插件的 *_PLUGIN_VERSION
  for (const { path } of allPackages) { /* 定点文本替换 */ }
}
```

**顺序是关键。** 必须写在 `bun update` 之前，lock 的 `workspaces` 块才会刷新成 canary 版本，`bun pm pack` 才能把 launcher 的 `workspace:*` optionalDeps 和 plugin-sdk 的 `catalog:` 解析成 canary 版本。脚本中已有的 tarball 校验（sibling range 不等于 version 即抛）顺带守住这条链路。

版本改写用定点文本替换而非 `JSON.stringify` 重写整个文件：正则 `/^ {2}"version": "[^"]+"/m` 锚定顶层字段的两空格缩进（所有 manifest 均为该格式，嵌套字段缩进更深不会误命中），保留原有格式不产生漂移；某个文件替换未命中时立即抛错，避免静默发出未改版本的包。

publish 行按模式追加 dist-tag：正式发布沿用现状（不带 `--tag`，即 `latest`），canary 追加 `--tag canary`。

```ts
npm publish <tgz> --provenance --access public [--tag canary]
```

`--tag canary` 是唯一承重的 flag，漏掉就会把 `latest` 打歪。因此 canary 模式下在进入 publish 循环前断言待用的 dist-tag 为非空字符串，由断言而非记忆保证。

尾部的 git tag / CHANGELOG 判定 / NDJSON 输出整块依赖 `if (outputPath)`（`CHANGESETS_OUTPUT` 仅由 changesets/action 注入），canary 路径下自然跳过，**零改动**。

改动后 `release.ts` 约 300 行，仍在 500 行限制内。

## 6. 版本计算函数与测试

`canaryVersion` 抽为独立纯函数，按仓库同名目录约定放置：

```
scripts/canary-version/
├── index.ts
├── canary-version.ts
└── canary-version.test.ts
```

已被根 `test:unit` 的 `bun test ./scripts` 覆盖，无需改动 script。

测试只覆盖真正会坏的行为，不复述实现字面量：

- canary 版本 `Bun.semver.order` 排在 base 之上；
- 排在下一个 patch 正式版与下一个 minor 正式版之下；
- run_number 递增时版本单调递增；
- base 非法（非 `x.y.z`）时抛错。

`release.ts` 主体是自顶向下的副作用脚本，本次不改变其可测性。

## 7. 使用方式

```bash
# 一次性试
bunx aio-proxy@canary

# 已安装用户切过去（binary 与 npm 两种安装方式都从 registry 拉 tgz）
aio-proxy upgrade --version 0.23.1-canary.4213.ga1b2c3d

# 回到稳定线
aio-proxy upgrade --force
```

`upgrade --version` 与 `binaryTarballUrl` 均为现成能力。唯一必要的 CLI 改动是版本解析：`--version` 输出原先用 `/(\d+\.\d+\.\d+)/` 提取，会丢掉 prerelease 后缀，令 binary 安装的装后校验拿 `0.23.1` 去比请求的 `0.23.1-canary.*`，判定失败并回滚刚装好的二进制。现由 `packages/cli/src/upgrade/version-output.ts` 保留后缀。

Homebrew 安装装不了 canary：tap 只有正式版 bottle，且 `runPackageManagerUpgrade` 对 brew 传的是 formula 而非版本，`--version` 被忽略。文档中已注明改用 `bunx` 或非 Homebrew 安装验证。

## 8. 风险与取舍

1. **`latest` 被打歪**是本方案唯一的严重故障模式。缓解：canary 模式下断言 `--canary` 与版本形态（是否 prerelease）双向一致。
2. **派发跑的是分支自己的 `scripts/release.ts`，且带着发布凭据。** 有写权限的人可以在分支上改掉这个脚本、绕过 main 的评审把代码推上 `latest`——即「写权限 == 发布权限」。仓库内的代码无法防住这一点（防的对象正是代码本身），真正的收窄手段是给 canary 路径挂一个带必需审批人的 protected environment，属于仓库设置，需人工决定。已在 CONTRIBUTING 中写明这条信任边界。
3. **OIDC 在 `workflow_dispatch` 下能否通过，只有真跑一次才能确认。** npm 文档指出 dispatch / call 场景校验的是"调用方 workflow 名"；直接派发 `release.yml` 自身时该名称即 `release.yml`，与现有 trusted publisher 配置一致。失败时的退路是 `NPM_TOKEN`（secret 若仍存在则直接生效），不改变方案形状。首次 canary 应视为对这条假设的验证。
4. **canary 版本永久留在 npm**（72 小时后不可 unpublish）。不做清理自动化；`npm dist-tag` 仅是指针，版本本身长期堆积可接受。
5. **每次 canary 消耗一个 macOS runner 跑 4 target 全量编译**，成本约等于一次正式发布。这由 launcher optionalDeps 锁精确版本决定，无法省略。macOS runner 的必要性见 `release.yml` 顶部注释（darwin 二进制需与 `codesign` 同机）。
6. 不需要 changeset：属于发布工具链改动，不改变已发布产品的行为。
