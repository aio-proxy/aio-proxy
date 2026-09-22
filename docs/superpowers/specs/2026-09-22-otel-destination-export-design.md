# Otel Destination 导出

日期：2026-09-22

## 目标

用户在设置里添加一个或多个 OTLP traces 终结点后，aio-proxy 把已经在记录的请求 span 发给这些终结点。本地追踪页保持原样。没有 destination 时不创建 exporter。

界面沿用 Cloudflare AI Gateway 的 destination 列表和「Add Destination」对话框：OTLP Traces Endpoint、Content Type（JSON 或 protobuf）、可选 Custom Headers。

## 背景

`getTraceRuntime()` 在进程内注册一次 `NodeTracerProvider`，采样器是 `AlwaysOnSampler`，唯一的 processor 是 `BufferingSpanProcessor`。SDK 2.x 不能在构造之后再 `addSpanProcessor()`。

`startPipelineSpan()` 把 `options` 原样交给 `tracer.startSpan()`。`ALLOWED_ATTRIBUTES` 只用在 `spanToRecord()`：写入 SQLite 时过滤 span、event、link 的属性，并且只存 `status.code`。原始 span 上可以存在白名单之外的属性、`status.message`，以及其他调用点通过 `recordException()` 写下的异常内容。

`parseRuntimeConfig` 先把 `{{env.NAME}}` 展开，缺变量变成空字符串，但会留下周围的字面量。`Bearer {{env.MISSING}}` 展开后仍是非空字符串。

`@opentelemetry/otlp-exporter-base` 0.221.0 的 `mergeHeaders` 先放入 `OTEL_EXPORTER_OTLP_HEADERS` 和 `OTEL_EXPORTER_OTLP_TRACES_HEADERS`，再用同名的代码 header 覆盖。显式传入的 `url`、`compression`、`timeoutMillis` 则盖过对应环境变量。

## 行为

- 导出与本地入库并行。导出失败不影响本地 trace，也不影响客户端请求。
- 发给哪个 destination，看 `onEnd()` 当时的活动集合，不看 span 开始时的集合。一次 reload 可以把同一棵 trace 的 child 和 root 拆到两个地址。v1 接受这种拆分，不按 trace 固定 destination。
- 删除或清空只表示之后结束的 span 不再进入该 destination。已经入队或正在发送的批次仍可能到达旧地址。
- `onEnd` 不等待网络结束，也不把导出失败抛回请求。批次满时，SDK 可能就在这条调用链里序列化并启动发送。不另加一层队列。
- aio-proxy 不再做应用层重试，也不把失败批次落盘重放。官方 exporter 可以在下面写明的 10 秒超时内按自己的策略重试 429、502、503、504。超时或最终失败后丢弃。
- HTTP 200 里声明了 `rejected_spans` 时视为 partial success：不重发整批。
- 直连终结点，不走 `proxy` / `proxyBackup`。请求体不压缩。URL 原样 POST，不追加 `/v1/traces`。
- 进程退出时，队列里的 span 可以丢失。

通过共享过滤规则的属性保持原值。trace id、span id、父子关系、名称、kind、状态码和原始起止时间保持不变。不从 `StoredSpan` 重建，避免把时间精度收成毫秒。

日志只包含 destination 在数组里的位置、URL 的 origin（scheme、host、port），以及受控类别：`export_failed`、`partial_success`、`destination_unavailable`。SDK 实际给出 HTTP 状态码时可以附上状态码。不记录 path、query、headers、响应正文、`error.message`，也不记录整个 exporter error。

## 配置

`server.otel` 与 `server.logging` 同级。缺省等于没有 destination。

```json
{
  "server": {
    "otel": {
      "destinations": [
        {
          "url": "https://collector.example/v1/traces",
          "contentType": "json",
          "headers": {
            "Authorization": "Bearer {{env.OTLP_TOKEN}}"
          }
        }
      ]
    }
  }
}
```

Langfuse 使用它公布的完整 traces URL。认证是 `Authorization: Basic {{env.LANGFUSE_OTLP_BASIC_AUTH}}`，变量值是 `publicKey:secretKey` 的 Base64。另加 header `x-langfuse-ingestion-version: 4`。不为 Langfuse 增加单独字段。

| 字段 | 规则 |
| --- | --- |
| `destinations` | 最多 8 条活动项。缺省 `[]`。相同内容可以出现多次，每条各发送一次。 |
| `url` | 展开后是绝对 `http` 或 `https` URL，最长 2048。不允许 username、password 或 fragment。query 可以出现在请求里。 |
| `contentType` | `json` 或 `protobuf`。缺省 `json`。 |
| `headers` | 最多 16 条。名字最长 256，是 HTTP token，大小写不敏感判重。值最长 4096。 |

作者 schema 允许 `url` 和 header 值使用 `{{env.NAME}}`。展开前，`parseRuntimeConfig` 检查 `server.otel` 里的每一个这类引用：变量必须存在于环境中，值必须是非空字符串。`Bearer {{env.MISSING}}` 和嵌进 path 或 query 的缺变量都拒绝。这个检查只覆盖 `server.otel`，其他字段仍按现有展开规则。设置写入和手改文件 reload 都走这里。

展开后的 header 值还必须能通过 Node `http` 的 header 校验。含 CR、LF、NUL 或其他会触发 `ERR_INVALID_CHAR` 的值，在写盘前拒绝。

禁止这些 header 名（大小写不敏感）：`content-type`、`content-length`、`content-encoding`、`host`、`connection`、`transfer-encoding`、`user-agent`。`content-encoding` 会和「不压缩」矛盾。`user-agent` 留给 exporter 自己写。认证放在 `Authorization` 或其他允许的 header 里。

编码：

- `json`：`Content-Type: application/json`。
- `protobuf`：`Content-Type: application/x-protobuf`。

使用与 `@opentelemetry/sdk-trace-node` 2.x 配套的官方 OTLP/HTTP trace exporter。依赖只加在 `packages/server`。

## 运行时

Provider 构造时挂两个 processor：先是现有的 `BufferingSpanProcessor`，然后是一个固定的 delegator。reload 不改 provider，只替换 delegator 里的活动集合。没有 destination 时，活动集合为空，不创建 exporter。

delegator 只转发 instrumentation scope 为 `@aio-proxy/server` 的 span。转发前做一份只读视图，不改 SDK 里的原始 span：

- span、event、link 的属性使用 `spanToRecord()` 同一份 `ALLOWED_ATTRIBUTES`。
- 事件名、link 的 trace id 和 span id、事件的原始时间保留。
- `status` 只保留 `code`，去掉 `message`。

每个活动 destination 一个官方 exporter 加一个 `BatchSpanProcessor`，批处理参数用 SDK 默认值。构造时显式传入该 destination 的 `url`、`compression: 'none'`、`timeoutMillis: 10000`。这三项不读 endpoint、compression、timeout 的 `OTEL_EXPORTER_OTLP_*` 环境变量。

请求 headers 只能是该 destination 展开后的 headers，加上协议要求的 `Content-Type`。官方 `OTLPTraceExporter` 构造器会合并 `OTEL_EXPORTER_OTLP_HEADERS` 和 `OTEL_EXPORTER_OTLP_TRACES_HEADERS`，空对象也清不掉。这两个环境变量任一非空，并且 `destinations` 不是空数组时，拒绝这份 `server.otel`。没有 destination 时，这两个变量不影响配置。不修改 `process.env`。

比较活动项时忽略 header 顺序。只改顺序不重建 exporter。完全相同的两项仍是两个 exporter；删掉一项只关掉其中一台。

reconcile 不等待网络：

- 新 exporter 初始化失败时，只把该项留在活动集合之外，记 `destination_unavailable`。不把已经删掉或换掉的旧项加回来。
- 离开活动集合的 processor 马上开始 `shutdown()`，调用方不等待。失败的 Promise 要接住。排空与 10 秒超时竞赛，结束后从跟踪表去掉。
- 同时排空的 processor 最多 8 台。超出时不再跟踪更早的那次 shutdown，那次调用仍自己结束，失败照样接住。
- 8 条上限只数活动 destination，排空中的不占这 8 条。

`ServerState.close()` 同步让 delegator 停止转发，并对它持有的 exporter 发起清理。不等待 flush，也不关闭共享的 `NodeTracerProvider`。`close()` 保持同步。

同步发生在服务器拿到初始配置之后，以及每次 `commitConfig` 切换快照之后。同步失败不回滚已经提交的配置。

## 设置页

入口是 `/settings` 里的一张卡片，放在「日志与重试」和「关于」之间。侧栏不加项，追踪页不放这张表单。

卡片标题中文是「Otel 集成」，英文是 “Otel integration”。说明的中文是「配置 Otel 集成来自动向 OpenTelemetry 终结点报告跟踪数据。」英文是 “Configure Otel to report trace data to OpenTelemetry endpoints.” 右上角按钮各语言都是 “Add Destination”，已有 8 条时不可用。每行显示完整 URL、`JSON` 或 `Protobuf` 徽章、Edit、Delete。行上不显示 header。

添加和编辑共用一个对话框。英文标题是 “Add Otel Destination” / “Edit Otel Destination”，中文是「添加 Otel 终结点」/「编辑 Otel 终结点」。主按钮从「创建」变为「保存」。英文字段名是 OTLP Traces Endpoint、Content Type、Custom Headers (Optional)。空 endpoint 的英文校验是 “Endpoint is required”。`+ Add Header` 各语言相同，满 16 行后不可用。两格都空的行忽略；只填一边不能提交。

编辑的是被打开的那一行。创建、保存、删除各自立刻 `PUT` 完整的 `destinations` 数组，写入 `server.otel`。省略 `otel` 表示不改这一段。删除不再次确认。失败时已保存的列表不变，对话框留着草稿。

`GET /dashboard/api/settings` 返回配置文件里的原文，`{{env.NAME}}` 原样回到编辑框，header 值不打码。文件读不出来时退回当前运行时配置，口径与 API 密钥相同。`/dashboard/api/config` 和 CLI 继续走 `redactSecrets`：destination 的 `url` 和 `headers` 显示为 `****`。

只改 otel 时 `restartRequired` 为 false。同一次保存如果还改了监听地址、端口或日志，`restartRequired` 仍按那些字段计算，otel 不能把它改回 false。

## 错误

| 情况 | 结果 |
| --- | --- |
| URL、header、缺变量、非法 header 字符、条数、冲突的 OTLP headers 环境变量 | 设置保存返回 `config_rejected`。手改文件则 reload 失败，上一份有效配置继续生效。 |
| 终结点 400，或超时内重试后仍失败 | 请求成功，本地 trace 还在。记 `export_failed`。有状态码就附上。 |
| 429、502、503、504 | 官方 exporter 可在 10 秒内重试。最终失败按上一行。 |
| HTTP 200 且 `rejected_spans` | 不重发。记 `partial_success`。 |
| 新 exporter 初始化失败 | 该项不进入活动集合。其他项不受影响。 |

## 测试

这些测试跑在 Bun 里，对本地 HTTP 服务发真实 OTLP 请求，不 mock 掉 exporter。

- 在原始 span、event、link 和 `status.message` 里放入白名单外的哨兵。JSON 和 protobuf 请求体都不含哨兵。原始 span 不被修改。允许的属性、身份和时间仍在。
- `OTEL_EXPORTER_OTLP_HEADERS` 或 `OTEL_EXPORTER_OTLP_TRACES_HEADERS` 非空时，带 destination 的配置被拒绝，不发出请求。两者都空时，gzip 压缩环境变量不会压缩 body，`OTEL_EXPORTER_OTLP_ENDPOINT` 也不会换掉显式 `url`。
- 完整模板、`Bearer {{env.MISSING}}`、嵌在 path 或 query 里的缺变量，都在写盘前拒绝。CR、LF 的 header 值同样拒绝。磁盘上的上一份有效配置不变。
- child 在 A→B 之前结束、root 在切换之后结束：root 不进入 A。已经入队的批次仍可能发到 A。
- 旧队列排空失败、新 exporter 初始化失败、连续 reload、`ServerState.close()` 都没有未处理的 rejection。删除项不会回到活动集合。`close()` 不等待 flush。
- 覆盖 400、503 加 `Retry-After`、超时，以及 200 partial success。成功回调不等于全部接收。日志里没有密钥、path 或响应正文。
- 两条完全相同的 destination 各导出一次。只改 header 顺序不重建。删掉其中一条，另一条还在。
- 设置页可以添加、编辑、删除。空 endpoint 不能提交。列表行不显示 header。只改 otel 时 `restartRequired` 为 false；同一请求里再改端口时仍为 true。`redactSecrets` 把 destination 的 url 和 headers 打成 `****`。

## 不做

- metrics、logs 的 OTLP 导出。
- 为导出额外记录 prompt、completion 或报文正文。
- 入站 trace context 透传，或按 trace 把 destination 固定住。
- 采样率、压缩、代理、每条 destination 的独立开关。
- 导出成功率界面，以及退出时保证 flush。
- 改写 `process.env`，或改变 `server.otel` 以外字段的缺变量语义。
