---
description: AIO Proxy HTTP API 提供商的配置体系、字段规范、多协议端点 (endpoints) 与路径保留机制。
---

# API 提供商概述

API 提供商（`kind: "api"`）用于接入通过标准 HTTP API 提供模型服务的第三方平台，包括官方商业接口、第三方中转、私有聚合网关或本地模型推理后端。

## 通用配置结构

所有 API 提供商均在 `config.jsonc` 的 `providers` 对象中声明：

```jsonc title="config.jsonc"
{
  "providers": {
    "my-provider-id": {
      "kind": "api",
      "protocol": "openai-compatible", // 主端点支持的协议
      "baseURL": "https://api.example.com/v1", // 主端点服务地址
      "apiKey": "{{env.MY_API_KEY}}", // 上游认证凭据
      "models": ["model-a", "model-b"], // 声明对外公开的模型列表
      "alias": {
        "client-model-name": "actual-upstream-model-id", // 模型别名映射
      },
      "priority": 10, // 故障切换层级（数值越大越先尝试）
      "weight": 100, // 同优先级内的流量权重
      "headers": {
        "x-custom-header": "custom-value", // 附加到上游请求的自定义请求头
      },
      "proxy": false, // 可选：独立网络代理设置（false 表示强制直连）
    },
  },
}
```

## 核心字段详解

| 字段名           | 类型                     | 说明                                                            |
| ---------------- | ------------------------ | --------------------------------------------------------------- |
| `kind`           | `"api"`                  | **必填**。标识为原生 HTTP API 提供商。                          |
| `protocol`       | `string`                 | 主端点支持的协议类型，支持的值见下方协议索引。                  |
| `baseURL`        | `string`                 | 主端点的上游服务地址。                                          |
| `apiKey`         | `string`                 | 调用上游所需的 API 密钥，推荐使用 `{{env.KEY_NAME}}` 模板语法。 |
| `models`         | `string[]`               | 手动声明支持的上游模型 ID 列表；非空时不能启用 `syncModels`。   |
| `syncModels`     | `boolean`                | 可选，默认关闭。设为 `true` 时自动同步上游模型列表。            |
| `excludedModels` | `string[]`               | 仅在 `syncModels: true` 时有效，按精确模型 ID 隐藏模型。        |
| `alias`          | `Record<string, string>` | 模型别名映射，方便客户端以自定义名称调用。                      |
| `priority`       | `number`                 | 故障转移优先级层级（`0..10000`，默认 `0`，越大越先尝试）。      |
| `weight`         | `number`                 | 同一优先级层级内的流量权重（默认 `1`，钳制在 `0..10000`）。     |
| `endpoints`      | `object \| array`        | 多协议端点配置，用于原生支持多种协议的上游服务。                |
| `headers`        | `Record<string, string>` | 附加给上游出站请求的自定义 HTTP Header。                        |
| `proxy`          | `string \| false`        | 覆盖全局代理；设为 `false` 时强制该提供商直连。                 |

---

## 与上游同步模型

设置 `syncModels: true` 后，无需编辑配置即可跟随上游模型列表。手动 `models` 列表保持原有行为。

```jsonc title="config.jsonc"
{
  "providers": {
    "relay": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "https://relay.example.com",
      "apiKey": "{{env.RELAY_API_KEY}}",
      "syncModels": true,
      "excludedModels": ["gpt-3.5-turbo"],
    },
  },
}
```

`syncModels: true` 与非空的 `models` 互斥。`excludedModels` 仅在 `syncModels: true` 时有效，按精确模型 ID 隐藏模型，不支持 glob 匹配。别名可以指向被隐藏的模型。

- **刷新时机**：启动和配置变更后立即发现模型，之后每小时刷新。刷新失败后，在列表过期时每隔 5 分钟重试；手动刷新未过期的列表失败时，会等到列表过期再重试。
- **可用性**：上游故障或返回空列表时保留上次成功的列表。首次发现成功前，仅别名可路由；配置加载不会等待网络请求。
- **更换上游**：更改主端点的 `baseURL`、`protocol` 或端点配置形式（顶层 `protocol`/`baseURL` 与 `endpoints` 之间切换）会丢弃旧列表。
- **发现范围**：仅通过主端点所属协议的模型列表接口查询，不查询次要端点，也不会改写配置文件。

Dashboard 的模型区域提供**手动 / 与上游同步（Manual / Sync with upstream）**切换。同步模式显示发现的模型列表，支持逐个隐藏模型、查看上次刷新时间和手动刷新。[AI SDK 提供商](../ai-sdk-providers.md) 在上游目录可发现时也支持此模式。

---

## 进阶：多协议端点 (`endpoints`) 与路径保留

很多现代服务商在同一个账号或同一套 Base URL 下原生支持多套协议接口。通过声明 `endpoints`，当入站协议命中任意已声明的端点时，AIO Proxy 会直接进行**原始透传**，无需损耗协议转换开销：

```jsonc title="config.jsonc"
{
  "providers": {
    // 形式一：多端点独立声明（适用于各协议路径不同的上游）
    "moonshot": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "https://api.moonshot.cn/v1",
      "apiKey": "{{env.MOONSHOT_API_KEY}}",
      "models": ["kimi-k2"],
      "endpoints": [
        {
          "protocol": "anthropic",
          "baseURL": "https://api.moonshot.cn/anthropic/v1",
          "auth": "bearer",
        },
      ],
    },
    // 形式二：共用 Base URL 声明（适用于聚合网关）
    "gateway": {
      "kind": "api",
      "apiKey": "{{env.GATEWAY_KEY}}",
      "models": ["gpt-5", "claude-sonnet-4-6"],
      "endpoints": {
        "baseURL": "https://api.gateway.example.com/v1",
        "protocol": ["openai-response", "anthropic", "openai-compatible"],
      },
    },
  },
}
```

> **重要规则**：
>
> 1. `endpoints` 中声明的 `baseURL` 在原始透传时会**完整保留其路径前缀**（例如 `/provider/v1` 或 `/anthropic/v1`），而顶层旧式的 `protocol/baseURL` 透传时仅截取 Origin。
> 2. `endpoints` 中每一项的 `baseURL` 需要符合 SDK 规范：OpenAI 系与 Anthropic 通常带 `/v1`，Gemini 端点带 `/v1beta`。

---

## 支持的协议清单

点击以下专有页面了解各个协议的具体配置规范与能力边界：

- [**OpenAI Responses 协议 (`openai-response`)**](./openai-response)
- [**OpenAI 兼容协议 (`openai-compatible`)**](./openai-compatible)
- [**Anthropic Messages 协议 (`anthropic`)**](./anthropic)
- [**Google Gemini 协议 (`gemini` / `gemini-interactions`)**](./gemini)
- [**OpenAI Images 图片协议 (`openai-image`)**](./openai-image)
- [**OpenAI Audio 音频协议 (`openai-audio`)**](./openai-audio)
- [**OpenAI Video 视频协议 (`openai-video`)**](./openai-video)
- [**TypeSafe System One 评估协议 (`typesafe-systemone`)**](./typesafe-systemone)
