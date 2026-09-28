---
description: 使用 @aio-proxy/plugin-xai-grok 接入 xAI Grok 官方账号，支持 Grok-2 与 Grok-3 大模型调用。
---

# xAI Grok 插件

**插件包名**：`@aio-proxy/plugin-xai-grok`  
**对应 Capability**：`grok`

直接连接 xAI Grok 平台，调用马斯克旗下 xAI 推出的大语言与深度思考模型。

## 核心特性

- **动态模型同步**：直连 xAI 官方模型端点动态获取当前账号可调用的最新 Grok 模型。
- **工具调用 Schema 兼容转换**：针对 Grok 特有的 Tool Call 参数格式内置双向纠偏管道，防止客户端调用报错。
- **额度追踪与账单统计**：实时跟踪调用消耗与账号状态。

## 登录与配置

在 Dashboard 中添加 **xAI Grok** 提供商或通过终端命令授权：

```sh
aio-proxy provider login grok
```

```jsonc title="config.jsonc"
{
  "providers": {
    "grok": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-xai-grok",
      "capability": "grok",
      "priority": 10,
      "weight": 100,
    },
  },
}
```
