---
description: 配置 OpenAI Images 图像生成与编辑协议，支持 DALL·E 与 GPT Image 系列。
---

# OpenAI Images 协议 (`openai-image`)

`openai-image` 对应 OpenAI Images 官方标准接口，涵盖：

- 图片生成：`POST /v1/images/generations`
- 图片编辑：`POST /v1/images/edits`

## 适用场景

- OpenAI 官方平台及兼容 OpenAI 图片格式的第三方生图网关。

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "openai-images": {
      "kind": "api",
      "protocol": "openai-image",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["dall-e-3", "dall-e-2", "gpt-image-2.5-sunburst", "gpt-image-2"],
    },
  },
}
```

## 协议特性与默认模型回退

1. **空模型自动回退**：若客户端发送的生图请求中未指定模型名称（或传空值），AIO Proxy 会自动尝试寻找支持 `gpt-image-2.5-sunburst` 的提供商承接请求。
2. **格式编码**：DALL·E 模型默认返回图片 URL；GPT Image 模型在未指定格式时默认编码为 `b64_json`。
3. **编辑上限支持**：原生支持官方高上限的多部分表单 (Multipart) 上传与 JSON 格式编辑请求。
