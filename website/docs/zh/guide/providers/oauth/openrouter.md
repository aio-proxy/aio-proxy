---
description: 使用 @aio-proxy/plugin-openrouter 接入 OpenRouter，统一访问全球数百款主流大模型。
---

# OpenRouter 插件

**插件包名**：`@aio-proxy/plugin-openrouter`  
**对应 Capability**：`openrouter`

[OpenRouter](https://openrouter.ai/) 汇聚了全球主流商业模型（OpenAI、Anthropic、Meta Llama、Mistral、DeepSeek 等）。该插件支持使用 OpenRouter 账号进行免密 PKCE 登录，免除手动创建和管理 API Key。

## 核心特性

- **全量模型动态拉取**：调用 OpenRouter 官方模型端点实时获取全平台支持的文本、多模态与向量模型。
- **PKCE 免密授权**：一键在 OpenRouter 官网确认授权即可绑定账号。
- **统一模型池**：一次登录即可使用 OpenRouter 平台托管的数百款大模型。
- **余额与配额监控**：实时采集账户 Credit 余额，并在余额不足时提供告警。

## 登录与配置

在 Dashboard 中选择 **OpenRouter** 并点击登录：

```jsonc title="config.jsonc"
{
  "providers": {
    "my-openrouter": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-openrouter",
      "capability": "openrouter",
      "priority": 10,
      "weight": 100,
    },
  },
}
```
