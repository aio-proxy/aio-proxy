# 发包流程迁移到 Changesets 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前手写、由 conventional-commit 驱动的发包流程迁移到 Changesets（目标 v3）。Changesets 接管「版本决策 + changelog + 私有包锁步」；发布仍由自定义 `scripts/release.ts` 用 `bun pm pack` + `npm publish`（OIDC/provenance）完成；tag 与 GitHub Release 交回 `changesets/action`。

**Non-goals:** 不改产物内容与包结构、不放弃 lockstep 同版本、不改 commit 规范（commitlint 保留）、不引入 brew。

设计参考：`docs/superpowers/specs/2026-07-04-distribution-design.md`（第 18-19、55-59 行已预先规划「changesets fixed 组 + 双阶段 + 不使用 changeset publish」）。

## 决定性约束（迁移后必须守住，v2/v3 都不变）

- **OIDC 可信发布必须走 `npm publish`**（`bun publish` 不支持，bun#22423）。
- **tarball 必须由 `bun pm pack` 产出**（`npm publish` 不认识 `catalog:`/`workspace:*`）。因此**不用 `changeset publish` / `changeset pack`**——后者走 npm/pnpm/yarn 的 pack，同样不解析 bun 的 `catalog:`。
- **发布顺序保留串行**：`npm/cli-*` 4 个平台包先于 launcher `aio-proxy` 发布（launcher 用 `optionalDependencies` 引用它们；平台包未上架时 npm 会静默跳过 optional dep 且不自动补装）。来自 npm 运行时语义，与 changeset 无关。保留现有串行 for 循环 + sort，零成本，不追求并行。
- **Lockstep 同版本**：全部包（含私有 `cli` / `plugin-*`）bump 到同一版本；私有包版本会被编译/读进产物（`packages/cli/src/main.ts` 读 package.json version、各插件导出 `*_PLUGIN_VERSION`）。
- **断点续发**：保留脚本按 `npm view` 跳过已发布版本的 resume 逻辑。
- **commit 规范不变**：保留 commitlint、lefthook `commit-msg` hook、`.commitlintrc.json`。

## 版本选型：Changesets v3（精确 pin 预发布）

- 目标 `@changesets/cli@3.0.0-next.10`（当前 `next`；`latest` 仍是 2.31.1，作者称 v3「almost ready」）。**精确 pin，不用 `^`/`next` 浮动**：预发布 API 可能在 patch 变动；转正 `latest` 后再放宽到 `^3`。
- 我们对 changeset 的用面极窄——只用 `version`（bump + changelog）与 `status`（CI 校验），**不碰** v3 变动最多的 publish-flow 命令，因此 v3 bug 对我们的爆炸半径仅落在最成熟的 version/status。
- v3 硬门槛我们已满足：ESM-only（本仓库已 `"type": "module"`）、Node `^22.11 || ^24 || >=26`（CI 已用 Node 26）。
- **v3 净红利**：config 新增 `format` 项且原生支持 `"oxfmt"`——生成的 CHANGELOG / 改写的 package.json 直接用 oxfmt 格式化，消除发布提交的格式漂移。
- **v3 需对齐项**：私有包默认不再 version，必须显式 `privatePackages`（我们本就要写，非额外成本）；`.changeset/` 会忽略 `AGENTS.md`/`CLAUDE.md`/`GEMINI.md`（对本仓库更安全）。
- `changesets/action` 使用其 v3-next 线（`2.0.0-next.3`，已依赖 v3 系列包）。

## 目标流程（单 workflow，`push: main` + `has-changesets` 分流）

`changesets/action` 在 `push: main` 上按 `has-changesets` 输出自动分流：

1. **有 changeset → 维护 Version PR**：把堆积的 `.changeset/*.md` 消费进一个常驻 Version PR（锁步 bump 全部包 + 更新 CHANGELOG，`format: oxfmt`，标题 `chore: release`）。每次带 changeset 的 PR 合入 main 都会刷新该 PR，使其始终反映「现在发版会是什么版本 / 含哪些变更」。
2. **无 changeset（说明 Version PR 刚被合并）→ 发布**：action 调用 `with.publish` = `scripts/release.ts` 完成 pack + publish。

**发版动作 = 手动合并 Version PR。** 合并把 bump 落到 main，下一次 `push` 因无 changeset 走发布分支。

### action ↔ 自定义脚本的契约（方案 A）

- action 执行 publish-script 前会**无条件**生成 `CHANGESETS_OUTPUT=<临时 ndjson 路径>` 并注入脚本环境（`changesets/action` `run.ts` runPublish：第 171-197 行）。
- 我们的 `npm publish` 不经过 changeset CLI，不会自动写该文件；因此 `release.ts` **每成功发布一个包，就往 `process.env.CHANGESETS_OUTPUT` 追加一行 NDJSON**：`{"type":"git-tag","tag":"<pkg>@<version>","packageName":"<pkg>"}`。
- action 发布后读取该文件 → **打 git tag** + 从各包 `CHANGELOG.md` 抽当前版本段 → **建 GitHub Release**（`createRelease` 读 CHANGELOG，第 34-63 行）。
- 因此 `release.ts` **删除** 自身的 `git tag` / `gh release create` / `git commit`（版本提交由 Version PR 合并完成）。若脚本不 emit NDJSON，action 会 warning 且不建 tag/Release（publish 仍算成功）——即无声半发布，须避免。

## Task 1: 引入 Changesets 配置与依赖

- [ ] 根 `package.json` `devDependencies` 加 `@changesets/cli`（精确 pin `3.0.0-next.10`）与 `@changesets/changelog-github`（精确 pin `1.0.0-next.8`，v3 配套线）；仅根安装，不进 catalog。
- [ ] `bun install`；确认 lockfile 更新、`bunx changeset --help` 可用、Node/引擎满足 v3。
- [ ] 新增 `.changeset/config.json`：
  - `fixed: [["@aio-proxy/*", "aio-proxy"]]`（glob 锁步；无 scope 的 `aio-proxy` 必须显式列入）。
  - `privatePackages: { version: true, tag: false }`（私有包 bump 但不 tag/发布）。
  - `access: "public"`、`baseBranch: "main"`、`commit: false`（默认；提交交给 action）。
  - `format: "oxfmt"`。
  - `changelog: ["@changesets/changelog-github", { "repo": "aio-proxy/aio-proxy" }]`（带 PR/commit/作者链接；需 `GITHUB_TOKEN`）。
- [ ] 新增 `.changeset/README.md`（贡献者指引）。
- [ ] 用临时 changeset 干跑 `bunx changeset version`（改后还原）验证：全部包（含 5 个私有 + 无 scope 的 `aio-proxy`）锁步 bump，CHANGELOG 用 oxfmt 格式化。
- **Verify:** `fixed` 覆盖全部 20 个包；私有包版本被改写；无 external drift。

## Task 2: 瘦身并改造 scripts/release.ts

- [ ] 删除 conventional-commit 版本决策：`detectBump`、`Bumper`、`ConventionalChangelog`、`changelogSection`、highest+`semver.inc`、`--bump=`。
- [ ] 删除脚本内 `git commit` / `git tag` / `gh release create`（改由 Version PR 合并 + action 承担）。
- [ ] 版本号来源：读 `changeset version` 已写好的 package.json（fixed 保证一致）；备选用 `@changesets/assemble-release-plan` 预演（注意 v3 `default` export 被弃用，用 named export）。
- [ ] **新增 NDJSON emit**：每个包 `npm publish` 成功后，向 `process.env.CHANGESETS_OUTPUT` 追加 `{"type":"git-tag","tag":"<pkg>@<version>","packageName":"<pkg>"}`；`CHANGESETS_OUTPUT` 缺失时降级为纯发布（本地 `--dry-run`）。
- [ ] 原样保留：`bun update` + lock splice、`bun run build` + `--filter @aio-proxy/cli build:binary`、`bun pm pack`、tarball 内 `catalog:`/`workspace:` 与 sibling 版本校验、按序 `npm publish --provenance --access public`（平台包先/launcher 后）、`npm view` 跳过已发布。
- [ ] 保留 `--dry-run`（现无外部 changelog 依赖，应更易本地跑到 pack 阶段且无残留 diff）。
- **Verify:** 本地（临时 changeset + 已 `changeset version`）`bun run scripts/release.ts --dry-run` 跑到 pack 校验通过、无残留 diff；模拟设 `CHANGESETS_OUTPUT` 时能写出预期 NDJSON。

## Task 3: 单 workflow（Version PR + Release 分流）

- [ ] 改造 `.github/workflows/release.yml`：
  - 触发 `on: push: branches: [main]`（去掉旧 `workflow_dispatch` 的 `bump` choice）。
  - 单 job 用 `changesets/action`（v3-next 线）：`version` 默认 `changeset version`；`publish: bun run scripts/release.ts`；`commit-message: "chore: release"`、`pr-title: "chore: release"`、`setup-git-user: true`。
  - `create-github-releases: true`、`push-git-tags: true`（消费我们 emit 的 NDJSON）。
- [ ] env 沿用现状：`GITHUB_TOKEN`（开 PR / 建 Release / `changelog-github` 生成链接，需 `read:user`+`repo:status`；Actions 内置 token 通常足够）、bootstrap `NODE_AUTH_TOKEN=NPM_TOKEN`（首发）、`id-token: write`（OIDC）、node 26、bun 1.3.14。
- [ ] `permissions`：`contents: write` + `pull-requests: write` + `id-token: write`。
- [ ] 保留 `concurrency: release`。
- **Verify:** YAML 通过 lint；分支/fork 演练：无 changeset 不误发、有 changeset 维护 PR、合并 PR 后走 publish 分支并按序发布 + 建 tag/Release。

## Task 4: 清理旧依赖与文档

- [ ] 移除仅服务旧流程的 devDependencies：`conventional-changelog`、`conventional-recommended-bump`；评估 `semver` / `@types/semver`（脚本若仍比较版本则保留）。
- [ ] **保留** `@commitlint/*`、`lefthook`、`.commitlintrc.json`。
- [ ] `CONTRIBUTING.md`：新增「改动需附 `bunx changeset`」；保留 Conventional Commits 段（二者共存）。
- [ ] changelog 生成器用 `@changesets/changelog-github`（v3 配套 `1.0.0-next.8`），配置 `{ "repo": "aio-proxy/aio-proxy" }`；生成的 CHANGELOG 带 PR/commit/作者链接，GitHub Release notes 随之继承这些链接。
- [ ] 同步 `docs/superpowers/specs/2026-07-04-distribution-design.md` 若与实现有出入。
- **Verify:** `rg 'conventional-|recommended-bump' package.json scripts` 无残留；commitlint 仍在 hook 生效。

## Task 5: 端到端验证

- [ ] 本地：`bun changeset` → `bunx changeset version` → 确认锁步 bump + CHANGELOG(oxfmt) → `bun run scripts/release.ts --dry-run` 跑到 pack 校验通过。
- [ ] `bun run preflight` 通过。
- [ ] 校验 tarball：`aio-proxy` 与 4 平台包无 `catalog:`/`workspace:`；launcher `optionalDependencies` 指向本次版本。
- [ ] （可选）fork/staging 真实跑一遍：功能 PR(带 changeset) 合并 → Version PR 刷新 → 合并 Version PR → 平台包先发/launcher 后发 → NDJSON → tag + GitHub Release。
- **Verify:** 全链路通过；产物版本一致、发布顺序正确、Release notes 来自 CHANGELOG。

## Risks / Open Questions

- **R1 v3 预发布**：CLI pin `3.0.0-next.10`、`changelog-github` pin `1.0.0-next.8`（须与 CLI 同走 v3 线，勿混用稳定版 0.7.0）；转正 `latest` 后一并升级到 `^3` / `^1` 并复测。
- **R2 lock splice 假设**：`changeset version` 不改 lockfile（已确认 apply-release-plan 不触碰 lockfile），故保留 `bun update` + `"patchedDependencies"` marker splice；回归确认 marker 仍在。
- **R3 首发 bootstrap**：OIDC 无法为尚不存在的包配置 trusted publisher，首发仍需 `NPM_TOKEN`；勿在迁移中误删该逻辑。
- **R4 NDJSON 契约**：`release.ts` 必须在每个成功 publish 后 emit 一行，否则 action 不建 tag/Release（无声半发布）。
- **R5 后续增强（v3 转正后评估，不进本期）**：验证 `changeset publish --from-pack-dir` 能否透传 `--provenance` + OIDC；若能，可考虑进一步简化脚本。
