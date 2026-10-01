# CLI 视觉语言

日期：2026-10-01
状态：草案
取代：PR #423（help 上色）；`2026-09-22-cli-clack-display-design.md` 中「不重写 Commander 的 Help」与「Provider 行始终一个字段一行」两条决定

给 `aio-proxy` 的人类可读输出定一套统一的视觉语言：单色排版，颜色取自 Dashboard 的设计 token，只用来标注分组标题和状态。help、查询命令、列表、错误和更新提示都走同一个样式模块。一个 PR 交付。

## 为什么

#423 只给 help 上了绿 / 青 / dim 三种颜色，排版没变，和其他命令的 `key: value` 输出也不统一。`agent list` 一个 agent 挤一行、分号分隔；`provider list` 每个 provider 16 行。颜色多但没有层次。

## 非目标

- 机器输出逐字节不变：`--json`、`completion`、`config show`、`config path`、`--version`、`agent auth` 的协议 stdout、隐藏命令。
- 交互会话（Clack 的 `intro` / 提问 / `outro`）保持 Clack 自带样式。
- 不改 LogTape 运行日志、退出码、命令名和参数。
- 错误不新增提示文案：只换前缀记号，不为每类错误补「下一步」。
- 不加 `FORCE_COLOR`、`--color`、`--wide` 开关。

## 视觉语言

### 角色

只有六个角色。输出代码只引用角色，不引用颜色。

| 角色 | 用途 | Token（`packages/ui/src/styles.css`） | 真彩色 | 16 色回退 |
| --- | --- | --- | --- | --- |
| `heading` | 分组 / 区块标题，加粗 | `--primary` 的 teal 系，取 teal-600 | `#009689` | 粗体 cyan (36) |
| `strong` | 命令名、ID、主值 | 终端前景色，加粗 | — | 粗体 |
| `muted` | 描述、次要信息、表头、`→` 提示 | `--muted-foreground` olive-500 | `#7c7c67` | bright black (90) |
| `success` | 正常 / 就绪 | `--chart-success` teal-600 | `#009689` | cyan (36) |
| `warning` | 需要注意 | Dashboard 现用 amber-600 | `#e17100` | yellow (33) |
| `danger` | 失败 | `--chart-error` red-500 | `#fb2c36` | red (31) |

`heading` 和 `success` 同色，与 Dashboard 一致。状态永远同时有记号和文字，不只靠颜色区分。teal-600 / red-500 在白底和深底上都过对比度，选它们而不是更亮的 500 档（teal-500 对白底只有 2.45:1）。正文不指定颜色，沿用终端前景色。

### 记号

| 记号 | 含义 | 角色 |
| --- | --- | --- |
| `●` | 正常 / 运行中 | `success` |
| `▲` | 需要注意 | `warning` |
| `✗` | 失败 | `danger` |
| `○` | 未运行 / 未启用 | `muted` |
| `→` | 下一步建议的命令 | `muted` |

### 颜色深度

按目标流判断，每个流各自判断：

1. 流不是 TTY，或 `NO_COLOR` 已设置：不写任何转义码。
2. `COLORTERM` 是 `truecolor` 或 `24bit`：用上表真彩色 hex。
3. `TERM` 含 `256color`：`Bun.color(hex, 'ansi-256')`。
4. 其他：上表 16 色回退。

16 色回退手写，不用 `Bun.color(..., 'ansi-16')`：它把 amber 映射成亮红，警告会看起来像失败。

无颜色时排版、对齐、记号完全不变，只少颜色。`grep` / `awk` 拿到的列与 TTY 下一致。

## Help

- 根命令 help 第一行：`aio-proxy 0.35.1 · <根描述>`（名称 `strong`，其余 `muted`），不再在 Usage 之后重复描述。子命令 help 不加这一行。
- 根命令按 Commander 15 的原生 `helpGroup()` 分组：
  - Server：`run`、`status`、`reload`、`dashboard`、`service`
  - Providers：`provider`、`plugin`
  - Agents：`agent`
  - Setup：`config`、`doctor`、`completion`、`upgrade`、`help`
- 标题去掉结尾冒号，本地化：分组名、`Usage`、`Options`、`Commands`、`Arguments` 进 i18n。`Usage` / `Arguments` 这类 Commander 硬编码的标题经 `styleTitle` 映射成本地化文本。
- 命令名和 flag 用 `strong`，`<参数>` / `[options]` 用 `muted`，描述用 `muted`，标题用 `heading`。
- `-h, --help` 和 `help [command]` 的描述改用本地化文案。
- 列宽沿用 Commander 的 `displayWidth`，它已忽略 ANSI。

## 各命令的输出

示例为 TTY 下的排版；颜色按「角色」一节。

### `run`

写在 stderr，`Bun.serve` 成功后一次：

```text
● AIO Proxy is running
  API        http://127.0.0.1:9317/v1
  Dashboard  http://127.0.0.1:9317
```

### `status`

```text
● Running  http://127.0.0.1:9317 · v0.35.1
○ Not running  http://127.0.0.1:9317
```

`status --deep` 的 provider 部分用下面的 provider 表格。不可达时仍抛 `StatusNotRunningError`。

### `doctor`

一项一行的检查清单，标签列对齐：

```text
● Config file  ~/.aio-proxy/config.jsonc
● Server       http://127.0.0.1:9317 · v0.35.1
▲ Plugins      none installed
```

服务器不可达是 `✗`。没有已安装插件是 `▲`。

### `provider list` / `provider test`

默认是表格，第一列是状态记号：

```text
  ID                                KIND   STATE        CATALOG  LATENCY
● carpool                           api    ready        -        -
● antigravity-wang-baran-gmail-com  oauth  ready        fresh    212ms
▲ copilot                           oauth  ready        stale    -
    token expired
    → aio-proxy provider login --provider copilot
✗ broken                            api    unavailable  -        -
    config invalid
○ disabled-one                      api    ready        -        -
```

- 记号：`enabled: false` 为 `○`；`state.status: 'unavailable'` 为 `✗`；`ready` 且（`catalog: 'stale'` 或带诊断）为 `▲`；其余 `●`。
- `--probe` 时加 PROBE 列，`OK` 为 `success`，`FAIL` 为 `danger`。
- 行下的缩进子行：先是诊断摘要（`muted`），再是 `dashboardProviderSuggestedCommand` 的 `→` 行。都没有就不打印子行。
- 恰好一个 provider 时（`--filter` / `provider test`）改为详情视图：标题行 `● <id>`，下面是今天全部 16 个字段（`--probe` 时 17 个），标签 `muted`、左对齐成一列。
- 表格里省掉的字段（passthrough、plugin、capability、account、expires at 等）在详情视图和 `--json` 里都有。
- 没有 provider 时打印现有的本地化空列表说明，退出码 0。

### `plugin list` / `provider list --installed`

```text
  NAME                PACKAGE                              SOURCE
● Claude Pro/Max      @aio-proxy/plugin-claude-code        built-in
    Use a Claude Pro or Max account to access models
```

插件说明是缩进的 `muted` 子行。状态记号：已配置 / 内置为 `●`，未安装为 `○`，加载失败为 `✗`（诊断摘要做子行）。`--installed` 是 PACKAGE / VERSION / DIRECTORY 三列，没有记号。

### `agent list`

一张表：所有 agent 宿主加上 Codex 各占一行。

```text
  AGENT     HOST     INTEGRATION  ENDPOINT                     CATALOG  AUTH
● pi        0.99.2   managed      http://127.0.0.1:9317        stale    not_checked
● codex     -        managed      http://127.0.0.1:9317/v1     -        not_checked
    auth keep-chatgpt
○ opencode  unknown  absent       -                            missing  not_checked
```

- 记号：`absent` 为 `○`；`unresolved`、`recovery_required`、endpoint 不一致、宿主版本不受支持为 `▲`；其余 `●`。
- 子行：`unresolved` 的原因、configuration modified / missing / recovery required 的字段、Codex 的认证模式。
- 表格之后，有对应数据时追加一个 `heading` 小节：Server 状态、capabilities、`--authorizations` 列表（authorizations 本身也是表格）。
- installation id、adapter 版本、最低宿主版本、schema 兼容性不进表格，在 `--json` 里。

### 错误

`main` 捕获的错误写成 `✗ <message>`，多行消息从第二行起缩进两格。空消息（例如 `status` 不可达）仍然不打印。

### 更新提示

```text
▲ Update available 0.35.1 → 0.36.0  → aio-proxy upgrade
```

仍写 stderr，仍由 `shouldPrintUpdateBanner` 决定。

### 其余人类文案

`service`、`upgrade`、`reload`、`dashboard`、`config validate`、`agent configure/remove/revoke`、插件的添加 / 删除完成句：只给已有的成功 / 失败句加 `●` / `✗` 前缀，文案不改。

## 结构

```text
packages/cli/src/ui/
├── style/      角色、记号、颜色深度判断。唯一写 ANSI 转义的地方
├── table/      列对齐（Bun.stringWidth）、记号列、缩进子行
├── help/       configureHelp 钩子、helpGroup 分组、标题本地化
└── summary/    各命令的格式化函数，改用 style + table
```

- `style` 导出 `createStyle(stream, env)`，返回六个角色函数和五个记号。调用方传入实际写入的流（stdout 或 stderr），不在模块里读全局。
- token hex 只写在 `style` 里一处，注释指向 `packages/ui/src/styles.css`。CLI 不能 import CSS，为几个值加同步脚本不值得。
- `table` 只负责排版：输入表头、行（每行可带记号和子行）、样式，输出字符串数组。不知道 provider 或 agent。
- `agent/output.ts` 里的列表渲染改用 `table`；把 agent 列表整句的 i18n 消息拆成列标题和值。
- `ui/summary/summary.ts` 和 `agent/output.ts` 超过 400 行时按命令拆开。
- 现有 `labelValue` 里手写的 `\u001b[2m` 并入 `style`。

### 删除

- `formatPluginLines` / `formatInstalledLines` / `formatDoctorLines` 里「放得下就一行，否则一字段一行」的 `fits` 分支：表格和清单在任何宽度下都是同一种排版。窄终端由终端自己换行，不截断 ID、包名和路径。
- 整句的 `cli.agent.list.target`、`cli.agent.list.unresolved`、`cli.agent.codex.list`、`cli.agent.codex.list_auth` 消息，换成列标题和子行文案。

## 文案

新增的分组名、Help 标题、表头、子行模板、`--help` 描述进 `@aio-proxy/i18n`，五种 locale 一起加：`en`、`zh-Hans`、`zh-Hant`、`ja`、`ko`。删掉的整句消息从五个 locale 一起删。枚举值（`ready`、`managed`、`not_checked` 等）保持原样，不翻译，和 `--json` 一致。

## 测试

只测会坏、且坏了用户看得到的行为：

- `style`：非 TTY 或 `NO_COLOR` 时输出不含 `\u001b`；16 色下 `warning` 是 33 而不是 31 / 91（防止警告看起来像失败）；真彩色下 `heading` 是 token 值。
- `table`：中日文和 ASCII 混排时各列起始显示列一致；子行缩进在记号列之后。
- Help：根 help 含四个分组和版本头行；非 TTY 下 help 不含转义码。
- provider：记号选择（disabled / unavailable / stale / 正常）；单个 provider 走详情视图，字段数与今天一致；空列表打印说明。
- agent：`absent` / `unresolved` 的记号和子行；`--json` 输出与改动前逐字节相同。
- 机器路径：`status --json`、`agent list --json` 的回归断言保留。

现有 `main.rendering.test.ts`、`summary.test.ts`、`output.test.ts` 里断言旧排版的用例改成新排版，不保留旧排版的断言。

## 发布

一条 changeset，`aio-proxy` 和 `@aio-proxy/cli` 都是 `minor`（`provider list` 和 `agent list` 的默认人类输出格式变了）。#423 未合并，仓库里没有它的 changeset；本 PR 在描述里注明取代它，关闭由维护者决定。
