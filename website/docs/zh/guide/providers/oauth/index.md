---
description: 了解 AIO Proxy 的 OAuth 插件体系、通用授权流程与配额监控机制。
---

# OAuth 插件概述

除了常规的付费 API Key 外，很多开发者拥有 ChatGPT Plus/Pro、Claude Pro/Team、Cursor、GitHub Copilot 等平台的个人订阅或组织账号。

AIO Proxy 内置了强大的 **OAuth 插件体系**，允许直接登录并托管这些订阅账号，享受以下核心优势：

- **免手填 Key**：支持通过浏览器一键登录或 CLI 设备码授权，Access Token 与 Refresh Token 由系统在底层自动安全加密存储与静默续期。
- **动态模型目录**：账号成功连接后，插件会自动通过官方接口发现你当前订阅权限所能调用的全部模型。
- **配额监控与价值换算**：实时采集账号的剩余请求限额、重置时间窗口，并按官方商业 API 定价自动折算“等效价值”。
- **自动熔断与无感回退**：当某个账号配额耗尽（触发 429）或遇到限制时，AIO Proxy 会自动将流量故障切换至其他备用账号或 API 提供商。

---

## 内置官方插件索引

点击下方卡片或侧边栏查看对应插件的详细使用教程：

| 提供商 / 平台                                  | 插件包名                               | 适用账号与特性                                                      |
| ---------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------- |
| [**OpenAI ChatGPT**](./openai-chatgpt)         | `@aio-proxy/plugin-openai-chatgpt`     | ChatGPT Plus/Pro 订阅，动态获取当前账号可用模型，支持图片多模态     |
| [**Claude Pro/Team**](./claude-code)           | `@aio-proxy/plugin-claude-code`        | Claude Pro / Team 账号，动态同步官方可用模型，Messages 协议原生调用 |
| [**Cursor**](./cursor)                         | `@aio-proxy/plugin-cursor`             | Cursor 订阅会员，动态同步可用模型，多模态对话历史自动适配           |
| [**GitHub Copilot**](./github-copilot)         | `@aio-proxy/plugin-github-copilot`     | GitHub Copilot 账号，动态发现可用模型，免 Key 调用                  |
| [**Google Antigravity**](./google-antigravity) | `@aio-proxy/plugin-google-antigravity` | Google 账号与开发者平台，动态同步模型并智能折叠别名                 |
| [**Kimi Code**](./kimi-code)                   | `@aio-proxy/plugin-kimi-code`          | Moonshot Kimi 账号，动态发现模型与超长上下文支持                    |
| [**Muse Code**](./muse-code)                   | `@aio-proxy/plugin-muse-code`          | Muse 平台代码模型，动态模型发现与代码优化                           |
| [**OpenCode Go**](./opencode-go)               | `@aio-proxy/plugin-opencode-go`        | OpenCode 官方通道，动态模型同步与零配置桥接                         |
| [**OpenRouter**](./openrouter)                 | `@aio-proxy/plugin-openrouter`         | OpenRouter PKCE 免密授权与全量模型动态同步                          |
| [**xAI Grok**](./xai-grok)                     | `@aio-proxy/plugin-xai-grok`           | xAI Grok 官方账号，动态拉取最新模型与工具兼容转换                   |

---

## 通用授权登录方式

AIO Proxy 支持两种便捷的 OAuth 账号接入方式：

### 方式一：Dashboard 一键授权（推荐）

1. 打开控制台：`http://127.0.0.1:9317/dashboard`。
2. 进入 **“提供商”** 页面，点击 **“添加提供商”**。
3. 提供商类型选择 **“OAuth 账号”**，在下拉列表中选择对应的厂商。
4. 点击 **“授权登录”**，浏览器将弹出官方授权页面，按提示确认授权即可自动完成绑定。

### 方式二：命令行交互式登录

在无图形界面终端或远程服务器操作时：

```sh
aio-proxy provider login
```

按终端指引选择目标提供商，通过终端打印的设备码链接在浏览器完成授权。

---

## 配置文件结构

所有已授权的 OAuth 账号均在 `config.jsonc` 的 `providers` 中声明：

```jsonc title="config.jsonc"
{
  "providers": {
    "my-account": {
      "kind": "oauth",
      "plugin": "@aio-proxy/plugin-openai-chatgpt",
      "capability": "chatgpt",
      "priority": 10,
      "weight": 100,
      // 可选：排除不想对外暴露的模型
      "excludedModels": ["text-davinci-002"],
      // 可选：模型别名映射
      "alias": {
        "gpt-5": "gpt-5",
      },
    },
  },
}
```

> 安全提示：OAuth 产生的 Access Token 与 Refresh Token 会由系统安全隔离存储在内部凭据库中，不会暴露在纯文本的 `config.jsonc` 中。
