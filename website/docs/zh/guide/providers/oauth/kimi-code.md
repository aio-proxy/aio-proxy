---
description: 使用 @aio-proxy/plugin-kimi-code 接入 Moonshot Kimi 账号，享受超长上下文大模型。
---

# Kimi Code 插件

**插件包名**：`@aio-proxy/plugin-kimi-code`  
**对应 Capability**：`kimi`

连接 Moonshot Kimi 平台，将具备超长上下文能力的大模型接入本地统一代理。

## 核心特性

- **动态模型发现**：实时同步 Moonshot Kimi 当前账号所支持的最新模型目录。
- **专有协议适配**：深度适配 Kimi 平台的认证请求头与流式事件协议。
- **状态监控**：支持查看当前账号的使用额度与健康状况。

## 登录与配置

在 Dashboard 中点击 **添加提供商** -> **Kimi Code** 进行登录：

```jsonc title="config.jsonc"
{
  "providers": {
    "kimi": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-kimi-code",
      "capability": "kimi",
      "priority": 10,
      "weight": 100,
    },
  },
}
```
