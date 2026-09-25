---
description: 使用 @aio-proxy/plugin-cursor 接入 Cursor 订阅会员账号，自动适配多模态对话历史与工具调用。
---

# Cursor 插件

**插件包名**：`@aio-proxy/plugin-cursor`  
**对应 Capability**：`cursor`

将你的 **Cursor** 会员订阅接入 AIO Proxy，让终端命令行、SDK 或外部应用也能借助 Cursor 的大模型通道进行交互。

## 核心特性

- **动态上游模型同步**：基于 HTTP/2 协议实时调用 Cursor 底层 `GetUsableModels` 接口获取当前会员资格下的最新可用模型集合。
- **多模态历史自动修复**：Cursor 上游对历史多模态消息有特殊格式校验，插件内置了报文修复管道，避免对话中断。
- **智能工具调用适配**：完整桥接并转码客户端与上游的 Function / Tool Calling。
- **会员配额查询**：实时监控 Fast Request 快速额度消耗情况与次月重置日期。

## 登录与授权

### 在 Dashboard 中授权（推荐）

进入 Dashboard -> **提供商** -> **添加提供商**，选择 **OAuth 账号** -> **Cursor**，点击 **授权登录** 并根据指引完成绑定。

### 命令行登录

```sh
aio-proxy provider login cursor
```

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "my-cursor": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-cursor",
      "capability": "cursor",
      "priority": 15,
      "weight": 100,
    },
  },
}
```
