---
description: 了解 AIO Proxy 的原始透传、跨协议转码、多协议端点配置与各协议能力边界。
---

# 协议与透传机制

AIO Proxy 既是强大的 API 网关，也是智能的跨协议转码器。无论客户端使用什么协议调用，也无论上游提供商原生支持何种接口，AIO Proxy 都能确保两端平滑对接。

## 原始透传 vs 协议转换

处理一条入站请求时，AIO Proxy 会对比客户端调用的入站协议与目标提供商的协议能力：

```
入站协议 == 提供商协议端点
  └─► 原始透传 (Raw Passthrough)
        保留原始请求体与响应流，零开销直接代理，上游私有特性无损透传

入站协议 != 提供商协议端点
  └─► 协议转换 (AI SDK Adapter Conversion)
        将入站协议解析为标准语义模型消息，经由 AI SDK 适配器调用目标提供商，再转换为入站协议的标准响应格式
```

### 原始透传 (Raw Passthrough)

当入站协议与上游端点匹配时（例如客户端使用 `/v1/chat/completions`，上游声明了 `openai-compatible`），请求会被**原样转发**。

- **无损特性**：保留上游服务商特有的扩展字段（如 DeepSeek `reasoning_content`、厂商专属参数等）。
- **原生流式**：直接流式中继上游的 Server-Sent Events (SSE)，不经过二次编码。

### 跨协议转换 (Cross-Protocol Conversion)

当协议不一致时（例如客户端使用 OpenAI SDK 调用 `/v1/chat/completions`，但目标提供商是 Anthropic Claude 或 Google Gemini）：

- AIO Proxy 会通过内置协议适配器将消息结构、System Prompt、多模态附件、工具定义 (Tools / Function Calling) 转换成对应上游的标准格式。
- 响应流在返回给客户端前，会被统一重新组装回客户端所期望的协议格式。

## 多协议端点 (`endpoints`)

很多现代大模型上游（例如 Moonshot / Kimi、z.ai 智谱、各类聚合网关）同一组 API Key 原生支持多套协议接口。AIO Proxy 允许在单个 Provider 中声明 `endpoints`，让各种协议的请求都能命中原始透传，避免不必要的协议转换：

```jsonc title="config.jsonc"
{
  "providers": {
    // 一方渠道：分别声明各协议的实际端点
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
    // 聚合网关：共用统一的 Base URL
    "aggregator": {
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

### 端点配置规范

1. **Base URL 规范**：`baseURL` 需要包含版本段：
   - OpenAI 系与 Anthropic 端点通常以 `/v1` 结尾。
   - Gemini 原生端点通常以 `/v1beta` 结尾（因此 Gemini 端点通常需要作为独立对象单列）。
2. **路径前缀保留**：
   - 使用 `endpoints` 声明的端点在进行原始透传时，会**完整保留 URL 中的路径前缀**（例如 `/provider/v1` 或 `/anthropic/v1`）。
   - 传统的顶层 `baseURL` 仅提取 Origin 拼接客户端请求路径。因此，有自定义路径前缀的上游推荐全部写在 `endpoints` 中。
3. **Anthropic 认证头定制**：
   - `auth: "bearer"`：用于向上游发送 `Authorization: Bearer <key>`（常见于兼容 Anthropic 接口的国内服务商）。
   - 默认使用 Anthropic 官方标准的 `x-api-key: <key>` 请求头。

## 受支持的协议概览

| 协议类别               | 入站路径                                                                                                                                                                            | 核心特性与说明                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **OpenAI Chat**        | `POST /v1/chat/completions`                                                                                                                                                         | 支持流式、工具调用、思考过程解析与多模态输入                            |
| **OpenAI Responses**   | `POST /v1/responses`<br/>`POST /v1/responses/compact`                                                                                                                               | 官方 Responses 规范、跨协议兼容、Compact 响应格式                       |
| **OpenAI Legacy**      | `POST /v1/completions`                                                                                                                                                              | 传统单文本补全格式支持                                                  |
| **Anthropic Messages** | `POST /v1/messages`<br/>`POST /v1/messages/count_tokens`                                                                                                                            | 原生 Messages 协议、Thinking 思考协议转换、本地与上游 Token 计数        |
| **Gemini**             | `POST /v1beta/models/{model}:generateContent`<br/>`POST /v1beta/models/{model}:streamGenerateContent`<br/>`POST /v1beta/models/{model}:countTokens`<br/>`POST /v1beta/interactions` | 原生 GenerateContent、流式交互、Token 计数与 Interactions 协议支持      |
| **向量 Embeddings**    | `POST /v1/embeddings`<br/>`POST /v1beta/models/{model}:embedContent`<br/>`POST /v1beta/models/{model}:batchEmbedContents`                                                           | OpenAI 格式与 Gemini 格式的双向向量计算与批量支持                       |
| **图片 Images**        | `POST /v1/images/generations`<br/>`POST /v1/images/edits`                                                                                                                           | DALL·E 与 GPT Image 协议支持，空模型自动兜底为 `gpt-image-2.5-sunburst` |
| **音频 Audio**         | `POST /v1/audio/speech`<br/>`POST /v1/audio/transcriptions`<br/>`POST /v1/audio/translations`                                                                                       | TTS 语音合成、Whisper 语音转写与翻译（翻译模式仅限原始透传）            |
| **视频 Videos**        | `POST /v1/videos`<br/>`GET /v1/videos/:id`<br/>`POST /v1/videos/:id/remix`                                                                                                          | 兼容 OpenAI Sora 视频 API，仅支持特定透传端点                           |
| **实时信令 Realtime**  | `GET/POST /v1/realtime`<br/>`POST /v1/realtime/calls`                                                                                                                               | Codex Live 与 Realtime WebSocket / WebRTC 旁路控制信令                  |
