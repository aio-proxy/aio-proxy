---
description: 使用任何符合 Vercel AI SDK 规范的驱动包直接接入更多模型提供商，无需额外适配。
---

# AI SDK 提供商 (`kind: "ai-sdk"`)

为了让 AIO Proxy 能够轻松融入广阔的开源大模型与社区驱动生态，AIO Proxy 原生集成了 [Vercel AI SDK](https://ai-sdk.dev) 的 Provider 运行时标准。

**任何符合 AI SDK [Provider 规范](https://ai-sdk.dev/docs/ai-sdk-core/providers-and-models)的 npm 驱动包（包括官方驱动、开源社区生态包或自建私有包）均可直接作为 AIO Proxy 的提供商驱动，无需为每个平台单独编写适配代码。**

---

## 什么是 Vercel AI SDK 与 Provider 规范？

[AI SDK](https://ai-sdk.dev) 是 Vercel 主导的开源 TypeScript 大模型调用标准框架。在 AI SDK 标准体系中，大模型厂商或推理网关被抽象为标准的 Provider 驱动包。一个合规的 Provider 驱动包只需满足以下约定：

1. **导出工厂函数**：包中导出了以 `create*` 命名的工厂函数（例如 `createOpenAI`、`createAnthropic`、`createOpenRouter`、`createMistral`、`createXai`、`createGoogle` 等）。
2. **返回模型实例**：该工厂函数接收自定义参数对象（如 `baseURL`、`apiKey` 等），并返回符合规范的 `LanguageModelV1` 或 `ProviderV1` 实例。

只要满足上述接口规范，AIO Proxy 就能直接通过 `packageName` 进行运行时动态加载与实例化调用。

---

## 常用包与配置示例

### 1. 接入通用 OpenAI 兼容服务 (`@ai-sdk/openai-compatible`)

适用于本地 Ollama、vLLM、LM Studio 或各类第三方中转：

```jsonc title="config.jsonc"
{
  "providers": {
    "local-ollama": {
      "kind": "ai-sdk",
      "packageName": "@ai-sdk/openai-compatible",
      "models": ["llama3.3", "qwen2.5-coder"],
      "options": {
        "name": "ollama",
        "baseURL": "http://127.0.0.1:11434/v1",
      },
      // 开启思考内容解析：从流式数据块中提取并分离出思考推理过程
      "parseReasoningContent": true,
      "proxy": false,
    },
  },
}
```

### 2. 接入 OpenRouter 全球模型池 (`@openrouter/ai-sdk-provider`)

```jsonc title="config.jsonc"
{
  "providers": {
    "openrouter-aisdk": {
      "kind": "ai-sdk",
      "packageName": "@openrouter/ai-sdk-provider",
      "models": ["anthropic/claude-3.5-sonnet", "deepseek/deepseek-r1"],
      "options": {
        "apiKey": "{{env.OPENROUTER_API_KEY}}",
      },
    },
  },
}
```

### 3. 接入各类开源与专属驱动包

如 `@ai-sdk/mistral`、`@ai-sdk/groq`、`@ai-sdk/xai`，甚至任何社区自主发布的驱动包（如 `my-company-ai-sdk-provider`）：

```jsonc title="config.jsonc"
{
  "providers": {
    "groq-speed": {
      "kind": "ai-sdk",
      "packageName": "@ai-sdk/groq",
      "models": ["llama-3.3-70b-versatile"],
      "options": {
        "apiKey": "{{env.GROQ_API_KEY}}",
      },
    },
  },
}
```

---

## 核心字段详解

| 字段名                  | 类型                      | 说明                                                                                                                                                      |
| ----------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                  | `"ai-sdk"`                | **必填**。标识为基于 AI SDK 规范驱动的提供商。                                                                                                            |
| `packageName`           | `string`                  | **必填**。实现了 AI SDK 规范的 npm 包名（默认值为 `@ai-sdk/openai-compatible`）。支持系统内置驱动包或项目中已安装的驱动包。                               |
| `options`               | `Record<string, unknown>` | 可选。原样传递给驱动包工厂函数（如 `createThing(options)`）的初始化参数对象，通常包含 `baseURL`、`apiKey`、`headers` 等。                                 |
| `parseReasoningContent` | `boolean`                 | 可选。针对具备深度推理能力的思考模型（如 DeepSeek-R1），开启后 AIO Proxy 会自动解析流式数据块中的 `reasoning_content`，保证思考过程与最终输出规范化分离。 |
| `models`                | `string[]`                | 该提供商声明支持的模型 ID 列表。                                                                                                                          |
| `alias`                 | `Record<string, string>`  | 模型别名映射。                                                                                                                                            |
| `priority` / `weight`   | `number`                  | 参与多提供商调度决策的优先级层级与流量分配权重。                                                                                                          |
