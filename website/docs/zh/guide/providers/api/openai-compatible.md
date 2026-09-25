---
description: 配置标准的 OpenAI Chat Completions 兼容协议，支持 DeepSeek、Moonshot、Groq、Ollama、vLLM 等绝大多数大模型服务商。
---

# OpenAI 兼容协议 (`openai-compatible`)

`openai-compatible` 是目前大模型生态中使用最广泛的协议标准，对应标准的 `POST /v1/chat/completions` 接口。

## 适用场景

- **各大云端大模型服务商**：DeepSeek、Moonshot / Kimi、SiliconFlow（硅基流动）、Groq、Mistral、Together AI、Fireworks 等。
- **本地或私有部署推理引擎**：vLLM、Ollama、LocalAI、SGLang、TGI 等。
- **中转分发网关**：OneAPI、NewAPI 及各类第三方聚合路由平台。

## 配置示例

### 接入云端平台（如 DeepSeek）

```jsonc title="config.jsonc"
{
  "providers": {
    "deepseek": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "{{env.DEEPSEEK_API_KEY}}",
      "models": ["deepseek-chat", "deepseek-reasoner"],
    },
  },
}
```

### 接入本地部署的 Ollama / vLLM

本地部署服务通常不需要真实的 API Key，可填写任意非空字符串：

```jsonc title="config.jsonc"
{
  "providers": {
    "local-vllm": {
      "kind": "api",
      "protocol": "openai-compatible",
      "baseURL": "http://127.0.0.1:8000/v1",
      "apiKey": "none",
      "models": ["qwen2.5-72b-instruct"],
      "proxy": false, // 本地服务强制直连
    },
  },
}
```

## 协议特性

- **无损流式透传**：客户端使用 Chat Completions 协议调用时直接走原始 SSE 透传，保留上游特有的扩展字段（如 `reasoning_content` 思考流）。
- **向其他协议转码**：当客户端使用 Anthropic SDK 或 Gemini SDK 发起请求时，AIO Proxy 会将请求转译为 Chat Completions 格式发送给该提供商。
