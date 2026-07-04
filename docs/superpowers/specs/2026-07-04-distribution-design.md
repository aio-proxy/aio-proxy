# aio-proxy 发布形态设计

日期：2026-07-04
状态：已评审（设计讨论见当日会话）

## 目标

用户通过 curl / brew / npm 任一渠道安装后开箱即用，全程不感知 Bun 的存在，不需要预装 bun 或 node（npm 渠道除外，走 npm 的用户天然有 node）。用户感知的唯一包名 / 命令名为 `aio-proxy`。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 产物形态 | Bun `--compile` 单文件自包含二进制（内嵌运行时 + 全部 JS + dashboard 静态资源） |
| Dashboard 静态资源 | 嵌入二进制（curl/brew 渠道只有一个可执行文件，没有存放共享资源包的地方，此项无可选空间） |
| 首发平台矩阵 | darwin-arm64 / darwin-x64 / linux-x64 / linux-arm64 |
| 主包名 | `aio-proxy`；平台包 `@aio-proxy/cli-<platform>-<arch>` |
| 版本管理 | changesets，`fixed` 组锁定所有包同版本 |
| 发布 | GitHub Actions；changesets 只管 version bump 与 changelog，publish 由自定义 workflow 接管 |

## 1. 产物与包结构

唯一「真产物」是每个平台的自包含二进制。三个渠道分发同一批产物：

```
aio-proxy                      ← 用户感知的 npm 主包，bin 为 launcher
@aio-proxy/cli-darwin-arm64    ← 平台包，内容即二进制，os/cpu 字段限定
@aio-proxy/cli-darwin-x64
@aio-proxy/cli-linux-x64
@aio-proxy/cli-linux-arm64
```

- **npm**：主包 `optionalDependencies` 以精确版本（`=x.y.z`，CI 发布时写入）挂四个平台包。launcher 是几行 node 脚本：`require.resolve` 定位当前平台的二进制，`execvp` 替换进程（Unix-only，Windows 已暂缓，无需 spawn 代理）。平台包在仓库中以模板目录形式存在（`npm/` 目录，esbuild 模式），CI 发布时填入二进制与版本号。
- **curl**：仓库根的 `install.sh`，探测 `uname -sm`，从 GitHub Releases 下载对应二进制到 `~/.local/bin/aio-proxy`。脚本始终指向 latest Release，无需逐版本更新。
- **brew**：formula 指向同一批 Release 产物。可与首发解耦，Release 流程跑通后再加。

所有现有 workspace 内部包（server / core / types / i18n / auth-flows / dashboard / infra）保持 `private: true`，被 bundle 进二进制，永不单独发布。

### catalog / workspace 协议与发布的关系

内部包大量使用 `catalog:` 与 `workspace:*`，但它们不发布，协议只在 monorepo 构建期解析，编译产物中不存在依赖声明。真正发布的 5 个包（主包 + 4 平台包）没有任何 catalog/workspace 引用。若未来需要单独发内部库，`bun publish` 会在打包时替换这些协议为实际版本号，路径不堵。

## 2. 代码改动

按影响排序：

1. **删除 `ensureDashboardStaticDir`**（`packages/cli/src/main.ts`）：`import.meta.resolve("@aio-proxy/dashboard")` 找包目录 + 运行时 spawn `bun run build` 的逻辑整体移除。这两个假设只在 monorepo 内成立。
2. **Dashboard 资源嵌入**：dashboard 构建后由 build script 扫描 dist 生成资产清单模块（`assets.gen.ts`，逐文件 `import ... with { type: "file" }`）。`bun build --compile` 时这些文件自动 embed。dist 文件名带 hash，清单必须构建期生成，不可手写。
3. **server 接口抽象**：`CreateServerOptions.dashboardStaticDir` 改为资产提供函数（形如 `dashboardAssets?: (path: string) => Response | Promise<Response> | null`，具体签名实现时定）。编译产物传嵌入资源版；dev 与测试传文件系统版；`serveStatic` 用法仅保留在 FS 版 provider 内部。
4. **CLI compile 管线**：`packages/cli` 增加 `build:binary` script，`bun build --compile --target=bun-<platform>` 直接从 `src/main.ts` 出四个平台产物。Bun 自行完成 bundle 与交叉编译，无需对应平台机器。
5. **`provider install` 不动**：`packages/core/src/npm.ts` 已用 `Bun.spawn([process.execPath, "add", ...], { env: { BUN_BE_BUN: "1" } })`——编译后的二进制可借 `BUN_BE_BUN=1` 变身 bun CLI 完成运行时包安装，装入 `~/.config/aio-proxy/cache` 后从磁盘绝对路径 dynamic import，整条链路在无 bun/node 的机器上成立。

## 3. 版本与发布流水线

- **changesets**：`fixed` 组锁定所有包（含 private 包，只 bump 不发布）。
- **双 workflow（标准 changesets 模式）**：
  1. *Version PR*：push main 时 changesets action 维护版本提升 PR，合并即触发发布。
  2. *Release*：矩阵编译四平台二进制 → 冒烟测试（`aio-proxy --version`；linux-arm64 用 QEMU，或降级为产物存在性检查）→ 创建 GitHub Release 并附二进制 → 填充平台包模板 → 按序 `npm publish`：**先四个平台包，后主包**，避免主包可装而平台包 404 的窗口。
- **不使用 changesets 默认 publish**：一是它对含 `catalog:` 的包会原样发出（虽然我们不发这些包，防御性避开），二是它无法表达平台包先于主包的发布顺序。

## 4. 暂缓项

- **Windows**：暂缓原因不止安装脚本——① Bun 编译的 exe 无签名时被 Defender/SmartScreen 误报拦截，需购买签名证书并接入 CI 签名流程；② Windows 无 `execve` 语义，launcher 需 spawn 子进程并代理 stdio/退出码/信号；③ 安装渠道需另建 PowerShell 脚本 + scoop/winget；④ CI 需 Windows runner 做冒烟测试。另有已知不一致待统一：provider 缓存目录写死 `~/.config/aio-proxy/cache`（`packages/core/src/npm.ts`），而配置文件路径 win32 下用 `APPDATA`。短期 Windows 用户走 WSL。
- **linux-musl**（Alpine 容器）与 **linux-x64-baseline**（无 AVX2 的老 CPU）变体：CI 矩阵留位，按需求加。
- **brew formula**：首个 Release 跑通后补。
