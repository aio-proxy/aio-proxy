---
description: 使用 @aio-proxy/plugin-google-antigravity 接入 Google 账号与开发者凭据，调用 Gemini 全系列大模型。
---

# Google Antigravity 插件

**插件包名**：`@aio-proxy/plugin-google-antigravity`  
**对应 Capability**：`antigravity`

用于集成 Google 账号体系与 Antigravity 云平台通道，支持原生 Gemini 模型接入。

## 核心特性

- **动态上游模型发现**：动态同步当前项目与账号权限下的最新可用 Gemini 模型列表。
- **智能别名折叠**：自动整理上游繁杂的带日期版本号与别名映射，保证客户端可用稳定名称调用。
- **多会话标识与鉴权**：完备处理 Google Cloud 项目 ID 与用户鉴权链路。

## 登录与配置

在 Dashboard 中选择 **Google Antigravity** 并点击登录授权。

```jsonc title="config.jsonc"
{
  "providers": {
    "google-cloud": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-google-antigravity",
      "capability": "antigravity",
      "priority": 10,
      "weight": 100,
    },
  },
}
```
