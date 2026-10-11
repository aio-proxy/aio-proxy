---
title: OpenAI Decisions
---

# OpenAI Decisions 评估协议 (`openai-decisions`)

`POST /v1/decisions` 根据文本或图片回答 `predicate`（条件概率）、`choice`（选项）和 `score`（评分）问题。参见 [OpenAI 官方文档](https://developers.openai.com/api/docs/guides/decisions)。目前官方上游支持 `gpt-6-luna`；aio-proxy 按配置解析模型及别名，不将这个模型限制写死。

```json
{
  "providers": {
    "openai-judge": {
      "kind": "api",
      "protocol": "openai-decisions",
      "baseURL": "https://api.openai.com",
      "apiKey": "{{env.OPENAI_API_KEY}}",
      "models": ["gpt-6-luna"]
    }
  }
}
```

也可将 `openai-decisions` 加入同一 Provider 的 `endpoints`，与 `openai-response` 等协议共用凭据。`protocol` 与 `baseURL` 使用源站地址；`endpoints[].baseURL` 使用 SDK 基础路径，例如 `https://api.openai.com/v1`。

```bash
curl http://127.0.0.1:9317/v1/decisions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-6-luna",
    "input": "I was charged twice.",
    "questions": [{
      "type": "choice",
      "name": "department",
      "instructions": "Which department should handle this?",
      "choices": [
        {"value": "billing", "description": "Payments and refunds"},
        {"value": "other", "description": "Other requests"}
      ]
    }]
  }'
```

## 与 SystemOne 共用评估管线

两种协议都使用统一的 `evaluation` 能力、模型路由、Provider priority/weight 和失败回退：

- 同协议上游优先原始透传，仅改写解析后的模型。保留额外字段、原生概率分布及 `refusal` 结果。
- Decisions 请求可转换为 SystemOne/AI SDK 评估请求：`predicate` 对应 `noul`，选项值在转换后保留原始类型，评分等级保留标签与描述。API 类型的 SystemOne 上游需要安装 `@ai-sdk/typesafe-ai`。
- SystemOne 请求也可转换并调用配置的原生 Decisions 上游。普通结构化 `state` 转成 JSON 文本作为证据；合法 Decisions 用户消息作为多模态输入保留。
- 转换后的 Decisions `choice`/`score` 结果必须包含完整概率分布及 `confidence`。不能表达所需结果的候选回退至下一 Provider；全部失败时返回协议对应的错误。SystemOne 无法表达 Decisions 的拒绝结果，因此该候选也会回退。

此接口不提供流式响应或生成文本的模拟评分。图片使用 `data:image/...;base64,...` 或可公开访问的 HTTP(S) URL；`file_id` 不受支持。已命名的问题名称必须唯一。

原生 Decisions 用量记录输入 Token、缓存子集，输出 Token 记为零。转换后的响应始终包含完整 usage 对象，并记录实际上游评估用量；上游未报告的计数记为零。费用估算遵循项目的配置价格优先规则，可以为评估通道单独配置价格。
