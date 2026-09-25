---
description: 使用 @aio-proxy/plugin-opencode-go 接入 OpenCode Go 分发通道。
---

# OpenCode Go 插件

**插件包名**：`@aio-proxy/plugin-opencode-go`  
**对应 Capability**：`opencode`

连接 OpenCode 生态的模型分发服务，支持跨平台调用与路由聚合。

## 核心特性

- **动态模型目录同步**：自动从 OpenCode 官方模型端点获取最新分发模型。
- **多模型聚合分发**：支持通过 OpenCode 通道调度多元大语言模型。
- **零配置桥接**：与 AIO Proxy 原生 Agent 体系紧密协同。

## 登录与配置

在 Dashboard 中添加并完成 OpenCode 授权绑定：

```jsonc title="config.jsonc"
{
  "providers": {
    "opencode": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-opencode-go",
      "capability": "opencode",
      "priority": 10,
      "weight": 100,
    },
  },
}
```
