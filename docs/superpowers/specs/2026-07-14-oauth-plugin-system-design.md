# OAuth Plugin System 设计

日期：2026-07-14
状态：待用户评审

## 背景

aio-proxy 当前把 GitHub Copilot 与 OpenAI ChatGPT OAuth 集中在 `packages/oauth`，并在 CLI、server runtime 和 provider config 中按固定 vendor 分支。这个结构能支持两个内置账号来源，但新增 OAuth 供应商时必须同时修改核心类型、CLI 分支、runtime materialization 和持久化逻辑，扩展成本会随供应商数量增长。

本设计把 OAuth 重构为通用插件系统的第一个 capability。GitHub Copilot 与 OpenAI ChatGPT 迁移为两个 built-in plugin package；它们与第三方 npm 插件使用完全相同的公共接口。插件系统后续可以增加请求链 hook 等 capability，但 v1 只交付 OAuth capability，不提前设计后台任务或完整前后端插件平台。

当前协议路由架构保持不变：

- `packages/core/src/protocol/` 继续拥有无状态入站协议 adapter。
- `packages/server/src/routes/pipeline.ts` 继续是唯一 candidate loop。
- 同协议 raw capability 优先；其他调用使用 materialized ProviderV4。
- route 不按 plugin、OAuth 或 provider kind 编排 fallback、usage、recording 或 stream preflight。

## 目标

- 让第三方 npm 包可以注册 OAuth account adapter，而无需修改 aio-proxy 核心枚举或 route。
- 把两个现有 OAuth 实现迁移为使用公共 SDK 的 built-in plugin。
- 用一个深的 OAuth adapter interface 封装配置、登录、凭据、目录与运行时。
- 让宿主统一负责插件加载、配置呈现、授权交互、凭据持久化、目录缓存和诊断。
- 保持账号与 routing provider 一一对应，并由宿主决定最终 Provider ID。
- 保持 model-first、capability-based routing 和跨 provider fallback。

## 非目标

- v1 不提供 Dashboard 配置或 OAuth 登录；Dashboard 只显示状态与诊断。
- v1 不允许插件注入 React、HTML 或其他自定义 UI。
- v1 不提供插件沙箱、权限隔离或进程隔离。第三方插件是经明确授权后在宿主进程内执行的可信代码。
- v1 不提供插件 `start/stop` 生命周期、后台 worker 或完整 full-stack plugin。
- v1 不迁移旧 OAuth config、旧 auth payload 或旧 provider ID。用户需要重新登录。
- v1 不保留旧 `BaseOAuthProvider` 与新 adapter 两套长期抽象。

## 核心决策

| 决策点 | 结论 |
| --- | --- |
| 插件配置 | `plugins: Array<string | [string, unknown]>` |
| Built-in | 隐式预注册，但使用与第三方相同的 plugin descriptor 和 capability interface |
| 第三方执行 | 信任确认后进程内执行；宿主不自动安装 |
| 模块形状 | `export default definePlugin(setup, metadata?)` |
| 公共 SDK | 独立发布 `@aio-proxy/plugin-sdk`，不暴露 core internals |
| Built-in 目录 | `packages/plugins/<vendor>/`，package identity 不绑定单一 capability |
| 注册接口 | `api.oauth.register(adapter)`，不拆成多个浅 registration call |
| setup 生命周期 | 只注册 capability；注册先 staging，成功后一次提交；v1 无 start/stop |
| 配置表单 | Standard Schema + 宿主控件组成的声明式 form |
| 表单入口 | v1 仅 CLI 渲染；Dashboard 保持只读 |
| 敏感字段 | 普通值写 config，secret 写宿主 vault |
| 授权方式 | SDK 同时支持 device-code 与 localhost loopback；插件按供应商能力选择 |
| Loopback 所有权 | 宿主负责监听、回调校验、取消、超时和清理 |
| 远程环境 | 自动 callback 优先，允许粘贴完整 callback URL 作为 fallback |
| 账号身份 | 插件返回 fingerprint 与 suggestedKey；宿主查重并生成最终 Provider ID |
| 凭据 | 插件提供 Standard Schema，宿主以 opaque value 持久化并提供 revision CAS |
| 模型目录 | 插件发现，宿主缓存 last-known-good；插件声明 static 或 TTL |
| Runtime seam | `createRuntime(ctx) -> { provider: ProviderV4; raw?: RawResolver }` |
| 故障策略 | 坏插件被跳过；引用它的 provider 保留并显示 unavailable 诊断 |
| 删除账号 | 显式删除 provider 时同时删除 config、账号 vault 与 catalog |

## 领域对象与不变量

### Plugin

一个 npm package 或 built-in package。公共插件身份是 canonical package name。公共第三方插件必须先经 `plugin add` 安装和授权；仅安装到 cache 但未进入 `plugins` 配置的包不会加载。

### Capability

插件通过 setup 注册的能力。capability ID 只需在当前插件内唯一；宿主用 `{ plugin, capability }` 组成无冲突引用。v1 只有 OAuth capability，但接口不假设一个插件永远只能注册一个能力。

### OAuth adapter

位于 OAuth capability seam 的深 adapter。它一次性描述账号配置、登录、credential schema、模型发现与运行时创建。调用方不需要分别拼装 login、catalog、refresh 和 runtime adapter。

### Account 与 Provider

一个 OAuth account 对应一个 routing provider。provider config key 是账号在路由层的身份。宿主根据 namespaced fingerprint 复用已有账号，避免重复登录产生多个相同 provider。

## 用户配置

### 插件启用配置

`plugins` 数组中的字符串表示无公开 options 的插件；tuple 表示插件及其非敏感 options：

    {
      "plugins": [
        "@example/aio-proxy-plugin",
        [
          "@example/enterprise-plugin",
          {
            "baseUrl": "https://example.internal"
          }
        ]
      ]
    }

secret 字段不会出现在 tuple options 中。它们以 plugin identity 为 scope 存入 vault，宿主在 schema 校验与 setup 前将普通值和 secret 合并。

GitHub Copilot 与 OpenAI ChatGPT built-in package 无需出现在 `plugins` 中即可加载。它们仍拥有 canonical package identity，provider 配置不会使用特殊 vendor enum。

### OAuth provider 配置

provider 以结构化引用指向插件能力：

    {
      "providers": {
        "copilot-12345": {
          "kind": "oauth",
          "plugin": "@aio-proxy/plugin-github-copilot",
          "capability": "default",
          "options": {
            "deploymentType": "github.com"
          },
          "enabled": true,
          "weight": 10
        }
      }
    }

`options` 只保存账号级非敏感值。账号级 secret 与 OAuth credential 存在账号 vault 中。alias、enabled、weight 等通用 routing 字段继续由宿主管理，不进入插件表单。

## 插件安装与加载

### 安装位置

复用现有 npm cache：

    ~/.aio-proxy/packages/<encoded-package>/node_modules

每个 package 继续拥有独立 cache directory 和安装锁，不向当前项目写入 `node_modules`。

### plugin add

`plugin add <package>` 按以下顺序执行：

1. 对将执行的 npm package 显示明确的信任确认。非交互模式必须显式提供确认参数。
2. 下载到独立 package cache。
3. import package entrypoint，并校验 default export 是 `definePlugin()` 创建的 descriptor。
4. 校验 plugin SDK API version。
5. 获取插件级 ConfigSpec，通过 CLI 收集或合并当前 options。
6. 从 plugin-scoped vault 合并已有 secret，并执行 Standard Schema 校验。
7. 用 staging registration API 执行 setup。
8. setup 完整成功后原子更新 `plugins` 配置；只有配置提交成功，当前宿主 snapshot 才提交 staging registry。

失败或取消不会启用插件，也不会留下 config 引用。已经下载但未启用的 cache 可以保留，并由显式 `plugin prune` 清理。安装事务保证的是启用状态，而不是回滚网络下载的每个文件。

### Staging setup

`setup(api, options)` 的契约是只注册 capability。宿主把所有 registration 写入 staging registry；只有 setup 返回成功才一次提交。

以下情况使整个插件加载失败，且不提交部分 capability：

- default export 不是有效 plugin descriptor；
- SDK API version 不兼容；
- plugin options 不通过 schema；
- 同一插件内 capability ID 重复；
- adapter 定义缺少必填 interface；
- setup 抛错。

staging 只能撤销宿主 registry 变更，无法撤销 npm 模块顶层代码或 setup 主动产生的外部副作用。信任确认必须明确说明第三方插件拥有当前进程权限。

### 删除与缺失

从 `plugins` 中移除第三方插件后，宿主不再加载它，但不会自动删除引用它的 provider、账号 vault 或 catalog。相关 provider 显示 `unavailable`，重新安装后可以恢复。

只有显式删除 provider 才级联删除：

- provider config；
- 账号级 options secret；
- OAuth credential；
- model catalog；
- 账号诊断状态。

Built-in package identity 是保留身份，第三方包不能覆盖其 capability namespace。

## 公共 Plugin SDK

`@aio-proxy/plugin-sdk` 是小型、独立发布的包。它可以依赖 Standard Schema 规范和 `@ai-sdk/provider` 的 ProviderV4 类型，但不能依赖 `@aio-proxy/core`、server、CLI 或数据库实现。

descriptor 的概念形状：

    export default definePlugin(
      (api, pluginOptions) => {
        api.oauth.register({
          id: "default",
          // account, credentials, login, catalog, runtime
        })
      },
      {
        options: pluginConfig
      }
    )

`definePlugin` 自动写入 SDK API version 与 SDK-owned descriptor brand。没有插件级 options 时，第二个参数可以省略，保持 `definePlugin(setup)` 的简单形状。brand 用于可靠识别 descriptor 形状，不构成对已获进程权限代码的安全隔离。

### ConfigSpec

插件级和账号级配置复用同一个 interface：

    type ConfigSpec<T> = {
      schema: StandardSchemaV1<unknown, T>
      form: readonly FormField[]
    }

v1 的 `FormField` 只包含宿主控件：

- `text`
- `secret`
- `number`
- `boolean`
- `select`
- `json`

字段可以包含 label、description、placeholder、静态 select options，以及一个简单的同级字段等值显示条件。复杂的数据正确性只由 Standard Schema 决定；form 不建立第二套验证规则。

v1 不支持：

- 插件自定义 UI code；
- 动态加载的 select options；
- 任意表达式条件；
- 基于 form descriptor 自动推导 credential 或 config schema。

`json` 是复杂但低频 options 的逃生口。出现真实重复需求后再增加新的宿主控件。

### Secret 语义

`secret` 字段的存储位置由宿主决定：

- plugin-level secret 使用 plugin identity 作为 scope；
- account-level secret 在登录前只驻留内存，登录成功后写入账号 vault；
- schema 与插件接收合并后的完整对象；
- config、列表、诊断和导出只显示脱敏占位；
- 编辑时空 secret 表示保留旧值，只有显式 clear 操作才删除。

## OAuth Adapter Interface

adapter 的概念形状：

    type OAuthAdapter<AccountOptions, Credential> = {
      id: string
      label: string

      account: {
        options: ConfigSpec<AccountOptions>
      }

      credentials: StandardSchemaV1<unknown, Credential>

      login(
        ctx: OAuthLoginContext,
        options: AccountOptions,
      ): Promise<OAuthLoginResult<Credential>>

      catalog: {
        policy:
          | { kind: "static" }
          | { kind: "ttl"; ttlMs: number }
        discover(ctx: AccountContext<Credential, AccountOptions>): Promise<ModelCatalog>
      }

      createRuntime(
        ctx: RuntimeContext<Credential, AccountOptions>,
      ): Promise<{
        provider: ProviderV4
        raw?: RawResolver
      }>
    }

这是 adapter 对宿主和测试暴露的唯一主要 interface。token refresh、供应商 header、模型 transport 选择和 vendor-specific metadata 都留在 adapter implementation 内。

### Login result

插件登录成功后只返回数据，不直接写 config 或数据库：

    type OAuthLoginResult<Credential> = {
      fingerprint: string
      suggestedKey: string
      label?: string
      credentials: Credential
      expiresAt?: number
    }

- `fingerprint` 是同一供应商账号稳定且不可变的身份。宿主用 `{ plugin, capability, fingerprint }` 查重；它不是最终 Provider ID。
- `suggestedKey` 是可读的 provider key 建议，例如 `copilot-12345`。
- 宿主复用已有 fingerprint 对应的 provider；新账号才对 suggestedKey 做格式化和确定性冲突处理。
- `label` 与 `expiresAt` 是宿主理解的唯二通用账号 metadata。其他 credential 字段保持 opaque。

## 授权交互

OAuth SDK 不把所有登录压缩成模糊的 `onAuth(url)`。宿主向 adapter 暴露两个明确的授权 port。

### Device-code flow

接口概念形状：

    presentDeviceCode({
      url,
      userCode,
      instructions
    }): Promise<void>

宿主负责：

- 优先打开供应商给出的 complete verification URL；
- 始终在 CLI 打印 URL；
- 尽力复制 user code，并明确告诉用户复制结果；
- 展示 instructions；
- 处理终端能力差异。

插件负责：

- 请求 device code；
- 解释供应商响应；
- polling、`authorization_pending`、`slow_down`、拒绝与超时；
- token exchange。

GitHub Copilot built-in 使用此 flow。GitHub Enterprise 的部署类型与 enterprise URL 在调用 flow 前由账号级 ConfigSpec 收集。

### Localhost loopback flow

接口概念形状：

    loopback({
      state,
      redirect: {
        hostname,
        port,
        path
      },
      authorizationUrl({ redirectUri }) {
        return buildAuthorizationUrl(redirectUri)
      },
      allowManualCallbackUrl: true
    }): Promise<{
      code: string
      redirectUri: string
    }>

`port` 可以是固定端口或 dynamic policy。需要注册固定 redirect URI 的供应商由插件声明固定 hostname、port 和 path；其他插件可让宿主选择空闲端口。

宿主按以下顺序执行：

1. 绑定 loopback listener，或在用户明确确认后进入 manual-only fallback。固定端口绑定失败不得静默继续。
2. 得到最终 redirect URI 后调用插件提供的 URL builder。
3. 尝试打开浏览器，并始终打印 authorization URL。
4. 等待自动 HTTP callback；交互终端同时允许用户粘贴浏览器地址栏中的完整 callback URL。
5. 两条输入路径竞争，第一条有效结果胜出，另一条立即取消。
6. 校验 callback scheme、hostname、port、path 与预期 redirect URI 一致。
7. 校验返回 state 与插件提供的 expected state 一致。
8. 处理标准 OAuth denial/error、超时、取消和重复 callback。
9. 返回 code 与实际 redirect URI，并保证 listener 关闭。

插件负责：

- PKCE verifier/challenge；
- state 生成；
- authorization URL 参数；
- authorization code 与 token exchange；
- 供应商特有响应语义。

OpenAI ChatGPT built-in 使用固定 `http://localhost:1455/auth/callback`。自动 callback 是首选路径；SSH、容器或远程浏览器无法访问 CLI 所在 localhost 时，用户可以粘贴完整 callback URL。浏览器打开失败本身不是授权失败。

### 安全不变量

- listener 必须在打开浏览器前就绪，除非用户明确选择 manual-only。
- callback URI 与 state 任一不匹配都使会话失败。
- authorization code 只返回一次；重复 callback 不得覆盖已完成结果。
- 取消、超时、拒绝和 callback 错误都必须关闭 listener。
- URL、诊断和日志不得记录 authorization code、PKCE verifier、access token 或 refresh token。
- server runtime 不得自动启动交互式登录，只返回修复建议。

## 登录与持久化事务

`provider login` 的宿主流程固定如下：

1. 解析注册完成的 `{ plugin, capability }`。
2. 通过账号级 ConfigSpec 收集普通值与 secret。
3. 合并已有 secret，执行 account options schema。
4. 调用 adapter login；此阶段所有输入与 credential 只驻留内存。
5. 用 adapter credential schema 验证返回值。
6. 以 namespaced fingerprint 查找已有账号。
7. 已有账号复用原 Provider ID；新账号由宿主根据 suggestedKey 生成最终 ID。
8. 使用内存中的新 credential 尝试首次 model discovery。
9. discovery 失败不回滚登录。已有 last-known-good 时继续保留旧目录并标记 stale；从未有可用目录时 provider 标记为 `unavailable`。
10. 先提交账号 vault 与可用 catalog，再原子替换 config 文件。
11. config 写入失败时补偿删除新账号记录，或恢复更新前 revision。

配置与 SQLite 无法组成单个底层事务，因此本设计保证不会让 config 指向尚未写入的 credential。进程在 vault 提交后、config 替换前崩溃时，可能留下无 config 引用的账号记录；启动时清理超过安全窗口的 orphan record。

re-login 是更新事务：

- 授权、credential validation 或持久化失败时保留旧 credential；
- 授权与 credential validation 成功后，即使 discovery 失败也可以提交新 credential，同时保留旧 catalog；
- 同一 fingerprint 不创建第二个 provider；
- account options 的普通值与 secret 和 credential 一起按 revision 更新。

## Vault

vault 由宿主实现并持久化，插件不能直接访问数据库。

账号运行时拿到的 credential port：

    type CredentialPort<Credential> = {
      read(): Promise<{
        value: Credential
        revision: number
      }>

      compareAndSwap(
        expectedRevision: number,
        next: Credential,
        metadata?: {
          label?: string
          expiresAt?: number
        },
      ): Promise<"updated" | "conflict">
    }

规则：

- credential 对宿主业务逻辑 opaque，但每次写入前必须经过 adapter schema。
- refresh token 并发更新使用 revision CAS。发生 conflict 时 adapter 重新读取，不盲写覆盖。
- 宿主只理解 label 和 expiresAt；vendor-specific 字段不提升为公共列。
- fingerprint 是账号 identity key，不作为可编辑 metadata。
- plugin-level secret 与 account-level credential 使用不同 scope，避免删除账号时误删插件全局配置。
- 本重设计不提供旧 credential migration。

## Model Catalog

插件负责发现，宿主负责缓存、调度与可用性判断。

`ModelCatalog` 按 ProviderV4 modality 分组：

- language；
- image；
- embedding；
- speech；
- transcription；
- reranking。

每个 descriptor 只包含宿主需要的标准字段，例如 model ID、display name 和 modality；供应商附加信息放入 `metadata?: JsonValue`。宿主不解释 metadata，而是在 runtime context 中把当前 catalog snapshot 原样交回同一 adapter。

刷新策略：

- `static`：首次装载后不调度刷新。
- `ttl`：adapter 声明 TTL，宿主统一调度。
- 刷新成功：原子替换 catalog snapshot。
- 刷新失败且存在旧 snapshot：继续使用 last-known-good，provider 状态为 ready + stale diagnostic。
- 刷新失败且从未成功：provider 为 unavailable。

插件不需要后台生命周期。catalog refresh 和 token refresh 都通过宿主调用 adapter 方法完成。

## Runtime 与路由

adapter materialization 返回：

    {
      provider: ProviderV4
      raw?: RawResolver
    }

项目锁定 `ai@7.0.8` 与 `@ai-sdk/provider@4.0.1`。公共 seam 是完整 ProviderV4，而不是只暴露 language model 的项目私有子集：

- `languageModel`
- `imageModel`
- `embeddingModel`
- 可选 speech、transcription、reranking

调用规则继续是：

    same inbound protocol + raw capability -> raw
    otherwise + ProviderV4 model capability -> model
    otherwise -> unsupported candidate

raw capability 是可选优化，不是 OAuth plugin 的必选接口。GitHub Copilot 等 adapter 可以根据 catalog metadata 在内部选择匹配 transport。跨协议请求永远不直接使用 raw transport，而是进入 AI SDK/ProviderV4 语义。

`packages/server/src/routes/pipeline.ts` 继续独占：

- model-first candidate resolution；
- weight/config order；
- raw/model dispatch；
- fallback；
- request/attempt recording；
- usage capture；
- stream preflight；
- final protocol-shaped error。

route 文件、protocol adapter 和 pipeline 都不按 OAuth plugin package 分支。

## 状态与诊断

状态保持为两个小型 union：

    type PluginState =
      | { status: "ready" }
      | { status: "failed"; diagnostic: Diagnostic }

    type ProviderState =
      | { status: "ready"; catalog: "fresh" | "stale" }
      | { status: "unavailable"; diagnostic: Diagnostic }

稳定诊断码按 seam 分类：

- `PLUGIN_NOT_INSTALLED`
- `PLUGIN_API_INCOMPATIBLE`
- `PLUGIN_LOAD_FAILED`
- `PLUGIN_OPTIONS_INVALID`
- `CAPABILITY_MISSING`
- `ACCOUNT_OPTIONS_INVALID`
- `CREDENTIALS_MISSING_OR_INVALID`
- `AUTHORIZATION_FAILED`
- `CATALOG_UNAVAILABLE`
- `RUNTIME_CREATE_FAILED`

`Diagnostic` 包含稳定 code、安全摘要、是否可重试、发生时间和建议命令。Dashboard 只展示这些安全字段；原始 cause 与 stack 只写本地日志，并经过 credential、secret、authorization code 与 URL query redaction。

故障行为：

- 一个坏插件不阻止其他插件和 server 启动。
- 引用缺失插件或 capability 的 provider 保持可见，但不进入候选执行。
- stale catalog 仍可路由。
- runtime attempt 失败交回唯一 candidate loop；同模型的后续 provider 继续尝试。
- 全部候选失败时继续保留最终失败，并由入站 protocol adapter 生成协议错误。
- 登录取消、拒绝、超时、callback 错误和 re-login 失败不修改已有账号。

## CLI 与 Dashboard

v1 CLI 提供：

- `plugin add`
- `plugin list`
- `plugin config`
- `plugin remove`
- `plugin prune`
- `provider login`
- 现有 provider list/delete/status 入口

`provider login` 解析已注册 OAuth capability；无歧义的短 capability ID 可以直接使用，发生歧义时要求 canonical `plugin + capability` 引用或交互选择。最终配置始终保存结构化引用，不保存 CLI alias。

Dashboard v1 只读展示：

- plugin ready/failed；
- provider ready/stale/unavailable；
- capability reference；
- account label 与 expiresAt；
- catalog last success/diagnostic；
- 建议的 CLI 修复命令。

Dashboard 不执行配置表单、OAuth session 或 plugin install。

## 包拆分与依赖方向

### `packages/plugin-sdk/`

公共 descriptor、ConfigSpec、OAuth adapter、authorization port、credential port、catalog 与 runtime 类型。独立发布为 `@aio-proxy/plugin-sdk`。

Built-in plugin implementation 统一放在 `packages/plugins/*`，workspace 增加 `packages/plugins/*` glob。目录使用稳定的 integration/vendor 名称，不把当前首个 capability `oauth` 固化进 package identity。

### `packages/plugins/github-copilot/`

迁移现有：

- GitHub 与 GitHub Enterprise 账号表单；
- device-code request 与 polling；
- Copilot token refresh；
- user fingerprint；
- model discovery 与 transport metadata；
- ProviderV4/raw runtime。

发布包名为 `@aio-proxy/plugin-github-copilot`。

### `packages/plugins/openai-chatgpt/`

迁移现有：

- PKCE 与 state；
- 固定 localhost loopback constraint；
- code exchange 与 refresh；
- OpenAI account fingerprint；
- static catalog；
- ChatGPT ProviderV4 runtime。

发布包名为 `@aio-proxy/plugin-openai-chatgpt`。

### `packages/core/src/plugins/`

宿主内部实现：

- npm package loader；
- plugin descriptor validation；
- staging registry；
- config/schema coordination；
- vault 与 catalog repository；
- account transaction；
- diagnostics。

### `packages/cli/src/plugin-commands/`

CLI command、ConfigSpec renderer、trust prompt、device-code presentation、browser open、loopback/manual callback interaction。

### `packages/server/src/plugin-runtime.ts`

读取 committed registry 和账号状态，把 adapter materialize 成现有 runtime capabilities。它不拥有 OAuth 登录 UI。

依赖方向固定为：

    plugin-sdk
        ↑
    built-in / third-party plugins

    plugin-sdk
        ↑
    core plugin host
        ↑
    CLI and server integration

plugin SDK 不反向依赖 core。built-in plugin 不从 server 或 CLI 导入实现。

## 迁移策略

这是 clean break：

1. 新增 plugin SDK、loader、registry 和 host stores。
2. 先用 fake plugin 验证完整 contract。
3. 将 GitHub Copilot 迁移为 built-in plugin，并通过现有行为 fixture。
4. 将 OpenAI ChatGPT 迁移为 built-in plugin，并通过 loopback/PKCE fixture。
5. server runtime 改为从 plugin registry materialize OAuth provider。
6. config schema 从 vendor enum 改为结构化 capability reference。
7. CLI login 改为通用 capability resolution 与 ConfigSpec renderer。
8. 删除 `packages/oauth`、`OAuthVendor`、`BaseOAuthProvider`、vendor switch 与专用 runtime branch。
9. 删除只验证旧抽象的测试；保留并迁移行为级 fixture。

不提供旧 config/auth migration，也不同时读取旧 vendor 记录。配置校验会明确拒绝旧 OAuth vendor entry，并提示用户删除旧条目后重新登录；宿主不会静默转换或猜测账号身份。

## 测试策略

### SDK 与 loader contract

- `definePlugin` descriptor brand 与 API version；
- 无效 default export；
- plugin options schema；
- duplicate capability；
- setup throw 后 staging registry 无残留；
- built-in 与 cached npm package 使用同一注册路径；
- namespace collision 拒绝。

### ConfigSpec 与 secret

- 所有宿主字段类型；
- 条件显示；
- schema issue 映射；
- plugin/account secret 分流；
- 空 secret 保留与显式 clear；
- config、诊断和日志脱敏。

### Authorization

- Device flow 展示 complete URL、复制 code、pending、slow_down、denial、timeout、cancel。
- Loopback listener 在浏览器前启动。
- 固定与 dynamic port。
- 自动 callback。
- 手工粘贴完整 callback URL。
- 自动与手工输入竞速只完成一次。
- URI/state mismatch、缺 code、OAuth error、超时、取消、重复 callback。
- listener 在所有结束路径关闭。

### 登录事务

- credential schema failure 不落盘；
- fingerprint 重复复用 Provider ID；
- suggestedKey 冲突由宿主稳定处理；
- 新登录 config 写入失败执行补偿；
- re-login 失败保留旧 revision；
- 首次 catalog discovery 失败仍保存账号但标记 unavailable；
- orphan vault record 启动清理；
- 删除 provider 级联清理账号数据。

### Vault 与 catalog

- credential read + revision CAS；
- 并发 refresh conflict；
- 写入前 schema validation；
- static catalog；
- TTL scheduling；
- last-known-good；
- stale 与 unavailable 状态；
- opaque metadata 原样回到 runtime。

### Built-in plugins

- GitHub.com 与 GitHub Enterprise ConfigSpec。
- GitHub device-code flow、Copilot token、user fingerprint、model discovery 与 transport metadata。
- ChatGPT PKCE/state、固定 redirect URI、token exchange、refresh 与 static models。
- 测试使用 mock fetch、fake clock 与本地 loopback，不访问真实 OAuth endpoint。

### Server dispatch

- 同协议 raw capability 优先；
- 跨协议使用 ProviderV4；
- API、AI SDK 与 plugin provider 混合候选；
- weight/config order；
- provider failure fallback；
- stream preflight 后不错误重放；
- 最终失败保持现有 protocol-shaped error。

### CLI 与 Dashboard

- plugin trust/install/config/remove/prune；
- provider login form、device-code、loopback 与 manual fallback；
- fake plugin 端到端；
- Dashboard 只读状态与诊断，不暴露 secret。

## 验收标准

- 新增第三方 OAuth 供应商只需发布一个依赖 `@aio-proxy/plugin-sdk` 的 npm package，不需要修改 core vendor enum、CLI vendor switch 或 route。
- GitHub Copilot 与 OpenAI ChatGPT 由两个 built-in plugin package 提供，并通过现有主要行为测试。
- GitHub Copilot 登录明确使用 device-code；ChatGPT 登录明确使用宿主 loopback，并支持手工 callback URL fallback。
- 插件级与账号级配置均由声明式 ConfigSpec 驱动；普通值与 secret 使用不同持久化位置。
- 任一插件加载失败不会阻止其他 provider 启动；引用它的 provider 保持可见且有稳定诊断。
- OAuth credential 只能通过宿主 vault 读写，refresh 使用 revision CAS。
- catalog refresh 失败时保留 last-known-good；没有任何 catalog 时 provider unavailable。
- 运行时只向 pipeline 暴露 raw/ProviderV4 capability，不向 route 泄漏 plugin/OAuth 分支。
- 删除 provider 会删除该账号全部配置、credential 与 catalog；删除插件不会隐式删除账号。
- 旧 OAuth 抽象、vendor switch 和 `packages/oauth` 在迁移完成后删除。
