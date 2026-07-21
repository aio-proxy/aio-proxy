# Provider 网络配置设计

- 日期：2026-07-21
- 状态：待用户评审

## 背景

aio-proxy 的 API provider 目前只能配置 `baseURL`、`apiKey`、协议和模型。raw passthrough 会重建上游认证 header，跨协议调用则通过 AI SDK bridge 创建 model capability；两条路径都没有统一的自定义 header 或显式 HTTP proxy 配置。

本设计增加三项相邻能力：

- API provider 的静态上游 headers；
- 顶层和单 provider 的 HTTP(S) proxy；
- 所有配置字符串值可使用的环境变量模板（provider `kind` 与对象键除外；`kind` 需在展开前区分 provider 形态）。

实现必须保持当前 model-first routing、raw/model capability 选择、provider fallback 和流式响应语义不变。

## 目标

- API provider 的自定义 headers 同时覆盖同协议 raw passthrough 和跨协议 AI SDK 调用。
- 顶层 proxy 作为 API 与 AI SDK provider 的默认值，单 provider 可以覆盖或关闭该默认值。
- 只使用 Bun 1.3.14 原生 HTTP(S) proxy 能力，不新增 transport agent 或 SOCKS 依赖。
- 使用活跃、parse-only 的 `@handlebars/parser` 解析环境变量模板，不手写 lexer/parser，也不引入完整 Handlebars runtime。
- 在运行时展开模板，同时保留配置文件中的模板原文和 Dashboard 的 secret retention 行为。

## 非目标

- SOCKS4、SOCKS5、SOCKS5H、proxy bypass 列表或 per-request direct fallback。
- 自动解释、覆盖或扩展 Bun 对 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY` 的原生行为。
- `{body:...}`、`{header:...}` 或等价的请求级模板 namespace。
- 参数覆盖 DSL、条件、helper、partial、block、filter、默认值或递归模板。
- OAuth plugin provider 的网络代理。插件拥有自己的 transport；本轮不增加 plugin transport capability 契约。
- Dashboard 中新的 proxy/header 编辑器。
- 连接池、transport registry 或 proxy capability 抽象。

## 核心决策

| 决策点               | 结论                                                                               |
| -------------------- | ---------------------------------------------------------------------------------- |
| 顶层 proxy           | 可选 HTTP(S) URL 字符串                                                            |
| provider proxy       | API/AI SDK provider 可配置 URL；缺省继承顶层，`false` 关闭顶层配置                 |
| proxy 失败           | 作为当前 candidate 失败进入现有 provider fallback，不回退同一 provider 直连        |
| 动态 AI SDK package  | 始终注入 proxy-aware `fetch`；内置 package 保证，任意第三方 package 为 best effort |
| API provider headers | `Record<string, string>`，raw/model 两条路径生效                                   |
| header 优先级        | provider 配置最后写入，可覆盖协议认证、`Host` 和其他默认字段                       |
| 模板语法             | `{{env.NAME}}`                                                                     |
| 模板范围             | 配置字符串值（不含 provider `kind` 与对象键）；对象键不展开                         |
| 缺失环境变量         | 替换为空字符串，随后执行正常 schema 校验                                           |
| 模板实现             | `@handlebars/parser` AST + aio-proxy 白名单 evaluator                              |

## 配置契约

```yaml
proxy: "{{env.GLOBAL_PROXY}}"

providers:
  openai:
    kind: api
    protocol: openai-response
    baseURL: https://api.openai.com/v1
    apiKey: $OPENAI_API_KEY
    proxy: false
    headers:
      Authorization: "Bearer {{env.OPENAI_UPSTREAM_TOKEN}}"
      X-Tenant: "{{env.TENANT_ID}}"

  anthropic-sdk:
    kind: ai-sdk
    packageName: "@ai-sdk/anthropic"
    proxy: "{{env.ANTHROPIC_PROXY}}"
    options:
      apiKey: "{{env.ANTHROPIC_API_KEY}}"
```

字段规则：

- 顶层 `proxy` 省略时，aio-proxy 不注入配置级 proxy。
- provider `proxy` 省略时继承顶层值；字符串整体覆盖顶层值；`false` 只关闭 aio-proxy 的顶层 proxy 配置，不重新定义 Bun 的环境代理行为。
- proxy 在模板展开后必须是 `http:` 或 `https:` URL。URL userinfo 可承载 proxy 凭据。
- `headers` 只属于 API provider；header name/value 必须能由原生 `Headers` 接受。
- 现有 API key `$NAME` 语法保持兼容；`{{env.NAME}}` 也可用于 `apiKey` 和其他字符串值。provider `kind` 必须是字面量（`api` / `oauth` / `ai-sdk`），不能模板化，以便 authoring/mutation schema 在展开前用它做 discriminated union。

## 环境变量模板

### AST 契约

`@handlebars/parser` 只负责把字符串解析成公开、带类型的 Handlebars AST。aio-proxy 不使用 Handlebars compiler 或 runtime。

允许的 AST 节点只有：

- `ContentStatement`；
- 无 params、hash、subexpression 的 `MustacheStatement`；
- `MustacheStatement.path` 必须是 `PathExpression`，且精确匹配 `env.<NAME>`；
- `<NAME>` 使用环境变量标识符形状 `[A-Za-z_][A-Za-z0-9_]*`。

block、inverse、partial、helper、comment、decorator、data/depth path、raw/triple mustache 和未知 namespace 都使候选配置加载失败。

### 求值规则

- 一个字符串可以包含多个 `{{env.NAME}}`，也可以与普通文本组合。
- evaluator 直接拼接文本和环境变量值，不执行 HTML escaping。
- 环境变量不存在时拼接 `""`。
- 求值只执行一次；环境变量值中的模板文本不递归解析。
- 对象键、数字、布尔值、`null` 和其他非字符串值保持原样。
- resolver 返回深拷贝，不修改文件 parser 提供的 authored config record。

### Materialization 边界

环境变量展开位于“raw config 已解析、runtime schema 尚未校验”的边界：

```text
JSON/JSONC/YAML source
  -> raw authored record
  -> template AST parse + runtime-only expansion
  -> ConfigSchema validation/materialization
  -> runtime snapshot
```

所有生产环境 `ConfigSchema` materialization 入口必须经过同一个 runtime parse wrapper。文件读取、原子 transaction 和序列化继续操作 raw authored record，因此 Dashboard 修改其他 provider 时不会把展开后的 secret 写回文件。

模板语法错误或未知 namespace 拒绝整个候选配置。模板展开后的 provider 字段校验继续遵循现有 `invalidProviders` 行为；顶层字段错误拒绝整个候选配置。

Authoring 和 mutation schema 必须允许原本为字符串的字段携带 `{{env.NAME}}`，但不能因此放宽 materialized runtime schema。例外：provider `kind`（以及作为记录身份的对象键 / mutation `id`）保持字面量，以便在展开前做形态分流。Dashboard mutation 仍先形成 raw candidate，再通过统一 runtime parse wrapper 展开并验证；验证失败时原子 transaction 不落盘。数字、布尔值和对象不能通过模板注入，因为本轮模板只替换字符串叶子。

## Proxy 数据流

有效 proxy 在 snapshot/provider materialization 时计算：

```text
provider.proxy === false  -> 无配置级 proxy
provider.proxy is string  -> provider.proxy
provider.proxy omitted    -> config.proxy
```

一个内部 proxy-aware fetch 将有效 URL 传给 Bun：

```ts
fetch(input, { ...init, proxy });
```

它只封装 Bun 原生 `proxy` 选项，不实现 agent、dispatcher、重试、bypass 或连接池。

### API raw capability

`createApiProvider()` 的 passthrough 和 API probe 使用同一个 proxy-aware fetch。proxy 只改变连接路径；method、body、signal、URL rewrite、raw response 和 SSE tee/trace 行为保持不变。

### API model capability

`bridgeApiProviderToAiSdk()` 把同一个 proxy-aware fetch 注入合成 AI SDK provider 的 factory options。OpenAI、Anthropic、Google 和 OpenAI-compatible bridge 的普通与流式请求都使用该 fetch。

### 直接 AI SDK provider

`createAiSdkProvider()` 在运行时把 proxy-aware fetch 合并进 package factory options；配置文件不保存函数。所有内置 AI SDK package 必须转发该 `fetch`。`@ai-sdk/openai-compatible` loader 重建 options 时必须显式保留 `fetch`。

动态 package loader 仍把 options 交给第三方 factory，但 aio-proxy 无法证明任意 package 会使用 `fetch`。文档只保证仓库内置 package；第三方 package 为 best effort。

### 错误与 fallback

- 非 HTTP(S) proxy 在 runtime config materialization 时被拒绝。
- proxy DNS、认证、连接或 TLS 错误作为 provider attempt 失败。
- candidate loop 按现有顺序尝试下一个 Provider ID。
- 同一 provider 不自动回退直连，避免代理策略静默失效。

## API provider headers 数据流

### Raw passthrough

header 构造顺序固定为：

1. 复制入站 headers；
2. 删除当前禁止透传的客户端认证、cookie、proxy authorization 和 `Host`；
3. 写入 aio-proxy 默认字段和 protocol-specific `apiKey` 认证；
4. 最后写入 provider `headers`。

第 4 步拥有最终优先级。用户明确选择完全覆盖语义，因此配置可以覆盖 `Authorization`、`x-api-key`、`x-goog-api-key`、`Host`、`accept-encoding` 和其他默认字段。非法 name/value 仍在配置 materialization 时被拒绝。

### Cross-protocol model invocation

API bridge 把 `headers` 传入对应 AI SDK provider。四个 bridge target 都在协议默认认证之后合并 provider headers，并在普通与流式请求中使用相同配置。若 protocol adapter 的 model invocation 以后产生 per-call headers，合并顺序仍必须让 provider `headers` 最终获胜。

本轮 headers 只有静态值和运行时 `env` 展开结果，不读取入站 body/header，也不增加 per-request template context。

## Secret 与持久化

- 配置文件始终保留 `{{env.NAME}}` 原文。
- Dashboard `/config` 和 provider edit view 不返回展开后的 header secret 或带凭据 proxy URL。
- `headers` 继续整值显示为 `****`。
- 顶层和 provider `proxy` 整值显示为 `****`，不只隐藏 password。
- 提交 redacted placeholder 时，从 raw authored record 恢复原始模板或 URL；不得把 runtime 展开值写回配置文件。
- proxy/header 展开值加入相关日志和诊断的 secret redaction 输入；allowlisted request diagnostics 不记录它们。

Dashboard 本轮不增加编辑器，但现有 mutation 路径必须无损保留新字段。

## 模块边界

- `packages/types`：顶层 proxy、API/AI SDK provider proxy、API headers 的 authored/runtime schema 与公共类型。
- `packages/core`：模板 AST evaluator、runtime config parse wrapper、proxy-aware fetch、API raw transport、API-to-AI-SDK bridge 和 AI SDK loader 注入。
- `packages/server`：把顶层 proxy 传入 provider materialization，复用 candidate fallback，扩展 Dashboard secret redaction/retention。
- `packages/dashboard`：不增加 UI；只要求现有 provider mutation 不删除不可见字段。

`@handlebars/parser` 只在实际执行 runtime config template materialization 的 package 中声明。没有第二个 package 使用前，不为它增加跨 workspace catalog 项。

## 测试策略

### 模板

- 普通字符串保持不变。
- 单个、多个和嵌入文本的 `{{env.NAME}}` 正确展开。
- 缺失环境变量得到空字符串。
- 展开值不递归处理。
- 对象键和非字符串值不变。
- helper、block、partial、unknown namespace 和非法 env name 被拒绝。
- runtime 展开不修改 raw authored record，transaction 后模板原文仍在磁盘。

### Schema 与 proxy 选择

- 顶层 proxy、provider URL、继承、局部覆盖和 `false` 关闭行为。
- `http:`、`https:` 接受；SOCKS 和其他 scheme 拒绝。
- proxy 整值引用缺失环境变量时得到空字符串，并在 URL 校验阶段失败。
- API 与 AI SDK provider mutation 保留 proxy；API mutation 保留 headers。

### Transport

- raw passthrough 和 API probe 把有效 proxy 传给 fetch。
- API bridge 和内置 AI SDK provider 收到同一个 proxy-aware fetch。
- OpenAI-compatible loader 不丢弃 fetch。
- 普通与 streaming 请求保持现有响应语义。
- proxy 连接错误进入现有 provider fallback，且不尝试同一 provider 直连。

### Headers 与 secrets

- raw headers 在协议认证后应用，配置值最终获胜。
- 四种 API protocol 的 bridge 都携带配置 headers。
- header name/value 非法时 provider 在 materialization 阶段无效。
- Dashboard 输出遮蔽 headers 与 proxy，提交 placeholder 后 raw 原值保持不变。
- 日志和 request diagnostics 不包含展开后的 secret。

## 拒绝的替代方案

### 手写模板 parser

固定正则足以实现当前 `env` 替换，但未来 namespace、错误位置和语法校验会继续堆在自研 parser 上。`@handlebars/parser` 已提供活跃、零运行时依赖、parse-only、带类型的 AST；aio-proxy 只维护小型白名单 evaluator。

### 完整 Mustache 或 Handlebars runtime

Mustache.js 维护活跃度低；完整 Handlebars 包含当前不需要的 compiler、helper 和渲染能力。两者都扩大依赖或语义表面。

### 通用参数覆盖或请求模板

`body`/`header` namespace 需要每次请求的 protocol-neutral context、raw/model 双路径注入和不可信输入策略。它与 config-load `env` 生命周期不同，本轮不预建接口。

### SOCKS/Undici dispatcher

Bun 1.3.14 原生 fetch 不支持 SOCKS5H。引入 SOCKS 需要第三方 transport，并同时适配 raw 与 AI SDK fetch；没有当前需求支撑该复杂度。

### Proxy 配置对象

当前只需要一个 URL 和 `false`。为未来的 bypass、fallback 或 headers 预建对象会增加 schema、合并和脱敏规则；真实需求出现后再演进。
