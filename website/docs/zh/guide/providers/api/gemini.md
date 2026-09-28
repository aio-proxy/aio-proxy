---
description: 配置 Google Gemini 原生 API 与 Interactions 交互端点，支持多模态输入与流式生成。
---

# Google Gemini 协议 (`gemini`)

AIO Proxy 支持 Google Gemini 原生协议，包括基础生成协议 `gemini` 与高级交互协议 `gemini-interactions`。

## 协议分类与端点

- **`gemini`**：
  - 核心生成接口：`POST /v1beta/models/{model}:generateContent`
  - 流式生成接口：`POST /v1beta/models/{model}:streamGenerateContent`
  - 令牌计数接口：`POST /v1beta/models/{model}:countTokens`
  - 向量计算接口：`POST /v1beta/models/{model}:embedContent`
- **`gemini-interactions`**：
  - 会话式多轮交互接口：`POST /v1beta/interactions`

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "google-gemini": {
      "kind": "api",
      "protocol": "gemini",
      "baseURL": "https://generativelanguage.googleapis.com/v1beta",
      "apiKey": "{{env.GEMINI_API_KEY}}",
      "models": ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash-exp"],
    },
  },
}
```

## 配置注意事项

1. **Base URL 规范**：Gemini 原生接口的 Base URL 必须包含版本段（通常为 `/v1beta`），请勿省略或写成 `/v1`。
2. **URL 模型参数分离**：Gemini 规范中模型名称通常直接嵌入在 URL Path 中（如 `:generateContent`），AIO Proxy 在进行跨协议路由时会自动将请求体中的模型参数与 URL 路径进行绑定与映射。
