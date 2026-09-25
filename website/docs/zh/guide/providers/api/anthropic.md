---
description: 配置 Anthropic Messages API 协议端点，支持 Claude 官方接口、Thinking 思考协议及第三方鉴权头定制。
---

# Anthropic Messages 协议 (`anthropic`)

`anthropic` 对应 Anthropic 官方的 Messages 协议规范，端点为 `POST /v1/messages` 与 `POST /v1/messages/count_tokens`。

## 适用场景

- Anthropic 官方商业 API（Claude 3.5 Sonnet、Claude 3.7 Sonnet、Claude 3.5 Haiku 等）。
- 兼容 Anthropic Messages 协议格式的第三方中转服务商或反向代理。

## 配置示例

### 1. Anthropic 官方平台（默认 x-api-key 认证）

```jsonc title="config.jsonc"
{
  "providers": {
    "anthropic-official": {
      "kind": "api",
      "protocol": "anthropic",
      "baseURL": "https://api.anthropic.com/v1",
      "apiKey": "{{env.ANTHROPIC_API_KEY}}",
      "models": ["claude-3-7-sonnet-20250219", "claude-3-5-haiku-20241022"],
    },
  },
}
```

### 2. 第三方兼容端点（Bearer 认证头定制）

部分国内服务商或中转平台兼容 Anthropic Messages 协议，但要求使用 `Authorization: Bearer <key>` 而非官方的 `x-api-key`。此时可在 `endpoints` 中声明 `auth: "bearer"`：

```jsonc title="config.jsonc"
{
  "providers": {
    "third-party-claude": {
      "kind": "api",
      "apiKey": "{{env.THIRD_PARTY_KEY}}",
      "models": ["claude-3-5-sonnet"],
      "endpoints": [
        {
          "protocol": "anthropic",
          "baseURL": "https://api.third-party.com/v1",
          "auth": "bearer",
        },
      ],
    },
  },
}
```

## 核心特性

- **思考协议兼容 (Thinking & Reasoning Effort)**：深度适配 Claude 的 Thinking 思考模式与预算参数，并能在跨协议请求（如 OpenAI reasoning_effort）之间精准互转。
- **Token 计数原生端点**：支持调用官方 `/v1/messages/count_tokens` 接口进行精准预计算，并在上游不支持时自动降级为本地预估。
