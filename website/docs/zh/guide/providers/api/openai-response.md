---
description: 配置 OpenAI Responses API 协议端点，支持会话状态、原生工具调用与上下文压缩。
---

# OpenAI Responses 协议 (`openai-response`)

`openai-response` 对应 OpenAI 官方推出的新一代 Responses API 接口规范，路径通常为 `/v1/responses` 与 `/v1/responses/compact`。

## 适用场景

- OpenAI 官方平台及原生支持 Responses 接口的高级聚合网关。
- 需要利用 OpenAI 官方新特性（如服务端持久化 Session、上下文直接压缩等）的应用。

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "openai-official": {
      "kind": "api",
      "protocol": "openai-response",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["gpt-5", "gpt-4.5-preview"],
    },
  },
}
```

## 协议行为与特性

1. **同协议透传**：客户端若直接调用 `POST /v1/responses`，请求将原样转发至上游，完整保留未压缩的会话与上下文字段。
2. **跨协议转码**：当客户端通过 `POST /v1/chat/completions` 或 Anthropic `POST /v1/messages` 访问声明了 `openai-response` 的提供商时，AIO Proxy 会自动将消息结构、System Prompt 与工具声明双向转码为 Responses 规范，实现无感平滑切换。
3. **压缩端点支持**：提供商原生支持 `POST /v1/responses/compact` 上下文压缩操作。
