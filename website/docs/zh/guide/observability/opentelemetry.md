---
description: 配置 AIO Proxy 的 OpenTelemetry (OTEL) 导出，将大模型请求追踪与用量 Span 实时同步至主流可观测性平台。
---

# OpenTelemetry 导出

除了内置的轻量 Trace 审查模块，AIO Proxy 原生实现了标准的 OpenTelemetry (OTEL) 分布式追踪导出能力。流经 AIO Proxy 的大模型请求链路、用量指标与故障尝试过程均可以 OTLP 标准格式实时导出至企业现有的 APM 或大模型专属可观测性平台中。

## 概述与核心能力

AIO Proxy 的 OpenTelemetry 导出支持：

- **多目标并行推送**：最多可同时配置 8 个独立的 OTLP 导出目标（`destinations`），实现跨系统同步。
- **双编码格式**：支持 `json` 与 `protobuf` 两种 OTLP 传输协议编码（默认为 `json`）。
- **严格 GenAI 语义规范**：遵循 OpenTelemetry 官方的 [Semantic Conventions for Gen AI](https://opentelemetry.io/docs/specs/semconv/gen-ai/)，标准输出模型名、用量 Token、首字延迟与缓存数据。
- **内部敏感数据脱敏**：出站 Span 会经过安全过滤，确保不泄露内部私钥与敏感系统上下文。

---

## 配置规范 (`server.otel`)

你可以在 `config.jsonc` 的 `server.otel.destinations` 数组中添加导出目标，也可以直接在 Dashboard 的 **“设置 -> OpenTelemetry”** 界面中可视化配置。

完整配置语法如下：

```jsonc title="config.jsonc"
{
  "server": {
    "otel": {
      "destinations": [
        {
          // OTLP Collector 的标准 HTTP(S) 端点地址
          "url": "https://us.cloud.langfuse.com/api/public/otel/v1/traces",
          // 编码格式：json（默认）或 protobuf
          "contentType": "json",
          // 平台所需的自定义请求头（支持环境变量插值）
          "headers": {
            "Authorization": "Basic {{env.LANGFUSE_AUTH_HEADER}}",
          },
        },
      ],
    },
  },
}
```

### 参数说明

| 字段名        | 类型                     | 说明                                                                                                                         |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `url`         | `string`                 | **必填**。OTLP Collector 的完整 HTTP/HTTPS 收集端点（必须以 `/v1/traces` 结尾或符合对应平台规范）。                          |
| `contentType` | `"json" \| "protobuf"`   | 可选。出站报文的序列化协议，默认为 `"json"`。如目标 Collector 性能敏感，可选择 `"protobuf"`。                                |
| `headers`     | `Record<string, string>` | 可选。随 OTLP 导出请求一同发送的鉴权或路由请求头（最多配置 16 个键值对）。保留字段如 `host`、`content-type` 由系统自动管理。 |

---

## 导出的标准 Span 属性

AIO Proxy 严格按照 OpenTelemetry GenAI 语义与代理运行拓扑输出属性：

### 1. GenAI 行业标准属性 (`gen_ai.*`)

| 属性标识                               | 类型     | 说明                                                        |
| -------------------------------------- | -------- | ----------------------------------------------------------- |
| `gen_ai.operation.name`                | `string` | 大模型操作类型（如 `chat`、`text_completion`）              |
| `gen_ai.request.model`                 | `string` | 客户端请求的逻辑模型名称（如 `gpt-5`、`claude-sonnet-4-6`） |
| `gen_ai.response.model`                | `string` | 上游提供商实际确认响应的底层模型名称                        |
| `gen_ai.provider.name`                 | `string` | 上游模型厂商体系（如 `openai`、`anthropic`、`google`）      |
| `gen_ai.response.id`                   | `string` | 上游返回的全局唯一响应标识符                                |
| `gen_ai.response.time_to_first_chunk`  | `double` | 首字到达客户端的等待延迟（秒，即 TTFT）                     |
| `gen_ai.usage.input_tokens`            | `int`    | 本次请求消耗的输入/提示词 Token 数量                        |
| `gen_ai.usage.output_tokens`           | `int`    | 本次请求生成的输出/补全 Token 数量                          |
| `gen_ai.usage.cache_read.input_tokens` | `int`    | 命中 Prompt Cache 读取的 Token 数量                         |
| `gen_ai.usage.reasoning.output_tokens` | `int`    | 深度思考模型（如 o1、DeepSeek-R1）消耗的思考 Token          |

### 2. AIO Proxy 网关与调度属性 (`aio_proxy.*`)

| 属性标识                            | 类型     | 说明                                                 |
| ----------------------------------- | -------- | ---------------------------------------------------- |
| `aio_proxy.request.id`              | `string` | AIO Proxy 分配的内部全局请求链路 ID                  |
| `aio_proxy.provider.id`             | `string` | 当前成功承接请求的提供商 ID                          |
| `aio_proxy.protocol.inbound`        | `string` | 客户端发起请求时使用的协议名称                       |
| `aio_proxy.attempt.index`           | `int`    | 当前提供商尝试的轮次序号（从 0 开始）                |
| `aio_proxy.attempt.http_sends`      | `int`    | 该尝试中实际发起的 HTTP 传输次数（包含网络退避重发） |
| `aio_proxy.inference.attempt_count` | `int`    | 本次请求在多个候选提供商之间累计的尝试总次数         |
| `aio_proxy.inference.failover_ms`   | `double` | 因故障切换 (Failover) 所额外消耗的毫秒数             |

---

## 常用可观测性平台接入示例

AIO Proxy 的 OTLP 导出机制与任何兼容 OpenTelemetry 协议的后端通用。以下是几个常见平台的典型配置参考：

### 1. Langfuse

在 [Langfuse](https://langfuse.com/) 项目的 Settings -> API Keys 中获取 Public Key 与 Secret Key，使用 Basic Auth 编码：

```jsonc
{
  "url": "https://us.cloud.langfuse.com/api/public/otel/v1/traces",
  "contentType": "json",
  "headers": {
    "Authorization": "Basic {{env.LANGFUSE_BASIC_AUTH}}",
  },
}
```

### 2. Honeycomb

[Honeycomb](https://www.honeycomb.io/) 通过专门的 API Key 请求头进行认证：

```jsonc
{
  "url": "https://api.honeycomb.io/v1/traces",
  "contentType": "protobuf",
  "headers": {
    "x-honeycomb-team": "{{env.HONEYCOMB_API_KEY}}",
    "x-honeycomb-dataset": "aio-proxy-traces",
  },
}
```

### 3. Braintrust

[Braintrust](https://www.braintrust.dev/) 的 OpenTelemetry 端点：

```jsonc
{
  "url": "https://api.braintrust.dev/otel/v1/traces",
  "contentType": "json",
  "headers": {
    "Authorization": "Bearer {{env.BRAINTRUST_API_KEY}}",
  },
}
```

### 4. Datadog

接入 [Datadog](https://docs.datadoghq.com/)（美国站点示例）：

```jsonc
{
  "url": "https://otlp.datadoghq.com/v1/traces",
  "contentType": "protobuf",
  "headers": {
    "dd-api-key": "{{env.DATADOG_API_KEY}}",
  },
}
```

### 5. New Relic

接入 [New Relic](https://newrelic.com/) 的 OTLP 端点：

```jsonc
{
  "url": "https://otlp.nr-data.net/v1/traces",
  "contentType": "protobuf",
  "headers": {
    "api-key": "{{env.NEW_RELIC_LICENSE_KEY}}",
  },
}
```

### 6. Arize Phoenix / 自建 OpenTelemetry Collector

如果你在内网部署了开源的 [Arize Phoenix](https://phoenix.arize.com/) 或自建的 `otel-collector`：

```jsonc
{
  "url": "http://otel-collector.internal:4318/v1/traces",
  "contentType": "protobuf",
}
```

- `gen_ai.system`：上游提供商厂商体系（如 `openai`、`anthropic`）。
- `gen_ai.request.model`：请求的目标模型标识。
- `gen_ai.response.model`：上游实际响应的模型标识。
- `gen_ai.usage.input_tokens` 与 `gen_ai.usage.output_tokens`：精细化的用量数据。
- `aio_proxy.provider.id`：当前承接请求的提供商 ID。
- `aio_proxy.attempt.index`：故障重试尝试序号。
