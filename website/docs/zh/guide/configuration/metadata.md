---
description: 模型公开 Slug 元数据配置、Token 上下文窗口定义、模型计费价格与 models.dev 自动继承。
---

# 模型元数据与计费

AIO Proxy 允许为客户端可见的模型公开名称（Slug）统一配置元数据、能力特征、Token 限制以及计费价格。该能力由配置文件的 `router` 字段控制。

配置示例：

```jsonc title="config.jsonc"
{
  "router": {
    "modelContextAggregation": "min",
    "models": {
      // 此处的键是面向客户端公开请求的 Slug（如 gpt-5）
      "gpt-5": {
        "metadata": {
          "name": "GPT-5 前沿模型",
          "description": "多模态旗舰模型，具备深度推理能力",
          "extend": "openai/gpt-5", // 继承 models.dev 权威目录数据
          "limit": {
            "context": 400000,
            "input": 272000,
            "output": 128000,
          },
          "capabilities": {
            "reasoning": true,
            "modalities": {
              "input": ["text", "image"],
              "output": ["text", "image"],
            },
          },
          "cost": {
            "input": 1.25, // 每 1M Token 输入费用（美元）
            "output": 10.0, // 每 1M Token 输出费用（美元）
          },
        },
        "providers": {
          // 针对特定 Provider 的差异化覆盖
          "azure-openai": {
            "cost": { "input": 1.0, "output": 8.0 },
            "limit": { "context": 300000, "input": 200000, "output": 100000 },
          },
        },
      },
    },
  },
}
```

## 核心概念

1. **Slug 必须已存在**：`router.models` 的键名是客户端调用时所使用的模型 Slug。该 Slug 必须已被至少一个提供商的 `models` 或 `alias` 声明；`router.models` 只会为已有路由附加元数据，**不会凭空创建新路由**。
2. **优先级继承梯队**：
   每个字段按以下梯队由高到低合并解析：
   ```
   所选 Provider 的专属覆盖 (providers.<id>.cost / limit)
     └─► Slug 元数据显式声明 (metadata)
           └─► 插件上报的原生元数据
                 └─► models.dev 社区目录数据 (通过 extend 继承)
                       └─► 协议默认规范值
   ```
3. **整体替换规则**：Provider 级别的 `cost` 或 `limit` 覆盖是**整体替换**，而不是深度合并。

## `extend` 属性与 models.dev 集成

当公开的 Slug 与开源社区权威模型数据库 [models.dev](https://models.dev) 中的模型标识一致或对应时，可通过 `extend: "provider/model"`（例如 `openai/gpt-5`、`anthropic/claude-3-5-sonnet`）一键继承官方的上下文窗口尺寸、输入输出配比、多模态支持情况以及最新官方定价。

你在 `metadata` 中手动填写的字段会自动覆盖继承值；即使某个冷门私有模型在 models.dev 中不存在，AIO Proxy 也会静默丢弃 `extend` 并保留你的显式配置，不会阻断系统启动。

## 多提供商上下文聚合 (`modelContextAggregation`)

当同一个模型公开 Slug（例如 `gpt-5`）挂载了多个提供商，而这些提供商各自声明了不同大小的上下文窗口时（例如官方支持 400K，某私有网关仅支持 128K）：

- **`"min"` (默认值，安全保守)**：对外公开的上下文大小取所有候选提供商中的**最小值**。确保无论请求被轮询调度到哪一个上游，都不会因为超出该上游的窗口大小而引发 400 Context Length Exceeded 错误。
- **`"max"` (激进)**：对外公开的上下文大小取所有候选中的**最大值**。
