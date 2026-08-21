# Agent Provider Integrations 设计

- 日期：2026-08-18
- 状态：已批准

## 摘要

aio-proxy 的产品承诺是：**Provider 配置一次，可在多个 Agent 中使用**。

Agent 接入不是一套新的 Provider 配置，也不要求把上游密钥复制给每个 Agent。Agent 只连接 aio-proxy，由 aio-proxy 继续负责模型目录、协议转换、Provider weight、session affinity 和失败回退。插件、配置文件和 Codex 的 `client_version` 特例都是实现方式，不是产品定义。

首期新增三个显式接入目标：

- OpenCode；
- 官方 Pi；
- OMP（oh-my-pi）。

官方 Pi 与 OMP 在产品上属于一个 **Pi-family integration**：共用一个包和业务核心，但各自使用一个很薄的宿主入口。OpenCode 首期只交付稳定的 V1 `server` 插件入口。已验证的 V2 `effect` 使用独立 credential store、loader 和 lifecycle，不是零风险的附加导出，因此延期为后续独立增量，不进入本期实现或验收。Codex 只作为“Agent 接入不一定依赖插件”的现有案例，本期不进入 `agent configure` 产品面。

用户通过 aio-proxy CLI 安装受管插件，再通过 Agent 原生登录入口完成 Device Authorization。每次安装拥有独立、可撤销的 Agent 身份；同一 access token 同时访问受保护模型目录和推理 API。不存在硬编码共享 SK，也不根据可伪造的 header 或 loopback 来源豁免鉴权。

## 产品目标

- 用户不复制上游 Provider 凭据，即可在 OpenCode、官方 Pi 和 OMP 使用 aio-proxy 当前启用的模型。
- 三个目标使用一致的 `list / configure / remove` 心智，同时保留各宿主原生的登录和凭据存储。
- 模型目录在登录后加载，启动时刷新，并每 5 分钟持续刷新。
- 每个 Agent 安装拥有稳定 installation ID、短期 access token、轮换 refresh token 和精确撤销能力。
- aio-proxy 升级时自动更新所有带 ownership marker 的受管插件。
- 保持当前匿名本地调用和 `server.apiKeys` 行为；Agent 身份作为并行认证方式加入，不把全局强制鉴权塞进本需求。
- 为未来增加 Agent 留下明确边界，但首期不设计通用 Agent SDK。

## 非目标

- 不安装、升级、启动或停止 OpenCode、Pi、OMP。
- 不管理项目级 Agent 配置；首期只安装用户全局插件。
- 不把 aio-proxy 做成通用 OAuth/OIDC Authorization Server。
- 不引入 Better Auth、用户账户、consent、动态 client registration 或 scope 引擎。
- 不提供 Agent 身份管理 Dashboard；只提供 Device Code 批准/拒绝页。
- 不统一或修复各 Agent 的 logout UI。OpenCode V2 不是首期验收项，也不承诺其当前未完整迁移的 logout 体验。
- 不把 Codex 纳入本期 `agent configure`。
- 不支持多个命名 aio-proxy 实例、远程实例发现或团队配置分发。
- 不提供离线 revoke、离线 SQLite mutation 或跳过撤销的 force-remove；server 无法启动时先修复配置并启动 control plane。
- 不发布第三方 Agent adapter SDK，也不允许 aio-proxy runtime plugin 注入 Agent 安装逻辑。
- 不为尚不存在的 catalog schema 2 预建兼容层。

## 术语

- **Agent target**：`opencode`、`pi` 或 `omp`。
- **Agent integration**：安装在宿主中的 aio-proxy Provider 插件及其受管元数据。
- **Installation ID**：一次 Agent integration 安装的稳定 UUID。重新 configure 保留；remove 后重装生成新的 ID。
- **Agent credential**：Device Authorization 批准后签发给 installation 的 access/refresh token。
- **Token family**：一次登录产生并由 refresh rotation 延续的一组凭据。重新登录或撤销会终止旧 family。
- **Agent catalog**：`GET /v1/models` 在带 Agent 协商参数时返回的 aio-proxy 内部中立模型目录，由各 adapter 映射成宿主结构。
- **LKG**：last-known-good，插件最后一次成功校验并持久化的目录。
- **Ownership marker**：证明某个插件目录完全由 aio-proxy 管理的元数据文件。

## 已验证的宿主基线

| Agent target | 首期最低版本 | 插件入口 | 凭据与目录关键能力 |
| --- | ---: | --- | --- |
| OpenCode | `1.17.10` | 本期只使用 V1 `server` | 插件自行 refresh 并用 `client.auth.set()` 持久化；V2 `effect` 延期 |
| 官方 Pi | `0.84.2` | Pi-family 包的官方 Pi 入口 | Provider OAuth；`refreshModels(context.credential)` 可使用已刷新 credential 发布动态模型 |
| OMP | `17.3.7` | Pi-family 包的 OMP 入口 | OMP 原生 Provider/ModelRegistry、OAuth registry 与 credential-aware dynamic model discovery |

OMP 会读取 `pi.extensions`、重写历史 Pi 包作用域，并运行大量普通 Pi extension；这证明它是 Pi extension 的兼容宿主。它不保证官方 Pi 的 native `refreshModels(context.credential)` 与 OMP ModelRegistry 生命周期完全等价，因此本设计使用一包双入口，而不是两个独立产品或一个强行共享的宿主绑定文件。

检测到低于最低版本时，`configure` **警告但继续安装**，`agent list` 标记 `unsupported`。未知版本同样警告继续。aio-proxy 不为旧版本增加静态配置降级路径。

### 参考项目调研基线

2026-08-18 已更新并核对以下只读参考快照；它们只提供设计证据，不成为构建或运行时依赖：

- OpenCode：`4e81a0b73f6e614afebf9c7ff8862904a3674455`（`1.18.18`），并回查 `1.17.10` 的 V1 loader 与可选 V2 integration OAuth/refresh contract；
- OMP：`644ad30d6e9436074a00f8bd08ecadcd98992fc1`（`v17.3.7`），核对 `omp`/`pi` manifest、legacy Pi shims、OAuth registry 与 ModelRegistry；
- OmniRoute：`aa912c42a7d50dd4c87c356f42218ccd2ff42c59`（`release/v3.8.50`），作为相邻产品对照。它有完整 OpenCode 动态插件，但 Pi 仍通过静态 `~/.pi/config.json` 管理，不是本设计的 Pi 插件模板；
- 官方 Pi：`@earendil-works/pi-coding-agent@0.84.2`，npm integrity `sha512-l4E+B7hgXKWddRo8bC/eSue2aWZjEgJ9xIpf5p0Og+lq8a2TArCwJ0HCoCPCgaBP/tN4zbYH/wOwvx9pJpeLCA==`，git head `914cf1472e715297caa30db4b9535d534a9eb718`；该快照已核对 Provider OAuth 与 credential-aware `refreshModels(context.credential)` contract。

后续修改宿主兼容代码前必须重新 fetch 对应参考项目，并用最低版本和当时最新版本各跑一次兼容矩阵。

## 用户旅程

### 首次配置与登录

1. 用户运行 `aio-proxy agent configure opencode`、`pi` 或 `omp`。
2. CLI 检测宿主及版本，解析当前本机 aio-proxy endpoint。
3. CLI 创建或复用 installation ID，把当前版本的内嵌插件原子安装到用户全局位置；OpenCode 同时安装其文件级自动发现所需的固定薄入口。
4. CLI 不启动 Agent、不启动 aio-proxy，也不写任何 secret；它打印对应宿主的原生登录命令。
5. 用户在 Agent 中登录 `aio-proxy`。
6. 插件向 aio-proxy 请求 Device Code，Agent 展示 verification URL 和 user code。
7. 用户在 Dashboard 页面批准或拒绝。
8. 插件轮询 token endpoint；成功后由宿主原生 credential store 保存 access/refresh token。
9. 插件用 access token 拉取受保护 Agent catalog，注册 Provider 和模型，并启动固定 5 分钟刷新。

OpenCode 的提示命令是 `opencode auth login --provider aio-proxy`。Pi 与 OMP 在各自交互界面提示 `/login aio-proxy`。`configure` 只打印这些命令，不代为执行。

### 日常启动

- 宿主从自己的 credential store 读取凭据。
- 到期前由宿主或插件完成 refresh；插件侧对 refresh 做 single-flight。
- 插件取得有效 access token 后立即拉目录，此后每 5 分钟刷新。
- 目录刷新失败时继续使用 LKG 并标记 stale；从未成功过且没有 LKG 时 Provider unavailable。
- 推理仍实时校验 token；LKG 只保持模型可见性，不绕过认证。

### 重新配置

- 对已有 ownership marker 的目标，`configure` 幂等更新代码与 marker，保留 installation ID、宿主 credential 和 LKG。
- 磁盘 adapter 版本高于当前 CLI 内嵌版本时不降级，也不读取或替换 adapter 资产；OpenCode 的固定相邻入口缺失时仍可依据合法 marker 原子补回，入口完整时才直接退出。
- 同名目录存在但没有合法 marker 时拒绝接管，并提示用户自行移动或删除原目录；OpenCode 相邻入口存在但不符合受管模板时同样拒绝。

### 重新登录

- 同一个 installation ID 重新登录时复用 installation 身份。
- 批准后的首次合法 token poll 撤销该 installation 的旧 token family，并创建新 family；只批准但未兑换不会影响旧 family。
- 不累积多个并行有效身份。

### 移除与重装

1. `aio-proxy agent remove <agent>` 先撤销该 marker 对应 installation 的 token family。
2. 撤销成功后，仅删除带合法 ownership marker 的受管插件目录；OpenCode 还删除与 marker installation ID 匹配的固定薄入口。
3. 不修改宿主配置文件，不删除或改写宿主 auth 文件。
4. 宿主可能留下失效的 `aio-proxy` 登录记录；它不再能访问目录或推理。
5. 重新 configure 生成新的 installation ID，用户必须重新登录。

撤销失败时不删除插件目录，避免产生仍有效但无法从本机定位的身份。若撤销成功而文件删除失败，保留已失效插件并提示重新执行 remove；安全优先于文件清理。

Agent 原生 logout 只保证删除宿主本地 credential，宿主不一定向 aio-proxy 发出可靠通知。需要服务端立即撤销时使用 `agent remove` 或 `agent revoke`。

### 遗失安装

用户可运行：

```text
aio-proxy agent list --authorizations
aio-proxy agent revoke <installation-id>
```

`--authorizations` 从本机 control plane 列出服务端 installation，包括已无本地 marker 的 orphan。`revoke` 只撤销当前 token family，不修改任何宿主文件；以后重新批准可再次授权。

## CLI 契约

### 命令

```text
aio-proxy agent list [--check] [--authorizations] [--json]
aio-proxy agent configure <opencode|pi|omp>
aio-proxy agent remove <opencode|pi|omp>
aio-proxy agent revoke <installation-id>
```

不带目标的 `configure` 和 `remove` 报错并列出支持项；不提供“自动配置所有检测到的 Agent”。

### `agent list`

默认只读本地状态，不连接 aio-proxy：

- Agent target；
- 宿主是否检测到；
- 宿主版本和 `supported / unsupported / unknown`；
- integration 状态：`unresolved / absent / managed / conflict`；
- installation ID；
- 已安装 adapter 版本；
- marker endpoint，以及它是否与当前本机配置一致；
- 本地 LKG 的 `fresh / stale / missing` 与最后成功时间。

`--check` 额外连接当前本机 control plane，补充：

- server 是否可达；
- authorization 是否 `active / expired / revoked / missing`；
- server、Device Approval 与 adapter schema 是否可用。

`--check` 把 server installation 状态与本地 LKG 状态组合为最终诊断；它不代表 CLI 自己持有 Agent token 或代替插件拉取 catalog。

OpenCode 与 OMP 的全局目录必须通过宿主公开命令解析。宿主未检测到或目录命令失败时，`agent list` 报告 `unresolved`，不得把“未能定位”伪装成 `absent`。官方 Pi 的目录可以由公开环境变量/default 规则解析，但宿主未检测到时同样以 `unresolved` 展示，避免三个 target 出现不同语义。`agent remove <target>` 遇到 `unresolved` 时在任何 revoke 或文件写入前失败；用户仍可通过 `agent list --authorizations` 与 `agent revoke <installation-id>` 撤销遗失身份。

`--authorizations` 列出服务端 installation，并分别显示本地关联 `configured / orphaned` 与 authorization 状态 `active / expired / revoked`。它隐含 `--check`；两者同时出现不改变结果。该选项和 `revoke` 要求本机 aio-proxy 可用；server 停止时提示先启动。

### `agent configure`

- 只配置当前用户的全局插件。
- 宿主未安装时失败且不落盘；aio-proxy 不代装宿主。
- aio-proxy server 未运行时仍可完成安装，但不声称已验证连接，并提示先启动 server 后再登录。
- server 可达但 `server.apiKeys` 非空且未配置 `server.password` 时仍完成插件安装，但明确提示 Device Approval 被安全策略禁用，必须先配置 Dashboard password。
- 首期只支持同机 loopback endpoint。endpoint 来自当前本机配置；通配 bind host 归一化为可连接的 loopback host，显式非 loopback bind 则拒绝 configure，并说明远程实例不在首期范围。
- 只写 aio-proxy 专属插件目录、marker，以及 OpenCode 文件级自动发现所需的固定薄入口；不写宿主 auth/config 文件。
- 安装完成后打印宿主原生登录命令和 reload/restart 提示。

### `agent remove`

- 根据 marker 精确定位 installation 和目录。
- 必须通过运行中的本机 admin control plane 撤销，不离线直写 SQLite，避免与 server 内存 token index 分叉。
- `revoked`、`expired` 或 `missing` 都是可安全继续删除的幂等终态；网络错误和服务端错误不是。
- 没有合法 marker 时拒绝删除。
- 不清理宿主 auth/config 文件。

## 安装产物与 ownership

### 交付形态

`@aio-proxy/opencode-provider` 与 `@aio-proxy/pi-provider` 是 workspace 内构建产物，并作为文件资产嵌入 aio-proxy CLI 分发。它们没有独立在线更新器；首期唯一受支持的安装和升级入口是 aio-proxy CLI。

- OpenCode：一个包、一个默认导出，本期只包含 V1 `server`，不导出 V2 `effect`。
- OpenCode 的最低版与当前版都只自动发现 `plugin(s)/*.{ts,js}` 文件，不会把 `plugins/aio-proxy/` 目录本身当成插件。因此安装产物由受管目录和一个相邻的薄入口文件组成：`plugins/aio-proxy.js` 只 re-export `./aio-proxy/index.js`，代码、marker 和 LKG 仍全部位于受管目录。CLI 不为此改写 OpenCode config。
- Pi-family：一个包、共享 core、`official-pi` 与 `omp` 两个薄入口；package manifest 同时声明 `pi` 和 `omp` extension。官方 Pi 读取 `pi`；OMP loader 使用 `pkg.omp ?? pkg.pi`，存在 `omp` 时不会再加载 `pi`，因此不会双重注册。
- 两个包都构建为自包含的宿主运行文件，只把宿主公开 API 保留为 external；`configure` 不运行 npm/bun install，也不从网络下载插件代码。

这两个包不是 aio-proxy runtime plugin，也不扩展 `@aio-proxy/plugin-sdk`。

### 用户全局目录

| Agent target | 默认受管目录 |
| --- | --- |
| OpenCode | `~/.config/opencode/plugins/aio-proxy/`，并安装相邻入口 `~/.config/opencode/plugins/aio-proxy.js`；遵守 `OPENCODE_CONFIG_DIR` 和 XDG config override |
| 官方 Pi | `~/.pi/agent/extensions/aio-proxy/`，遵守 Pi agent-dir override |
| OMP | `~/.omp/agent/extensions/aio-proxy/`，遵守 OMP active agent-dir override |

项目级目录、OMP profile 批量配置和多套自定义根目录不在首期承诺内。CLI 只使用宿主公开的目录解析规则，不扫描或修改仓库内的 `.opencode`、`.pi`、`.omp`。

### Marker

每个目录根部包含 `.aio-proxy-managed.json`：

```json
{
  "format": 1,
  "managedBy": "aio-proxy",
  "agent": "opencode",
  "installationId": "uuid",
  "adapterVersion": "1.2.3",
  "endpoint": "http://127.0.0.1:9317"
}
```

marker 不含 secret。目录权限沿用用户私有配置目录；adapter 写入的状态文件使用 `0600`。

合法 marker 必须满足：`format` 和 `managedBy` 精确匹配、`agent` 与目标目录匹配、installation ID 是规范 UUID、adapter version 是合法 semver、endpoint 是首期允许的 loopback URL。CLI 先解析宿主公开的配置根目录，再确认目标是该根目录下的固定直接子目录；目标目录本身或 marker 是 symlink 时拒绝接管、升级或删除。

OpenCode 的相邻入口文件内容固定为：

```js
// aio-proxy-managed:v1:<installation-id>
export { default } from "./aio-proxy/index.js";
```

CLI 只在入口不存在，或入口逐字节符合以上模板且 installation ID 与目录 marker 一致时创建、升级或删除它。创建缺失入口时用同父目录 durable temporary + exclusive hard-link 提交；如果最终检查后并发出现普通文件、目录或 symlink，提交必须以 conflict 失败并保留对方字节，不能用会覆盖目标的普通 rename。入口是 symlink、installation ID 不匹配或内容被修改时均视为 `conflict`，不得覆盖。入口不保存 secret，也不承担业务逻辑；它只是满足 OpenCode 文件级自动发现规则。Pi 与 OMP 没有这个相邻入口。

每个 adapter 还维护 `.aio-proxy-state.json`，其中包含 catalog schema、`fresh / stale / missing`、最后成功时间、最后错误类别和该 target 最近一次通过校验的完整 LKG，不含 token、请求内容或任意错误文本。三个 target 都以这个文件作为 LKG 真相源；宿主自己的 model cache 只是下游副本。这样重启后的失败也能恢复 LKG，`agent list` 无需读取宿主 credential 即可报告一致状态。

`agent list` 在状态文件报告失败，或最后成功时间已超过两个刷新周期（10 分钟）时显示 `stale`；没有通过 schema 校验的 catalog 时显示 `missing`。状态和 LKG 使用临时文件加 fsync/rename 原子替换，失败不破坏旧文件。

带合法 marker 的整个目录由 aio-proxy 管理。`configure` 和 post-upgrade 可覆盖其中的代码、manifest 和 marker；用户手工修改这些受管文件不会被合并。通过 schema 1 校验的 `.aio-proxy-state.json` 是唯一保留项，升级时迁移到新目录。OpenCode 相邻入口只允许上述固定模板，不属于可扩展或可合并的用户配置。

安装采用同父目录 staging + rename。更新时先把当前目录原子移动到本次唯一 backup，再对这个不再变化的 backup 重新校验 marker、installation ID、版本和 LKG；校验失败立即原路恢复，校验成功才把 staging 提升到固定路径。任一步失败都恢复旧目录，且只清理本次创建的 staging/backup；无 marker 的同名目录永不自动备份或覆盖。OpenCode 首装先落目录、再原子落相邻入口；入口落盘失败时恢复安装前目录状态。升级时入口模板不变且始终指向同一路径，目录成功替换后再校验/修复入口。remove 在服务端撤销成功后先删除入口，再逐项删除目录中的普通受管内容，最后删除 ownership marker 并对空目录执行 `rmdir`；中途失败必须保留 marker，使重试仍能证明 ownership。入口已经不存在是可重试终态，入口冲突则拒绝删除任何文件。

### 升级

用户已决定 `aio-proxy upgrade` 自动更新受管插件。当前 upgrade 进程仍运行旧二进制，不能用自己的旧内嵌资产完成更新，因此流程是：

1. 旧进程在升级前按自己的有效用户解析三个受管目标目录，然后由现有 upgrade 逻辑安装并校验新 aio-proxy。
2. upgrade 从 PATH/已知 binary target 解析**新二进制**，仍由未提权的旧进程启动；package manager 自己的提权不改变插件目录所属用户。
3. 新二进制执行一次内部 post-upgrade action，只检查旧进程传入且重新校验过的三个用户全局目标目录及其合法 ownership marker，不遍历其他目录。
4. 新二进制用自己的内嵌资产原子更新每个 managed integration。
5. 单个插件更新失败不回滚已成功的 aio-proxy 升级；汇总告警并给出 `aio-proxy agent configure <agent>` 修复命令。

在当前发布平台上，如果用户直接以 Unix root 身份运行 `aio-proxy upgrade`，post-upgrade 通过有效 UID 检测，不猜测 `SUDO_USER` 或其他用户 home，只更新 root 自己的受管目录并明确告警；普通用户的插件需在其身份下运行 `aio-proxy agent configure <agent>`。Windows Administrator 检测属于未来平台支持边界，本期不假装覆盖。post-upgrade 不创建新 integration、不接管无 marker 目录、不撤销身份、不启动或重启 Agent。运行中的 Agent 继续使用已加载的旧代码，用户按提示 reload/restart 后加载新 adapter。

## Agent 插件架构

### 共享边界

两个交付包只共享与宿主无关的窄逻辑：

- Device Code 请求与 polling；
- token refresh exchange 与 single-flight；
- catalog HTTP 请求、schema 1 校验和 LKG；
- aio-proxy endpoint、installation ID 与 adapter version 读取；
- 安全日志与错误归一化。

不新增单实现 interface、通用 Agent registry SDK 或宿主抽象层。OpenCode 与 Pi-family 包可以共享普通内部模块，但宿主注册代码保持显式。

三个目标注册的用户可见 Provider ID 均为 `aio-proxy`，base URL 为 marker endpoint 的 `/v1`。OpenCode 使用 `@ai-sdk/openai-compatible`；Pi/OMP 使用宿主的 `openai-completions` API。模型 ID 始终是 aio-proxy 暴露的 client-facing alias；协议转换继续由 aio-proxy routing pipeline 处理。

### OpenCode

同一个默认导出必须提供 V1 `server`：

- V1 `server`：
  - `auth.methods.authorize()` 请求并轮询 Device Code；
  - `config` hook 只修改本次进程的内存 config：注册固定 `aio-proxy` custom provider，并把 adapter-owned LKG 投影为 OpenCode provider models；它不写 OpenCode config，也不直接读写 OpenCode auth 文件；
  - `auth.loader` 安装带 Bearer token 的 fetch；每次请求通过 loader 提供的 `getAuth()` 读取当前 credential，不在加载时把 access token 捕获成常量；
  - OpenCode 要求 custom provider options 中存在 `apiKey`；这里固定填写不可用于认证的 `aio-proxy-managed` 占位值，真实 fetch 在发出请求前总是用当前 installation access token 覆盖 Authorization，server 也不接受该占位值；
  - access 到期时插件 single-flight refresh，并用 `client.auth.set()` 保存轮换结果；
  - loader 启动时立即刷新 catalog，成功后原子更新 LKG；当模型内容变化时调用宿主公开的 `client.instance.dispose()` 请求一次实例重建，下一次 `config` hook 从新 LKG 发布模型；固定 5 分钟刷新沿用同一流程；
  - `dispose` 清理 adapter 自己的 timer。

不能用 V1 `provider.models` 作为 `aio-proxy` 的首次注册入口：OpenCode 在物化 config-defined provider 之前只对内置 provider database 中已存在的 ID 调用该 hook，而 `aio-proxy` 不在内置目录。首期因此采用上述 config-hook/LKG 投影；这是宿主生命周期适配，不改变 server catalog。没有 LKG 时仍注入零模型 provider，使登录与 loader 可用。首次登录的 callback 在宿主持久化 credential 前只刷新 LKG，不调用 `instance.dispose()`；callback 返回且宿主完成保存后，后续 loader/config pass 或新进程从该 LKG 发布模型，避免在 receive→persist 窗口主动重建。

以下 V2 `effect` 保留为后续独立增量的边界记录，本期不实现：

- V2 `effect`：
  - 注册 `aio-proxy` Integration OAuth method；
  - 实现 `authorize` 与 `refresh`；
  - host 负责触发 refresh 和持久化 credential；
  - catalog transform 注册 Provider/model；
  - background refresh 使用 Effect/host-managed lifecycle，不留 raw detached timer。

当前已确认 V1/V2 的 credential store、refresh 责任和 logout/lifecycle 不同，所以不把它们伪装成一个互不干扰的双栈导出。后续启动 V2 时必须单独设计凭据迁移、并发 refresh、logout 和 host-managed lifecycle，并重跑最低版与当时最新版兼容矩阵。

### 官方 Pi

官方 Pi 入口：

- 使用官方 Pi native Provider contract 注册 `aio-proxy`，不依赖 OMP legacy compatibility；
- 登录返回标准 access/refresh credential；
- `refreshToken` 调 aio-proxy token endpoint；
- `getApiKey` 返回 access token；
- 使用官方 credential-aware `refreshModels(context.credential)` 请求中立 catalog，映射成 `ProviderModelConfig[]` 后 publish；
- 启动和刷新失败时先从 adapter-owned LKG publish；宿主 cache 不作为持久化真相源；
- 不直接读取或写入 `auth.json`。

### OMP

OMP 入口使用 OMP 原生 Provider/ModelRegistry 生命周期：

- 注册 OMP Provider 与 OAuth；
- credential resolution 走 OMP AuthStorage/registry；
- dynamic models 走 OMP 的 `fetchDynamicModels(apiKey)`，在 adapter 内把中立 catalog 映射成 OMP model config；
- OMP 会在 `session_start` 前运行 offline/background dynamic refresh；该阶段若 catalog 返回 401，adapter 先返回 LKG 并记录待恢复状态，随后在首个 `session_start` 通过 ModelRegistry 强制刷新 credential，再执行一次 online runtime-provider refresh；
- 映射后的目录交给 OMP 原生 model cache/registry，同时把映射前的最后一次成功校验响应写入 adapter-owned LKG；启动和刷新失败时由该 LKG 重新映射并 publish；
- source ID 与 unregister/rollback 使用 OMP 原生语义。

OMP 的 Pi compatibility shim 只负责普通 extension 兼容，不作为本入口正确性的依赖。

## Agent catalog

### 请求

插件请求：

```http
GET /v1/models?agent=opencode&adapter_version=1.2.3&schema_version=1
Authorization: Bearer <agent-access-token>
```

`agent` 必须是 `opencode`、`pi` 或 `omp`；`adapter_version` 和 `schema_version` 必填。adapter version 用于诊断和兼容观测，响应分派由 `agent + schema_version` 决定。

`/v1/models` 在全局 `/v1/*` 鉴权 middleware 之前使用专用流程。只要三个 Agent 字段中任意一个出现，就先只抽取 `agent`、`adapter_version`、`schema_version` 交给 strict schema；`client_version` 和其他 query 不进入该对象。这样 malformed Agent negotiation 在任何 credential 检查前稳定返回 400，同时 Agent 字段与 `client_version` 并存时仍由 Agent 分支优先。

路由顺序：

1. 有 `agent`：校验 Agent access token 与目标 installation，返回中立 Agent catalog。
2. 无 `agent`、有 `client_version`：保留现有 Codex catalog 行为。
3. 两者都没有：保留现有标准 `{ object: "list", data: [...] }`。

有 `agent` 时不允许回退到 Codex 或标准列表。该分支只接受 Agent access token：匿名和静态 API key 返回 401，token target 与 `agent` 不匹配返回 403。反过来，使用 Agent access token 请求 `/v1/models` 时缺少 `agent` 返回 400，target 不匹配返回 403，不能进入 Codex 或标准列表。

未知 Agent、缺少参数、非法 semver 或不支持的 schema 均返回 400；body 使用稳定的 `{ "error": { "code": string, "message": string } }`，schema 不支持时额外返回 `supported_schema_versions`。adapter 会解析这个 400 body，并把 `error.code === "unsupported_schema"` 记录为稳定的 `unsupported_schema` 失败类别；其他非成功响应仍按其固定类别处理。认证失败继续使用现有 protocol-shaped 401/403。任何错误都不会触发插件用匿名或静态 key 重试，插件保留 LKG。

### schema 1

schema 1 是三个内嵌 adapter 共用的最小中立 wire object，不携带任何宿主 SDK 类型：

```ts
type AgentCatalogV1 = {
  schema_version: 1
  agent: 'opencode' | 'pi' | 'omp'
  models: Array<{
    id: string
    name: string
    reasoning: boolean
    tool_call: boolean
    temperature: boolean
    attachment: boolean
    input: Array<'text' | 'audio' | 'image' | 'video' | 'pdf'>
    context_window: number | null
    max_output_tokens: number | null
  }>
}
```

该 JSON-compatible schema 放在 `@aio-proxy/types` 的内部 Agent catalog 模块，供唯一 server assembler 与两个内嵌 adapter 包共用；它不是公开 Agent SDK。server 不依赖 OpenCode、Pi 或 OMP 的 model-config 类型，也不按宿主版本分支。

assembler 复用当前 `resolveEnabledModels(state)`，因此 catalog：

- 只列出启用 Provider 暴露的 client-facing alias；
- 保持现有 alias 去重和元数据优先级；
- 从当前 model metadata 映射 display name、reasoning、tool call、temperature、attachment、输入模态和 context/output limits；
- 未知 reasoning 与 attachment 默认为 `false`，未知 tool call 默认为 `true`，未知 temperature 默认为 `false`，未知输入模态默认为 `['text']`，未知 limits 返回 `null`；这些默认值与 OpenCode 对自定义 OpenAI-compatible model 的当前默认语义一致，并由 server wire contract 固定，adapter 不自行猜测；
- 不改变 routing pipeline、Provider weight、session affinity 或 fallback。

endpoint、Provider ID、API 类型、OAuth wiring、headers 和宿主要求的默认 cost 不从 catalog 返回；它们是 adapter 的固定安装级配置。中立 schema 保留当前 model metadata 中 Agent 需要的行为能力和完整输入模态集合；每个 adapter 只投影宿主公开类型能表达的能力，不把 audio/video/pdf 误报成 image。OpenCode 直接使用 catalog 的 `tool_call`、`temperature` 和 `attachment`，不在 adapter 内另设 capability 默认值。已核验的官方 Pi `0.84.2` 与 OMP `17.3.7` model config 都没有独立 tool-capability 字段，因此 Pi-family 首期不伪造 `supportsTools`；`tool_call` 仍保留在中立 schema，供能表达它的宿主使用。宿主 schema 演进只改对应 adapter 和兼容测试，不改 server wire schema。宿主要求必填 limit 而 catalog 为 `null` 时，adapter 使用该宿主文档中的默认值。

### 缓存与失败

- 登录成功后立即刷新。
- 宿主启动且已有 credential 时立即刷新。
- 后续固定每 5 分钟刷新；同一进程合并并发刷新。
- 成功响应先完整校验，再原子替换 LKG。
- 网络失败、401、5xx、JSON 错误或 schema 不兼容都不覆盖 LKG。
- 有 LKG：继续提供模型并标记 stale。
- 无 LKG：Provider unavailable，并给出登录、启动 server 或升级 adapter 的对应诊断。
- 401 不触发匿名 catalog 请求。OpenCode 与 OMP 各自只走一次可持久化的 host refresh，第二次 401、refresh `invalid_grant` 或宿主无法返回新 credential 时要求重新登录。官方 Pi 的 `refreshModels(context.credential)` 已接收宿主在该 refresh phase 预先解析并按到期状态刷新的 credential，且 callback 没有再次旋转并持久化 credential 的 seam；它收到 401 时保留 LKG 并直接要求重新登录，不能在 adapter 内生成一对宿主不会保存的新 token。

三个 adapter 都在 managed state 文件中持久化 schema 1 LKG，再发布给各自宿主。remove 会随受管插件目录删除 aio-proxy 自己的 LKG，但不触碰宿主的其他缓存；插件入口消失后，那些缓存不能继续建立 aio-proxy Provider。

## Agent 身份与 Device Authorization

### 信任模型

分发到用户机器上的插件不是可信秘密载体：

- User-Agent、query 和普通 header 可伪造；
- loopback 只能证明请求来自本机，不能证明来自官方插件；
- 硬编码的共享 SK 可以从包中提取，且无法逐安装撤销。

因此三个插件都是 OAuth public client。固定 client ID：

- `aio-proxy-opencode`；
- `aio-proxy-pi`；
- `aio-proxy-omp`。

client ID 不是 secret。服务端校验 client ID、Agent target 与 installation ID 的绑定。installation 首次成功签发后 target 永久固定；同一 installation ID 以其他 target 重新授权时返回 `invalid_grant`，且不得撤销或改写原 target 的有效 token family。

### Hono 子应用

使用一个内部 Hono sub-app 集中注册窄 RFC 8628 能力：

```text
POST /oauth/device/code
POST /oauth/token
GET  /dashboard/agents/authorize
POST /dashboard/api/agent-authorizations/resolve
POST /dashboard/api/agent-authorizations/:device-id/approve
POST /dashboard/api/agent-authorizations/:device-id/deny
GET  /admin/agent-installations
POST /admin/agent-installations/:installation-id/revoke
```

不引入通用 OAuth server adapter。Dashboard approve/deny 复用现有 Dashboard authentication 和 same-origin mutation 防护；远程 Dashboard 仍遵守已有“非 loopback 必须设置密码”的边界。两个 `/admin/*` endpoint 复用现有 admin control-plane policy，只服务同机 CLI；list 不返回 token hash，revoke 是幂等操作。

`GET /admin/agent-installations` 返回一个 capability snapshot，而不是裸 installation 数组：`installations` 是不含 token/hash 的 summary，`deviceAuthorization` 是 `available | password_required`，`catalogSchemaVersions` 首期固定为 `[1]`。这样 `agent list --check` 可以只读判断 server、Device Approval 和 catalog schema 能力，不需要为了探测能力创建 challenge。`POST /admin/agent-installations/:installation-id/revoke` 返回 `revoked | expired | missing` 幂等终态。

两个插件侧 OAuth endpoint（`/oauth/device/code`、`/oauth/token`）只接受 transport peer 为 loopback 的直连请求，不信任 `Forwarded` / `X-Forwarded-For`，也不支持经远程 reverse proxy 暴露；远程 Dashboard 只能审批已经由本机插件创建的 challenge。这与首期仅支持同机 endpoint 的产品边界一致，并避免公开 bind 上的未认证 pending-challenge DoS。

Device Approval 的认证强度与模型 API 门禁一致：

- `server.apiKeys` 为空时，保留现有 loopback Dashboard 行为；本机推理本来就是匿名的，批准 Agent token 不扩大推理权限。
- `server.apiKeys` 非空时，必须同时配置 `server.password`。`POST /oauth/device/code` 在缺少 password 时返回 503 `authorization_unavailable`，不创建 challenge。
- `server.apiKeys` 非空时，resolve、approve、deny 即使来自 loopback 也必须携带有效 Dashboard session；same-origin/Origin header 只做 CSRF 防护，绝不作为身份凭证。

`POST /oauth/device/code` 接收 form-encoded `client_id`、`agent`、`installation_id` 和 `adapter_version`，返回标准 `device_code`、`user_code`、`verification_uri`、`verification_uri_complete`、`expires_in` 和 `interval`。`verification_uri_complete` 把 user code 放在 URL fragment 中，由 Dashboard 页面读取后通过 authenticated same-origin POST 解析，只返回内部 `device-id`；approve/deny 从不把 OAuth device code 暴露给页面。

adapter 不把“能监听 marker 端口的本机进程”等同于可信 aio-proxy：它只接受与 marker endpoint 同 origin、path 固定为 `/dashboard/agents/authorize` 的 `verification_uri`；complete URL 必须只有与响应 `user_code` 一致的 `#code=` fragment。off-origin、额外 query 或不匹配 fragment 都按 invalid response 终止，不向用户展示。

`POST /oauth/token` 只接受两种 form-encoded grant：

- `urn:ietf:params:oauth:grant-type:device_code`：`client_id + device_code`；
- `refresh_token`：`client_id + refresh_token`。

成功响应是 `token_type=Bearer`、`access_token`、`refresh_token` 和 `expires_in`。协议错误使用 RFC 8628/OAuth 名称：`authorization_pending`、`slow_down`、`access_denied`、`expired_token`、`invalid_client`、`invalid_grant`；本机防护还使用稳定的 `authorization_unavailable`、`invalid_request`、`rate_limited` 和 `capacity_exceeded`。不提供 public revoke/introspect endpoint；本机 admin control plane 负责 list/revoke，避免增加插件并不需要的 OAuth 面。

device/token 响应统一设置 `Cache-Control: no-store`。OAuth form body、Authorization、device code、user code 和 access/refresh token 不进入访问日志、request record、trace attribute 或诊断文件；日志只保留 target、adapter version、结果类别和 request ID。

### Device Code

- device code：32 个随机字节，base64url。
- user code：8 位非歧义大写字符，显示为 `XXXX-XXXX`。
- 有效期：10 分钟。
- 初始 polling interval：5 秒。
- pending state 只驻内存；aio-proxy 重启后返回 `expired_token`，用户重新登录。
- 同一 `client_id + installation_id` 只保留一个 active challenge；新请求使旧的 pending/approved/denied challenge 失效。challenge 首次 consume 后立即释放这个 active-installation 槽位，但 device-code/device-id 索引与明文签发结果仍保留到 30 秒 replay 截止，因此立即开始一次新登录也不会破坏旧 device code 的幂等 replay。
- 全局最多保留 256 个未过期 challenge（包含 pending、approved、denied 和 consumed）；每来源地址每分钟最多创建 10 个，超限返回 429。create/lookup/decision 的来源 bucket 各自最多保留 256 个并按一分钟窗口惰性淘汰，避免通过 127/8 源地址轮换制造无界 Map。
- user code lookup 与 approve/deny 同样按来源地址限流；不存在的、过期的和已消费 code 不泄露额外 installation 信息。
- 过快 polling 返回 `slow_down` 并按 RFC 8628 增加 interval。
- 状态包括 pending、approved、denied、consumed、expired。

批准页显示 Agent target、installation ID、adapter version、固定权限“模型目录 + 推理”和过期时间。approve/deny 不接受插件提供的任意 HTML、redirect URI 或 scope。

批准后第一次合法 token poll 原子创建/替换 token family。已消费 device code 从消费时刻起拥有独立、完整的 30 秒 replay 窗口，即使原 10 分钟 challenge TTL 随后到期，重复 poll 仍返回同一签发结果，避免并发 polling 产生多个 family；窗口结束后删除 challenge 及其明文结果，再次 poll 返回 `expired_token`。

### Token 生命周期

- access token：15 分钟。
- refresh token：90 天滑动过期。
- 每次 refresh 同时轮换 access 和 refresh；新 pair 事务提交时立即移除该 family 的旧 access row/hot-index entry，避免 rotation 累积多个有效 access。并发旧 access 请求可收到 401，再通过 30 秒 refresh replay 收敛到同一新 pair。
- 插件和 V1 OpenCode fetch 都做进程内 single-flight；refresh 发起前必须从宿主 credential store 重新解析当前 credential，不能使用 adapter 启动时捕获的 refresh token。
- 服务端对同一旧 refresh token 提供 30 秒幂等窗口：
  - 同进程 replay cache 存在时，在先校验 client/target 与 family 未撤销后返回同一轮换结果；这个从成功 rotation 开始的 30 秒窗口不被旧 refresh token 随后的到期时刻截断；
  - server 在窗口内重启导致 replay result 丢失时，返回 `invalid_grant` 但不撤销 family；
  - 窗口外再次使用任何已消费 refresh token，撤销整个 family。
- remove、显式 revoke 和同 installation 重新登录都会撤销旧 family。

同一宿主的多个进程共享一个 installation 与宿主 credential store。兼容矩阵必须覆盖两个进程同时到期，以及一个进程暂停超过 30 秒后恢复：第二个进程必须重新读到已轮换 credential，不能在窗口外提交旧 token。任一宿主做不到这一点时，该 target 不满足首期发布条件；不为绕过宿主 credential 一致性而放宽通用 reuse detection。

refresh 响应到达后、宿主持久化新 credential 前存在不可消除的崩溃窗口。server 无法区分窗口外的旧 token 来自恢复中的合法进程还是窃取者，因此保持 fail closed：超过 30 秒后复用旧 token 仍撤销 family 并要求重新登录，不延长明文 replay cache，也不返回其后继 token。兼容测试必须注入 receive→persist 之间的崩溃/长暂停，并验证结果是明确、可恢复的重新登录诊断，而不是静默继续或放宽 reuse detection。

`revoke <installation-id>` 撤销该 installation 当前 family，但不永久拉黑 installation ID；用户以后再次明确完成 Device Authorization，可以在同一受管安装上创建新 family。`remove` 随后删除 marker，所以重装会使用新 installation ID。

wire token 使用可识别的版本化前缀和 32 字节随机 payload：

- `aio_agent_at_v1_<base64url>`；
- `aio_agent_rt_v1_<base64url>`。

这些前缀是认证分派标识，不是 secret；`server.apiKeys` 文档将其声明为保留前缀。

### 固定权限

首期不实现 scope engine。有效 Agent access token 固定允许：

- 读取与自身 target 相符的 Agent catalog；
- 调用现有模型推理和 token-count API。

它不能访问 Dashboard、`/dashboard/api/*`、`/admin/*`、配置、插件管理或其他 installation。批准页显示这两个固定权限。

## 持久化与请求热路径

### SQLite

Agent identity 是 client 身份，不复用 `oauth_account`（它表示上游 Provider 账号），新增独立 schema/repository：

- `agent_installation`：installation ID、Agent target、创建时间、最近授权时间和最近一次批准时的 adapter version。
- `agent_token_family`：family ID、installation ID、创建/撤销时间、当前 refresh 过期时间。
- `agent_access_token`：token hash、family ID、expires at。
- `agent_refresh_token`：token hash、family ID、issued/expires/consumed at。

数据库只保存 token 的 SHA-256 hash 和非秘密元数据，不保存 access/refresh 明文。随机 token 具有足够熵，hash 用于精确查找而不是密码验证。

已消费 refresh token 记录保留到该 token 自己的 `expires_at`，用于 reuse detection；过期 access rows 可立即删除。revoked family 从 `revoked_at`、expired family 从 refresh `expires_at` 起保留 90 天供 CLI 诊断，之后连同没有其他 family 的 installation 一并清理。清理只在启动及 token mutation 时顺带执行，不新增后台 worker。

### 内存索引

- server 在打开 SQLite、执行 migration 或创建任何内存 token index 前，必须先取得与数据库物理身份绑定的进程生命周期独占锁；先 realpath 规范化已创建的父目录，使父目录 symlink alias 汇合到同一 lock，数据库文件本身若是 symlink 或 `nlink > 1` 的 hardlink 则直接拒绝。同一数据库在同一或不同进程中只能存在一个活动 `ServerState`。锁记录 PID、进程 starttime、随机 owner 和 heartbeat，并复用现有 file-lock 的 stale recovery/fencing 规则。
- `ServerState.close()` 保持同步：以不因单项 close 异常而中断的顺序停止 server-owned lifecycle、关闭数据库，最后同步释放 ownership lock。初始化在取得锁后的任何失败都通过 LIFO cleanup 清理已经创建的 watcher、login session、recovery、scheduler、event hub、数据库和锁；下一次启动无需等待 stale timeout。`createServer()` 返回的 Hono app 暴露幂等 `close()`，route assembly 失败与 CLI 收到 `SIGINT`/`SIGTERM` 时都必须调用，不能只依赖进程退出后的 stale-lock recovery。
- server 启动时把未过期 access token hash、family 和 installation 状态加载进内存。
- 普通推理请求只 hash bearer token 并查询内存，同时检查 `expires_at`；过期 entry 在命中时惰性删除，不逐请求访问 SQLite。
- 签发、refresh、revoke 才事务写 SQLite，并同步更新内存索引。
- Device 首次签发和 refresh rotation 的 replay result 都只在内存保存明文 30 秒，过期立即丢弃；refresh replay cache 最多保留 1024 个结果，异常压力下淘汰最旧项并 fail closed，不无界增长。
- CLI 在 server 运行时必须通过 admin control plane 变更身份，避免数据库与内存索引分叉。

持久化 access token 是必要条件：否则 aio-proxy 重启会让尚未到期的 15 分钟 token 立即失效，而部分宿主不会立刻触发 refresh。

## 与现有 API key 鉴权并存

模型 API 认证顺序：

1. bearer token 匹配保留的 Agent token 前缀时，必须按 Agent credential 校验。
2. 可识别 Agent token 无效、过期或已撤销时返回 401，绝不降级成匿名或 `server.apiKeys`。
3. 非 Agent credential 继续走现有 `server.apiKeys` 校验。
4. `server.apiKeys` 为空且请求没有 Agent token时，保持当前匿名访问。
5. `server.apiKeys` 非空，模型 API 接受有效静态 API key **或**有效 Agent access token。

`server.apiKeys` 从空变为非空不会追溯撤销已经批准的 Agent token family；Agent token 与静态 API key 是并列的显式 client credential。锁定服务后，运维提示用户用 `agent list --authorizations` 复核并按需 `agent revoke`，不增加按签发时配置状态区分的第二类 family。

带 `agent` query 的 catalog 是例外中的严格分支：无论 `server.apiKeys` 是否为空，都必须有 target 匹配的有效 Agent access token；静态 API key 和匿名请求不能读取中立 Agent catalog。

Agent token 只从 `Authorization: Bearer` 识别；不从 `x-api-key`、query 或其他兼容字段识别。配置加载时拒绝任何以 `aio_agent_at_` 或 `aio_agent_rt_` 保留前缀开头的静态 `server.apiKeys`，避免静态 key 被错误分派成 Agent credential。

认证 middleware 在路由前剥离调用方 credential，保证它不会传给上游 Provider。各协议的 401 body 继续使用现有 protocol-shaped error。

## Dashboard

首期只新增 Device Code 批准页：

- 输入或预填 user code；
- 展示待批准 installation 信息与固定权限；
- approve / deny；
- 展示 expired、consumed、denied 和成功状态。

当 `server.apiKeys` 非空时，该页面必须先完成 Dashboard password 登录；未配置 password 时只展示阻塞原因和配置指引，不允许批准。

不新增 Agent identity 列表、改名、scope、审计或 revoke 页面。遗失身份通过 CLI `list --authorizations` / `revoke` 处理。

pending challenge 不写数据库，也不进入现有 OAuth provider login session。Agent Device Authorization 是独立 Hono 模块，但复用 Dashboard session 验证、loopback access 和 same-origin mutation middleware。

## 模块边界

- `packages/types`
  - Agent target、marker、catalog query/response schema 1；
  - Dashboard approve/deny 与 installation summary DTO；
  - 只包含 JSON contract，不依赖宿主 SDK runtime。
- `packages/core`
  - Agent identity Drizzle schema、migration 和 repository；
  - opaque token hash/rotation/reuse state machine；
  - 不包含 Hono、Dashboard 或宿主插件代码。
- `packages/server`
  - internal Device Authorization Hono sub-app；
  - Dashboard approval API；
  - composite model API authentication 与 access-token memory index；
  - `/v1/models` Agent dispatch 和一个中立 catalog assembler；
  - 本机 admin installation list/revoke。
- `packages/cli`
  - `agent` commands、host detection、global path resolution；
  - marker、atomic install/remove、embedded adapter assets；
  - upgrade 的 new-binary post-upgrade step。
- `packages/agent-provider/runtime`
  - `@aio-proxy/agent-provider-runtime`：共享 Device/token/catalog client，无宿主行为。
- `packages/agent-provider/opencode`
  - `@aio-proxy/opencode-provider`：本期只有 V1 host binding；V2 binding 延期。
- `packages/agent-provider/pi`
  - `@aio-proxy/pi-provider`：共享 core、官方 Pi entry、OMP entry。
- `packages/dashboard`
  - Device Code approval route/page；
  - 不新增长期身份管理页面。

现有 `packages/server/src/routes/pipeline.ts` 不承担 Agent 身份、catalog 分支或插件类型判断；它继续只做模型候选循环。通过 middleware 验证后的 Agent 请求与普通请求进入同一 routing pipeline。

## 故障处理

| 故障 | 行为 |
| --- | --- |
| 宿主缺失 | configure 失败，不写目录 |
| 宿主版本过旧/未知 | 警告后继续；list 标 unsupported/unknown |
| aio-proxy 未运行 | configure 成功但不验证；登录和 `--check` 提示启动 server |
| `server.apiKeys` 非空但无 Dashboard password | 插件可安装；device-code 创建返回 503，提示先配置 password |
| 无 marker 同名目录 | 拒绝接管 |
| OpenCode 相邻入口内容冲突或为 symlink | 拒绝接管、升级或删除任何本地文件 |
| managed 更新失败 | 恢复旧目录；upgrade 汇总告警 |
| Device Flow 中 server 重启 | pending 失效，重新登录 |
| 用户拒绝 | token endpoint 返回 `access_denied` |
| catalog 401 | 尝试 refresh；失败则重新登录，保留 LKG |
| catalog schema 不兼容 | 保留 LKG，标 stale，提示升级 |
| 无 LKG 且刷新失败 | Provider unavailable |
| access token 过期/撤销 | 401，不匿名降级 |
| refresh 正常并发 | 30 秒内幂等；插件 single-flight |
| 旧 refresh 窗口外复用 | 撤销整个 family |
| refresh 响应后、持久化前崩溃 | 后续旧 token 窗口外复用时撤销 family；明确要求重新登录 |
| remove/revoke 时 server 不可达 | 不改数据库、不删插件；提示先启动 server 后重试 |
| remove 撤销失败 | 不删除插件目录 |
| remove 文件删除失败 | 身份保持 revoked，保留目录并提示重试 |

## 测试策略

### Core identity

- token 只以 hash 落库，access/refresh 明文不出现于 SQLite。
- access 15 分钟、refresh 90 天滑动和 rotation。
- 30 秒正常并发返回同一结果；窗口外 reuse 撤销 family。
- receive→persist 间崩溃或长暂停不会延长 replay 窗口；旧 token 复用后 family 撤销并返回可操作的重新登录诊断。
- installation relogin、remove、显式 revoke 都终止旧 family。
- 过期清理不删除仍需用于 reuse detection 的记录。
- migration 从当前 schema 升级且保持现有数据。

### Server auth 与 Device Flow

- 同一数据库的第二个 server 在创建 hot token index 前失败；父目录 symlink alias 收敛到同一 canonical DB path，DB 文件 symlink/hardlink 被拒绝。
- 正常 `ServerState.close()`、`AppType.close()`、route assembly 失败、各初始化资源之后的注入失败，以及 CLI `SIGINT`/`SIGTERM` 都立即关闭已启动资源并释放 ownership lock；崩溃遗留锁可按 PID/starttime/heartbeat 恢复。
- pending、slow_down、approve、deny、expired、atomic consume。
- consumed challenge 后立即创建同 installation 的新 challenge，不影响旧 device code 在 30 秒内返回同一签发结果；在原 Device expiry 前 1ms consume 仍获得完整 30 秒 replay window。
- refresh 在旧 refresh token expiry 前 1ms 轮换后，仍可跨过旧 expiry 返回完整 30 秒内存 replay；client binding 校验先于 replay 返回。
- pending 重启失效。
- 插件侧 OAuth endpoint 的非 loopback 直连请求被拒绝，forwarded header 不能伪造 loopback。
- Dashboard auth + same-origin 防护覆盖 approve/deny。
- 固定 client/Agent/installation 绑定，错误组合拒绝。
- Agent token、`server.apiKeys` 和匿名模式的完整认证矩阵。
- `server.apiKeys` 非空时，缺少 password、缺少 Dashboard session、仅伪造 Origin 都不能批准 Device Code。
- 静态 API key 使用 Agent token 保留前缀时配置校验失败。
- 无效或 revoked Agent token 在匿名模式下仍为 401。
- credential 在进入 routing/upstream 前被剥离。
- server 重启后未过期 access token 从数据库恢复到内存。
- `server.apiKeys` 从空切换为非空不会静默撤销已有 Agent family，list/revoke 仍可管理它。

### Catalog

- 三种 `agent` 分支返回同一 schema 1，并携带对应 target；server 输出不含宿主 SDK 字段。
- `agent` query 无 Agent token 拒绝；普通和 Codex models 行为零回归。
- malformed Agent query 在全局 API-key 检查前返回 400；`client_version` 与 Agent 字段并存时只把三个 Agent 字段交给 strict schema。
- alias、Provider metadata、reasoning、tool call、temperature、attachment、modalities、context limits 映射及未知值默认语义。
- 5 分钟 refresh、single-flight、LKG、stale、无 LKG unavailable。
- 真实 400 `unsupported_schema` 和 401 都不覆盖 LKG，且前者不会被降级分类为 `server_error`。
- OpenCode V1、官方 Pi 与 OMP 分别把同一 fixture 映射成各自宿主合法 model config；宿主版本差异不进入 server schema。

### CLI 与文件系统

- host detection、最低版本 warning、global path resolution；Pi 的空 `PI_CODING_AGENT_DIR` 回退默认目录，`~` 与 `~/...` 按被测 home 展开。
- configure 首装、幂等更新、newer adapter 不降级；newer OpenCode adapter 缺固定入口时只补入口，不读取 adapter 资产。
- marker 缺失拒绝、marker 伪造/损坏拒绝；OpenCode 相邻入口缺失可修复，内容冲突或 symlink 拒绝接管和删除。
- staging install 在目标被替换的 race 下先固定 backup、再验证、后 promote；OpenCode 相邻入口以 durable temp + exclusive hard-link commit，竞态创建的 file/symlink 不被覆盖；remove 部分失败时 ownership marker 保留到最后。
- remove 先撤销后删除，且不改宿主 auth/config。
- `list` local-only；`--check` 和 `--authorizations` 的在线状态。
- upgrade 确实由新二进制资产更新 marker 目录；真实 fake binary 覆盖精确版本检查、closed-stdin JSON、stdout/stderr、timeout kill、非零退出、malformed JSON 与 schema-invalid JSON，只告警单项失败。
- 真实 `buildProgram()` 同时注册公开 `agent` 命令树和隐藏 `__agent-post-upgrade`，root help 不暴露隐藏命令；renderer/Commander stdout 仍独立验证。

### 宿主兼容矩阵

- OpenCode `1.17.10` 与当前版本：自动发现相邻 `aio-proxy.js`、V1 login、refresh、catalog、inference，以及 refresh response 到达但 `client.auth.set()` 尚未持久化即崩溃后的明确重新登录诊断，都是必过项；本期不运行 V2 验收。
- 官方 Pi `0.84.2` 与当前版本：login、credential-aware refresh models、inference。
- OMP `17.3.7` 与当前版本：OMP 原生入口、model registry/cache、inference。
- 低于最低版本：configure 只警告，运行失败产生明确诊断。
- OpenCode V2 logout 不列入本期通过标准；V2 启动后再单独定义清理契约。

常规完成门槛是两个 adapter package 的 `test:artifact`、版本固定的宿主兼容矩阵和 `bun run preflight` 全部通过。reference clone 不成为运行时依赖。

## 发布

- 用户可见变更需要 changeset。
- CLI/server/types/core 变更目标至少包含产品包 `aio-proxy`；实际修改的内部包使用相同 bump level。
- Agent adapter 随 aio-proxy lockstep 发布，不建立独立更新渠道。
- release notes 明确列出最低宿主版本、登录命令、remove/logout 差异与升级后需 reload Agent。

## 演进规则

首期以显式的三个 Agent target 验证产品，不提前抽象通用 SDK：

1. 新增 Agent 先作为内置 adapter，证明真实宿主 seam。
2. 只有出现至少第三种可复用安装/认证/catalog 模式，且重复代码成为维护问题时，才提取内部 adapter registry。
3. 只有第三方 adapter 分发成为真实需求时，才设计公开 Agent SDK、信任模型和独立发布协议。
4. Codex 后续若进入 `agent configure`，应使用 Codex 原生配置/auth contract；不能为了统一表面体验伪装成插件。
5. 远程、多实例、团队授权或用户账户进入近期路线图时，再重新评估 Better Auth 或完整 OAuth server。
6. catalog schema 升级必须至少跨一个完整 aio-proxy 发布周期同时服务旧版和新版；旧 schema 不能在 bundled adapter 已支持下一版的同一个发布中立即移除，以容忍单个 post-upgrade 插件更新失败。

## 拒绝的替代方案

### 根据“官方插件请求”豁免 API key

HTTP header、query、User-Agent 和 loopback 来源都不能证明插件身份。该方案等于让任意本机进程绕过鉴权。

### 在插件中隐藏共享 SK

客户端包中的 secret 可以被提取；所有用户共享同一后门，无法逐安装撤销。public client + Device Authorization 是正确边界。

### 公开 Agent catalog

会打破“登录后才能读取目录”的既定顺序，并使 Agent token 只保护推理的一部分。目录与推理使用同一 access token。

### 复用 `server.apiKeys` 存 Agent token

从空列表写入一把 key 会让所有现有匿名客户端立即 401；长期 API key 也没有 installation、过期、rotation 和 family reuse 语义。

### JWT access token

即时撤销仍需查询 installation/family 状态；JWT 只是在 opaque token 数据库之外再增加签名和 key rotation，没有消除持久化。

### Better Auth

其 Device/OAuth 能力完整，但会把 user/session/client/consent/token schema 和身份生命周期带进当前单机单管理员产品。首期内部 Hono 模块更贴合范围。

### OpenCode、Pi、OMP 三个独立插件产品

重复发布与共享逻辑。Pi/OMP 应是一包双入口；OpenCode 本期只需一个导出 V1 `server` 的包，V2 作为后续独立增量。

### 单一 Pi/OMP 宿主入口

OMP 的 Pi compatibility 很强，但没有保证官方 Pi native credential-aware catalog seam 与 OMP ModelRegistry 等价。共享业务 core，不共享宿主绑定。

### 通用 Agent SDK

当前只有两类交付包，接口会基于猜测设计。显式内置 adapter 更小，也不会冻结错误抽象。

### 写静态 Agent Provider 配置

OpenCode、官方 Pi 和 OMP 都已有正式插件 Provider/OAuth seam。静态配置会重新引入配置漂移、secret 写入和额外回滚语义。

### server 停止时离线撤销或强制删除

server 现在通过数据库进程生命周期 ownership lock 保证单一内存 token index，但首期仍不让 CLI 离线打开并迁移身份数据库，也不复制 server 的 mutation/replay/cleanup 语义。强制只删插件还会把仍有效的 credential 留在宿主 auth store。首期因此保持单一在线 mutation 面并 fail closed：修复配置、启动本机 control plane 后再 remove/revoke；只有出现无法启动 server 的真实恢复需求时，才为 CLI 设计取得同一锁的专用 recovery 模式。
