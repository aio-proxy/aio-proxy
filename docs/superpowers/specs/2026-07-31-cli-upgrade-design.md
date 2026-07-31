# CLI upgrade 命令设计

日期：2026-07-31
状态：草案

## 目标

新增 `aio-proxy upgrade`，让用户用一条命令升级到最新版，无需记住自己当初用哪种方式安装的。命令自动识别当前二进制归属的安装渠道，并调用该渠道对应的升级方式。

```sh
aio-proxy upgrade            # 升级到最新版
aio-proxy upgrade --check    # 只检查是否有新版本，不安装
aio-proxy upgrade --force    # 已是最新也强制重装当前最新版
```

## 现状

- 唯一「真产物」是 Bun `--compile` 单文件自包含二进制（见 `2026-07-04-distribution-design.md`）。三个渠道分发同一批产物：
  - **npm**：主包 `aio-proxy`，`optionalDependencies` 以精确版本挂四个平台包 `@aio-proxy/cli-<platform>-<arch>`。用户可用 npm / bun / pnpm 全局安装。
  - **brew**：独立 tap `aio-proxy/homebrew-tap`，`brew install aio-proxy/tap/aio-proxy`，Formula 复用 npm 平台 tarball（见 `2026-07-30-homebrew-tap-design.md`）。
  - **curl**：仓库根 `install.sh`，从 GitHub Release 下载二进制到 `~/.local/bin/aio-proxy`。
- 版本号在编译期确定：`main.ts` 通过 `import packageJson` 读取，release 流程在编译前把所有包 bump 到同一版本。因此 `aio-proxy --version` 的输出可信，无需 `--define`。
- 主包 `optionalDependencies` 是精确版本，所以 `npm i -g aio-proxy@<v>` 会连带拉到匹配的平台二进制，**不存在** oh-my-pi 那种平台包版本漂移问题，升级命令无需显式 lockstep 安装平台包。

### 阻塞依赖（必须在文档中如实记录）

- **GitHub Release 目前不附带二进制**：`scripts/release.ts` 的 `gh release create` 未传任何 asset 参数，`packages/cli/scripts/build-binary.ts` 只把二进制写进 `npm/cli-*/bin/`。因此 `releases/latest/download/aio-proxy-<os>-<arch>` 现在就是 404 —— 这同时意味着 `install.sh`（curl 渠道）今天也是坏的。**binary 渠道的升级依赖 release 上传二进制资产这一前置条件**，本设计一并把 binary 升级路径实现好，等资产就位即可用；在资产缺失期间该路径会以明确的「请用 install.sh 重装」提示失败。
- **仓库标识不一致**：`install.sh` 写的是 `baranwang/aio-proxy`，而 `package.json`、README、brew tap 组织都是 `aio-proxy`。binary 下载 URL 统一固定为 `aio-proxy/aio-proxy`；`install.sh` 的 `baranwang` 是遗留 bug，属于本设计之外的单独修复项。

## 决策

### 渠道识别：反向查找（对齐 oh-my-pi）

不猜测、不读环境变量，而是反查当前 `aio-proxy` 落在哪个包管理器的全局 bin 目录里：

1. 用 `Bun.which('aio-proxy')` 解析 PATH 中实际执行的路径，**不用** `process.execPath`（编译后的二进制 execPath 指向自身，npm launcher 场景下又指向 node，均不可靠）。
2. 依次取各包管理器的全局 bin 目录，判断解析到的路径是否落在其中：
   - brew：`brew --prefix aio-proxy/tap/aio-proxy`（失败则回退裸名 `aio-proxy`）拼 `/bin`
   - bun：`bun pm bin -g`
   - npm：`npm prefix -g`（Unix 再拼 `/bin`）
   - pnpm：`pnpm bin -g`
3. 路径归属判断用「词法 + realpath」双重判定：先 `path.relative` 词法判断，再对文件与其父目录做 `realpath` 兜底，处理 Homebrew 的 `bin/aio-proxy -> Cellar/.../bin/aio-proxy` 符号链接。
4. 优先级 **brew → bun → npm → pnpm → binary**。都不命中则判定为 binary（curl 安装的裸二进制）。

识别与升级动作解耦：识别产出 `UpgradeTarget`（`{ method }` 或 `{ method: 'binary', path }`），升级逻辑只消费它，便于单测。

### 目标版本来源：npm registry

查 `https://registry.npmjs.org/aio-proxy/latest` 拿最新版，而非 GitHub API —— 避免未认证 GitHub 速率限制。官方 registry origin 固定为常量，并在 bun/npm/pnpm 安装步骤用 `--registry` 一并钉住，防止用户的镜像源（公司代理 / 淘宝源）落后于上游导致「版本存在但镜像还没同步」的安装失败。

### 各渠道升级动作

| 渠道 | 升级命令 |
| --- | --- |
| bun | `bun add -g --registry=<official> aio-proxy@<v>` |
| npm | `npm i -g --registry=<official> aio-proxy@<v>` |
| pnpm | `pnpm add -g aio-proxy@<v>` |
| brew | `brew update && brew upgrade aio-proxy/tap/aio-proxy`（`--force` 时改 `brew reinstall`） |
| binary | 下载 GitHub Release 资产 → 原子替换 → 校验 → 失败回滚 |

binary 路径细节（对齐 oh-my-pi 的健壮实现）：

- 下载 `https://github.com/aio-proxy/aio-proxy/releases/download/v<v>/aio-proxy-<os>-<arch>` 到 `<path>.new`。
- 把现有二进制重命名到唯一备份名 `<path>.<timestamp>.<pid>.bak`（唯一名避免覆盖可能仍被占用的旧备份），再把 `.new` 重命名到目标路径。
- 运行新二进制 `--version` 校验版本；不匹配则回滚备份并报错。
- 成功后清理本次备份，并顺带清扫历史遗留的 `*.bak`。

### 升级后处理正在运行的守护进程

编译型二进制被替换后，正在运行的 `aio-proxy` 进程仍是旧版。升级成功后：

- 用 control-plane 的 `probeHealth` 探测本机是否有守护进程在跑。
- 若在跑：打印明确提示，告知需要重启才能生效；若检测到已安装托管服务（launchd/systemd），提示 `aio-proxy service restart`。
- 默认只提示不自动重启（避免升级命令产生意料外的服务中断）；提供 `--restart` 显式开启升级后自动重启。

### 命令行为与选项

- `--check`：只比较版本并输出结果，不执行安装。
- `--force`：即使已是最新，也强制重装当前最新版（brew 走 reinstall）。
- `--registry <url>`：覆盖默认官方 registry（与 `plugin add` 的选项风格一致）。
- `--restart`：升级成功后自动重启已安装的托管服务。
- 全部用户可见文案走 `@aio-proxy/i18n` 的 `m.cli_upgrade_*`，en 与 zh-Hans 同步新增。

### 代码结构（遵循 300 行上限与按职责拆分）

```
packages/cli/src/upgrade/
├── index.ts        # 仅导出
├── upgrade.ts      # runUpgradeCommand 编排 + 版本比较
├── detect.ts       # 反向查找识别 UpgradeTarget
├── methods.ts      # 各渠道 arg 构造 + 执行
├── binary.ts       # 下载 / 原子替换 / 回滚 / 备份清扫
└── upgrade.test.ts # 识别归属、arg 构造、版本比较
```

## 失败处理

- 版本检查失败（网络 / registry 不可达）：报错并以非零码退出，不触发任何安装。
- 已是最新且无 `--force`：打印「已是最新」，正常退出。
- 包管理器命令非零退出：透传退出码并给出该渠道的失败信息。
- binary 替换失败：回滚到备份，保留原可用二进制，报错。
- binary 资产缺失（当前 404 状态）：明确提示改用 `install.sh` 重装，而不是留下半损坏的二进制。
- 无法解析 `aio-proxy` 在 PATH 中的路径：报错说明无法定位安装位置。

## 验收

- 在 bun / npm / pnpm / brew 全局安装各自场景下，`upgrade` 能正确识别渠道并调用对应升级命令。
- `--check` 不产生任何写操作，只输出版本比较结果。
- binary 路径在资产就位后可完成「下载→替换→校验」；校验失败可回滚到原二进制。
- 单元测试覆盖：路径归属判定（含 realpath 软链场景）、各渠道 arg 构造、semver 比较、binary 回滚逻辑。
- `bun run preflight` 通过。

## 非目标

- 不修复 `install.sh` 的 `baranwang` 遗留标识，也不在本次补齐 GitHub Release 二进制资产（仅记录为 binary 渠道的前置依赖）。
- 不支持 Windows、musl、额外 CPU 变体（与现有分发矩阵一致）。
- 不引入自动后台升级 / 定时检查；升级只在用户显式执行时发生。
- 不改动 npm / brew / curl 的安装行为本身。
