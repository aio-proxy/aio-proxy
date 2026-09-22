# CLI 展示层统一：Clack

日期：2026-09-22
状态：草案

用 `@clack/prompts` 的公开组件统一 `aio-proxy` CLI 的交互提问和指定的人类可读输出。Commander、命令树、业务校验、配置格式、认证协议、LogTape 和退出码契约保持不变。

## 方案

在 `packages/cli` 内增加一个展示模块。命令通过它调用 Clack，并把取消、TTY、颜色和流归属收口到一处。`renderConfigSpec` 继续拥有字段可见性、默认值、校验和 secret 边界；展示模块只负责把一次提问画出来。

`@clack/core`、自绘渲染器、Ink 或其他全屏 TUI 不进入这个仓库。就地堆 `styleText` 也停在这里：Codex 已经有一套手写 spinner 和 dim 文案，再各写一套会让下一次提问继续分叉。

## 非目标

- 不新增首页菜单、向导步骤、实时面板或终端版 Dashboard。
- 不重写 Commander 的 Help，不改命令名、参数和配置文件格式。
- 不把 Clack 引入 `@aio-proxy/core`、`@aio-proxy/server` 或 `@aio-proxy/plugin-sdk`。
- 不替换 LogTape，不改 `run` 启动之后的运行日志。
- 不改 `EXIT` / `toExitCode` 的分类。
- 不为还没有 `--json` 的命令新增机器输出。
- 不重绘本轮范围以外的人类文案：`service`、`upgrade`、`reload`、`dashboard`、`config show` / `validate`、`agent list` / `configure`（Codex 以外）、更新提示横幅。
- 取消时不回滚已经完成的 npm 安装、配置写入或外部登录。

## 现状

交互提问全部来自 `@inquirer/prompts`，类型绑在 Inquirer 的函数参数上：

| 位置 | 组件 |
| --- | --- |
| `packages/cli/src/plugin-commands/form/render.ts` | `input`、`password`、`confirm`、`select`，作为 `PluginFormPrompts` 的默认实现 |
| `packages/cli/src/plugin-commands/plugin/deps.ts` | 同一组默认实现，外加信任 / 删除 / 清理确认 |
| `packages/cli/src/plugin-commands/provider-login/deps.ts` | 账号表单，以及手动回调 URL 的 `input` |
| `packages/cli/src/plugin-commands/provider-login/capability.ts` | capability `select`，手动端口确认 `confirm` |
| `packages/cli/src/agent/codex/codex.ts` | `input`、`select`、`checkbox`、`confirm`，以及写到 stderr 的手写 spinner |

`PluginFormPrompts` 已经可以注入。表单测试用替身覆盖默认值、条件字段、空 secret、`--clear-secret`、数字 / JSON 校验和外部 `AbortSignal`。这些测试继续走替身，不启动 Clack。

人类输出里，本轮要改的是这几处，它们今天都把结果交给调用方传入的 `print`（默认 `console.log`，即 stdout），`run` 的启动句除外（`console.error`）：

- `run` 监听成功后的一句启动摘要
- `status`，以及 `status --deep` 在人类模式下把 provider 响应 `JSON.stringify` 到 stdout
- `doctor` 的三行环境报告
- `provider list` / `provider test` 的管道符表格，以及 `provider list --installed` 的包名、版本、路径
- `plugin list` 的一行一个插件

机器输出已经分开的路径保持原样：`status --json`、`config show`、`agent list --json`、`completion`、`--version`、`config path`、`agent auth` 的协议 stdout、隐藏命令 `__agent-post-upgrade`。

非交互缺口今天已经有明确失败，展示层继续调用它们，不另造确认：

- 插件确认：`PluginConfirmationRequiredError`
- capability 有歧义：`ProviderCapabilityAmbiguousError`
- Codex 配置：返回 `non_interactive` 的取消结果，进程仍按该结果的现有路径结束
- 非 TTY 的 loopback：现有端口和手动回调错误

## 决定

| 题目 | 决定 |
| --- | --- |
| 依赖 | 只在 `@aio-proxy/cli` 的 `package.json` 加入 `@clack/prompts`。选用包含下列公开 API 的当前稳定版：`text`、`password`、`confirm`、`select`、`multiselect`、`intro`、`outro`、`cancel`、`note`、`spinner`、`isCancel`、`updateSettings`，以及每次调用的 `signal`、`input`、`output`。不加入 `@clack/core`。两个包以上才进 catalog，这里不进 |
| 使用的组件 | 上面列出的那些。不用 `group`、`tasks`、`progress`、`box`、`stream`、`autocomplete`、`path`、`date` |
| 引导线 | 保持库默认的 `withGuide`。不关引导线，不套第二层边框，不用 ASCII logo、渐变或装饰性 emoji |
| 品牌 | 交互标题写 `aio-proxy`。通过 `aiop` 启动时标题同样是 `aio-proxy` |
| 一次会话 | 一个命令最多一个 `intro`。`renderConfigSpec`、capability 选择和手动回调都不单独再打印标题。第一次真正提问时才打印 `intro`；全程没有提问则没有 `intro` / `outro` |
| 结束行 | 打印过 `intro` 的成功路径用一句完成语做 `outro`，不再另加「完成」。提问取消时调用一次 `cancel`，不调用 `outro`；spinner 的取消行由库写出，不再调用第二次 `cancel`。Codex 把取消收成自己的结果时不打印这句，见「取消、错误和终端」。插件的添加、配置、删除、清理在发生过提问时，把今天的完成句从 stdout 移到这句 `outro`：`cli.plugin.added`、`cli.provider.package_installed`、`cli.plugin.configured`、`cli.plugin.removed_secrets_purged`、`cli.plugin.removed_secrets_retained`、`cli.plugin.pruned`。没有提问时这些句子仍走 stdout。provider 登录的 stdout 仍只打印 provider id，`outro` 另用一条新的短句。Codex 配置的现有多行结果仍走 stdout，`outro` 另用一条新的短句，不复制结果行 |
| 提问流 | 交互提示、spinner、`intro`、`outro`、`cancel` 写入 stderr |
| 结果流 | 今天写到 stdout 的数据行留在 stdout：provider id、授权 URL、列表、诊断、`status` 的人类结果。`run` 启动摘要留在 stderr |
| 查询命令 | `status`、`doctor`、provider / plugin 列表不进入会话，不打印 `intro` |
| 三个开关 | 能否提问、能否上色、是否机器输出，各自判断 |
| 取消 | 适配层把 Clack 取消值变成抛出的 `PromptCancelledError`。提问取消调用一次 `cancel`，不调用 `outro`。spinner 的取消行由库写出，不再调用第二次 `cancel`。UI 模块不调用 `process.exit` |
| Inquirer | 所有调用点迁完后再从依赖和 lockfile 删除 `@inquirer/prompts` |

## 视觉

交互会话画在 stderr 上，形状与 Clack 默认引导线一致：

```text
┌  aio-proxy · 配置插件
│
◇  API Key
│  ********
│
└  配置已保存
```

密码掩码使用 `*`，与现在的 Inquirer 掩码一致。secret 的值不出现在已完成步骤、`outro`、日志或错误文案里。

查询命令把标签弱化、值写全。状态同时有文字和记号，文字来自现有文案。普通结果不加边框。本轮唯一的 Clack `note` 是 Codex 配置里「没有可用 API key」那句现有状态；它写在 stderr 会话里。其他命令不新增说明块。

Provider 行（`provider list`、`provider test`、`status --deep`）始终一个字段一行，两个 provider 之间空一行。列的顺序和今天的 `printProviderTable` 相同：id、kind、enabled、passthrough、last status、last latency、state、catalog、plugin、capability、account、expires at、catalog last success、diagnostic、suggested command；`--probe` 时再加 probe。标签用现有表头文案。没有 provider 时 stdout 打印一行本地化的空列表说明，退出码仍是 0。

`doctor`、`status` 的服务器行、`plugin list` 和 `provider list --installed` 在一行的显示宽度不超过 `stdout.columns` 且列数至少 80 时保持一行；否则一个字段一行。字段集合不变：

- `doctor`：配置路径、服务器可达性和地址与版本、已安装插件数
- `status`：运行状态、地址、版本；不可达时仍抛 `StatusNotRunningError`
- `plugin list`：显示名、包名、状态、说明。状态选择顺序不变：未安装，已安装则为已配置，内置覆盖为内置，加载失败再用诊断摘要
- `--installed`：包名、版本、入口所在目录。没有已安装包时不打印，和现在一样

`run` 在 `Bun.serve` 成功之后写一次 stderr 摘要，包含现有启动文案里的 API 地址和 Dashboard 地址。写完即结束。之后的日志仍由 LogTape 输出，屏幕不刷新，也不留 spinner。

`status --deep` 的人类视图用上面的 provider 行。响应先按 `provider list` 已有的 provider 列表 schema 取 `providers`。`--json` 仍输出今天的对象，包括 `providers` 和 `deepFailure`。鉴权失败和探测失败仍打印现有的两句本地化文案。schema 对不上时，经同一个 `print` 在 stdout 打一行新的本地化说明，不抛错，退出码保持 0。不把原始 JSON 打到终端。

## 输出与兼容

### 能否提问

同时满足才提问：

- `process.stdin.isTTY === true`
- 提问输出流 stderr 的 `isTTY === true`
- 环境变量 `CI` 未设置、空串、`0` 或 `false`
- 这次调用不是该命令已有的机器输出（`status --json`、`agent list --json`、`config show`，以及补全、版本、路径、认证协议和 `__agent-post-upgrade`）

stdout 是否为 TTY 不影响能否提问。参数已经足够时直接执行，不先打开会话。缺少必填输入时走「现状」里的既有失败，不挂起，也不把确认的默认答案改成同意。

这比今天更严。插件和 provider 登录现在只看 stdin；Codex 配置看 stdin 和 stdout。迁完之后，stdin 是 TTY 但 stderr 被重定向时，按非交互处理。

### 能否上色

目标流是 TTY，且 `NO_COLOR` 未设置时才写颜色。`NO_COLOR` 不禁止提问。重定向的 stdout 和 stderr 不含颜色码和光标控制序列。状态行在无颜色时仍然能读，因为文字还在。

### 机器输出

机器路径不调用展示模块。stdout 的内容和退出码与现在一致。不因为检测到 TTY 就在这些路径前面加标题。更新提示仍由 `shouldPrintUpdateBanner` 决定，仍写现有的 stderr 文案，不放进 Clack 会话。

### 窄终端

用 `process.stdout.columns` 和 `Bun.stringWidth` 判断「视觉」一节里的单行是否放得下。列数未知时视为放不下。不截断 provider id、包名和路径。中文宽度取 `Bun.stringWidth`。

### 文案

新增标题、确认的「是 / 否」、取消语和意外 payload 说明进入 `@aio-proxy/i18n`，五种 locale 一起加：`en`、`zh-Hans`、`zh-Hant`、`ja`、`ko`。字段标签、选项和插件说明继续用现有的 `LocalizedText`。

Clack 的 `confirm` 必须传入本地化的 `active` / `inactive`。库自己的 `initialValue` 默认是 `true`，适配层在调用方没有给出默认值时传 `false`。会话开始时用 `updateSettings` 把会显示出来的库文案（取消、错误）设成当前 locale。选择列表底部的按键说明如果没有公开文案槽，就保留库默认，不为它自建组件。

## 提问语义

`PluginFormPrompts` 改成 CLI 自己的最小类型，不再引用 Inquirer 的 `Parameters<typeof ...>`。替身测试只依赖这个类型。

```ts
type PromptContext = { readonly signal?: AbortSignal };

type TextAsk = {
  readonly message: string;
  readonly placeholder?: string;
  readonly defaultValue?: string;
};

type PasswordAsk = { readonly message: string; readonly mask?: string };

type ConfirmAsk = { readonly message: string; readonly initialValue?: boolean };

type SelectChoice<T> = {
  readonly label: string;
  readonly value: T;
  readonly hint?: string;
};

type SelectAsk<T> = {
  readonly message: string;
  readonly choices: readonly SelectChoice<T>[];
  readonly initialValue?: T;
};

type PluginFormPrompts = {
  readonly input: (ask: TextAsk, context?: PromptContext) => Promise<string>;
  readonly password: (ask: PasswordAsk, context?: PromptContext) => Promise<string>;
  readonly confirm: (ask: ConfirmAsk, context?: PromptContext) => Promise<boolean>;
  readonly select: <T>(ask: SelectAsk<T>, context?: PromptContext) => Promise<T>;
};
```

适配规则：

- `placeholder` 只作为 Clack 的 placeholder。空提交不会得到 placeholder 文本。
- 文本、数字、JSON 的现有默认值同时传给 Clack 的 `initialValue` 和 `defaultValue`，用户能看见并能改。清空后直接回车仍得到该默认值，和现在的 Inquirer `default` 一样。
- 没有默认值的文本空提交返回 `""`。适配层不把它改成 `undefined`；表单层自己决定空字符串是否入列。
- secret 不传 `initialValue` 或 `defaultValue`。Clack 空提交返回 `""`。`renderConfigSpec` 继续把 `""` 解释为保留原 secret；`--clear-secret` 继续在表单层删除该键。适配层不解释这两件事。
- 数字 `0` 以字符串 `"0"` 作为默认值，解析后仍是数字 `0`，不会被当成缺省。
- 布尔 `false` 是确认的有效结果，不是取消，也不是跳过。
- `select` 的 `value` 保持 `string | number | boolean`，不改成字符串。`false` 和 `0` 要能被选中并原样返回。
- Codex 的 `checkbox` 改成 `multiselect`。原来 `checked` 的项成为预选项。空提交仍用现有文案拒绝。这个方法只给 Codex 用，不放进 `PluginFormPrompts`。

`renderConfigSpec` 里的可见条件、`compatibleDefault`、schema 校验和 secret 边界逻辑不改。

## 模块

```text
packages/cli/src/ui/
├── index.ts          # 只做导出
├── mode.ts           # canPrompt、useColor
├── prompts.ts        # Clack 适配和 PromptCancelledError
├── session.ts        # 懒 intro、outro、cancel、spinner
├── summary.ts        # status、doctor、列表的纯文本行
├── mode.test.ts
├── prompts.test.ts
├── session.test.ts
└── summary.test.ts
```

`index.ts` 以外的文件不从 `ui/` 外面被引用。命令依赖注入的 `prompts`、`confirm`、`selectCapability`、`readManualCallbackUrl` 改为这个模块的默认实现；测试仍可注入替身。手动回调和手动端口确认的提问文案仍是调用方今天传入的 URL，不改成另一句说明。

```ts
type CommandSession = {
  readonly prompts: PluginFormPrompts;
  confirm(ask: ConfirmAsk): Promise<boolean>;
  select<T>(ask: SelectAsk<T>): Promise<T>;
  multiselect<T>(ask: SelectAsk<T> & { readonly initialValues?: readonly T[] }): Promise<readonly T[]>;
  spin<T>(message: string, task: (signal: AbortSignal) => Promise<T>, context?: { readonly signal?: AbortSignal }): Promise<T>;
  note(message: string): void;
  finish(success: string): void;
  close(error?: unknown): void;
};

function createCommandSession(title: string): CommandSession;
function canPrompt(io: { stdinIsTTY: boolean; stderrIsTTY: boolean; env: NodeJS.ProcessEnv }): boolean;
function useColor(streamIsTTY: boolean, env: NodeJS.ProcessEnv): boolean;
```

`canPrompt` 使用「能否提问」的规则，不含机器输出判断；机器输出由命令在调用前排除。`createCommandSession` 在 `canPrompt` 为假时抛出错误且不读 stdin。生产路径在调用前已经走既有的非交互失败，这条抛出只用来挡住误调用。

命令在 `try/finally` 中持有 session。成功时调用 `finish(message)`：只有已经打印过 `intro` 才写 `outro`。`finally` 调用 `close(error)`。`close` 只停掉残留 spinner 并恢复终端：不打印 `Error.message`，不调用失败 `outro`，也不修改错误对象。失败之后没有 `outro`。未 `finish` 且已经打印过 `intro` 时，只有提问产生的 `PromptCancelledError` 打印一次 `cancel`。spinner 已经写出取消行时，这次 `close` 不再打印第二句。确认选否是业务拒绝，不是 Clack 取消，不画成 `cancel`。其余错误一律交给现有的 `formatCliError`。

`summary.ts` 返回字符串，由现有 `print` 写出。它不调用 Clack 会话。颜色只在 `useColor(stdoutIsTTY, env)` 为真时写入；测试覆盖的是无颜色文本。

`session.spin` 把 `AbortSignal` 传给任务，并 await 到任务自己结束。用户 Ctrl+C 时 abort 该信号，任务协作退出后才拒绝 `PromptCancelledError`。外部 abort 时任务收到这个中止，结束后拒绝 `signal.reason`。不要用 `Promise.race` 把仍在运行的扫描当成已经停止。`@clack/prompts` 1.8.1 的 spinner 先写出取消行，再调用 `onCancel`；之后 `clear()` 不会清掉那一行。stderr 不是 TTY 或处于 CI 时不动画，但仍把外部信号（没有外部信号时用一个未中止的新信号）传给任务。调用方如果会在任务期间写 stderr，改用一次静态进度行，不动画。本轮不改 LogTape。`run` 的进程生命周期不放进 spinner。

Codex 的手写 `withSpinner` 和 `styleText` 状态行删掉，改走 `session`。

## 取消、错误和终端

用户取消（Clack `isCancel`，或提问期间的 Ctrl+C）抛出 `PromptCancelledError`，`message` 为空。空的 `error.message` 不能阻止顶层再打印：`main` 看的是 `formatCliError` 的结果，未识别异常会变成非空的通用内部错误。`formatCliError` 遇到 `PromptCancelledError` 时先返回 `{ message: '' }`，现有的「空消息不再打印一行」分支才不会打出第二句。不要把该错误加入 `isKnownCliUserError`，否则退出码会从 `2` 变成 `1`。未捕获时 `toExitCode` 仍是 `2`，和今天未分类的 Inquirer 退出一致。

调用方传入的 `AbortSignal` 已经 abort，或在提问、扫描期间 abort：拒绝原因用 `signal.reason`，不换成 `PromptCancelledError`，也不把取消标记写进表单值。

其他错误不另画 Clack 错误行，也不在 `close` 里写出 `Error.message`。`AppError` 的用户文案由类型和 `messageKey` 重新生成，清空 `message` 不能代替 `formatCliError`。`cancel` 的可见文案用新增的本地化取消语，不用 `PromptCancelledError` 的空消息。Codex 若把取消收成自己的取消结果，就在向导内部捕获 `PromptCancelledError`，再调用不带错误的 `close()`。这种 `close` 只停 spinner 并恢复终端，不打印 `cancel` 或 `outro`；下面只保留 Codex 现有的取消结果行。提问取消时 Clack 只画删除线框，那一句取消语来自这次 `cancel`。spinner 取消已经由库写出那一行，不再调用第二次 `cancel`。

展示模块不调用 `process.exit`，不安装会退出进程的 SIGINT 处理。提问和 spinner 都要 await 到结束，以便恢复 stdin 的 raw mode 和光标。

已完成的外部操作不回滚。

## 迁移顺序

每步都保持现有测试可跑。Inquirer 留到最后一步再删。

1. 加入 `ui/`、依赖和适配测试。默认实现还没换。
2. 插件表单、插件确认改走适配层。
3. provider 登录的选择、账号表单、手动确认和手动回调 URL 改走适配层。
4. Codex 提问和 spinner 改走适配层，并删掉手写 spinner。
5. `run` 摘要、`status`、`doctor`、provider 列表、plugin 列表改走 `summary`。
6. 删除 `@inquirer/prompts`。

实现 PR 带一条 changeset，对象是 `aio-proxy`。说明人类可读的提问和指定结果换了统一的终端样式；`--json`、补全、版本和认证协议输出不变。本设计文档不带 changeset。

## 验收

- 迁过的命令共用标题、提问、等待和结束样式。没有提问的命令不出现标题。同一个命令不出现两个标题，取消或失败不出现两句错误。
- 现有表单测试继续通过，包括默认值、条件字段、空 secret、显式清除、`0`、`false`、非法数字 / JSON，以及把同一个 `AbortSignal` 传给每次提问。
- 适配测试覆盖：placeholder 不会成为提交值；文本默认值在空提交时返回；secret 空提交是 `""`；`select` 能返回 `0` 和 `false`；`confirm` 在未指定默认值时初始为否；`isCancel` 变成 `PromptCancelledError` 而不是字段值；外部 abort 拒绝 `signal.reason`。
- `status --json`、`agent list --json`、`config show`、`completion`、`--version`、`config path` 的 stdout 不含引导线、颜色码或完成语。
- 人类输出在 TTY、非 TTY、`CI`、`NO_COLOR`、中文窄终端下含义还在。`NO_COLOR` 下仍可提问。`CI` 和非 TTY 不等待输入。
- 发生过提问之后抛出 `new Error('unknown plugin secret')`：`close` 不把原文写到 stderr，也不修改 `error.message`。随后的 `formatCliError` 仍是通用内部错误，原文不出现，错误提示不重复。
- `PromptCancelledError` 经 `formatCliError` 得到空消息，不出现通用内部错误。`isKnownCliUserError` 为假，`toExitCode` 仍是 `2`，取消文案只出现一次。Codex 自己收成取消结果的路径不额外打印 `cancel` 或 `outro`。
- spinner 在任务尚未结束时取消：任务先观察到 `AbortSignal` 并协作退出，然后才拒绝 `PromptCancelledError`。外部 abort 拒绝 `signal.reason`。对真实 `@clack/prompts` spinner 发出 `SIGINT` 时，取消行先出现，随后的 `clear()` 清不掉它，进程不退出。
- 用 `bun` 直接跑 `packages/cli/src/main.ts`，并用现有二进制脚本打出一个本机目标。两条路径都做冒烟：`--version` 只有版本。终端冒烟把 CLI 当作直接子进程；读取 PTY 时把 `EIO` 当作结束并读完尾部输出；断言 CLI 自己的退出码。比较运行前后的 `ECHO`、`ICANON`、`ISIG`。光标隐藏码 `\x1b[?25l` 之后必须还有恢复码 `\x1b[?25h`。除拒绝和 Ctrl+C 外，还要有一次不访问注册表的成功交互（`plugin prune` 回答是）。冒烟不替代上面的单元测试。
