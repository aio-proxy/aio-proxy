---
description: 使用 @aio-proxy/plugin-muse-code 接入 Muse 平台代码专属模型。
---

# Muse Code 插件

**插件包名**：`@aio-proxy/plugin-muse-code`  
**对应 Capability**：`muse`

用于将 Muse 平台的代码生成与优化模型引入 AIO Proxy 路由网络。

## 核心特性

- **动态模型发现**：实时拉取 Muse 平台模型端点，动态获取当前可用模型。
- **代码加速模型**：针对代码补全与复杂系统分析进行定向优化的专用模型。
- **OAuth 凭证自动托管**：支持静默 Token 自动续期。

## 登录与配置

在 Dashboard 中添加 **Muse Code** 提供商并授权：

```jsonc title="config.jsonc"
{
  "providers": {
    "muse": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-muse-code",
      "capability": "muse",
      "priority": 10,
      "weight": 100,
    },
  },
}
```
