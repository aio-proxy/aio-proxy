# OAuth Plugin Icon and Quota Capability 设计

日期：2026-07-18
状态：已批准

## 与既有设计的关系

本文增补 `2026-07-14-oauth-plugin-system-design.md` 与
`2026-07-16-oauth-plugin-review-hardening-design.md`。未在本文修改的既有决策继续有效。

本次只扩展 OAuth capability 的宿主中立 SDK 契约：

- capability icon；
- quota snapshot；
- 账号级 quota reset；
- 对新增数据与副作用的宿主验证、隔离和并发语义。

网页回调能力经代码调查后确认已经由宿主持有。本文不修改
`AuthorizationPort.loopback()`；统一品牌回调页及其可选内容插槽作为独立后续需求。

## 背景

当前 `OAuthAdapter` 已封装账号配置、登录、credential schema、模型目录与运行时创建，
但缺少两个展示和账号管理能力：

1. 宿主无法从 capability 获取品牌 icon。
2. 宿主无法读取账号的上游 quota，也无法调用渠道提供的主动 quota reset。

对
[Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)
的调研显示，Codex quota 包含多个独立时间窗口，并额外暴露账号级 reset-credit 库存。
消费 reset credit 时不选择 quota 窗口或具体 credit；调用成功后再重新读取 quota。

本文保留这组有用的能力边界，但不复制该项目为不同 provider 建立的 UI 专用状态类型。
插件必须把上游差异归一化为一个小型、宿主中立的公共模型。

## 目标

- 让每个 OAuth capability 声明自己的 icon。
- 为 LobeHub 静态 SVG key 提供精确的发布类型，而不把完整 key 列表带入运行时。
- 允许插件按需读取扁平、有序的 quota snapshot。
- 支持 Codex 类账号级 reset-credit 库存与主动 reset。
- 明确 reset 的实时预检、串行化、无自动重试和刷新隔离语义。
- 保持旧插件、新宿主、旧宿主之间的渐进兼容。
- 保证合法 adapter 注册后的 icon 降级和 quota operation 故障不影响 provider 的模型路由能力。

## 非目标

- 不设计 Dashboard 如何渲染、加载、缓存或回退 icon。
- 不设计 Dashboard quota 页面、按钮、确认框或刷新交互。
- 不修改 loopback callback URL、回调 HTML 或网页内容插槽。
- 不把 quota 扩展成账单、消费明细、定价或本地 request usage 统计。
- 不提供 quota group/bucket 层级；v1 只返回扁平数组。
- 不提供通用插件 action/command 系统；v1 只有可选的账号级 quota reset。
- 不允许 reset 指定某个 quota item 或某张 reset credit。
- 不为 quota read 声明 static/TTL cache policy。
- 不定义 quota 的 HTTP endpoint、API DTO、CLI 命令或 Dashboard 调用入口；这些消费者另立规范。
- 不把 quota 塞入只服务模型路由的 `RuntimeProviderInstance.raw/model` capability。

## 核心决策

| 决策点              | 结论                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Icon 所有权         | 属于 `OAuthAdapter` capability，不属于 plugin package metadata                                                                       |
| Icon 写法           | 一个字符串联合：Lobe key、HTTP/HTTPS URL 或受限图片 data URL                                                                         |
| Lobe key 类型       | `plugin-sdk` 在 Rslib 配置求值时扫描依赖、写入 build cache，并以 `banner.dts` 注入 bundled declaration 的精确 union                  |
| Lobe key 构建入口   | `bun run build`/`bun run preflight` 是唯一权威 declaration 构建；不增加独立 codegen script 或 postinstall                            |
| Lobe key 运行时校验 | 不发布完整 key 列表；只校验 slug 语法，精确存在性由 TypeScript union 保证                                                            |
| 非法 icon           | 丢弃 icon 并记录结构化警告；插件和 capability 继续加载                                                                               |
| Quota 所有权        | `OAuthAdapter.quota`，与 `catalog` 并列并复用 `AccountContext`                                                                       |
| Quota 结构          | 扁平、有序的 `items[]`，剩余量使用 0–1 的 ratio                                                                                      |
| 时间表示            | epoch milliseconds，与现有 `expiresAt` 一致                                                                                          |
| Reset 作用域        | 账号级，不绑定 quota item 或 reset credit ID                                                                                         |
| Reset 库存          | snapshot 返回 `availableCount` 与可选 credit 明细                                                                                    |
| Reset 返回值        | `Promise<void>`；后续 quota refresh 是独立操作                                                                                       |
| Reset 门禁          | provider 锁内实时 `read()`，只有 `availableCount > 0` 才执行                                                                         |
| Reset 并发          | 按 Provider ID 串行化，不自动重试                                                                                                    |
| Quota 调用面        | 独立的宿主 quota operation service；不扩展模型路由 runtime，也不在本文定义外部 endpoint                                              |
| Quota 缓存          | SDK 不声明 policy；普通 read 的 single-flight 是宿主 MAY 优化，消费者决定后续缓存                                                    |
| 故障范围            | 合法注册后的 icon/quota 操作仅使当前操作失败或降级，不改变 provider routing state；registration contract error 仍使 plugin load 失败 |
| SDK API version     | 保持 `PLUGIN_API_VERSION = 1`，新增字段均为可选兼容扩展                                                                              |

## 公共 SDK 契约

### Icon 类型

概念类型如下：

```ts
export type OAuthIcon = LobeIconKey | `http://${string}` | `https://${string}` | `data:image/${string}`;
```

`OAuthAdapter` 增加可选字段：

```ts
type OAuthAdapter<AccountOptions, Credential> = {
  readonly id: string;
  readonly label: LocalizedText;
  readonly description?: LocalizedText;
  readonly icon?: OAuthIcon;
  // existing fields...
};
```

Icon 放在 capability 上，因为 provider 和登录入口引用的是 `{ plugin, capability }`。
一个 plugin package 可以注册多个 OAuth capability，不能假设它们共享同一品牌。

### Quota 类型

```ts
export type OAuthQuotaItem = {
  readonly id: string;
  readonly label: LocalizedText;
  readonly remainingRatio?: number;
  readonly resetsAt?: number;
};

export type OAuthQuotaResetCredit = {
  readonly id: string;
  readonly expiresAt?: number;
};

export type OAuthQuotaResetCredits = {
  readonly availableCount: number;
  readonly items?: readonly OAuthQuotaResetCredit[];
};

export type OAuthQuotaSnapshot = {
  readonly items: readonly OAuthQuotaItem[];
  readonly resetCredits?: OAuthQuotaResetCredits;
};

export type OAuthQuotaCapability<AccountOptions, Credential> = {
  readonly read: (context: AccountContext<Credential, AccountOptions>) => Promise<OAuthQuotaSnapshot>;
  readonly reset?: (context: AccountContext<Credential, AccountOptions>) => Promise<void>;
};
```

`OAuthAdapter` 增加：

```ts
type OAuthAdapter<AccountOptions, Credential> = {
  // existing fields...
  readonly quota?: OAuthQuotaCapability<AccountOptions, Credential>;
};
```

Quota 使用 `AccountContext`，因为读取与 reset 都需要相同的 credential port、账号 options
和取消信号。Quota 不属于 `RuntimeContext`：它不依赖模型 catalog、ProviderV4 或入站协议。

## Icon 生成与验证

### LobeIconKey 生成

`@lobehub/icons-static-svg` 只发布 `icons/*.svg`，没有 JavaScript export、manifest
或官方 key union。`@aio-proxy/plugin-sdk` 因此以该包作为构建期依赖，并在 Rslib 配置求值
期间生成精确声明。`bun run build` 是唯一生成入口；仓库不增加 `generate:*` script、
`postinstall` 或需要开发者预先执行的 codegen 命令。

构建流程如下：

1. Rslib 配置求值解析已安装的固定版本 package。
2. 配置求值枚举 `icons/*.svg`，去掉 `.svg`，验证 slug，按字典序稳定排序并检测重复；重复 key
   属于 build error，不能静默去重。
3. 配置求值在确定性的 Rsbuild cache 路径下写入精确 helper declaration：

   ```ts
   declare type AioProxyLobeIconKey = "anthropic" | "codex-color" | "openai";
   ```

   Cache 文件使用 plugin/package version 命名空间并原子更新。配置求值每次 build 都重新解析和
   验证输入，不能把已有 cache 当作依赖缺失或扫描失败时的 fallback。

4. SDK 源码的 placeholder 只声明同名 global helper 为 `string`，因此尚未 build 的
   `plugin-sdk` 源码、编辑器和裸 `tsc` 仍可解析宽类型。
5. Rslib 0.23.2 在 Rsbuild plugin `setup` 前读取 `source.tsconfigPath`，且 API Extractor
   在 rollup 时重新读取该 tsconfig；`dts.alias` 只能影响初始 declaration emit，不能使
   API Extractor 内联 private/path-mapped module。因此精确 declaration 必须在配置求值时写入，
   并作为 `banner.dts` 传给最终 rollup，而不是生成派生 tsconfig 或依赖 alias 生命周期。
6. `plugin-sdk` 单独启用 `dts.bundle: true`；其公开 `LobeIconKey` alias 指向该 banner helper，
   使最终 `dist/index.d.ts` 包含精确 union。共享 Rslib 配置和其他 workspace package 继续使用
   bundleless dts。Rsbuild plugin 的 `setup` 仅断言 cache path 一致；它不承担生成时序。

最终 npm artifact 不能包含 placeholder 或 build cache 绝对路径，也不发布 key array/Set 的
JavaScript 运行时数据。`@lobehub/icons-static-svg` 以精确 `1.93.0` 统一放入 root workspace
catalog，`plugin-sdk` 与 Dashboard 都使用 `"catalog:"`；它对 `plugin-sdk` 仍只是构建期依赖。Bun isolated
依赖布局要求 Rslib 动态加载的 `@microsoft/api-extractor` 位于 root `devDependencies`，尽管只有
`plugin-sdk` 启用并使用 `dts.bundle`。

Workspace consumer 按 package exports 解析 `@aio-proxy/plugin-sdk`，当前两个 built-in plugin
实际读取 `dist/index.d.ts`；Turbo 的 `build` 依赖保证 SDK 先于它们构建。因此精确 union 会在
第一方 plugin build 中拒绝拼错的 key。根 solution 中列出 project references 本身不会把这些
package import 改写为 SDK 源码。

裸 `tsc -b` 不执行 Rslib plugin，只能看到源码 placeholder，因此不是权威 declaration 或发布
构建入口。仓库的标准验证入口保持 `bun run build` 与 `bun run preflight`。Artifact type test
和 built-in consumer type test 必须验证实际构建链路接受真实 key 并拒绝不存在的 key。

若 package 无法解析、没有 SVG、出现重复 key 或非法文件名，SDK build 必须失败，不能发布
退化为 `string` 的声明。

若该依赖被两个或更多 workspace package 使用，实现时必须遵循根 catalog 规则，避免类型版本
与消费方资源版本无意漂移。本文不规定 Dashboard 如何交付这些 SVG。

### 运行时 icon 分类

宿主按以下顺序解释 icon：

1. `http://` 或 `https://`：解析为绝对 URL；两种协议和任意主机都允许。
2. `data:`：解析并验证为允许的图片 MIME。
3. 其他字符串：按 Lobe icon slug 处理。

data URL 只允许：

- `image/svg+xml`
- `image/png`
- `image/webp`
- `image/gif`
- `image/avif`

允许合法的 MIME 参数和 base64/percent-encoded payload。原始 icon 字符串最大 256 KiB；
超限时不继续解码。Lobe slug 必须匹配当前 package 文件名使用的小写字母、数字与连字符语法。

宿主不携带完整 Lobe key 列表，因此格式合法但实际不存在的 slug 不会在 plugin load 阶段被
精确识别。该取舍避免为了展示元数据向运行时和编译二进制加入约 900 个 key。

非法 icon 是非关键展示错误：宿主删除该 adapter snapshot 中的 icon，写入脱敏、结构化的
plugin warning，并继续提交 capability。Warning sink 是 best-effort；即使 logger 抛错也必须继续删除
icon 并提交 capability。它不产生 failed plugin state，也不使 provider unavailable。

## Quota snapshot 语义

### Quota item

- `id` 是插件提供的稳定机器标识，在同一 snapshot 内唯一；不能使用本地化 label 作为 ID。
- `label` 使用 `LocalizedText`。动态上游名称可以直接使用普通字符串。
- `remainingRatio` 表示剩余额度比例，范围为闭区间 `0..1`。
- 上游只提供 used percent 时，插件负责换算为剩余 ratio。
- `remainingRatio` 可以缺失，以表达只知道 reset window、暂时无法获得用量的情况。
- `resetsAt` 是 epoch milliseconds，可以缺失；宿主不接受 `Date` object。
- `items` 的顺序由插件决定，宿主保持原顺序，不按 label、ratio 或 reset time 重新排序。

插件负责把 provider-specific group、window、绝对额度与 plan 信息收敛到上述公共字段。
v1 不提供任意 `metadata` 逃生口，避免公共 SDK 重新变成 provider UI payload。

### Reset-credit 库存

`resetCredits` 只在插件能获取动态库存时返回：

- `availableCount` 是非负整数。
- `items` 是可选详情列表；详情缺失不影响已知总数。
- 每个 credit 具有稳定 `id` 和可选 epoch-ms `expiresAt`。
- `availableCount` 不要求等于 `items.length`，因为总数和详情可能来自不同上游接口，详情查询也可能部分失败。
- `availableCount: 0` 表示明确没有可用 credit。
- `resetCredits` 缺失表示库存未知；即使 adapter 暴露 `reset()`，宿主也不能据此盲目执行。

Reset credit 不是 quota item。宿主不能把它放入 `items[]`，也不能让调用方选择要消费的
credit ID；插件与上游负责选择实际消费对象。

## 宿主验证

### Adapter registration

Registry 在 staging 阶段继续复制并 bind 经过验证的 adapter 字段。新增验证包括：

- `icon` 缺失或为字符串；非法值按非关键 icon 降级处理。
- `quota` 缺失或为 object。
- `quota.read` 必须是 function。
- `quota.reset` 缺失或为 function。

`quota`、`quota.read` 或 `quota.reset` 的形状错误属于 adapter registration contract error。
`register()` 必须抛错，该 plugin 的 staging registry 不得 commit，现有 plugin loader 将整个
plugin 标记为 failed。该行为有意区别于非关键展示字段 `icon` 的 warning + 降级语义。

旧 adapter 不包含这些字段时继续正常加载。

### Quota result

每次 `read()` 返回后，宿主在数据进入 API/消费者前验证：

- snapshot 和嵌套字段是普通、无循环的数据对象；
- quota item ID 非空且唯一；
- label 是有效 `LocalizedText`；
- ratio 有限且位于 `0..1`；
- timestamp 是有限、安全的 epoch-ms 数值；
- reset-credit count 是非负安全整数；
- reset-credit ID 非空且在详情列表内唯一。

数组验证必须先根据 own canonical numeric index key 计数证明 density，再进行任何按 `length` 的遍历或
分配；`new Array(0xffffffff)` 这类巨大 sparse array 必须立即拒绝，同时保持既有 path/order/cycle 语义。

宿主不 clamp 越界 ratio，不猜测秒/毫秒，也不从 label 生成 ID。契约错误使本次 quota read
失败并记录脱敏日志；不能静默输出被修改的业务数据。

Quota result 错误不写 provider routing diagnostic，不销毁 runtime，也不改变 provider 的
`ready/unavailable` 状态。

## 宿主 quota operation service

SDK capability 由独立的宿主 operation service 调用。概念入口为：

```ts
type OAuthQuotaOperations = {
  readonly read: (providerId: string, signal: AbortSignal) => Promise<OAuthQuotaSnapshot>;
  readonly reset: (providerId: string, signal: AbortSignal) => Promise<void>;
};
```

该 service 根据 Provider ID 从当前宿主 snapshot 和 account repository 中解析 OAuth provider
config、plugin/capability、adapter、账号 options 与 credential port，并构造 `AccountContext`。
它负责 result validation、可选 read single-flight、reset 串行锁和错误隔离。

Quota 是账号管理 control-plane 能力，不加入 `RuntimeProviderInstance.raw/model`。Operation
执行期间必须持有对应 snapshot lease，避免 plugin reload 或 provider config swap 使一次调用
混用两个版本的 adapter/config。账号或 capability 缺失、provider 不是 OAuth、adapter 未暴露
quota 时，service 返回稳定的 capability-unavailable 类错误，不调用插件；adapter 未暴露
`quota.reset` 时，reset 入口返回稳定的 reset-unsupported 类错误，也不执行 quota 预检。

本文只定义该内部调用 seam。后续 HTTP、CLI 或 Dashboard consumer 必须复用该 service，不能
自行从 registry 取出 adapter 后绕过 result validation、锁和错误隔离。

## Quota read 执行

`quota.read()` 表示一次当前账号 snapshot 读取，不声明 `static` 或 TTL policy。

宿主可以对同一 Provider ID 的普通并发 read 使用 single-flight，避免同一时刻重复请求上游；
这是 MAY 优化，不是 SDK correctness 要求。若实现，promise settlement 后必须删除 flight，不能
形成 SDK 级 TTL cache。未来 Dashboard、CLI 或 API 消费者自行决定查询频率、stale time 和
手动刷新行为。

Credential refresh 继续通过现有 `CredentialPort` lease + single-flight + exchange/schema + CAS 契约完成。
Quota 使用该 port 的 control-plane mode：credential 更新、metadata 与返回值语义保持不变，失败日志仍写入；
但不得写入或清除持久化 `CREDENTIAL_REFRESH_FAILED`，也不得调用 diagnostic/credential changed callback，
从而不会触发 routing rebuild。默认 runtime mode 行为不变。Quota capability 不获得 credential 原始存储或
绕过该 port 的权限。

进程内 refresh single-flight 使用规范化的 `(Provider ID, mode)` 键：同一 mode 的并发调用继续共享，
runtime 与 control-plane 不共享带策略的 Promise。底层 repository refresh lease 与 CAS 仍只按 Provider ID
串行化，因此跨 mode 调用会得到一致的 updated/superseded revision 结果，而不会混用 diagnostics/callback 策略。

Credential port 的 secret 输入按 mode 区分：runtime/default 保留原始 `pluginSecrets` 引用，并在每次 refresh
时动态收集字符串；control-plane 只接受预收集的 `pluginSecretValues`。Quota 在调用账号准备 seam 前立即把
plugin secret 对象收敛为字符串，control-plane preparation 再收集 stored credential/account secret 字符串，
返回不含完整 stored account 或 account identity 的结果，并通过独立 factory 构造只捕获这些字符串的 port。
因此 `PreparedOAuthQuotaContext` 不直接或间接保留 raw plugin secret 或完整 stored account。

用于错误脱敏的动态 secret 收集必须跳过 Proxy 与 accessor（不得触发 trap/getter），并安全遍历 Map
key/value、Set value、symbol/non-enumerable data descriptor、数组、普通对象与 class instance 的公开
data field，同时处理循环。Map/Set 检测必须使用 `node:util/types.isMap/isSet` 这类不会沿原型链触发
Proxy trap 的内部类型判断；
`Object.create(proxyPrototype)` 即使原型的 `getPrototypeOf` trap 会抛错也必须零 trap 完成。Zod transform 或 refresh 新产生的 secret 必须在后续 quota error 的 name、
message 与 stack 中被脱敏；不尝试反射 JavaScript private field。

## Reset 执行协议

Reset 是会消耗稀缺资源的账号级副作用。宿主必须执行以下顺序：

1. 按 Provider ID 获取 reset 串行锁。
2. 在锁内直接调用一次实时 `quota.read()`；该预检不得复用锁外已经存在的普通 read flight。
3. 若 `resetCredits` 缺失或 `availableCount <= 0`，拒绝 reset，不调用插件 mutation。
4. 调用一次 `quota.reset(context)`。
5. 不因超时、连接中断或普通失败自动重试该 mutation。
6. reset resolve 后，将之前的 quota snapshot 视为失效。
7. 将 reset mutation 报告为成功。
8. 如调用方需要最新数据，再单独执行 `quota.read()`；该刷新失败不能把已经成功的 reset 改报为失败。

锁必须覆盖实时预检与 mutation，避免同一账号的并发请求都看见同一张可用卡。插件负责生成
供应商 API 所需的 redeem request ID 或 idempotency key；v1 不把 operation ID 加入公共 SDK。

`reset()` 返回 `void` 是有意设计。若它返回 post-reset snapshot，可能发生上游已经消费 credit、
随后刷新失败，最终 Promise reject 并错误地告诉用户 reset 没有发生。

宿主不对不同 Provider ID 的 reset 建立全局锁。

## 故障与日志

- `quota.read()` 网络、认证或解析失败：当前 read 失败，provider routing 保持可用。
- reset 实时预检失败：reset 不执行，返回预检错误。
- `availableCount` 为 0 或未知：reset 不执行，返回不可用结果。
- `quota.reset()` reject：reset 操作失败；宿主不自动重试。
- reset 成功后的独立 refresh 失败：reset 仍为成功，refresh 单独失败。
- 所有插件错误日志继续使用 credential、account secret 与 plugin secret 的现有脱敏规则。

本文不新增持久化 quota diagnostic。需要长期可观测性时，应新增独立 quota operation telemetry，
不能复用代表模型路由健康状态的 provider diagnostic。

## Callback 决策

现有 callback server 已由 CLI 宿主实现：插件通过 `AuthorizationPort.loopback()` 描述 redirect
要求和 authorization URL，宿主负责监听、state/code 校验、超时、取消、清理和 HTML response。

因此本次：

- 不把 loopback 参数缩减为只有 port；
- 保留 hostname/path，以兼容供应商预注册或固定 redirect URI；
- 不向插件暴露 HTML、React 或任意 callback UI 注入；
- 统一品牌页面与安全的可选内容插槽另立规范。

## API version 与兼容性

`icon` 和 `quota` 都是 `OAuthAdapter` 的可选字段，因此 `PLUGIN_API_VERSION` 保持 `1`。

- 旧插件运行在新宿主：没有 icon/quota，现有登录、catalog 和 runtime 行为不变。
- 新插件运行在旧宿主：旧 registry 会忽略新增字段；登录和路由仍可工作，但 icon/quota 不可用。
- 新宿主不能因为旧插件缺少可选字段而报告 `PLUGIN_API_INCOMPATIBLE`。

能力发现基于字段是否存在，不增加 feature negotiation API。未来若 quota/reset 契约发生不兼容变化，
再提升整数 API version。

## 验收标准

### Icon

- 发布的 SDK declaration 对真实 Lobe key 提供补全，并拒绝不存在的 key。
- 最终 `dist/index.d.ts` 不包含私有 specifier、placeholder 或 build cache 路径。
- 两个 built-in plugin 在 SDK build 后消费 `dist` 窄类型，拼错 key 的 consumer type test 失败。
- Rslib build 在依赖缺失、无 SVG、重复 key 或非法文件名时失败。
- Icon key 生成只由 `plugin-sdk` build 触发，不增加独立 codegen script 或 postinstall。
- runtime bundle 不包含完整 Lobe key array/Set。
- HTTP、HTTPS 和允许的 data image 通过验证。
- 非图片 data URL、超过 256 KiB 的 data URL 和非法 slug 被忽略并记录 warning。
- 非法 icon 不阻止 capability commit。

### Quota

- Registry 正确保留、bind 并暴露可选 quota capability。
- 非 object quota、非 function `read` 或非法 `reset` 使 plugin staging 不 commit，并产生 failed plugin state。
- 宿主 quota operation service 按 Provider ID 解析 adapter/account context，并持有 snapshot lease。
- 非 OAuth provider、账号/capability 缺失或未暴露 quota 时不调用插件。
- adapter 未暴露 `quota.reset` 时返回 unsupported，且不调用 `quota.read()`。
- `read()` 返回的 item 顺序保持不变。
- duplicate ID、越界 ratio、非法 timestamp 和负数 credit count 被拒绝。
- quota read/reset 错误不改变 provider routing state。
- 若实现普通 read single-flight，同一 Provider ID 的并发调用共享 flight，settlement 后立即清理。

### Reset

- 同一 Provider ID 的 reset 预检和 mutation 串行执行。
- reset 锁内实时预检不复用锁外普通 read flight。
- 缺失库存、库存为 0 或预检失败时不调用 mutation。
- mutation 只调用一次且不自动重试。
- reset 成功后的 refresh 失败不会把 reset 改报为失败。
- 不同 Provider ID 的 reset 可以并行。

### 回归

- 旧 adapter 不修改即可加载。
- 两个 built-in plugin 的登录、catalog 和 runtime 测试继续通过。
- SDK artifact type tests、相关 package unit tests、`bun run check` 与受影响测试通过。
- 完成实现前按仓库要求运行 `bun run preflight`，或至少运行 `bun run check` 与所有受影响 package tests。
