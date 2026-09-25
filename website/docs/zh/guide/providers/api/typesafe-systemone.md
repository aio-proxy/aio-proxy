---
description: 配置 TypeSafe System One 评估协议，用于面向确定性状态、分类决策与打分评估的专有大模型评估接口。
---

# System One 评估协议 (`typesafe-systemone`)

`typesafe-systemone` 是针对 **TypeSafe System One 评估模型**（如 `jev-latest`、`public-jev`）的专用入站与上游协议，对应入站接口 `POST /v1/systemone`。

与传统的 Chat 对话（生成长文本）不同，System One 专注于**结构化评估 (Evaluation)**：客户端输入一个共享的上下文状态（`state`）以及一组严格类型化的问题映射（`questions`），模型直接返回高精度的结构化判定与概率分布（Probabilities）。

---

## 配置示例：接入 TypeSafe 官方或兼容网关

在 `config.jsonc` 中将提供商协议指定为 `typesafe-systemone`：

```jsonc title="config.jsonc"
{
  "providers": {
    "typesafe-official": {
      "kind": "api",
      "protocol": "typesafe-systemone",
      "baseURL": "https://api.typesafe.ai/v1",
      "apiKey": "{{env.TYPESAFE_API_KEY}}",
      "models": ["jev-latest", "public-jev"],
    },
  },
}
```

如果通过 [AI SDK 提供商](../ai-sdk-providers)接入，可配合 `@ai-sdk/typesafe-ai` 使用 `kind: "ai-sdk"`：

```jsonc title="config.jsonc"
{
  "providers": {
    "typesafe-aisdk": {
      "kind": "ai-sdk",
      "packageName": "@ai-sdk/typesafe-ai",
      "models": ["jev-latest"],
      "options": {
        "apiKey": "{{env.TYPESAFE_API_KEY}}",
      },
    },
  },
}
```

---

## 客户端调用报文示例

客户端向 `http://127.0.0.1:9317/v1/systemone` 发送结构化评估请求：

```sh
curl http://127.0.0.1:9317/v1/systemone \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-aio-key" \
  -d '{
    "model": "jev-latest",
    "state": "用户提交了工单：账号登录时提示网络错误，客户端版本为 2.3.1，操作系统 macOS 14.5",
    "questions": {
      "is_urgent": {
        "type": "noul",
        "instructions": "该问题是否属于紧急线上阻断故障？",
        "criteria": { "true": "影响正常登录核心业务", "false": "一般体验或配置问题" }
      },
      "category": {
        "type": "choice",
        "instructions": "该问题应分发给哪一个处理团队？",
        "criteria": {
          "network": "网络与网关团队",
          "client": "桌面客户端团队",
          "account": "账号与鉴权团队"
        }
      },
      "severity_score": {
        "type": "score",
        "instructions": "评估严重级别等级（1为低，3为严重）",
        "criteria": ["level-1", "level-2", "level-3"]
      }
    }
  }'
```

### 问题类型说明 (`type`)

1. **`noul`（布尔 / 是非判定）**：
   - 评估命题真伪，返回 `true` / `false` 结果及对应置信概率。
   - 支持在 `criteria` 中为 `true` / `false` 提供额外判定准则描述。
2. **`choice`（单选分类）**：
   - 从候选集（最多 255 个选项）中选择唯一最佳匹配，并返回各选项的概率分布。
3. **`score`（等级 / 分数评估）**：
   - 从有序的等级序列（至少 2 个级别，最多 10 个级别）中评估所处梯队。

---

## 协议特性

- **无损原始透传**：入站为 `typesafe-systemone` 且上游声明了同协议时，请求体与结果原样穿透，耗时最低。
- **跨模型评估转换**：如果通过 AI SDK 驱动配置，系统能够利用 `experimental_evaluate` 接口将结构化评估任务跨协议派发给上游支持评估的底层模型。
- **原生格式错误映射**：若入站校验未通过（如缺少 `state` 或 `criteria` 越界），AIO Proxy 直接返回 TypeSafe 规范的 400 结构化错误响应。
