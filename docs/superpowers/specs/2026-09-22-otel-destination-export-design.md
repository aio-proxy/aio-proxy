# Otel Destination 导出

日期：2026-09-22

## 目标

用户在设置里添加一个或多个 OTLP traces 终结点后，aio-proxy 把已经在记录的请求 span 树发给这些终结点。本地追踪页保持原样。没有 destination 时，运行时与现在一致。

参考形态是 Cloudflare AI Gateway 的 Otel 集成：设置页上一块列表，加上「Add Destination」对话框。对话框收集 OTLP Traces Endpoint、Content Type（JSON 或 protobuf）、可选 Custom Headers。

## 背景

请求 span 由 `NodeTracerProvider` 产生，唯一的 `SpanProcessor` 是 `BufferingSpanProcessor`：它把已注册 trace 的结束 span 交给本地 `traceStore`。`getTraceRuntime()` 在进程内只注册一次，采样器是 `AlwaysOnSampler`。span 上的属性由 `ALLOWED_ATTRIBUTES` 在创建时约束，不含 prompt、completion 或原始报文。

设置页（`/settings`）是网关运行时配置的入口，侧栏路径是「配置 → 设置」。卡片顺序是外观、服务、API 密钥、日志与重试、关于。写设置会改配置文件并走现有 reload；`commitConfig` 在快照切换后更新 `currentConfig()`。日志级别和目录要重启才生效，API 密钥和重试上限随 reload 生效。

`{{env.NAME}}` 在 `parseRuntimeConfig` 里先展开，再交给运行时 schema。设置页读磁盘上的原文，所以模板能原样显示并再次保存。

## 方案

采用「现有 tracer 上再挂一个导出 processor，destination 写在 `server.otel`」。

另外两条路不采用：

- 做成插件。这是网关自己的追踪出口，和监听地址、日志一样属于服务器配置。插件的安装和选项抽屉对不上 Cloudflare 的 destination 列表。
- 等 span 落进 SQLite 再读出来重编码发送。导出会被本地保留期绑住，也绕开 SDK 已经构造好的 span。进程内的 `SpanProcessor` 才是 OTLP 的发送点。

## 行为

- 每个 destination 收到同一棵 span 树：trace id、span id、父子关系、名称、kind、状态、起止时间、已有属性和事件都保持 span 上的值。
- 导出与本地入库并行。一边失败不影响另一边，也不影响客户端请求的成功或失败。
- 导出是异步的。`onEnd` 只入队。终结点超时、拒绝或不可达时，丢弃这一批并记一条警告。警告里有 URL；有 HTTP 响应时带上状态码。警告里没有 header 值。
- 修改、清空 destination 随配置 reload 生效，不要求重启进程。`restartRequired` 为 false。
- 进程退出时，还在批处理队列里的 span 可以丢失。`ServerState.close` 保持现有的同步关闭顺序，不为了 flush 改成异步。
- 直连终结点。不走 `proxy` / `proxyBackup`。
- 请求体不压缩。
- URL 原样作为 POST 地址，不追加 `/v1/traces`。Langfuse 这类已经带完整路径的地址因此可以照抄。

## 配置

`server.otel` 与 `server.logging` 同级。缺省等于没有 destination。

```json
{
  "server": {
    "otel": {
      "destinations": [
        {
          "url": "https://jp.cloud.langfuse.com/api/public/otel/v1/traces",
          "contentType": "json",
          "headers": {
            "Authorization": "Bearer {{env.LANGFUSE_OTLP_TOKEN}}"
          }
        }
      ]
    }
  }
}
```

字段：

| 字段 | 规则 |
| --- | --- |
| `destinations` | 数组，最多 8 条。缺省 `[]`。相同 URL 可以出现多次。 |
| `url` | 必填。展开后是绝对 `http` 或 `https` URL，最长 2048。不允许 username、password 或 fragment。query 保留。 |
| `contentType` | `json` 或 `protobuf`。缺省 `json`。 |
| `headers` | 名字到值的对象，最多 16 条。缺省省略。名字最长 256，字符集是 HTTP token。值最长 4096，展开后非空。名字按大小写不敏感判重。 |

作者 schema 里，`url` 和 header 值可以是字面量，也可以是现有的 `{{env.NAME}}` 模板。运行时 schema 只接受展开后的具体值。缺环境变量会展开成空字符串，从而通不过运行时 schema；这次写入被拒绝，磁盘上的上一份配置保留。这和别的配置字段共用 `parseRuntimeConfig`。

禁止这些 header 名（大小写不敏感），因为它们属于 OTLP 请求本身：`content-type`、`content-length`、`host`、`connection`、`transfer-encoding`。认证放在 `Authorization` 或其他自定义 header 里。不单设 Cloudflare Secrets Store 那种 `authorization` 字段。

`contentType` 决定编码：

- `json`：`Content-Type: application/json`，OTLP/HTTP JSON。
- `protobuf`：`Content-Type: application/x-protobuf`，OTLP/HTTP protobuf。

使用与 `@opentelemetry/sdk-trace-node` 2.x 配套的官方 OTLP/HTTP trace exporter。不手写 OTLP 编码。依赖只加在 `packages/server`。

## 运行时

`getTraceRuntime()` 的 provider 上，`BufferingSpanProcessor` 保持第一位，后面加一个 destination processor。本地入库仍只看见已 `register` 的 trace。

destination processor：

- 只转发 instrumentation scope 为 `@aio-proxy/server` 的 span。
- 每个 destination 一个官方 exporter 加一个 `BatchSpanProcessor`，批处理参数用 SDK 默认值。
- `onEnd` 不抛错。某个 destination 发送失败时，其余 destination 照常发送。
- 资源上设置 `service.name=aio-proxy`。不把 tracer 上的占位版本 `0.0.0` 写成 `service.version`。
- 不增加第二套属性白名单，也不写入 prompt、completion、报文正文。

同步发生在两处，输入都是已经展开的 `server.otel.destinations`：

1. 服务器拿到初始配置之后。
2. `commitConfig` 完成快照切换之后。

数组里的每一条对应一个 processor。两条内容完全相同的 destination 各发送一次，不能折成一条。比较时忽略 header 顺序：一条没变就留用它的 processor，变了或删了的先从转发集合拿掉，再关闭。关闭会把队列里残留的 span 发给旧地址。关闭之后才产生的 span 只发给新地址。同步失败只记日志，不把已经提交的配置打回去。

## 设置页

入口是 `/settings` 里的一张新卡片，放在「日志与重试」和「关于」之间。侧栏不加项，追踪页也不放这张表单。

卡片：

- 标题「Otel 集成」，说明「配置 Otel 集成来自动向 OpenTelemetry 终结点报告跟踪数据。」
- 右上角「Add Destination」。已有 8 条时按钮不可用。
- 每行显示 URL、Content Type 徽章（`JSON` 或 `Protobuf`）、Edit、Delete。行上不显示 header。
- 没有 destination 时只有说明和添加按钮。

添加和编辑共用一个对话框。英文标题是 “Add Otel Destination” / “Edit Otel Destination”，中文标题是「添加 Otel 终结点」/「编辑 Otel 终结点」。主按钮从「创建」变为「保存」。英文字段名是：

- OTLP Traces Endpoint，必填。空值时显示校验错误；英文是 “Endpoint is required”，其他语言翻译这句。
- Content Type，下拉，默认 JSON。
- Custom Headers（Optional）。一行是名字、值、删除。`+ Add Header` 增加一行，满 16 行后不可用。两格都空的行视为没填。只填一边时不能提交。

编辑的是列表中的那一行，不按 URL 查找。两条 destination 的 URL 相同时，保存只替换被打开的那一行。

创建、保存、删除各自立刻 `PUT` 完整的 `destinations` 数组，写入 `server.otel`。请求体里省略 `otel` 表示不改这一段。删除不再次确认。卡片在保存进行中不可操作。失败时沿用设置页现有的保存失败提示：已保存的列表不变，对话框留着刚才的草稿。

`GET /dashboard/api/settings` 从配置文件原文读取 destination，因此 `{{env.NAME}}` 原样回到编辑框。文件不存在或读不出来时，退回当前运行时配置，口径与 API 密钥相同。这个接口位于控制台密码之后，header 值不打码；打码会在下一次保存时覆盖真实凭证。

`[]` 清空 `server.otel.destinations`。成功响应里 `restartRequired` 为 false。

文案走 i18n。各语言保持同一拼写的只有 `Otel`、`OTLP`、`JSON`、`Protobuf`、`Add Destination`、`+ Add Header`。卡片标题中文是「Otel 集成」，英文是 “Otel integration”。说明的中文是「配置 Otel 集成来自动向 OpenTelemetry 终结点报告跟踪数据。」英文是 “Configure Otel to report trace data to OpenTelemetry endpoints.” 对话框标题、字段名、校验、Edit、Delete、创建、保存、取消都按语言翻译；英文对话框标题是 “Add Otel Destination”，英文空 endpoint 校验是 “Endpoint is required”。

## 错误

| 情况 | 结果 |
| --- | --- |
| URL、header 或条数不合法 | 设置保存返回现有的 `config_rejected`。手改文件则 reload 失败，上一份有效配置继续生效。 |
| 终结点返回非 2xx、超时或网络错误 | 请求成功，本地 trace 还在。警告日志含 URL，有响应时含状态码，不含 header 值。 |
| 批处理队列满 | SDK 丢弃新 span。请求成功，本地 trace 还在。 |
| 一个 destination 失败 | 其他 destination 继续接收这一批。 |

## 测试

- 配置接受上面的示例，缺省 `contentType` 为 `json`，缺省没有 destination。拒绝非法 scheme、带 userinfo 或 fragment 的 URL、超长、第 9 条 destination、第 17 个 header、重复 header 名、被禁止的 header 名、展开后为空的 header 值。
- `{{env.NAME}}` 写入后，设置视图仍显示模板；环境变量存在时，实际 POST 带展开后的值。
- 设置保存 destination 后 `restartRequired` 是 false。清空数组后不再发送。
- 本地 HTTP 服务收到 JSON destination 的 POST：路径与配置的 URL 路径相同，body 里能读出结束的 span 名，自定义 header 被带上。protobuf destination 的 body 能解析出同一个 span 名，`Content-Type` 为 `application/x-protobuf`。
- 两个 destination 各收到一次。其中一个返回 500 时，另一个仍收到，且本地 trace 仍可查询。
- reload 把 URL 从 A 改成 B 后，新 span 发往 B，不再发往 A，进程不重启。
- 设置页可以添加、编辑、删除一条 destination。空 endpoint 不能提交。列表行显示 URL 和 content type，不显示 header 值。

## 不做

- metrics、logs 的 OTLP 导出。
- prompt、completion、报文正文。
- 入站 trace context 透传。
- 采样率、压缩、代理、每条 destination 的独立开关。
- 导出成功率和最近一次错误的界面。
- 为了退出时 flush 把 `ServerState.close` 改成异步。
