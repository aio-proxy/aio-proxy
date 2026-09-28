---
description: 使用 @aio-proxy/plugin-claude-code 接入 Anthropic Claude 账号，享受原生 Messages 协议调用。
---

# Claude Pro / Team 插件

**插件包名**：`@aio-proxy/plugin-claude-code`  
**对应 Capability**：`claude`

将 Anthropic **Claude Pro** 或 **Claude Team** 账号直接接入 AIO Proxy，提供官方级别的 Messages 接口与流式响应。

:::important{title="合规与使用限制提示"}
**严禁滥用与风控警告**：  
Anthropic 通常严格限制非官方第三方软件访问 Claude 个人/组织订阅账号。AIO Proxy 对 Claude OAuth 的支持定位为**纯透明代理**，核心目的是方便个人在官方支持的环境（如 **Claude Code** 或 **Claude Desktop**）中便捷接入与多订阅账号轮换分流。  
**请务必继续仅在 Claude Code 或 Claude Desktop 等合规场景中使用该反代端点，切勿将其用于其他第三方 Agent、外部爬虫或高并发脚本中**。非预期客户端行为与调用特征极易触发 Anthropic 的严格风控检测，可能导致您的 Claude 账号被直接封禁。
:::

## 核心特性

- **动态模型目录同步**：直接通过 Anthropic 官方模型端点实时拉取当前账号有权调用的全部可用模型，支持自动分页发现，紧跟官方最新发布节奏。
- **原生 Messages 协议**：入站与出站均原生遵循 Anthropic Messages 规范，支持复杂 System Prompt 与多轮对话。
- **安全 PKCE 授权**：基于标准的 OAuth 2.0 PKCE 流程完成授权，无须提供密码。
- **长效 Token 自动刷新**：由后台自动处理 Access Token 过期与刷新，保障调用不中断。

## 登录与授权

### 在 Dashboard 中授权

1. 进入 Dashboard -> **提供商** -> **添加提供商**。
2. 选择 **OAuth 账号** -> **Claude Pro/Team**。
3. 点击 **授权登录** 完成身份验证。

### 命令行登录

```sh
aio-proxy provider login claude
```

## 配置示例

```jsonc title="config.jsonc"
{
  "providers": {
    "my-claude": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-claude-code",
      "capability": "claude",
      "priority": 20,
      "weight": 100,
    },
  },
}
```
